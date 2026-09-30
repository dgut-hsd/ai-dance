/**
 * video-import-core.mjs — 视频 → 动作序列(dance-sequence/v1),用真浏览器跑 MediaPipe。
 *
 * 为什么走浏览器:动捕管线(pose_capture/pose-engine + contract + filters)本来就是浏览器端的,
 * 再在 Node 里重写一套等于维护第二份实现。这里用 Playwright 起本机 Chrome,
 * 在一个临时 harness 页面里 import 那套模块,把视频逐帧喂给 MediaPipe。
 *
 * 与 pose_capture/export.js 的关系:契约、骨骼表、平滑参数、序列字段一律照抄,
 * 唯一区别是「取帧方式」——
 *   export.js:video.play() + requestVideoFrameCallback,按解码器实际呈现的帧顺序采集(快,但不可控);
 *   本模块   :把视频暂停在 [0, T/30, 2T/30 …] 上逐点 seek,每点只识别一次(慢一点,但帧号=时间×fps,
 *             和谱面的 refFrameIdx 严格对齐,不会被丢帧/VFR 带偏)。
 * 视频模式的作品是靠「时间」对齐判定点的(不是靠帧下标),这个对齐是评分能不能对上的前提。
 *
 * 前置:DANCE ARENA 服务已在本机运行(npm start,默认 http://127.0.0.1:8000)。
 */
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

export const DEFAULT_BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";

const CHROME_FALLBACKS = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

/** 与 silhouette-core.mjs 同一套启动参数:无头 + SwiftShader 软件 WebGL。 */
export async function launchChrome({ headless = true } = {}) {
  const args = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
    // 无头 Chrome 默认把 <video> 当"后台媒体"处理,自动播放会被拦、解码节流,
    // 逐帧 seek 会一直等到超时。这三条关掉那套限制。
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
  ];
  try {
    return await chromium.launch({ channel: "chrome", headless, args });
  } catch (e) {
    const exe = CHROME_FALLBACKS.find((p) => existsSync(p));
    if (!exe) throw new Error(`找不到可用的 Chrome(channel:'chrome' 失败:${e.message})`);
    return await chromium.launch({ executablePath: exe, headless, args });
  }
}

export function harnessHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>video-import-harness</title></head>
<body style="margin:0;background:#111;color:#ccc;font:12px/1.4 monospace">
<div id="log"></div>
<script type="module">
import { createPoseEngine } from "/pose_capture/pose-engine.js";
import {
  landmarksToJoints, addDerivedJoints, constrainLimbDepth, visibilitiesFromLandmarks,
  poseFromJoints, computeShoulderAxis, resolveMode,
} from "/pose_capture/contract.js";
import { PoseSmoother } from "/pose_capture/filters.js";
import { RootMotionTracker } from "/pose_capture/root-motion.js";
import { computeDimensions } from "/pose_capture/playback.js";

// 与 export.js 逐字一致的默认平滑参数(偏跟手,适合舞蹈)
const SMOOTHING = { minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 };

const logNode = document.getElementById("log");
function say(msg) {
  logNode.textContent = msg;
  try { window.__log && window.__log(msg); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等视频元数据(loadedmetadata);已经好了就直接返回 */
function waitMeta(video) {
  if (video.readyState >= 1 && video.duration > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("视频加载失败")), { once: true });
  });
}

/**
 * 把视频停在 t 秒。用 fastSeek 时拿到的关键帧时间可能早于 t,反馈给调用方做时间戳校正。
 * @returns 实际解码位置(秒)
 */
function seekTo(video, t, timeoutMs = 20000) {
  const target = Math.max(0, Math.min(t, Math.max(0, (video.duration || 0) - 0.001)));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      // 下一帧:确保解码器已经把该帧画到视频元素上,createImageBitmap 拿到的才是这一帧
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(video.currentTime)));
    };
    const onSeeked = () => finish();
    const onError = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error("视频定位失败")); } };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try { video.currentTime = target; } catch { finish(); }
  });
}

window.__ready = true;

/**
 * 主入口:把一个视频文件逐帧识别成 dance-sequence/v1。
 * @param {{url:string, fps?:number, mode?:string, maxFrames?:number, name?:string, onProgress?:(p:any)=>void}} opt
 */
