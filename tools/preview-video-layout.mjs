/**
 * preview-video-layout.mjs — 在真页面上试几组「参考视频」的摆放参数,截图 + 量尺寸。
 *
 * 现场反馈:「9:16 的视频太贴边、中间好多空白,把视频往左移一些」。
 * 视频原本是 `right: 0`(贴屏幕最右),9:16 满高时只占约 32vw,左边空掉一大片。
 *
 * 两种改法都想看看:
 *   contain(不裁剪) —— 只改横向位置,画面完整(头脚都在),但视频本体仍然只有 ~32vw;
 *   cover(放大+裁切) —— 把视频放大到 ~45vw,纵向裁掉一部分,人物更大但可能丢掉头/脚。
 *
 * 这个脚本只**注入覆盖样式**试参数,不改任何文件 —— 选好了再写进 style.css。
 *
 * 用法:
 *   node tools/preview-video-layout.mjs --dance dance7-video --w 1600 --h 900
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const danceLabel = arg("label", "舞蹈7");
const W = Number(arg("w", 1600));
const H = Number(arg("h", 900));
const outDir = "tmp/layout";
mkdirSync(outDir, { recursive: true });

/** contain 方案:只挪位置,画面不裁 */
const containCss = (shift) => `
  #ref-video {
    right: auto;
    left: calc((100vw - min(56vw, 100vh * var(--ref-ratio))) / 2 + (${shift}));
    width: min(56vw, 100vh * var(--ref-ratio));
    object-position: center center;
  }
`;

/** cover 方案:按给定比例把元素放宽(纵向因此被裁),再挪位置 */
const coverCss = ({ widthVw, ratio, focusY, shift }) => `
  #ref-video {
    right: auto;
    left: calc((100vw - min(${widthVw}vw, 100vh * ${ratio})) / 2 + (${shift}));
    width: min(${widthVw}vw, 100vh * ${ratio});
    object-fit: cover;
    object-position: center ${focusY}%;
  }
`;

const variants = [
  { name: "base-旧样", css: null },
  { name: "contain-居中", css: containCss("0vw") },
  { name: "contain-左移6vw", css: containCss("-6vw") },
  { name: "cover-40vw-焦点42", css: coverCss({ widthVw: 40, ratio: "var(--ref-ratio)", focusY: 42, shift: "-4vw" }) },
  { name: "cover-46vw-焦点42", css: coverCss({ widthVw: 46, ratio: "var(--ref-ratio)", focusY: 42, shift: "-6vw" }) },
];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  for (const v of variants) {
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
    await page.evaluate((label) => {
      const cards = [...document.querySelectorAll("#song-pick-strip .song-card")];
      (cards.find((c) => (c.textContent || "").includes(label)) || cards[0])?.click();
    }, danceLabel).catch(() => {});
    await page.waitForTimeout(3500);
    if (v.css) await page.addStyleTag({ content: v.css });
    await page.waitForTimeout(700);

    const geo = await page.evaluate(() => {
      const el = document.getElementById("ref-video");
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const vw = el.videoWidth, vh = el.videoHeight;
      // contain:画面完整;cover:按宽度铺满、纵向裁切
      const scale = cs.objectFit === "cover" ? r.width / vw : Math.min(r.width / vw, r.height / vh);
      const cw = vw * scale, ch = vh * scale;
      return {
        src: decodeURIComponent(el.getAttribute("src") || "").split("/").pop(),
        fit: cs.objectFit,
        intrinsic: `${vw}x${vh}`,
        el: { x: +r.x.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0) },
        shown: { w: +cw.toFixed(0), h: +ch.toFixed(0), croppedV: +Math.max(0, ch - r.height).toFixed(0) },
        gapLeft: +r.x.toFixed(0),
        gapRight: +(innerWidth - (r.x + r.width)).toFixed(0),
        videoPct: +((cw / innerWidth) * 100).toFixed(1),
      };
    });
    await page.screenshot({ path: `${outDir}/v-${v.name}.png` });
    console.log(JSON.stringify({ variant: v.name, ...geo }));
    await page.close();
  }
} finally {
  await browser.close();
}
