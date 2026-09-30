/**
 * lane-assets.js — 右下判定轨道「逐点 3D 白影」资源的契约与查找层(纯逻辑,可在 Node 单测)。
 *
 * 为什么需要:车道上的剪影是"每个判定点一张",不能用选曲卡那 4 张招牌动作图。
 * 生成方式(tools/lane-silhouettes.mjs,和选曲卡同一套 silhouette.js 流水线):
 *
 *   node tools/lane-silhouettes.mjs            # 读歌单 → 逐判定点出图
 *   → web_dance/assets/lane/index.json         # 清单(本模块消费)
 *   → web_dance/assets/lane/<danceId>/<key>.png
 *
 * manifest 结构(lane-silhouettes/v1):
 * {
 *   "schema": "lane-silhouettes/v1",
 *   "model": "/models/Michelle.glb", "size": 256, "color": "#ffffff",
 *   "dances": {
 *     "hiphop": {
 *       "danceId": "hiphop",
 *       "notes": [{ "t": 0, "key": "0.000", "file": "hiphop/0.000.png",
 *                   "w": 256, "h": 256,
 *                   "joints": { "left_wrist": [101.5, 92.3], "hips_center": [128, 150], ... } }]
 *     }
 *   }
 * }
 *
 * 约定:
 *  - key = 判定点时刻 toFixed(3)(与 pose-lane.js 的 laneEventKey 完全一致);
 *  - 出图用「固定取景 + 不裁剪」,所以同一支舞所有图的 w/h 与投影都一致,
 *    每张图里的 joints 就是该帧各关节在图内的像素坐标(箭头直接用它,不再靠包围盒猜);
 *  - 资源缺失时返回 null,调用方自行决定兜底(游戏里退回 2D 剪影,不影响可玩性)。
 */
import { computePoseEvents, laneEventKey } from "./pose-lane.js";

export const LANE_ASSET_SCHEMA = "lane-silhouettes/v1";
export const LANE_ASSET_DIR = "assets/lane/";
export const LANE_MANIFEST_URL = `${LANE_ASSET_DIR}index.json`;
/** 生成器与消费端共同关心的关节(与 pose-lane.js 的箭头候选一致) */
export const LANE_JOINT_KEYS = [
  "left_wrist", "right_wrist", "left_elbow", "right_elbow",
  "left_ankle", "right_ankle", "left_knee", "right_knee",
  "hips_center", "nose",
];

/** 一支舞要出哪些图:判定点时刻(去重、升序)。生成器用它,车道 key 也用它。 */
export function laneNoteTimes(seq) {
  const seen = new Set();
  const out = [];
  for (const ev of computePoseEvents(seq)) {
    const key = laneEventKey(ev.t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ t: ev.t, key, moveId: ev.moveId ?? null });
  }
  return out;
}

export function laneAssetUrl(entry) {
  return entry?.file ? `${LANE_ASSET_DIR}${entry.file}` : null;
}

/** 取某支舞某个时刻的白影条目;找不到返回 null(调用方走 2D 兜底) */
export function laneAssetFor(manifest, danceId, t) {
  const notes = manifest?.dances?.[danceId]?.notes;
  if (!Array.isArray(notes) || !Number.isFinite(Number(t))) return null;
  const key = laneEventKey(Number(t));
  for (const n of notes) if ((n.key ?? laneEventKey(Number(n.t))) === key) return n;
  return null;
}

/**
 * 把条目里的关节像素换算到"实际显示尺寸"(scale = 显示高 / 图片高)。
 * 只有落在图内的有限坐标才会保留,避免坏数据把箭头甩出去。
 */
export function laneAssetJointPixels(entry, scale = 1) {
  const out = {};
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  for (const k of LANE_JOINT_KEYS) {
    const p = entry?.joints?.[k];
    if (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      out[k] = [p[0] * s, p[1] * s];
    }
  }
  return out;
}

/** 图片显示尺寸:高度跟车道盒子一致,宽度按图片纵横比(避免压扁) */
export function laneAssetBox(entry, boxH) {
  const h = Number.isFinite(boxH) && boxH > 0 ? boxH : 142;
  const iw = Number(entry?.w) > 0 ? Number(entry.w) : 0;
  const ih = Number(entry?.h) > 0 ? Number(entry.h) : 0;
  if (!iw || !ih) return { w: Math.round(h), h };
  return { w: Math.max(8, Math.round((h * iw) / ih)), h };
}

const isFinitePair = (p) => Array.isArray(p) && p.length >= 2
  && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** 严格校验 manifest;生成器写完自检、测试也用它。不合法就抛错(别静默变成空白车道) */
export function validateLaneManifest(manifest) {
  const bad = (msg) => { throw new Error(`lane manifest 非法: ${msg}`); };
  if (!manifest || typeof manifest !== "object") bad("不是对象");
  if (manifest.schema !== LANE_ASSET_SCHEMA) bad(`schema 应为 ${LANE_ASSET_SCHEMA},实际 ${manifest.schema}`);
  const dances = manifest.dances;
  if (!dances || typeof dances !== "object") bad("缺少 dances");
  for (const [id, dance] of Object.entries(dances)) {
    if (!Array.isArray(dance?.notes)) bad(`${id}: notes 应为数组`);
    for (const n of dance.notes) {
      if (!Number.isFinite(Number(n?.t))) bad(`${id}: 有判定点缺 t`);
      if (!n.file) bad(`${id}: t=${n.t} 缺 file`);
      if (!(Number(n.w) > 0 && Number(n.h) > 0)) bad(`${id}: t=${n.t} 的 w/h 不合法`);
      const joints = n.joints ?? {};
      if (!joints || typeof joints !== "object" || Array.isArray(joints)) bad(`${id}: t=${n.t} 的 joints 应为对象`);
      for (const [k, p] of Object.entries(joints)) {
        if (!LANE_JOINT_KEYS.includes(k)) bad(`${id}: t=${n.t} 出现未知关节 ${k}`);
        if (!isFinitePair(p)) bad(`${id}: t=${n.t} 的关节 ${k} 坐标不合法`);
      }
    }
  }
  return manifest;
}

/** 读 manifest;缺失/损坏都返回 null(游戏照常跑,只是回到 2D 剪影) */
export async function loadLaneManifest(url = LANE_MANIFEST_URL, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  try {
    const res = await fetchImpl(url);
    if (!res?.ok) return null;
    return validateLaneManifest(await res.json());
  } catch {
    return null;
  }
}

/** 生成器侧的组装(把逐张结果拼成 manifest);放这里保证与消费端同一份契约 */
export function buildLaneManifest({ model, size, color = "#ffffff", dances }) {
  const out = { schema: LANE_ASSET_SCHEMA, generatedAt: new Date().toISOString(), model, size, color, dances: {} };
  for (const d of dances ?? []) {
    const notes = (d.notes ?? []).slice().sort((a, b) => a.t - b.t);
    const entry = { danceId: d.danceId, notes };
    if (d.crop) entry.crop = d.crop; // 该舞共用的裁剪框(剪影比例一致;消费端只用于排查)
    out.dances[d.danceId] = entry;
  }
  return validateLaneManifest(out);
}
