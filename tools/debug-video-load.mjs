/**
 * debug-video-load.mjs — 单独在一个 Chromium 页面里加载参考视频,把真实的 error code 打出来。
 * 自检脚本只报了「error」,得知道是解码失败、404 还是被策略拦。
 */
import { chromium } from "@playwright/test";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = names.length ? names : ["舞蹈7.mp4", "舞蹈1.mp4"];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  page.on("response", (r) => { if (/\.mp4/.test(r.url())) console.log("  [http]", r.status(), decodeURIComponent(r.url())); });
  page.on("requestfailed", (r) => console.log("  [failed]", decodeURIComponent(r.url()), r.failure()?.errorText));
  for (const n of list) {
    const url = `${BASE}/videos/${encodeURIComponent(n)}`;
    const out = await page.evaluate(async (u) => {
      const el = document.createElement("video");
      el.muted = true;
      el.preload = "auto";
      el.src = u;
      document.body.appendChild(el);
      const res = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ why: "timeout" }), 20000);
        el.addEventListener("loadedmetadata", () => { clearTimeout(t); resolve({ why: "ok" }); }, { once: true });
        el.addEventListener("error", () => { clearTimeout(t); resolve({ why: "error" }); }, { once: true });
      });
      return {
        ...res, duration: el.duration, readyState: el.readyState, w: el.videoWidth, h: el.videoHeight,
        mediaError: el.error ? { code: el.error.code, message: el.error.message, MEDIA_ERR: ["", "ABORTED", "NETWORK", "DECODE", "SRC_NOT_SUPPORTED"][el.error.code] } : null,
        networkState: el.networkState, currentSrc: decodeURIComponent(el.currentSrc || ""),
      };
    }, url);
    console.log(JSON.stringify({ name: n, url: decodeURIComponent(url), ...out }, null, 1));
  }
} finally {
  await browser.close();
}
