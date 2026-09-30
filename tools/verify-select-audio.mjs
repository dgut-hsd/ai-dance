/**
 * verify-select-audio.mjs — 真页面验证:选曲页打开/切卡片时到底有没有音频起播。
 *
 * 之前那批视频「点卡片没声音」是因为 songs/index.json 里 defaultSongId 悬空,
 * performanceMusicUrl() 返回 null。这里对每一支视频舞曲单独验证:
 *   打开选曲页(吸引态)→ 音频起播 → 点该卡片 → 仍能起播,并把 AudioEngine 实际加载的 URL 打出来。
 * 不依赖摄像头/MediaPipe(那两个在 headless 下会卡)。
 */
import { chromium } from "@playwright/test";

const BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  // 记录 fetch 过的音频 URL + BufferSource.start() 次数
  await page.addInitScript(() => {
    window.__audioUrls = [];
    window.__audioStarts = 0;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input?.url;
      if (url && /\.(wav|mp3|ogg|m4a)(\?|$)/i.test(url)) window.__audioUrls.push(url);
      return origFetch.call(this, input, init);
    };
    const proto = (globalThis.AudioContext || globalThis.webkitAudioContext)?.prototype;
    if (proto) {
      const orig = proto.createBufferSource;
      proto.createBufferSource = function (...a) {
        const src = orig.apply(this, a);
        const start = src.start.bind(src);
        src.start = (...b) => { window.__audioStarts++; return start(...b); };
        return src;
      };
    }
    localStorage.setItem("dance-side-mode", "video");
    sessionStorage.setItem("dance-record-highlight", "0");
    const c = document.createElement("canvas"); c.width = 640; c.height = 480;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => c.captureStream(5) });
  });

  const idx = await (await fetch(`${BASE}/songs/index.json`)).json();
  const videos = idx.dances.filter((d) => d.mode === "video");
  console.log(`歌单里 ${videos.length} 支视频舞曲\n`);

  await page.goto(`${BASE}/web_dance/dance.html?mode=challenge&autoload=1`, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const cur = document.getElementById("song-pick-current");
    return cur && cur.textContent.trim() && cur.textContent.trim() !== "—";
  }, null, { timeout: 60000 });

  // 吸引态(不点任何卡片)就该有音频
  await page.waitForTimeout(3500);
  const attract = await page.evaluate(() => ({ starts: window.__audioStarts, urls: window.__audioUrls.slice() }));
  console.log("吸引态:", JSON.stringify({ starts: attract.starts, urls: attract.urls.map((u) => u.split("/").slice(-2).join("/")) }));

  let bad = 0;
  for (const d of videos) {
    const before = await page.evaluate(() => window.__audioStarts);
    await page.evaluate(() => { window.__audioStarts = 0; window.__audioUrls = []; });
    const clicked = await page.evaluate((label) => {
      const cards = [...document.querySelectorAll("#song-pick-strip .song-card")];
      const card = cards.find((c) => (c.textContent || "").includes(label));
      if (!card) return false;
      card.click();
      return true;
    }, d.label);
    await page.waitForTimeout(1600);
    const got = await page.evaluate(() => ({ starts: window.__audioStarts, urls: window.__audioUrls.slice() }));
    const songs = new Set(idx.songs.map((s) => s.id));
    const ok = clicked && got.starts > 0 && got.urls.some((u) => u.includes(`/songs/${d.danceId}/`));
    if (!ok) bad++;
    console.log(
      (ok ? "✓" : "✗"),
      d.danceId.padEnd(18),
      `songEntry=${songs.has(d.defaultSongId) ? "有" : "悬空"}`.padEnd(14),
      `起播=${got.starts}`.padEnd(8),
      "加载:", got.urls.map((u) => u.split("/").slice(-2).join("/")).join(",") || "(无)",
    );
  }
  console.log(bad ? `\n${bad} 支没声音` : "\n每支视频舞曲都有音频");
  process.exit(bad ? 1 : 0);
} finally {
  await browser.close();
}
