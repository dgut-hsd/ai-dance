/**
 * debug-countdown-real.mjs — 用「点击时视频真的在播」的可控场景验证倒计时停帧。
 *
 * 之前用 pose-worker 桩时启动链卡在摄像头那段(卡住的 promise 后面的倒计时永远不开始),
 * 那是测试环境的限制、不是产品行为。这里换个思路:
 *   1. 等吸引态把视频播起来并确认 paused=false;
 *   2. 点「开始挑战」,在"倒计时应该开始"的时间窗内持续采样。
 * 只要视频从"在播"变成"暂停且 currentTime 冻结",就说明倒计时停帧生效了。
 * 如果摄像头这段起不来,脚本会把卡点如实打出来(不伪装成通过)。
 */
import { chromium } from "@playwright/test";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on("console", (m) => { const t = m.text(); if (/摄像头|ref-video|attract/i.test(t)) console.log(`[${m.type()}]`, t.slice(0, 170)); });
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

  const probe = () => page.evaluate(() => {
    const v = document.getElementById("ref-video");
    const cm = document.getElementById("center-msg");
    return {
      paused: v?.paused, t: +(v?.currentTime ?? 0).toFixed(2),
      cd: cm && !cm.classList.contains("hidden") ? document.getElementById("center-msg-text")?.textContent : null,
      status: document.getElementById("status")?.textContent?.trim().slice(0, 44),
    };
  });

  // 1) 等吸引态把视频播起来
  const playing = await page.waitForFunction(() => document.getElementById("ref-video")?.paused === false, null, { timeout: 45000 })
    .then(() => true).catch(() => false);
  console.log("吸引态在播:", playing, JSON.stringify(await probe()));
  if (!playing) { console.log("吸引态没播起来,后面无法判定"); process.exit(1); }

  // 2) 点开始,采样 4 秒
  await page.click("#song-pick-open");
  await page.click("#song-pick-start");
  const rows = [];
  let sawCountdown = false;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(250);
    const s = await probe();
    if (s.cd) sawCountdown = true;
    rows.push(s);
  }
  const anyPlayingDuring = rows.some((r) => !r.paused);
  const tStart = rows[0].t, tEnd = rows[rows.length - 1].t;
  console.log(JSON.stringify({
    sawCountdown, anyPlayingDuring,
    tAtStart: tStart, tAtEnd: tEnd, advanced: +(tEnd - tStart).toFixed(2),
    trail: rows.filter((_, i) => i % 4 === 0),
  }, null, 1));
  // 结论判定
  if (!sawCountdown) console.log("⚠ 没进入倒计时(启动链在这一环境卡住了),本次无法判定停帧");
  else if (anyPlayingDuring) console.log("✗ 倒计时期间视频仍在播 —— 停帧没生效");
  else console.log("✓ 倒计时期间视频保持暂停");
} finally {
  await browser.close();
}
