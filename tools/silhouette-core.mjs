/**
 * silhouette-core.mjs — 命令行批量生成剪影的 Node 侧封装。
 *
 * 页面内渲染核心在 web_dance/silhouette.js(浏览器 ESM),这里只负责:
 *   1) 起一个只做剪影渲染的临时页面(importmap 加载 three,import 那个核心模块);
 *   2) 用本机 Chrome 无头跑它;
 *   3) 把每个任务渲染出的 PNG 收回来给调用方写文件。
 *
 * 之所以跑真浏览器:剪影必须来自真实的 3D 骨骼姿态 + WebGL 渲染,
 * 在 Node 里重画一遍等于维护第二套渲染逻辑。
 *
 * 前置:DANCE ARENA 服务已在本机运行(npm start,默认 8000),
 *       且能访问 jsdelivr CDN 加载 three.js。
 */
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

export const DEFAULT_BASE = process.env.DANCE_BASE || "http://127.0.0.1:8000";

// Playwright 的 channel:'chrome' 通常能找到系统 Chrome;找不到就退回这几个常见路径
const CHROME_FALLBACKS = [
  process.env.CHROME_PATH,
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function harnessHtml({ model, size, color }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
</head><body style="margin:0;background:#111">
<script type="module">
import * as THREE from "three";
import { loadAvatar } from "/web_dance/avatar.js";
import { loadSongIndex, loadSequence, dances, songById } from "/web_dance/song-library.js";
import { resolveMode } from "/pose_capture/contract.js";
import { reconstructJoints } from "/pose_capture/playback.js";
import { createSilhouetteRenderer, renderSilhouetteFrame, renderSilhouetteShot, canvasToPng, pickSignatureTimes, alphaCropBox, unionCropBox, applySequenceFrame } from "/web_dance/silhouette.js";
import { laneNoteTimes } from "/web_dance/lane-assets.js";

const SIZE = ${size};
await loadSongIndex();   // 歌单(用于 __dances 探测;渲染本身只依赖 loadSequence)
const sil = createSilhouetteRenderer({ size: SIZE, color: ${color} });
const model = await loadAvatar(${JSON.stringify(model)});
sil.attach(model.object);
const whitened = sil.whiten(model.object);

// 箭头锚点用的关节 → 模型骨骼名(Mixamo 命名;找不到的关节就不写进 manifest)
const ARROW_BONES = {
  left_wrist: ["LeftHand"], right_wrist: ["RightHand"],
  left_elbow: ["LeftForeArm"], right_elbow: ["RightForeArm"],
  left_ankle: ["LeftFoot"], right_ankle: ["RightFoot"],
  left_knee: ["LeftLeg"], right_knee: ["RightLeg"],
  hips_center: ["Hips"], nose: ["Head"],
};
// renderSilhouetteShot 会把 { retargeter, object3D, seq, t } 传进来
function jointPointsOf({ retargeter } = {}) {
  const out = {};
  if (!retargeter?.findBone) return out;
  for (const [name, cands] of Object.entries(ARROW_BONES)) {
    const bone = retargeter.findBone(cands);
    if (!bone) continue;
    const p = bone.getWorldPosition(new THREE.Vector3());
    out[name] = [p.x, p.y, p.z];
  }
  return out;
}

const seqCache = new Map();
async function seqOf(danceId) {
  if (!seqCache.has(danceId)) seqCache.set(danceId, await loadSequence(danceId));
  return seqCache.get(danceId);
}

// 一支舞要拍哪几帧:给了 times 就用给定时刻,否则自动挑最展开的招牌动作
async function timesFor(danceId, { times, count = 1 }) {
  const seq = await seqOf(danceId);
  if (Array.isArray(times) && times.length) return times.map(Number);
  const jointsAt = (f) => reconstructJoints(f, seq.meta?.dimensions, seq.bones);
  const picked = pickSignatureTimes(seq, jointsAt, { count });
  return picked.length ? picked.map((p) => p.t) : [0];
}

window.__shots = async (jobs) => {
  const out = [];
  for (const job of jobs) {
    try {
      const danceId = job.danceId;
      const seq = await seqOf(danceId);
      const bones = resolveMode(seq.meta?.danceType || "full-body").bones;

      // notes:true = 逐判定点出图(判定轨道用)
      // 两遍渲染:第一遍量所有动作的 alpha 包围盒求并集,第二遍按这个共用裁剪框出图 ——
      // 剪影填满画面,且同一支舞里所有动作比例一致;关节像素也跟着裁剪框走。
      if (job.notes) {
        const times = laneNoteTimes(seq);
        const boxes = [];
        for (const nt of times) {
          applySequenceFrame(seq, nt.t, model.retargeter, bones, { mirror: false, rootMotion: false });
          model.skeletons?.forEach((s) => s.update());
          model.object.updateMatrixWorld(true);
          boxes.push(alphaCropBox(sil.renderRaw(), { alphaThreshold: sil.opts.alphaThreshold }));
        }
        const crop = unionCropBox(boxes, { size: SIZE, padFrac: sil.opts.padFrac });
        for (const nt of times) {
          const shot = renderSilhouetteShot({
            sil, object3D: model.object, skeletons: model.skeletons, retargeter: model.retargeter,
            seq, t: nt.t, boneDefs: bones, crop, jointPoints: jointPointsOf,
          });
          out.push({
            name: job.name, danceId, t: nt.t, key: nt.key, moveId: nt.moveId,
            width: shot.width, height: shot.height, joints: shot.joints, crop,
            dataUrl: canvasToPng(shot.canvas),
          });
        }
        continue;
      }

      const tl = await timesFor(danceId, job);
      for (const t of tl) {
        const canvas = renderSilhouetteFrame({
          sil, object3D: model.object, skeletons: model.skeletons,
          retargeter: model.retargeter, seq, t, boneDefs: bones,
        });
        out.push({
          name: job.name,
          danceId, t,
          width: canvas.width, height: canvas.height,
          dataUrl: canvasToPng(canvas),
        });
      }
    } catch (err) {
      // 单支舞失败不影响整批,错误交回 Node 侧汇总
      out.push({ name: job.name, danceId: job.danceId, error: String(err && err.message || err) });
    }
  }
  return out;
};
window.__dances = () => dances().map((d) => ({ id: d.id, danceId: d.danceId, label: d.label }));
window.__info = () => ({ meshes: whitened, model: ${JSON.stringify(model)} });
window.__ready = true;
</script></body></html>`;
}

export async function launchChrome({ headless = true } = {}) {
  const args = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"];
  try {
    return await chromium.launch({ channel: "chrome", headless, args });
  } catch (e) {
    const exe = CHROME_FALLBACKS.find((p) => existsSync(p));
    if (!exe) {
      throw new Error(`找不到可用的 Chrome(channel:'chrome' 失败:${e.message};也没有常见路径下的 chrome.exe)`);
    }
    return await chromium.launch({ executablePath: exe, headless, args });
  }
}

/**
 * 读歌单里的舞曲元数据(复用同一个 harness 页面,只取 window.__dances)。
 * 各生成脚本(招牌动作 / 逐判定点)共用,避免各写一份歌单读取。
 */
export async function fetchDanceMeta({ base = DEFAULT_BASE } = {}) {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    await page.route("**/silhouette-harness", (r) =>
      r.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><script type="module">
import { loadSongIndex, dances } from "/web_dance/song-library.js";
await loadSongIndex();
window.__dances = dances().map(d => ({ id: d.id, danceId: d.danceId, label: d.label }));
window.__ready = true;
</script>` }));
    await page.goto(`${base}/silhouette-harness`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
    return await page.evaluate(() => window.__dances);
  } finally {
    await browser.close();
  }
}

