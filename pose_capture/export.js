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
  visibilitiesFromLandmarks,
  poseFromJoints,
  handsFromResult,
  resolveMode,
} from "./contract.js";
import { PoseSmoother, HandSmoother } from "./filters.js";
import { RootMotionTracker } from "./root-motion.js";
import { computeDimensions } from "./playback.js";

export async function exportVideoToSequence({
  file,
  onProgress = () => {},
  onStatus = () => {},
  onError = (err) => console.error(err),
  mode = "full-body",
  smoothing = { minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 },
  timing = null, // [可选] timing/v1 对象(由 tools/detect_beats.py 产出),写入 meta.timing
  chart = null,  // [可选] chart/v1 对象(含 audio),写入顶层 chart
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

  await new Promise((resolve, reject) => {
    let ended = false;
    let inFlight = 0;

    video.onended = () => {
      ended = true;
      maybeResolve();
    };
    video.onerror = () => reject(new Error("视频播放失败"));

    function maybeResolve() {
      if (ended && inFlight === 0) resolve();
    }

    function onFrame(now, metadata) {
      video.requestVideoFrameCallback(onFrame);
      inFlight++;
      (async () => {
        try {
          const bitmap = await createImageBitmap(video);
          const { world, img, hands } = engine.detect(bitmap, metadata.mediaTime * 1000);
          bitmap.close();

          if (world) {
            const tSec = metadata.mediaTime;
            const rawJoints = landmarksToJoints(world);
            const vis = visibilitiesFromLandmarks(img);
            const smoothed = smoother.smooth(rawJoints, vis, tSec);
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
              conf,
              rootVel: root.rootVel,   // 根运动:髋中点速度(米/秒)
              grounded: root.grounded, // 根运动:是否贴地
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

            onProgress(Math.min(tSec / duration, 1));
          }
        } catch (err) {
          // 偶发取帧失败,跳过
        } finally {
          inFlight--;
          maybeResolve();
        }
      })();
    }

    video.requestVideoFrameCallback(onFrame);
    video.play().catch(reject);
  });

  // ---- 4. 组装 §4 dance-sequence JSON ----
  const dimensions = {};
  if (dimsCount > 0) {
    for (const k in dimsSum) dimensions[k] = +(dimsSum[k] / dimsCount).toFixed(3);
  }

  const sequence = {
    schema: "dance-sequence/v1",
    danceId: file.name.replace(/\.[^.]+$/, ""),
    meta: {
      fps: frames.length > 1 ? Math.round((frames.length - 1) / duration) : 30,
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
