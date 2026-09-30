/**
 * export.js — 导入视频 -> MediaPipe 逐帧 -> 导出参考序列 JSON(合同 §4)。
 *
 * mode 决定骨骼表(全身/手势)、是否跑手部模型、以及 meta.danceType 标签。
 * 处理管线与实时端完全一致(同一 pose-engine、同样标定/平滑)。
 */

import { createPoseEngine } from "./pose-engine.js";
import {
  landmarksToJoints,
  addDerivedJoints,
  constrainLimbDepth,
  visibilitiesFromLandmarks,
  poseFromJoints,
  computeShoulderAxis,
  handsFromResult,
  resolveMode,
} from "./contract.js";
import { PoseSmoother, HandSmoother } from "./filters.js";
import { RootMotionTracker } from "./root-motion.js";
import { computeDimensions } from "./playback.js";

// fps 必须由帧自身的 PTS 跨度推导,不能用 video.duration:
// duration 是容器标称值,而 requestVideoFrameCallback 只回调解码器实际呈现的帧。
// 抖音这类 VFR 转码常丢帧,两者不一致时按 duration 算会把 fps 算小,
// 令下游 refFrameIdx = round(t * fps) 整体前移(实测可偏 3s+)。
function deriveFps(frames) {
  if (frames.length < 2) return 30;
  const span = frames[frames.length - 1].t - frames[0].t;
  if (!(span > 1e-6)) return 30;
  return Math.round((frames.length - 1) / span);
}

export async function exportVideoToSequence({
  file,
  onProgress = () => {},
  onStatus = () => {},
  onError = (err) => console.error(err),
  mode = "full-body",
  smoothing = { minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 },
  timing = null, // [可选] timing/v1 对象(由 tools/detect_beats.py 产出),写入 meta.timing
  chart = null,  // [可选] chart/v2 对象(含 audio),写入顶层 chart
} = {}) {
  const m = resolveMode(mode);

  // ---- 1. 建隐藏 video 元素加载文件 ----
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(file);
  video.src = url;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("视频加载失败"));
  });
  const duration = video.duration;

  // ---- 2. 加载模型 ----
  onStatus("loading-model");
  const engine = await createPoseEngine(m.poseModel, {
    withHands: m.hands,
    handModelPath: m.handModel,
  });
  // 预热:拿张空白小图先跑一次推理,把 GPU shader 编译/图初始化的一次性开销(~10s)提前吃掉。
  // 不做这一步的话,播放期间第一次 detect 会一直占着 inFlight,这段时间的帧全被丢掉 ——
  // 实测 30s 的舞会直接缺掉前 11.5s(只剩 2 帧),参考序列等于废了三分之一。
  // 注意:Tasks Vision 的 VIDEO 模式要求时间戳严格递增。预热占用 WARM_TS,
  // 所以真实帧统一加上 TS_OFFSET,否则第一帧会因为「时间戳没变大」而抛错 ——
  // 一旦抛错,后面每一帧都在同一个坑里失败,整段会静默变成空序列。
  const WARM_TS = 0;
  const TS_OFFSET = 1;
  try {
    const warmCanvas = document.createElement("canvas");
    warmCanvas.width = 64;
    warmCanvas.height = 64;
    await engine.detect(await createImageBitmap(warmCanvas), WARM_TS);
  } catch (err) { onError(err); /* 预热失败不影响主流程 */ }
  onStatus("processing");

  // ---- 3. 播放并逐帧采集 ----
  const smoother = new PoseSmoother(smoothing);
  const rootTracker = new RootMotionTracker();
  const handSmoother = m.hands
    ? new HandSmoother({ minCutoff: 3.0, beta: 1.0, dCutoff: 1.0 })
    : null;
  const frames = [];
  let dimsSum = null;
  let dimsCount = 0;
  let frameErrors = 0;

  await new Promise((resolve, reject) => {
    let ended = false;
    let inFlight = 0;

    video.onended = () => {
      ended = true;
      onProgress(1); // 视频播放结束强制进度到 100%,避免末帧 time 略小于 duration
      maybeResolve();
    };
    video.onerror = () => reject(new Error("视频播放失败"));

    function maybeResolve() {
      if (ended && inFlight === 0) resolve();
    }

    function onFrame(now, metadata) {
      video.requestVideoFrameCallback(onFrame);
      if (ended || inFlight) return;
      inFlight++;
      (async () => {
        try {
          const bitmap = await createImageBitmap(video);
          const { world, img, hands } = await engine.detect(bitmap, metadata.mediaTime * 1000 + TS_OFFSET);
          bitmap.close();

          // 进度按视频时间推进,与是否检测到人无关(避免 world=null 时进度卡死)
          const tSec = metadata.mediaTime;
          onProgress(Math.min(tSec / duration, 1));
          if (world) {
            const rawJoints = landmarksToJoints(world);
            const depthFixed = constrainLimbDepth(rawJoints, img); // S3 深度约束(在平滑前)
            const vis = visibilitiesFromLandmarks(img);
            const smoothed = smoother.smooth(depthFixed, vis, tSec);
            const joints = addDerivedJoints(smoothed);
            const { bones, rootYaw, conf } = poseFromJoints(joints, vis, m.bones);
            const rawHands = m.hands ? handsFromResult(hands) : null;
            const handsField = handSmoother
              ? handSmoother.smooth(rawHands, tSec)
              : null;
            const root = rootTracker.update(joints, tSec);

            const frame = {
              t: tSec,
              bones,
              rootYaw,
              shoulderAxis: computeShoulderAxis(joints),
              conf,
            };
            if (handsField) frame.hands = handsField;
            frames.push(frame);

            const d = computeDimensions(joints);
            if (!dimsSum) {
              dimsSum = { ...d };
            } else {
              for (const k in dimsSum) dimsSum[k] += d[k];
            }
            dimsCount++;
          }
        } catch (err) {
          // 偶发取帧失败可以跳过,但第一次必须报出来:
          // 若是系统性错误(时间戳不递增之类),后面每一帧都会同样失败,整段会静默变空。
          if (!frameErrors++) onError(err);
        } finally {
          inFlight--;
          maybeResolve();
        }
      })();
    }

    video.requestVideoFrameCallback(onFrame);
    video.play().catch(reject);
  });

  // 一帧都没采到就是整体失败,直接报错,别把空序列存进草稿(否则到制谱那步才发现)
  if (!frames.length) {
    engine.close();
    URL.revokeObjectURL(url);
    throw new Error(`视频动捕没采到任何帧(失败 ${frameErrors} 次)`);
  }

  // ---- 4. 组装 §4 dance-sequence JSON ----
  const dimensions = {};
  if (dimsCount > 0) {
    for (const k in dimsSum) dimensions[k] = +(dimsSum[k] / dimsCount).toFixed(3);
  }

  const sequence = {
    schema: "dance-sequence/v1",
    danceId: file.name.replace(/\.[^.]+$/, ""),
    meta: {
      fps: deriveFps(frames),
      durationSec: +duration.toFixed(3),
      numFrames: frames.length,
      boneCount: m.bones.length,
      danceType: mode, // full-body | gesture
      source: "video-import",
      coordinateSystem: "canonical-yup",
      dimensions,
      ...(timing ? { timing } : {}),
    },
    bones: m.bones.map(({ name, parent, child }) => ({ name, parent, child })),
    frames,
    ...(chart ? { chart } : {}),
  };

  engine.close();
  URL.revokeObjectURL(url);
  return sequence;
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