/**
 * 跑一批剪影任务。
 * @param jobs [{ name, danceId, times?: number[], count?: number, notes?: boolean }]
 *        notes:true = 逐判定点出图(判定轨道用),返回项额外带 key/joints
 * @returns [{ name, danceId, t, width, height, buffer }]
 */
export async function renderSilhouetteBatch(jobs, {
  base = DEFAULT_BASE, model = "/models/Michelle.glb", size = 512, color = 0xffffff, silent = false,
} = {}) {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const log = (...a) => { if (!silent) console.log(...a); };
    page.on("pageerror", (e) => console.error("[harness] pageerror:", e.message));
    page.on("console", (m) => { if (m.type() === "error") console.error("[harness]", m.text()); });
    await page.route("**/silhouette-harness", (r) =>
      r.fulfill({ contentType: "text/html; charset=utf-8", body: harnessHtml({ model, size, color }) }));
    await page.goto(`${base}/silhouette-harness`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
    log("harness ready · 舞曲:", JSON.stringify(await page.evaluate(() => window.__dances())));

    const shots = await page.evaluate((j) => window.__shots(j), jobs);
    const failures = shots.filter((s) => s.error);
    if (failures.length) {
      console.error(`渲染失败 ${failures.length} 项:`);
      for (const f of failures) console.error(`  - ${f.name} (${f.danceId}): ${f.error}`);
    }
    const ok = shots.filter((s) => s.dataUrl);
    log(`渲染完成: ${ok.length} 张${failures.length ? `,失败 ${failures.length} 项` : ""}`);
    return {
      shots: ok.map((s) => ({ ...s, buffer: Buffer.from(s.dataUrl.split(",")[1], "base64"), dataUrl: undefined })),
      failures,
    };
  } finally {
    await browser.close();
  }
}
