/**
 * check-video-layout.mjs — 改动后验收:视频几何 + 与左侧 UI(摄像头小窗/标题/按钮)是否打架。
 *
 * 打印:元素盒/画面尺寸/裁掉多少/两侧空档,以及 #cam-panel、#song-pick-title、#song-pick-open 的
 * 包围盒和与画面的重叠面积。任何"视频跑到小窗底下"这类问题都会直接显示成 overlap>0。
 *
 * 用法: node tools/check-video-layout.mjs [--w 1366] [--h 768] [--label 舞蹈7] [--shot 1]
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const label = arg("label", "舞蹈7");
const shot = arg("shot", "1") === "1";
const sizes = (arg("sizes", "") || "1366x768,1600x900,1920x1080").split(",").map((s) => s.trim());
mkdirSync("tmp/layout", { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  for (const size of sizes) {
    const [W, H] = size.split("x").map(Number);
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

    const geo = await page.evaluate(() => {
      const el = document.getElementById("ref-video");
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const vw = el.videoWidth, vh = el.videoHeight;
      // cover:按宽度铺满(纵向溢出被裁);contain:完整装下
      const scale = Math.min(r.width / vw, r.height / vh);
      const coverScale = Math.max(r.width / vw, r.height / vh);
      const s = getComputedStyle(el).objectFit === "cover" ? coverScale : scale;
      const cw = vw * s, ch = vh * s;
      const box = (n) => { const e = document.querySelector(n); if (!e) return null; const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(0), y: +b.y.toFixed(0), w: +b.width.toFixed(0), h: +b.height.toFixed(0), vis: getComputedStyle(e).visibility }; };
      const overlap = (a, b) => {
        if (!a || !b || a.vis === "hidden" || b.vis === "hidden") return 0;
        const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return Math.round(w * h);
      };
      const content = { x: r.x + (r.width - cw) / 2, y: r.y + (r.height - ch) / 2, w: cw, h: ch, vis: "visible" };
      const cam = box("#cam-panel");
      const title = box("#song-pick-title");
      const open = box("#song-pick-open");
      return {
        fit: cs.objectFit,
        cropVar: cs.getPropertyValue("--ref-crop").trim(),
        shiftVar: cs.getPropertyValue("--ref-shift").trim(),
        box: { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) },
        shown: { w: Math.round(cw), h: Math.round(ch) },
        croppedV: Math.round(Math.max(0, ch - r.height)),
        croppedPct: +((Math.max(0, ch - r.height) / ch) * 100).toFixed(1),
        gapLeftOfBox: Math.round(r.x),
        gapRightOfBox: Math.round(innerWidth - r.x - r.width),
        contentLeftVw: +((content.x / innerWidth) * 100).toFixed(1),
        overlapCamPanel: overlap(content, cam),
        overlapTitle: overlap(content, title),
        overlapOpenBtn: overlap(content, open),
        camPanel: cam,
        title,
        openBtn: open,
      };
    });
    if (shot) await page.screenshot({ path: `tmp/layout/check-${W}x${H}.png` });
    console.log(JSON.stringify({ size, ...geo }));
    await page.close();
  }
} finally {
  await browser.close();
}
