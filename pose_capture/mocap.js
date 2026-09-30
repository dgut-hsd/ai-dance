/**
 * mocap.js — 实时端主模块。
 *
 * 入口:
 *   - startPoseStream:        摄像头 -> 实时画火柴人 + 契约帧回调
 *   - startVideoPreviewSync:  视频文件 -> 一边放视频一边实时画火柴人
 *
 * 共用 runLivePipeline。mode 决定骨骼表(全身/手势)与是否跑手部模型。
 */

import {
  landmarksToJoints,
  addDerivedJoints,
  constrainLimbDepth,
  visibilitiesFromLandmarks,
  buildFrame,
  handsFromResult,
  resolveMode,
} from "./contract.js";
import { PoseSmoother, HandSmoother } from "./filters.js";
import { RootMotionTracker } from "./root-motion.js";
import { PerfMonitor } from "./perf.js";
import { createPoseEngine } from "./pose-engine.js";
import { renderStickFigure } from "./stick-figure.js";

// 把后台 /settings 页面保存的 USB 相机参数应用到 track 上。
// 先设模式(*Mode),再设数值,保证 exposureTime 等在手动模式下生效。
export async function applyCameraConstraints(track, params) {
  if (!track || !params) return;
  const keys = Object.keys(params).sort((a, b) => {
    const am = a.endsWith("Mode") ? 0 : 1;
    const bm = b.endsWith("Mode") ? 0 : 1;
    return am - bm;
  });
  for (const key of keys) {
    const v = params[key];
    if (v === null || v === undefined || v === "") continue;
    try { await track.applyConstraints({ [key]: v }); } catch { /* 设备不支持,跳过 */ }
  }
}

async function runLivePipeline({
  video,
  canvas,
  onFrame,
  onStatus = () => {},
  onError = (err) => console.error(err),
  onPerf = null,
  modelPath,
  handModelPath,
  smoothing,
  boneDefs,
  withHands,
  onReady = async () => {},
}) {
  const monitor = new PerfMonitor();

  onStatus("loading-model");
  const engine = await createPoseEngine(modelPath, { withHands, handModelPath });
  onStatus("model-ready");
  try { await onReady(); } catch (e) { engine.close(); throw e; }

  const smoother = new PoseSmoother(smoothing);
  const rootTracker = new RootMotionTracker();
  const handSmoother = withHands
    ? new HandSmoother({ minCutoff: 3.0, beta: 1.0, dCutoff: 1.0 }) // 手更快,更跟手
    : null;
  let busy = false;
  let stopped = false;
  let rvfId = null;
  let lastTsMs = -Infinity;

  let perfTimer = null;
  if (onPerf) {
    perfTimer = setInterval(
      () => onPerf({ ...monitor.read(), delegate: engine.delegate }),
      1000
    );
  }

  async function detect(tsMs, capturedAtMs = performance.now()) {
    if (stopped) return;
    if (busy) { monitor.drop(); return; }
    // PoseLandmarker VIDEO mode requires strictly increasing timestamps.
    // This also handles a looping preview whose mediaTime jumps backwards.
    if (!Number.isFinite(tsMs) || tsMs <= lastTsMs) { monitor.drop(); return; }
    lastTsMs = tsMs;
    busy = true;
    const tStart = performance.now();
    try {
      const bitmap = await createImageBitmap(video);
      const tBitmap = performance.now();
      monitor.record("captureToBitmap", tBitmap - capturedAtMs);

      const { world, img, hands, inferenceMs } = await engine.detect(bitmap, tsMs);
      const tInfer = performance.now();
      if (stopped) return;
      monitor.record("inference", inferenceMs);

      if (world) {
        const tSec = tsMs / 1000;
        const rawJoints = landmarksToJoints(world);
        const depthFixed = constrainLimbDepth(rawJoints, img); // S3 深度约束(在平滑前)
        const vis = visibilitiesFromLandmarks(img);
        const smoothed = smoother.smooth(depthFixed, vis, tSec);
        const joints = addDerivedJoints(smoothed);
        const rawHands = withHands ? handsFromResult(hands) : null;
        const handsField = handSmoother
          ? handSmoother.smooth(rawHands, tSec)
          : null;
        const root = rootTracker.update(joints, tSec);
        // MediaPipe world coordinates are hip-relative, not global translation.
        const frame = buildFrame(tSec, joints, vis, boneDefs, handsField, root);
        frame.capturedAtMs = capturedAtMs;

      monitor.record("captureToResult", performance.now() - capturedAtMs);
        onFrame?.(frame);
        if (canvas) renderStickFigure(canvas, joints, boneDefs, handsField);
      }
      const tEnd = performance.now();

      monitor.record("createImageBitmap", tBitmap - tStart);
      monitor.record("detectForVideo", tInfer - tBitmap);
      monitor.record("postprocess", tEnd - tInfer);
      monitor.fpsTick();
    } catch (err) {
      if (!stopped) onError(err);
    } finally {
      busy = false;
    }
  }

  function onVideoFrame(now, metadata) {
    if (stopped) return;
    rvfId = video.requestVideoFrameCallback(onVideoFrame);
    detect(metadata.mediaTime * 1000, metadata.captureTime ?? now);
  }

  if (video.requestVideoFrameCallback) {
    rvfId = video.requestVideoFrameCallback(onVideoFrame);
  } else {
    requestAnimationFrame(function tick() {
      if (stopped) return;
      detect(performance.now());
      requestAnimationFrame(tick);
    });
  }

  return {
    delegate: engine.delegate,
    perf: monitor,
    stop() {
      stopped = true;
      if (rvfId != null && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(rvfId);
      }
      if (perfTimer) clearInterval(perfTimer);
      engine.close();
      if (video) video.pause();
    },
  };
}

