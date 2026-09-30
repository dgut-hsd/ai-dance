/**
 * debug-select-ui.mjs — 打开游戏页(视频模式)看选曲 UI 到底列出了哪些舞曲、选中了哪一支。
 * 自检报「游戏页没切到该视频源」时用它定位:是歌单里没有,还是列表过滤掉了,还是选中态没跟过去。
 */
import { chromium } from "@playwright/test";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const dance = process.argv[2] || "dance7-video";

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.text().slice(0, 200)); });
  await page.addInitScript(() => {
    localStorage.setItem("dance-side-mode", "video");
    sessionStorage.setItem("dance-record-highlight", "0");
    const c = document.createElement("canvas"); c.width = 640; c.height = 480;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => c.captureStream(5) });
  });
  await page.goto(`${BASE}/web_dance/dance.html?mode=challenge&dance=${encodeURIComponent(dance)}&autoload=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__danceVideo, null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(12000);

  const info = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const opts = [...document.querySelectorAll("#dance-select option")].map((o) => ({ value: o.value, text: o.textContent.trim() }));
    const cards = [...document.querySelectorAll("#song-pick-cards *")].slice(0, 40).map((n) => `${n.tagName}.${n.className}`);
    return {
      search: location.search,
      danceSelectValue: q("#dance-select")?.value ?? null,
      danceOptions: opts,
      songSelectValue: q("#song-select")?.value ?? null,
      pickCurrent: q("#song-pick-current")?.textContent?.trim() ?? null,
      pickTitle: q("#song-pick-title")?.textContent?.trim() ?? null,
      pickHidden: q("#song-pick")?.classList.contains("hidden") ?? null,
      pickHtmlHead: (q("#song-pick")?.innerHTML || "").slice(0, 400),
      cardNodes: cards.length,
      cardSample: cards.slice(0, 12),
      refVideoSrc: decodeURIComponent(q("#ref-video")?.getAttribute("src") || ""),
      status: q("#status")?.textContent?.trim() ?? null,
      bodyClass: document.body.className,
      videoMap: window.__danceDebug?.state?.videoMap ?? null,
    };
  });
  console.log(JSON.stringify(info, null, 1));

  // 直接把选中项点一下,看 UI 会不会切过去
  const clicked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("[data-dance-id], .song-card, .pick-card")];
    const target = cards.find((c) => (c.dataset.danceId || c.getAttribute("data-id") || "").includes("dance7"));
    if (!target) return { found: false, sample: cards.slice(0, 6).map((c) => c.dataset.danceId || c.className) };
    target.click();
    return { found: true, tag: target.tagName, cls: target.className };
  });
  console.log("click:", JSON.stringify(clicked));
  await page.waitForTimeout(3000);
  console.log("after click src:", await page.evaluate(() => decodeURIComponent(document.getElementById("ref-video")?.getAttribute("src") || "")));
} finally {
  await browser.close();
}
