/**
 * debug-start-countdown.mjs — 点「开始挑战」之后参考视频没起来,查是哪一步停的。
 *
 * 关注点:startChallenge 的异步链很长(序列 → 会话 → 准备视频 → 摄像头 → 倒计时 → play),
 * 任何一步 return 都会静默停住。这里把 console/网络/错误和 ref-video 的日志一起收下来。
 */
import { chromium } from "@playwright/test";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 220)}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => logs.push(`[reqfail] ${decodeURIComponent(r.url()).slice(0, 160)} ${r.failure()?.errorText}`));
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
  }, null, { timeout: 60000 });
  await page.waitForTimeout(3000);

  await page.click("#song-pick-open");
  await page.click("#song-pick-start");

  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => {
      const v = document.getElementById("ref-video");
      const cm = document.getElementById("center-msg");
      return {
        paused: v?.paused, t: +(v?.currentTime ?? 0).toFixed(2), rs: v?.readyState,
        src: decodeURIComponent(v?.getAttribute("src") || "").split("/").pop(),
        status: document.getElementById("status")?.textContent?.trim().slice(0, 60),
        centerMsg: cm && !cm.classList.contains("hidden") ? document.getElementById("center-msg-text")?.textContent : null,
        pickerHidden: document.getElementById("song-pick")?.classList.contains("hidden"),
        videoLog: (globalThis.__danceVideo?.log?.() || []).slice(-4).map((e) => `${e.at ?? ""}${e.text}`.slice(0, 80)),
      };
    });
    console.log(JSON.stringify({ sec: i + 1, ...st }));
  }
  console.log("---- console ----");
  for (const l of logs.slice(-40)) console.log(l);
} finally {
  await browser.close();
}
