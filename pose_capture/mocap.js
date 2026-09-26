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
        const vis = visibilitiesFromLandmarks(img);
        const smoothed = smoother.smooth(rawJoints, vis, tSec);
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
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream;
      try { await video.play(); } catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; }
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
