/**
 * silhouette-payload.mjs — 用「内存里的序列对象」生成判定轨道白影(不经过歌单)。
 *
 * 为什么需要它:tools/lane-silhouettes.mjs 是从 songs/<danceId>/<danceId>.json 读序列的,
 * 只能给「已经上架」的舞曲出图。而作品工坊的流程是「白影要在上架之前生成」(第⑤步),
 * 那时候序列还躺在 .drafts/<id>/sequence.json 里。
 * 所以这里复用 silhouette.js 的渲染核心,把序列当成参数传进去。
 *
 * 渲染逻辑与 tools/silhouette-core.mjs 的 notes:true 分支逐行一致(两遍渲染求共用裁剪框),
 * 保证同一支舞在上架前后生成的图完全同构。
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

export async function launchChrome({ headless = true } = {}) {
  const args = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"];
  try {
    return await chromium.launch({ channel: "chrome", headless, args });
  } catch (e) {
    const exe = CHROME_FALLBACKS.find((p) => existsSync(p));
    if (!exe) throw new Error(`找不到可用的 Chrome(channel:'chrome' 失败:${e.message})`);
    return await chromium.launch({ executablePath: exe, headless, args });
  }
}

function payloadHtml({ model, size, color }) {
  // color 必须是数字:直接插进模板会变成 `color: #ffffff`,JS 把 #ffffff 当私有字段名解析,
  // 报「Private field '#ffffff' must be declared in an enclosing class」。
  const colorInt = hexToInt(color);
  return `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
</head><body style="margin:0;background:#111">
<script type="module">
import * as THREE from "three";
import { loadAvatar } from "/web_dance/avatar.js";
import { resolveMode } from "/pose_capture/contract.js";
import { createSilhouetteRenderer, renderSilhouetteShot, canvasToPng, alphaCropBox, unionCropBox, applySequenceFrame } from "/web_dance/silhouette.js";
import { laneNoteTimes } from "/web_dance/lane-assets.js";

const SIZE = ${size};
const sil = createSilhouetteRenderer({ size: SIZE, color: ${colorInt} });
const model = await loadAvatar(${JSON.stringify(model)});
sil.attach(model.object);
sil.whiten(model.object);

// 箭头锚点用的关节 → 模型骨骼名(与 tools/lane-silhouettes.mjs 同一份表)
const ARROW_BONES = {
  left_wrist: ["LeftHand"], right_wrist: ["RightHand"],
  left_elbow: ["LeftForeArm"], right_elbow: ["RightForeArm"],
  left_ankle: ["LeftFoot"], right_ankle: ["RightFoot"],
  left_knee: ["LeftLeg"], right_knee: ["RightLeg"],
  hips_center: ["Hips"], nose: ["Head"],
};
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

/**
 * @param {object} seq dance-sequence/v1(必须带 chart,判定点时刻从 chart 里读)
 * @returns {Promise<{notes:Array, crop:object}>}
 */
window.__laneShots = async (seq) => {
  const bones = resolveMode(seq.meta?.danceType || "full-body").bones;
  const times = laneNoteTimes(seq);
  if (!times.length) throw new Error("序列里没有判定点(seq.chart.notes 为空?)");

  // 两遍渲染:先求所有判定点姿势的 alpha 包围盒并集,再用同一个裁剪框出图
  const boxes = [];
  for (const nt of times) {
    applySequenceFrame(seq, nt.t, model.retargeter, bones, { mirror: false, rootMotion: false });
    model.skeletons?.forEach((s) => s.update());
    model.object.updateMatrixWorld(true);
    boxes.push(alphaCropBox(sil.renderRaw(), { alphaThreshold: sil.opts.alphaThreshold }));
  }
  const crop = unionCropBox(boxes, { size: SIZE, padFrac: sil.opts.padFrac });

  const out = [];
  for (const nt of times) {
    const shot = renderSilhouetteShot({
      sil, object3D: model.object, skeletons: model.skeletons, retargeter: model.retargeter,
      seq, t: nt.t, boneDefs: bones, crop, jointPoints: jointPointsOf,
    });
    out.push({
      t: nt.t, key: nt.key, moveId: nt.moveId ?? null,
      width: shot.width, height: shot.height, joints: shot.joints,
      dataUrl: canvasToPng(shot.canvas),
    });
  }
  return { notes: out, crop };
};

window.__ready = true;
</script></body></html>`;
}

/** '#ffffff' → 0xffffff(与 tools/lane-silhouettes.mjs 的 hexToInt 一致)。 */
function hexToInt(hex) {
  if (typeof hex === "number" && Number.isFinite(hex)) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  return m ? parseInt(m[1], 16) : 0xffffff;
}

/**
 * 渲染一批判定轨道白影。
 * @param {{ sequences: Array<{danceId:string, seq:object}> }} jobs
 * @returns [{ danceId, notes:[{t,key,moveId,width,height,joints,buffer}], crop, error? }]
 */
export async function renderLaneFromSequences(jobs, {
  base = DEFAULT_BASE, model = "/models/Michelle.glb", size = 256, color = 0xffffff, onLog = null, onProgress = null,
} = {}) {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    if (onLog) {
      page.on("pageerror", (e) => onLog(`[harness] pageerror: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error") onLog(`[harness] ${m.text()}`);
      });
    }
    await page.route("**/silhouette-payload", (r) =>
      r.fulfill({ contentType: "text/html; charset=utf-8", body: payloadHtml({ model, size, color }) }));
    await page.goto(`${base}/silhouette-payload`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });

    const out = [];
    for (const [i, job] of jobs.entries()) {
      try {
        onProgress?.({ index: i + 1, total: jobs.length, danceId: job.danceId, notes: job.seq?.chart?.notes?.length ?? 0 });
        const res = await page.evaluate((seq) => window.__laneShots(seq), job.seq);
        out.push({
          danceId: job.danceId,
          crop: res.crop,
          notes: res.notes.map((n) => ({ ...n, buffer: Buffer.from(String(n.dataUrl).split(",")[1], "base64"), dataUrl: undefined })),
        });
      } catch (e) {
        out.push({ danceId: job.danceId, notes: [], error: String(e && e.message || e) });
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}
