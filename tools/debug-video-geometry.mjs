/**
 * debug-video-geometry.mjs — 把 #ref-video 及其祖先/兄弟的真实几何与生效样式全量打出来。
 *
 * 起因:debug-video-layout.mjs 量到元素盒 607x1080(9:16 的 62vw 上限),但截图里
 * 视频画面明显更宽、而且被右侧屏幕边缘裁掉 —— 说明有别的因素在缩放/位移它
 * (祖先 transform、CSS 变量在别处重定义、或者渲染的是另一个元素)。量清楚再改。
 */
import { chromium } from "@playwright/test";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const dance = process.argv[2] || "dance7-video";

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem("dance-side-mode", "video");
    sessionStorage.setItem("dance-record-highlight", "0");
    const c = document.createElement("canvas"); c.width = 640; c.height = 480;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => c.captureStream(5) });
  });
  await page.goto(`${BASE}/web_dance/dance.html?mode=challenge&autoload=1&dance=${encodeURIComponent(dance)}`, { waitUntil: "load" });
  await page.waitForTimeout(8000);

  const info = await page.evaluate(() => {
    const el = document.getElementById("ref-video");
    const rect = (n) => { const r = n.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
    const chain = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      chain.push({
        tag: n.tagName + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + n.className.split(" ").join(".") : ""),
        rect: rect(n), transform: cs.transform, position: cs.position, overflow: cs.overflow,
        display: cs.display, width: cs.width, height: cs.height, opacity: cs.opacity,
      });
    }
    const cs = getComputedStyle(el);
    // 所有与视频有关的 CSS 变量(可能有别处重定义了 --ref-ratio)
    const vars = {};
    for (const k of ["--ref-ratio"]) { vars[k] = cs.getPropertyValue(k); vars[`${k} @root`] = getComputedStyle(document.documentElement).getPropertyValue(k); }
    return {
      videoAttrs: { src: decodeURIComponent(el.getAttribute("src") || ""), vw: el.videoWidth, vh: el.videoHeight, readyState: el.readyState, paused: el.paused, currentTime: +el.currentTime.toFixed(2) },
      videoComputed: {
        width: cs.width, height: cs.height, maxWidth: cs.maxWidth, maxHeight: cs.maxHeight,
        objectFit: cs.objectFit, objectPosition: cs.objectPosition, position: cs.position,
        left: cs.left, right: cs.right, top: cs.top, transform: cs.transform, scale: cs.scale, zoom: cs.zoom,
        zIndex: cs.zIndex, background: cs.backgroundColor,
      },
      videoRect: rect(el),
      vars,
      ancestors: chain,
      // 页面上还有没有别的 <video>
      videos: [...document.querySelectorAll("video")].map((v) => ({ id: v.id, cls: v.className, rect: rect(v), vw: v.videoWidth, vh: v.videoHeight })),
      sheets: [...document.styleSheets].map((s) => s.href || "(inline)"),
    };
  });
  console.log(JSON.stringify(info, null, 1));
} finally {
  await browser.close();
}
