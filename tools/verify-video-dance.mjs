/**
 * verify-video-dance.mjs — 上架之后的真机自检:游戏页能不能真的把新视频舞曲跑起来。
 *
 * 查的是"上架流程看着成功、玩的时候才炸"的那几类问题:
 *   1. 歌单里有没有这支舞、有没有绑上参考视频;
 *   2. 参考视频真能加载出元数据(时长 > 0),不是 404 黑屏;
 *   3. 序列有帧、谱面有判定点,而且 chart 内嵌在序列里(运行时读的是 seq.chart,
 *      两份不同步 = 谱面看着有、车道却是空的);
 *   4. 判定轨道白影清单里有这支舞(没有就退回 2D 剪影);
 *   5. 游戏页能真的切到这支舞的参考视频(选曲 UI 层)。
 *
 * 摄像头/MediaPipe 用桩挡掉(自检的是上架产物,不是动捕本身)。
 *
 * 用法: node tools/verify-video-dance.mjs [--dances dance7-video,dance2-video] [--base http://127.0.0.1:8000]
 */
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { parseChart } from "../scoring/src/chartCodec.js";

const CHROME_FALLBACKS = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const BASE = arg("base", process.env.DANCE_BASE || "http://127.0.0.1:8000");

async function launch() {
  const args = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"];
  try { return await chromium.launch({ channel: "chrome", headless: true, args }); }
  catch {
    const exe = CHROME_FALLBACKS.find((p) => existsSync(p));
    return await chromium.launch({ executablePath: exe, headless: true, args });
  }
}

const index = await (await fetch(`${BASE}/songs/index.json`)).json();
const allVideoDances = (index.dances || [])
  .filter((d) => d.mode === "video" || String(d.danceId).endsWith("-video"))
  .map((d) => d.danceId);
