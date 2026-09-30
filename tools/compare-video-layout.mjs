/**
 * compare-video-layout.mjs — 把参考视频的几种摆放方案跑成一组对比图,便于直接选。
 *
 * 方案(都基于 9:16 竖屏视频):
 *   A 现状      :右贴边、contain、满高(~32vw)
 *   B 居中      :position 居中、contain、满高(画面完整,左右各留黑)
 *   C 左移      :在 B 基础上再左移若干 vw
 *   D 放大+裁切 :宽度按 vw 定死、cover,纵向裁掉一部分(人物更大)
 *
 * 输出:tmp/layout/compare-<w>x<h>-<方案>.png 与一行 JSON(几何数据)。
 * 用法: node tools/compare-video-layout.mjs [--w 1366] [--h 768] [--label 舞蹈7]
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const W = Number(arg("w", 1366));
const H = Number(arg("h", 768));
const label = arg("label", "舞蹈7");
const outDir = "tmp/layout";
mkdirSync(outDir, { recursive: true });

const PLANS = [
  { id: "A", name: "现状-贴右", css: null },
  {
    id: "B", name: "居中-不裁剪",
    css: `#ref-video{right:auto;left:calc((100vw - min(56vw, 100vh * var(--ref-ratio))) / 2);width:min(56vw, 100vh * var(--ref-ratio));object-position:center center;}`,
  },
  {
    id: "C", name: "左移6vw-不裁剪",
    css: `#ref-video{right:auto;left:calc((100vw - min(56vw, 100vh * var(--ref-ratio))) / 2 - 6vw);width:min(56vw, 100vh * var(--ref-ratio));object-position:center center;}`,
  },
  {
    id: "D", name: "放大-裁切-焦点42",
    css: `#ref-video{right:auto;left:calc((100vw - min(40vw, 100vh * var(--ref-ratio) * 1.4)) / 2 - 6vw);width:min(40vw, 100vh * var(--ref-ratio) * 1.4);object-fit:cover;object-position:center 42%;}`,
  },
  {
    id: "E", name: "放大-裁切-焦点30",
    css: `#ref-video{right:auto;left:calc((100vw - min(40vw, 100vh * var(--ref-ratio) * 1.4)) / 2 - 6vw);width:min(40vw, 100vh * var(--ref-ratio) * 1.4);object-fit:cover;object-position:center 30%;}`,
  },
];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  for (const plan of PLANS) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.addInitScript(() => {
      localStorage.setItem("dance-side-mode", "video");
      sessionStorage.setItem("dance-record-highlight", "0");
      const c = document.createElement("canvas"); c.width = 640; c.height = 480;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => c.captureStream(5) });
    });
    await page.goto(`${BASE}/web_dance/dance.html?mode=challenge&autoload=1`, { waitUntil: "load" });
    await page.waitForFunction(() => {
      const cur = document.getElementById("song-pick-current");
      return cur && cur.textContent.trim() && cur.textContent.trim() !== "—";
    }, null, { timeout: 90000 }).catch(() => {});
    await page.evaluate((lb) => {
      const cards = [...document.querySelectorAll("#song-pick-strip .song-card")];
      (cards.find((c) => (c.textContent || "").includes(lb)) || cards[0])?.click();
    }, label).catch(() => {});
    await page.waitForTimeout(3500);
    if (plan.css) await page.addStyleTag({ content: plan.css });
    await page.waitForTimeout(700);

    const geo = await page.evaluate(() => {
      const el = document.getElementById("ref-video");
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const vw = el.videoWidth, vh = el.videoHeight;
      const scale = cs.objectFit === "cover" ? r.width / vw : Math.min(r.width / vw, r.height / vh);
      const cw = vw * scale, ch = vh * scale;
      return {
        src: decodeURIComponent(el.getAttribute("src") || "").split("/").pop(),
        fit: cs.objectFit,
        box: `${Math.round(r.width)}x${Math.round(r.height)}@x${Math.round(r.x)}`,
        shownW: Math.round(cw),
        croppedV: Math.max(0, Math.round(ch - r.height)),
        pctOfViewport: +((cw / innerWidth) * 100).toFixed(1),
        gapLeft: Math.round(r.x),
        gapRight: Math.round(innerWidth - r.x - r.width),
      };
    });
    await page.screenshot({ path: `${outDir}/compare-${W}x${H}-${plan.id}.png` });
    console.log(JSON.stringify({ plan: `${plan.id} ${plan.name}`, ...geo }));
    await page.close();
  }
} finally {
  await browser.close();
}
