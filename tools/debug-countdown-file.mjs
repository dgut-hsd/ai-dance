/**
 * debug-countdown-file.mjs — 复现「倒计时期间视频是否定住」,并把失败原因(404/异常/状态)一起收下来。
 * 与 test/browser/video-select-flow.spec.js 同一套桩,但跑在 Node 里方便看全量日志。
 */
import { chromium } from "@playwright/test";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";
const POSE_WORKER_STUB = `
self.onmessage = ({ data }) => {
  const { id, type, bitmap } = data;
  try {
    if (type === "init") self.postMessage({ id, delegate: "stub" });
    else if (type === "detect") self.postMessage({ id, world: null, img: null, hands: null, inferenceMs: 0 });
  } finally { bitmap?.close?.(); }
};
`;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on("console", (m) => { const t = m.text(); if (!/GL Driver|gl_context|Graph /.test(t)) console.log(`[${m.type()}]`, t.slice(0, 190)); });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 190)));
  page.on("response", (r) => { if (r.status() >= 400) console.log("[http]", r.status(), decodeURIComponent(r.url()).slice(0, 150)); });
  await page.route("**/pose_capture/pose-worker.js*", (r) =>
    r.fulfill({ contentType: "text/javascript; charset=utf-8", body: POSE_WORKER_STUB }));
  // 给页面装一条"阶段日志"总线:把 startChallenge 里每个 await 前后的进度打出来
  await page.addInitScript(() => {
    window.__stage = [];
    const stamp = (s) => { window.__stage.push(`${(performance.now() / 1000).toFixed(1)}s ${s}`); };
    window.__mark = stamp;
    stamp("init-script");
  });
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
  await page.waitForTimeout(4000);

  const probe = () => page.evaluate(() => {
    const v = document.getElementById("ref-video");
    const cm = document.getElementById("center-msg");
    return {
      paused: v?.paused, t: +(v?.currentTime ?? 0).toFixed(2), rs: v?.readyState,
      cd: cm && !cm.classList.contains("hidden") ? document.getElementById("center-msg-text")?.textContent : null,
      status: document.getElementById("status")?.textContent?.trim().slice(0, 50),
      running: Boolean(document.getElementById("btn-stop") && !document.getElementById("btn-stop").disabled),
    };
  });
  console.log("before start:", JSON.stringify(await probe()));

  await page.click("#song-pick-open");
  await page.click("#song-pick-start");
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500);
    console.log(`+${((i + 1) * 0.5).toFixed(1)}s`, JSON.stringify(await probe()));
  }
  // 关键诊断:参考视频元素自己的事件时间线(play/pause/seeked 都在 video-source 的日志里)
  const vlog = await page.evaluate(() => (globalThis.__danceVideo?.log?.() || []).slice(-25).map((e) => `${e.at ?? ""} ${e.text}`.slice(0, 100)));
  console.log("---- ref-video log ----");
  for (const l of vlog) console.log(l);
  const audioInfo = await page.evaluate(() => ({
    stages: window.__stage,
    camSrcObject: Boolean(document.getElementById("cam")?.srcObject),
  }));
  console.log("---- misc ----", JSON.stringify(audioInfo));
} finally {
  await browser.close();
}
