/* Classic worker: the MediaPipe WASM loader uses importScripts. */
let pose, hand;
let lastTsMs = -Infinity;
self.onmessage = async ({ data }) => {
  const { id, type, bitmap } = data;
  try {
    if (type === "init") {
      importScripts(`${data.runtime}/vision_bundle.js`);
      const api = self.vision;
      const files = await api.FilesetResolver.forVisionTasks(`${data.runtime}/wasm`);
      let delegate = "GPU";
      const options = { baseOptions: { modelAssetPath: data.model, delegate },
        runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: .5,
        minPosePresenceConfidence: .5, minTrackingConfidence: .5 };
      try { pose = await api.PoseLandmarker.createFromOptions(files, options); }
      catch { delegate = "CPU"; options.baseOptions.delegate = delegate;
        pose = await api.PoseLandmarker.createFromOptions(files, options); }
      if (data.withHands) hand = await api.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: data.handModel, delegate }, runningMode: "VIDEO",
        numHands: 2, minHandDetectionConfidence: .3, minHandPresenceConfidence: .3,
        minTrackingConfidence: .5 });
      self.postMessage({ id, delegate });
    } else if (type === "detect") {
      if (!Number.isFinite(data.tsMs) || data.tsMs <= lastTsMs) {
        throw new Error("MediaPipe VIDEO timestamp must increase");
      }
      lastTsMs = data.tsMs;
      const start = performance.now();
      const result = pose.detectForVideo(bitmap, data.tsMs);
      const hands = hand?.detectForVideo(bitmap, data.tsMs) ?? null;
      self.postMessage({ id, world: result.worldLandmarks?.[0] ?? null,
        img: result.landmarks?.[0] ?? null, hands, inferenceMs: performance.now() - start });
    }
  } catch (error) { self.postMessage({ id, error: error.message || String(error) }); }
  finally { bitmap?.close(); }
};
