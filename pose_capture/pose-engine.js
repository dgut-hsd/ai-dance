// Inference always stays in a worker, including CPU fallback.
// Self-hosted Tasks Vision runtime. Keeping this local avoids CDN/CORS failures
// during a kiosk/demo session and makes Worker startup deterministic.
const RUNTIME = new URL("./runtime", import.meta.url).href.replace(/\/$/, "");
async function createMainThreadFallback(modelPath, { withHands = false, handModelPath = "models/hand_landmarker.task" } = {}) {
  const api = await import(`${RUNTIME}/vision_bundle.mjs`);
  const files = await api.FilesetResolver.forVisionTasks(`${RUNTIME}/wasm`);
  const opts = { baseOptions: { modelAssetPath: new URL(modelPath, import.meta.url).href, delegate: "GPU" }, runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5, minTrackingConfidence: .5 };
  let delegate = "GPU", pose;
  try { pose = await api.PoseLandmarker.createFromOptions(files, opts); }
  catch { delegate = "CPU"; opts.baseOptions.delegate = "CPU"; pose = await api.PoseLandmarker.createFromOptions(files, opts); }
  const hand = withHands ? await api.HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: new URL(handModelPath, import.meta.url).href, delegate }, runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: .3, minHandPresenceConfidence: .3, minTrackingConfidence: .5 }) : null;
  return { delegate: `${delegate} · Main-thread fallback`, detect(bitmap, tsMs) { try { const r = pose.detectForVideo(bitmap, tsMs); return { world: r.worldLandmarks?.[0] ?? null, img: r.landmarks?.[0] ?? null, hands: hand?.detectForVideo(bitmap, tsMs) ?? null, inferenceMs: 0 }; } finally { bitmap.close(); } }, close() { pose.close?.(); hand?.close?.(); } };
}
export async function createPoseEngine(modelPath = "models/pose_landmarker_full.task",
  { withHands = false, handModelPath = "models/hand_landmarker.task" } = {}) {
  // Query suffix prevents a previously cached classic-worker artifact from being reused.
  const worker = new Worker(new URL("./pose-worker.js?module=1", import.meta.url), { type: "module" });
  const pending = new Map();
  let serial = 0, closed = false, busy = false;
  function close(reason = new Error("姿态推理已停止")) {
    closed = true; worker.terminate();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    pending.clear();
  }
  worker.onerror = (e) => close(new Error(e.message || "姿态 Worker 加载失败"));
  worker.onmessageerror = () => close(new Error("姿态 Worker 数据传输失败"));
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id); clearTimeout(p.timer);
    if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
  };
  function request(data, transfer = [], timeout = 30000) {
    if (closed) return Promise.reject(new Error("姿态推理已停止"));
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => close(new Error("姿态 Worker 超时，请重试")), timeout);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ ...data, id }, transfer); }
      catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  try {
    const { delegate } = await request({ type: "init", runtime: RUNTIME,
      model: new URL(modelPath, import.meta.url).href, withHands,
      handModel: new URL(handModelPath, import.meta.url).href }, [], 90000);
    return { delegate: `${delegate} · Worker`,
      async detect(bitmap, tsMs) {
        // Ownership of a transferred ImageBitmap moves to the worker. The
        // worker closes it in its finally block; never close it on this side.
        if (busy || closed) throw new Error("姿态推理忙碌或已停止");
        busy = true;
        try { return await request({ type: "detect", bitmap, tsMs }, [bitmap]); }
        finally { busy = false; }
      }, close };
  } catch (e) {
    close(e);
    try { return await createMainThreadFallback(modelPath, { withHands, handModelPath }); }
    catch (fallbackError) { throw new Error(`姿态推理不可用：Worker=${e.message || e}；主线程兜底=${fallbackError.message || fallbackError}`); }
  }
}
