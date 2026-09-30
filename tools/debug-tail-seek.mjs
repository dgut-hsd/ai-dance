/**
 * debug-tail-seek.mjs — 为什么动捕序列在视频末尾前几秒就断了?
 *
 * 现象:舞蹈2/3(57.86fps VFR 源)的序列最后一帧在 37.7s / 21.9s,而视频时长 40.7s / 25.0s,
 * 差的不是零头 —— 用「就近绑定」铺谱面时,末尾几个判定点会指到 2 秒以外的帧。
 *
 * 这个脚本逐点 seek 到视频末尾,把「请求时刻 / 实际位置 / 是否推进」打出来,定位卡在哪一步。
 *
 * 用法: node tools/debug-tail-seek.mjs [--url /videos/舞蹈2.mp4] [--fps 15] [--from 34]
 */
import { openHarness, DEFAULT_BASE } from "./video-import-core.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const url = arg("url", "/videos/舞蹈2.mp4");
const fps = Number(arg("fps", 15));
const from = Number(arg("from", 34));

const harness = await openHarness({ onLog: (m) => process.stderr.write(m + "\n") });
try {
  const out = await harness.page.evaluate(async ({ url, fps, from }) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto";
    video.src = url;
    video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px";
    document.body.appendChild(video);
    await new Promise((res, rej) => {
      video.addEventListener("loadedmetadata", res, { once: true });
      video.addEventListener("error", () => rej(new Error("加载失败")), { once: true });
    });
    const duration = video.duration;

    function seekTo(t, timeoutMs = 20000) {
      const target = Math.max(0, Math.min(t, Math.max(0, (video.duration || 0) - 0.001)));
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return; done = true;
          clearTimeout(timer);
          video.removeEventListener("seeked", onSeeked);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(video.currentTime)));
        };
        const onSeeked = () => finish();
        const timer = setTimeout(() => finish(), timeoutMs);
        video.addEventListener("seeked", onSeeked);
        video.currentTime = target;
      });
    }

    const rows = [];
    let last = -1;
    for (let i = Math.floor(from * fps); i / fps <= duration; i++) {
      const want = i / fps;
      const t0 = performance.now();
      const actual = await seekTo(want);
      const ms = Math.round(performance.now() - t0);
      rows.push({ i, want: +want.toFixed(3), actual: +actual.toFixed(3), delta: +(actual - want).toFixed(3), advanced: actual > last + 1e-6, ms });
      last = actual;
      // 连续两次开不动就停(再往后都是同一个值,没必要刷屏)
      const tail = rows.slice(-3);
      if (tail.length === 3 && tail.every((r) => !r.advanced)) break;
    }
    return { duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight, rows };
  }, { url, fps, from });

  console.log(JSON.stringify({ url, duration: out.duration, size: `${out.videoWidth}x${out.videoHeight}` }));
  for (const r of out.rows) console.log(JSON.stringify(r));
} finally {
  await harness.close();
}
