// Inference always stays in a worker, including CPU fallback.
const RUNTIME = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
export async function createPoseEngine(modelPath = "models/pose_landmarker_full.task",
  { withHands = false, handModelPath = "models/hand_landmarker.task" } = {}) {
  const worker = new Worker(new URL("./pose-worker.js", import.meta.url));
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
  } catch (e) { close(e); throw e; }
}
