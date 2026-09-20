/**
 * pose-engine.js — MediaPipe PoseLandmarker(+ 可选 HandLandmarker)的加载与推理。
 *
 * 实时端、离线导出、视频预览共用同一份,保证模型参数/delegate/阈值完全一致。
 * withHands = true 时额外加载手部模型,用于手势舞。
 */

const TASKS_VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

// 模型路径统一相对「本模块」解析,保证无论页面放在哪个目录,
// 都能定位到与本模块同级的 models/(便于 pose_capture 之外的其他页面复用)。
function resolveModelAsset(p) {
  try {
    return new URL(p, import.meta.url).href;
  } catch {
    return p; // 已是绝对 URL 或非浏览器环境
  }
}

export async function createPoseEngine(
  modelPath = "models/pose_landmarker_full.task",
  { withHands = false, handModelPath = "models/hand_landmarker.task" } = {}
) {
  const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import(
    `${TASKS_VISION}/vision_bundle.mjs`
  );
  const vision = await FilesetResolver.forVisionTasks(`${TASKS_VISION}/wasm`);

  const options = {
    baseOptions: { modelAssetPath: resolveModelAsset(modelPath), delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };

  let landmarker;
  let delegate = "GPU";
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, options);
  } catch (gpuErr) {
    console.warn("GPU delegate 不可用,退回 CPU:", gpuErr);
    options.baseOptions.delegate = "CPU";
    delegate = "CPU";
    landmarker = await PoseLandmarker.createFromOptions(vision, options);
  }

  let handLandmarker = null;
  if (withHands) {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: resolveModelAsset(handModelPath), delegate },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.3, // 手动作快易模糊,放宽阈值减少丢帧
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.5,
    });
  }

  return {
    delegate,

    // 返回 { world, img, hands }
    //   world: 33 个 pose 世界 landmark 或 null
    //   img:   33 个 pose 图像 landmark(带 visibility/presence)或 null
    //   hands: HandLandmarker 原始结果(仅 withHands 时非 null)
    detect(bitmap, tsMs) {
      const result = landmarker.detectForVideo(bitmap, tsMs);
      let hands = null;
      if (handLandmarker) {
        hands = handLandmarker.detectForVideo(bitmap, tsMs);
      }
      return {
        world: result.worldLandmarks?.[0] ?? null,
        img: result.landmarks?.[0] ?? null,
        hands,
      };
    },

    close() {
      landmarker.close?.();
      handLandmarker?.close?.();
    },
  };
}