// ---------------------------------------------------------------------------
// 入口 1:摄像头
// ---------------------------------------------------------------------------
export async function startPoseStream({
  video,
  canvas,
  onFrame,
  onStatus = () => {},
  onError = (err) => console.error(err),
  onPerf = null,
  mode = "full-body",
  smoothing = { minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 },
  deviceId = null,
  cameraParams = null,
} = {}) {
  if (!video) throw new Error("startPoseStream: 缺少 video 元素");
  if (typeof onFrame !== "function") {
    throw new Error("startPoseStream: 缺少 onFrame 回调");
  }
  const m = resolveMode(mode);

  let stream = null;
  const handle = await runLivePipeline({
    video,
    canvas,
    onFrame,
    onStatus,
    onError,
    onPerf,
    modelPath: m.poseModel,
    handModelPath: m.handModel,
    smoothing,
    boneDefs: m.bones,
    withHands: m.hands,
    onReady: async () => {
      const videoConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      if (deviceId) videoConstraints.deviceId = { exact: deviceId };
      else videoConstraints.facingMode = "user";
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false,
      });
      video.srcObject = stream;
      // 摄像头预览只负责"看得见自己",失败不该把整条启动链打断 ——
      // AbortError("play() request was interrupted by a new load request")在
      // 上一次 srcObject 的 play() 还没落定时再赋一次就会抛,重试一次即可;
      // 仍失败就当作没有预览画面继续(识别用的是 MediaPipe 的帧,不依赖这个元素在播)。
      //
      // 关键:play() 还可能**既不 resolve 也不 reject**(源的尺寸/帧率一直不满足播放条件),
      // 光 await 会把整条启动链吊死 —— 而 state.running 要等这条链返回才置位,
      // 于是「倒计时永远不来、本局开不了、视频停在原地」。所以每次都加超时兜底。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await Promise.race([
            video.play(),
            new Promise((r) => setTimeout(r, 2500)),
          ]);
          break;
        } catch (e) {
          if (attempt === 1) { onStatus("camera-preview-failed"); console.warn("摄像头预览未起播:", e?.name || e); }
          else await new Promise((r) => setTimeout(r, 120));
        }
      }
      if (cameraParams) await applyCameraConstraints(stream.getVideoTracks()[0], cameraParams);
      onStatus("camera-on");
    },
  });

  return {
    ...handle,
    stop() {
      handle.stop();
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

// ---------------------------------------------------------------------------
// 入口 2:视频文件(同步预览)
// ---------------------------------------------------------------------------
export async function startVideoPreviewSync({
  video,
  canvas,
  onFrame,
  onStatus = () => {},
  onError = (err) => console.error(err),
  onPerf = null,
  mode = "full-body",
  smoothing = { minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 },
} = {}) {
  if (!video) throw new Error("startVideoPreviewSync: 缺少 video 元素");
  const m = resolveMode(mode);

  return runLivePipeline({
    video,
    canvas,
    onFrame,
    onStatus,
    onError,
    onPerf,
    modelPath: m.poseModel,
    handModelPath: m.handModel,
    smoothing,
    boneDefs: m.bones,
    withHands: m.hands,
    onReady: async () => {
      await video.play();
      onStatus("video-playing");
    },
  });
}