const dances = (arg("dances", "") || allVideoDances.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
if (!dances.length) { console.error("歌单里没有 video 模式的舞曲"); process.exit(1); }

const lane = await (await fetch(`${BASE}/web_dance/assets/lane/index.json`)).json().catch(() => null);
const mapping = (await (await fetch(`${BASE}/api/videos-map`)).json()).mapping || {};

const browser = await launch();
let failures = 0;
try {
  for (const danceId of dances) {
    const videoName = mapping[danceId] || "";
    const entry = (index.dances || []).find((d) => d.danceId === danceId);
    const row = {
      danceId, videoName: videoName || null,
      danceLabel: entry?.label || danceId,
      inSongIndex: Boolean(entry),
    };

    // ---- 序列 + 谱面 + 白影(纯数据,不需要浏览器) ----
    try {
      const seq = await (await fetch(`${BASE}/songs/${danceId}/${danceId}.json`)).json();
      row.frames = seq.frames?.length ?? 0;
      row.durationSec = seq.meta?.durationSec ?? null;
      row.fps = seq.meta?.fps ?? null;
      row.embeddedChart = Boolean(seq.chart);
      row.chartNotes = seq.chart?.notes?.length ?? 0;
      // 用项目自己的谱面解析器过一遍:refFrameIdx 越界/字段缺失这类问题,
      // 「文件看着正常」是查不出来的,只有真解析才会露出来。
      try {
        const events = parseChart(seq, seq.chart);
        row.parsedEvents = events.length;
        row.parseError = null;
      } catch (e) { row.parseError = String(e.message || e); }
      const chartFile = (index.dances || []).find((d) => d.danceId === danceId)?.chartFile;
      if (chartFile) {
        const chart = await (await fetch(`${BASE}/songs/${danceId}/${chartFile}`)).json();
        row.chartFileNotes = chart.notes?.length ?? 0;
      }
    } catch (e) { row.seqError = e.message; }
    row.laneNotes = lane?.dances?.[danceId]?.notes?.length ?? 0;

    // ---- 参考视频能不能加载(每支舞一个干净页面,避免上一个页面的加载被中断) ----
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`${BASE}/web_dance/dance.html`, { waitUntil: "load" });
      if (videoName) {
        row.videoLoad = await page.evaluate(async (url) => {
          const el = document.createElement("video");
          el.muted = true; el.preload = "auto"; el.src = url;
          const done = await new Promise((resolve) => {
            const t = setTimeout(() => resolve({ ok: false, why: "timeout" }), 20000);
            el.addEventListener("loadedmetadata", () => { clearTimeout(t); resolve({ ok: true }); }, { once: true });
            el.addEventListener("error", () => { clearTimeout(t); resolve({ ok: false, why: `error code=${el.error?.code}` }); }, { once: true });
          });
          return { ...done, duration: el.duration, videoW: el.videoWidth, videoH: el.videoHeight };
        }, `/videos/${encodeURIComponent(videoName)}`);
      }

      // ---- 游戏页选曲 UI:能不能翻到这支舞并切到它的参考视频 ----
      // 注意:选曲抽屉一打开总是停在第 0 张卡(与 ?dance= 参数无关),所以这里按现场的操作
      // 顺序来 —— 翻箭头直到卡面标题是这支舞,再看 ref-video 的源有没有切过去。
      await page.addInitScript(() => {
        localStorage.setItem("dance-side-mode", "video");
        sessionStorage.setItem("dance-record-highlight", "0");
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 480;
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
          configurable: true, value: async () => canvas.captureStream(5),
        });
      });
      // autoload=1 必须有:没有模型时选曲态进不去(视频模式虽不用 3D 模型,但 enterSelect
      // 仍要等 layoutForMode 收尾),表现就是卡在「正在加载默认舞者…」。
      await page.goto(`${BASE}/web_dance/dance.html?mode=challenge&autoload=1`, { waitUntil: "load" });
      const selected = await page.waitForFunction(() => {
        const cur = document.getElementById("song-pick-current");
        return cur && cur.textContent.trim() && cur.textContent.trim() !== "—" ? cur.textContent.trim() : false;
      }, null, { timeout: 90000 }).then((h) => h.jsonValue()).catch(() => null);
      row.uiFirst = selected;

      const target = await (async () => {
        // 直接点抽屉里的那张卡(比反复点箭头可靠:箭头在抽屉收起/动画期间会点不动)
        const found = await page.evaluate((label) => {
          const cards = [...document.querySelectorAll("#song-pick-strip .song-card")];
          const idx = cards.findIndex((c) => (c.textContent || "").includes(label));
          if (idx < 0) return { idx: -1, labels: cards.map((c) => (c.textContent || "").trim().slice(0, 40)) };
          cards[idx].click();
          return { idx, labels: cards.map((c) => (c.textContent || "").trim().slice(0, 40)) };
        }, row.danceLabel).catch(() => ({ idx: -1, labels: [] }));
        row.cardLabels = found.labels;
        if (found.idx < 0) return null;
        await page.waitForTimeout(1200);
        return await page.evaluate(() => document.getElementById("song-pick-current")?.textContent?.trim() || "");
      })();

      await page.waitForFunction(
        (name) => decodeURIComponent(document.getElementById("ref-video")?.getAttribute("src") || "").includes(name),
        videoName || "", { timeout: 25000 },
      ).catch(() => {});
      row.ui = await page.evaluate(() => {
        const el = document.getElementById("ref-video");
        return {
          selectedLabel: document.getElementById("song-pick-current")?.textContent?.trim() || "",
          src: decodeURIComponent(el?.getAttribute("src") || ""),
          readyState: el?.readyState ?? -1,
          duration: el?.duration ?? -1,
          cardCount: document.querySelectorAll("#song-pick-strip .song-card").length,
        };
      });
      row.uiTarget = target;
    } catch (e) {
      row.uiError = String(e.message || e).split("\n")[0];
    } finally {
      await page.close();
    }

    const bad = [];
    if (!row.inSongIndex) bad.push("不在 songs/index.json");
    if (!row.videoName) bad.push("没绑参考视频");
    if (row.videoLoad && !row.videoLoad.ok) bad.push(`参考视频加载失败(${row.videoLoad.why})`);
    if (row.videoLoad && !(row.videoLoad.duration > 0)) bad.push("参考视频时长无效");
    if (!(row.frames > 0)) bad.push("序列没有帧");
    if (!(row.chartNotes > 0)) bad.push("序列内嵌 chart 没有判定点");
    if (!(row.chartFileNotes > 0)) bad.push("谱面文件没有判定点");
    if (row.parseError) bad.push(`谱面解析失败:${row.parseError}`);
    if (!(row.parsedEvents > 0)) bad.push("谱面解析出来 0 个判定事件");
    if (!(row.laneNotes > 0)) bad.push("没有判定轨道白影");
    // 白影必须逐判定点一一对应:数量不一致说明白影是照着**旧谱面**生成的
    // (改过判定点却没重生成白影的典型症状),车道会给错动作的剪影。
    if (row.laneNotes > 0 && row.chartNotes > 0 && row.laneNotes !== row.chartNotes) {
      bad.push(`白影张数(${row.laneNotes})与判定点数(${row.chartNotes})不一致 —— 白影要按当前谱面重新生成`);
    }
    // 选曲 UI 只在没别的错时才要求(它是最后一环,前面炸了它必然也不对)
    if (!bad.length && videoName) {
      if (!row.ui) bad.push("选曲 UI 没起来");
      else {
        if (!row.uiTarget) bad.push(`选曲抽屉的卡片里没有这支舞(卡片:${(row.cardLabels || []).join(" / ") || "空"})`);
        else if (!String(row.uiTarget).includes(row.danceLabel)) bad.push(`点卡后选中态没跟上(停在「${row.uiTarget}」)`);
        if (!row.ui.src.includes(videoName)) bad.push(`选中后没切到该视频源(src=${row.ui.src})`);
      }
    }
    row.ok = bad.length === 0;
    row.bad = bad;
    if (!row.ok) failures++;
    console.log(JSON.stringify(row));
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} 支舞曲自检不通过` : "\n全部通过");
process.exit(failures ? 1 : 0);
