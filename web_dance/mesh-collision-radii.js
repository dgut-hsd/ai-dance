/**
 * mesh-collision-radii.js — 用**蒙皮网格实测**的肢体包络半径,替换原来按骨长估算的碰撞代理半径。
 *
 * 为什么:碰撞层(collision/胶囊分离)把肢体当圆柱。原来的半径是拍脑袋的比例式
 * (`shoulderWidth×0.11` ≈ 0.031),而 dancer_girl 蒙皮后的实际表面(宽松外套的袖子)中段半径约 **0.145**,
 * 胸腔约 **0.19** —— 代理比真实几何细 1.4~7 倍,于是"骨架不重叠"但**手/前臂照样插进身体**。
 * 这不是布料物理(角色是刚性蒙皮网格,没有布料解算),而是碰撞代理没有把衣服的体积算进去。
 *
 * 做法:对每根目标骨,取「主导骨 = 该骨」的顶点(蒙皮到当前姿态后的世界位置),
 * 量它们到骨线段的距离,只取骨中段(投影 0.25~0.75)避开肩/肘处的团块,取 P50 当管道半径。
 * 每套骨架只算一次(WEAK 缓存),没有蒙皮网格就回退到原来的比例式。
 */
import * as THREE from "three";

const FACTOR = 0.85; // 安全系数:严格贴面会显得僵,留一点余量
// 默认混合系数:0=旧的按骨长估算(保真最好,但袖子会压进外套),1=网格实测表面(不穿模,但会把手臂推歪)。
// 实测(对源真值的手臂方向误差,见 tools/audit-retarget.mjs):
//   0 → 0.6° / 0.25 → 0.9° / 0.5 → 2.3° / 1.0 → 27.1°
// 取 0.35:把"手臂插进身体"的深度压掉约 1/3,代价约 1° —— 再往上性价比就崩了。
const DEFAULT_BLEND = 0.35;
const _norm = (n) => String(n).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");
const _cache = new WeakMap();

/** 没有网格数据时的兜底(原来的比例式)。 */
export function fallbackRadii(dims) {
  const sw = dims?.shoulderWidth || 0;
  const hw = dims?.hipWidth || 0;
  return {
    torsoR: sw * 0.32 || 0.10,
    headR: (dims?.headLen || 0) * 0.45 || 0.08,
    armUpperR: sw * 0.11 || 0.035,
    armLowerR: sw * 0.11 || 0.035,
    handR: sw * 0.08 || 0.03,
    legUpperR: hw * 0.14 || 0.04,
    legLowerR: hw * 0.14 || 0.04,
  };
}