window.__render = async (opt) => {
  const fps = Number(opt.fps) > 0 ? Number(opt.fps) : 30;
  const mode = opt.mode || "full-body";
  const m = resolveMode(mode);
  const maxFrames = Number(opt.maxFrames) > 0 ? Number(opt.maxFrames) : Infinity;

  const progress = (p) => { say(JSON.stringify(p)); try { window.__progress && window.__progress(p); } catch {} };

  // ---- 1. 建 video 元素并等元数据 ----
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = opt.url;
  video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01";
  document.body.appendChild(video);
  await waitMeta(video);
  const duration = video.duration;

  // ---- 2. 加载 MediaPipe ----
  progress({ phase: "loading-model" });
  const engine = await createPoseEngine(m.poseModel, { withHands: m.hands, handModelPath: m.handModel });
  // 预热:吃掉 GPU shader 编译/图初始化的一次性开销(与 export.js 同样的理由)
  try {
    const warm = document.createElement("canvas");
    warm.width = 64; warm.height = 64;
    await engine.detect(await createImageBitmap(warm), 0);
  } catch (err) { /* 预热失败不影响主流程 */ }

  // ---- 3. 逐帧 seek + 识别 ----
  const smoother = new PoseSmoother(SMOOTHING);
  const rootTracker = new RootMotionTracker();
  const frames = [];
  let dimsSum = null, dimsCount = 0, frameErrors = 0, firstError = null;
  let ts = 1; // MediaPipe VIDEO 模式要求时间戳严格递增,这里用独立递增的时钟
  let seekMs = 0, detectMs = 0, decodeMs = 0;
  const total = Math.min(Math.floor(duration * fps) + 1, maxFrames);

  progress({ phase: "processing", current: 0, total });
  for (let i = 0; i < total; i++) {
    const want = i / fps;
    if (want > duration) break;
    const ts0 = performance.now();
    const actual = await seekTo(video, want, 20000);
    seekMs += performance.now() - ts0;
    // 时间轴优先用「请求的时刻」:它是 fps 的整数倍,和谱面 refFrameIdx 严格对齐。
    // 只有在 seek 明显没到位(差超过一帧且不是视频末尾)时才用实际位置兜底。
    let t = want;
    if (Math.abs(actual - want) > 1.5 / fps && want < duration - 1 / fps) t = actual;

    try {
      const td0 = performance.now();
      const bitmap = await createImageBitmap(video);
      const td1 = performance.now();
      const { world, img } = await engine.detect(bitmap, ts++);
      const td2 = performance.now();
      decodeMs += td1 - td0;
      detectMs += td2 - td1;
      if (world) {
        const rawJoints = landmarksToJoints(world);
        const depthFixed = constrainLimbDepth(rawJoints, img);
        const vis = visibilitiesFromLandmarks(img);
        const smoothed = smoother.smooth(depthFixed, vis, t);
        const joints = addDerivedJoints(smoothed);
        const { bones, rootYaw, conf } = poseFromJoints(joints, vis, m.bones);
        const root = rootTracker.update(joints, t);
        frames.push({ t: +t.toFixed(4), bones, rootYaw, shoulderAxis: computeShoulderAxis(joints), conf });
        const d = computeDimensions(joints);
        if (!dimsSum) dimsSum = { ...d };
        else for (const k in dimsSum) dimsSum[k] += d[k];
        dimsCount++;
      }
    } catch (err) {
      if (!frameErrors++) firstError = String(err && err.message || err);
    }
    if (i % 5 === 0 || i === total - 1) {
      progress({ phase: "processing", current: i + 1, total, kept: frames.length, errors: frameErrors, t: +t.toFixed(2) });
    }
  }

  video.remove();
  engine.close();

  if (!frames.length) {
    throw new Error("视频动捕没采到任何帧" + (firstError ? ":" + firstError : ""));
  }

  const dimensions = {};
  if (dimsCount > 0) for (const k in dimsSum) dimensions[k] = +(dimsSum[k] / dimsCount).toFixed(3);

  return {
    schema: "dance-sequence/v1",
    danceId: (opt.name || "dance").replace(/\\.[^.]+$/, ""),
    meta: {
      fps,
      durationSec: +duration.toFixed(3),
      numFrames: frames.length,
      boneCount: m.bones.length,
      danceType: mode,
      source: "video-import",
      coordinateSystem: "canonical-yup",
      dimensions,
    },
    bones: m.bones.map(({ name, parent, child }) => ({ name, parent, child })),
    frames,
    _stats: {
      frameErrors, firstError, sampled: total, detected: frames.length,
      seekMs: Math.round(seekMs), decodeMs: Math.round(decodeMs), detectMs: Math.round(detectMs),
    },
  };
};
</script></body></html>`;
}

/**
 * 起一个 harness 页面。
 * @param {{base?:string, headless?:boolean, onLog?:(line:string)=>void, onProgress?:(p:object)=>void, timeout?:number}} opt
 */
export async function openHarness({ base = DEFAULT_BASE, headless = true, onLog = null, onProgress = null, timeout = 120000 } = {}) {
  const browser = await launchChrome({ headless });
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  if (onLog) {
    page.on("console", (m) => onLog(`[console:${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => onLog(`[pageerror] ${e.message}`));
  }
  // 逐帧进度:动捕一支舞要几分钟,没有进度就只能干等(也分不清是慢还是卡死)
  if (onProgress) await page.exposeFunction("__progress", (p) => onProgress(p));
  await page.route("**/video-import-harness", (r) =>
    r.fulfill({ contentType: "text/html; charset=utf-8", body: harnessHtml() }));
  await page.goto(`${base}/video-import-harness`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout });
  return {
    page,
    browser,
    close: async () => { await browser.close(); },
  };
}
