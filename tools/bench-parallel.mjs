/**
 * bench-parallel.mjs — 量一下「一个浏览器里开 N 个页面并行动捕」的加速比。
 * 这台机器是纯 CPU(Chrome 无头 + SwiftShader 软件 WebGL),单页 ~0.5s/帧太慢,
 * 6400+ 帧要跑一小时。先测 1 / 2 / 3 / 4 个并发的每帧耗时,再决定用几路。
 *
 * 用法: node tools/bench-parallel.mjs [--frames 40] [--url /videos/舞蹈1.mp4]
 */
import { launchChrome, harnessHtml, DEFAULT_BASE } from "./video-import-core.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const url = arg("url", "/videos/舞蹈1.mp4");
const frames = Number(arg("frames", 40));
const body = harnessHtml();

const browser = await launchChrome();
try {
  for (const n of [1, 2, 3, 4]) {
    const pages = [];
    for (let i = 0; i < n; i++) {
      const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
      await page.route("**/video-import-harness", (r) =>
        r.fulfill({ contentType: "text/html; charset=utf-8", body }));
      await page.goto(`${DEFAULT_BASE}/video-import-harness`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
      pages.push(page);
    }
    const t0 = Date.now();
    const out = await Promise.all(pages.map((p) => p.evaluate(
      (o) => window.__render(o), { url, fps: 30, mode: "full-body", maxFrames: frames },
    )));
    const ms = Date.now() - t0;
    console.log(JSON.stringify({
      pages: n, wallMs: ms, wallPerFrame: +(ms / frames).toFixed(0),
      perPageMsPerFrame: +(out[0]._stats.detectMs / out[0]._stats.sampled).toFixed(0),
      detected: out.map((o) => o._stats.detected),
      detectMs: out.map((o) => o._stats.detectMs),
      seekMs: out.map((o) => o._stats.seekMs),
    }));
    for (const p of pages) await p.close();
  }
} finally {
  await browser.close();
}