/** @returns {{torsoR:number, headR:number, armUpperR:number, armLowerR:number, handR:number, legUpperR:number, legLowerR:number, measured:boolean}} */
export function collisionRadiiFor(root, dims, opts = {}) {
  // 调试/对比用:`mode: "formula"` 强制回到旧的按骨长估算(URL 加 ?collisionradii=old)
  const key = opts.mode === "formula" ? "formula" : "mesh:" + (Number.isFinite(opts.blend) ? opts.blend : DEFAULT_BLEND);
  let entry = _cache.get(root);
  if (!entry) { entry = {}; _cache.set(root, entry); }
  if (entry[key]) return entry[key];

  const fb = fallbackRadii(dims);
  const skin = key === "formula" ? null : findSkinnedMesh(root);
  if (!skin) {
    entry[key] = { ...fb, measured: false };
    return entry[key];
  }
  const tube = measureTubeRadii(root, skin);
  const pick = (names) => {
    const vals = names.map((n) => tube.get(n)).filter((v) => Number.isFinite(v) && v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  // blend: 0 = 旧的按骨长估算(保真最好、会穿模), 1 = 网格实测表面(不穿模、但会把手臂推歪)。
  // 中间值在两者之间线性插值 —— 用 tools/audit-retarget.mjs + tmp 的扫描脚本挑拐点。
  const blend = Number.isFinite(opts.blend) ? Math.max(0, Math.min(1, opts.blend)) : DEFAULT_BLEND;
  const atLeast = (measured, floor) => {
    const mesh = Math.max(floor, (measured || 0) * FACTOR);
    return floor + (mesh - floor) * blend;
  };
  entry[key] = {
    torsoR: atLeast(pick(["spine1", "spine2", "chest", "spine"]), fb.torsoR),
    headR: fb.headR, // 头发/头不是"手交叉穿模"的点,保持小半径(避免手靠近脸时被过度外推)
    // 上臂/大腿的**近端**天生就在躯干里(肩/髋离脊柱轴 ~0.14,小于"躯干半径+上臂半径"),
    // 用实测半径会让它永远处于重叠 → 被持续推开 → 手臂永久外张(教练路径实测方向误差 30°)。
    // 所以近端段保持旧的估算半径,只把**前臂+手**这些真正会"插进身体"的远端段放大。
    armUpperR: fb.armUpperR,
    armLowerR: atLeast(pick(["leftforearm", "rightforearm"]), fb.armLowerR),
    handR: atLeast(pick(["lefthand", "righthand"]), fb.handR),
    legUpperR: fb.legUpperR,
    legLowerR: fb.legLowerR, // 腿穿模不是当前问题,保持原半径
    measured: true,
  };
  return entry[key];
}

function findSkinnedMesh(root) {
  let skin = null;
  root.traverse((o) => { if (!skin && o.isSkinnedMesh && o.geometry?.attributes?.skinIndex) skin = o; });
  return skin;
}

/**
 * 网格实测的「真实表面」半径(不混合、不夹兜底下限):用于**度量**玩家肉眼看到的穿模。
 * 与 collisionRadiiFor 不同,这里上臂/大腿也用实测值 —— 碰撞时近端段保持小半径是为了
 * 避免"肩天生在躯干胶囊里 → 被持续推开 → 手臂外张",但度量时要把近端的贴躯干与远端的
 * "真的插进去"分开(见 tools/audit-retarget.mjs 的网格级穿模口径)。
 */
export function meshSurfaceRadii(root) {
  const skin = findSkinnedMesh(root);
  if (!skin) return fallbackRadii({ shoulderWidth: 0.278, hipWidth: 0.2, headLen: 0.07 });
  const tube = measureTubeRadii(root, skin);
  const pick = (names) => {
    const vals = names.map((n) => tube.get(n)).filter((v) => Number.isFinite(v) && v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  return {
    torsoR: pick(["spine1", "spine2", "chest", "spine"]) * FACTOR,
    headR: pick(["head"]) * FACTOR,
    armUpperR: pick(["leftarm", "rightarm"]) * FACTOR,
    armLowerR: pick(["leftforearm", "rightforearm"]) * FACTOR,
    handR: pick(["lefthand", "righthand"]) * FACTOR,
    legUpperR: pick(["leftupleg", "rightupleg"]) * FACTOR,
    legLowerR: pick(["leftleg", "rightleg"]) * FACTOR,
    measured: true,
  };
}

/** 每根骨的「中段管道半径」。 */
function measureTubeRadii(root, skin) {
  const out = new Map();
  const bones = skin.skeleton.bones;
  const pos = skin.geometry.attributes.position;
  const si = skin.geometry.attributes.skinIndex;
  const sw = skin.geometry.attributes.skinWeight;
  if (!pos || !si || !sw) return out;
  skin.updateMatrixWorld(true);

  const perBone = new Map();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    let best = -1;
    let bw = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) { bw = w; best = si.getComponent(i, k); }
    }
    if (best < 0 || bw < 0.5) continue;
    const bone = bones[best];
    if (!bone) continue;
    v.fromBufferAttribute(pos, i);
    skin.applyBoneTransform(i, v);
    v.applyMatrix4(skin.matrixWorld);
    const key = _norm(bone.name);
    if (!perBone.has(key)) perBone.set(key, []);
    perBone.get(key).push(v.clone());
  }

  const byKey = new Map();
  root.traverse((o) => { if (o.isBone && !byKey.has(_norm(o.name))) byKey.set(_norm(o.name), o); });
  const distToSeg = (p, a, b) => {
    const ab = b.clone().sub(a);
    const ap = p.clone().sub(a);
    const l2 = ab.lengthSq();
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ap.dot(ab) / l2)) : 0;
    return ap.clone().sub(ab.clone().multiplyScalar(t)).length();
  };
  for (const [key, pts] of perBone) {
    const bone = byKey.get(key);
    if (!bone || !pts.length) continue;
    const a = bone.getWorldPosition(new THREE.Vector3());
    const child = bone.children.find((c) => c.isBone);
    const b = child ? child.getWorldPosition(new THREE.Vector3()) : a.clone().add(new THREE.Vector3(0, 0.02, 0));
    const ab = b.clone().sub(a);
    const l2 = ab.lengthSq();
    const mid = [];
    for (const p of pts) {
      const t = l2 > 1e-12 ? p.clone().sub(a).dot(ab) / l2 : 0;
      if (t > 0.25 && t < 0.75) mid.push(distToSeg(p, a, b));
    }
    const src = mid.length > 8 ? mid : pts.map((p) => distToSeg(p, a, b));
    src.sort((x, y) => x - y);
    out.set(key, src[Math.floor(src.length * 0.5)]);
  }
  return out;
}
