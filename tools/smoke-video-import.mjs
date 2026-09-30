/**
 * smoke-video-import.mjs — 冒烟验证:无头 Chrome 里 MediaPipe 能不能真的逐帧识别视频。
 * 只跑前 N 帧(`--frames`,默认 60 帧 = 2 秒),打印耗时与序列摘要,不写任何文件。
 *
 * 用法: node tools/smoke-video-import.mjs [--url /videos/舞蹈1.mp4] [--frames 60]
 */
import { openHarness, DEFAULT_BASE } from "./video-import-core.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const url = arg("url", "/videos/舞蹈1.mp4");
const maxFrames = Number(arg("frames", 60));

const t0 = Date.now();
const harness = await openHarness({ onLog: (m) => process.stderr.write(m + "\n") });
console.log("harness ready in", Date.now() - t0, "ms; base =", DEFAULT_BASE);

try {
  const tt = Date.now();
  const seq = await harness.page.evaluate(
    (o) => window.__render({ ...o, onProgress: undefined }),
    { url, fps: 30, mode: "full-body", maxFrames },
  );
  const ms = Date.now() - tt;
  console.log(JSON.stringify({
    elapsedMs: ms,
    msPerFrame: +(ms / (seq._stats?.sampled || 1)).toFixed(1),
    schema: seq.schema,
    meta: seq.meta,
    stats: seq._stats,
    bones: seq.bones.length,
    sampleFrame: seq.frames[0] && { t: seq.frames[0].t, rootYaw: seq.frames[0].rootYaw, bones: Object.keys(seq.frames[0].bones || {}) },
  }, null, 2));
} finally {
  await harness.close();
}
