/**
 * debug-video-layout.mjs — 看视频模式右侧画面的真实几何:元素盒、视频固有比例、内容实际落在哪。
 *
 * 现场反馈「9:16 视频太贴边、中间好多空白」—— 需要区分是
 *   (a) 元素盒太窄(内容被 contain 居中,左右留黑),还是
 *   (b) 元素盒够宽但贴右(object-position:right),左侧留黑。
 * 两者的修法完全不同,所以先把数字量出来,并顺便截图存档。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const dance = process.argv[2] || "dance7-video";
const shotDir = "tmp/layout";
mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  for (const vp of [{ width: 1600, height: 900 }, { width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    const page = await browser.newPage({ viewport: vp });
    await page.addInitScript(() => {
      localStorage.setItem("dance-side-mode", "video");
      sessionStorage.setItem("dance-record-highlight", "0");
      const c = document.createElement("canvas"); c.width = 640; c.height = 480;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => c.captureStream(5) });
    });
    await page.goto(`${BASE}/web_dance/dance.html?mode=challenge&autoload=1&dance=${encodeURIComponent(dance)}`, { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("song-pick") && !document.getElementById("song-pick").classList.contains("hidden"), null, { timeout: 90000 }).catch(() => {});
    // 点目标卡,让参考视频切到它并拿到固有比例
    await page.evaluate(() => {
      const cards = [...document.querySelectorAll("#song-pick-strip .song-card")];
      const t = cards.find((c) => /舞蹈7|舞蹈2|闪身步/.test(c.textContent || ""));
      (t || cards[0])?.click();
    }).catch(() => {});
    await page.waitForTimeout(4000);

    const geo = await page.evaluate(() => {
      const el = document.getElementById("ref-video");
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // content(视频画面)在元素内的实际位置:contain + object-position 决定
      const vw = el.videoWidth || 0, vh = el.videoHeight || 0;
      const scale = vw && vh ? Math.min(r.width / vw, r.height / vh) : 0;
      const cw = vw * scale, ch = vh * scale;
      const pos = cs.objectPosition.split(" ").map((s) => s.trim());
      const alignX = pos[0] || "50%", alignY = pos[1] || "50%";
      const fracX = alignX.endsWith("%") ? parseFloat(alignX) / 100 : (alignX === "left" ? 0 : alignX === "right" ? 1 : 0.5);
      const contentLeft = r.left + (r.width - cw) * fracX;
      return {
        viewport: { w: innerWidth, h: innerHeight },
        el: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) },
        css: { width: cs.width, height: cs.height, objectFit: cs.objectFit, objectPosition: cs.objectPosition, ratioVar: cs.getPropertyValue("--ref-ratio") },
        intrinsic: { vw, vh },
        content: { left: +contentLeft.toFixed(1), width: +cw.toFixed(1), height: +ch.toFixed(1) },
        letterbox: { leftBlack: +(contentLeft - r.left).toFixed(1), rightBlack: +((r.left + r.width) - (contentLeft + cw)).toFixed(1) },
        videoPctOfViewport: +((cw / innerWidth) * 100).toFixed(1),
        // 视频画面左缘离屏幕左边的距离(vw),以及左侧 UI 的占用情况
        contentLeftVw: +((contentLeft / innerWidth) * 100).toFixed(1),
      };
    });
    console.log(JSON.stringify(geo, null, 1));
    await page.screenshot({ path: `${shotDir}/video-${vp.width}x${vp.height}.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
