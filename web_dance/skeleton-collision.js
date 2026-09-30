/**
 * skeleton-collision.js — 给「直接搬运四元数」的骨架补一层胶囊碰撞避免。
 *
 * 背景:教练路径(契约帧 → Retargeter)在 IK 之后有 `retarget.js._resolveCollisions()`:
 * 把四肢抽象成胶囊,与躯干/头/彼此做最小平移分离,压掉「手插进躯干 / 双腿互穿」。
 * 而表演路径(`dance-library.retargetClipToSkeleton`)是直接搬源骨的世界朝向,没有这一层 ——
 * 忠实还原源动作时,源里本来就贴着身体的手(抱臂/手贴肚子)在目标模型的比例下就会穿进去。
 *
 * 这里把那套逻辑独立出来(不依赖 Retargeter 的内部状态),给表演路径逐帧复用:
 *   1) 每帧用当前姿态的关节世界位置建胶囊(躯干/头固定,四肢两段、中末关节可动);
 *   2) 跑 collision.js 的最小平移分离;
 *   3) 把被推开的中/末关节方向写回骨骼(最小旋转,保留 roll)。
 *
 * 纯几何 + 就地改骨骼四元数,不引入新的状态。
 */
import * as THREE from "three";
import { separateCapsulePairs } from "./collision.js";
import { collisionRadiiFor } from "./mesh-collision-radii.js";

const norm = (name) => String(name).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");
const first = (map, keys) => { for (const k of keys) { const b = map.get(k); if (b) return b; } return null; };

// 四肢:[上段骨, 下段骨, 末端骨, 是否腿]
const LIMB_DEFS = [
  ["leftarm", "leftforearm", "lefthand", false],
  ["rightarm", "rightforearm", "righthand", false],
  ["leftupleg", "leftleg", "leftfoot", true],
  ["rightupleg", "rightleg", "rightfoot", true],
];

/** 把一根骨「指向子骨」的方向拧到 targetDir(最小旋转,保留 roll,写回局部四元数)。 */
function aimBone(root, bone, targetDir) {
  const child = bone.children.find((c) => c.isBone);
  if (!child) return;
  const a = bone.getWorldPosition(new THREE.Vector3());
  const b = child.getWorldPosition(new THREE.Vector3());
  const cur = b.sub(a);
  if (cur.lengthSq() < 1e-12) return;
  const q = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), targetDir.clone().normalize());
  const parentWorld = bone.parent
    ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
    : new THREE.Quaternion();
  const boneWorld = bone.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentWorld.invert().multiply(q).multiply(boneWorld));
  root.updateMatrixWorld(true);
}

/**
 * @param {THREE.Object3D} root 骨架根(调用时它的姿态应当已摆好)
 * @param {{ iterations?:number, pushFactor?:number, on?:boolean }} [opts]
 * @returns {() => number} 逐帧调用:就地修正当前姿态,返回被修正的肢体段数(0 = 没穿)
 */
export function createSkeletonCollisionPass(root, opts = {}) {
  const iterations = opts.iterations ?? 8; // 半径改成网格实测后要推开的距离变大,3 轮不够(实测 8 轮才收敛)
  // 允许量:放过"衣服互相贴住"的正常接触,只压深层穿透(见 collision.js 的 margin 说明)
  const allowance = opts.allowance ?? 0.05;
  const pushFactor = opts.pushFactor ?? 0.6;
  const map = new Map();
  root.traverse((o) => { if (o.isBone && !map.has(norm(o.name))) map.set(norm(o.name), o); });
  const hips = first(map, ["hips"]);
  const chest = first(map, ["chest", "spine2", "neck", "spine1"]);
  const head = first(map, ["head"]);
  const limbs = LIMB_DEFS.map(([u, l, e, leg]) => ({
    upper: map.get(u) ?? null,
    lower: map.get(l) ?? null,
    end: map.get(e) ?? null,
    leg,
  })).filter((l) => l.upper && l.lower && l.end);

  // 半径按**蒙皮网格实测**(见 mesh-collision-radii.js),不再按骨长估算:
  // 估算值(上臂 0.031 / 躯干 0.089)比实际表面(袖子 ~0.145 / 胸腔 ~0.19)小 1.4~7 倍,
  // 于是骨架不重叠、手却插进身体。
  const dist = (a, b) => (a && b ? a.getWorldPosition(new THREE.Vector3()).distanceTo(b.getWorldPosition(new THREE.Vector3())) : 0);
  const R = opts.radii ?? collisionRadiiFor(root, {
    shoulderWidth: dist(map.get("leftarm"), map.get("rightarm")),
    hipWidth: dist(map.get("leftupleg"), map.get("rightupleg")),
    headLen: dist(chest, head) * 0.6,
  }, { mode: opts.radiiMode, blend: opts.blend });
  const torsoR = R.torsoR;
  const headR = R.headR;
  const armUpperR = R.armUpperR;
  const armLowerR = R.armLowerR;   // 前臂
  const handR = R.handR;           // 手(单独一段,不再并进前臂)
  const legUpperR = R.legUpperR;
  const legLowerR = R.legLowerR;

  return function resolve() {
    if (opts.on === false) return 0;
    if (!hips || !chest || !limbs.length) return 0;
    root.updateMatrixWorld(true);

    const caps = [];
    const torsoIdx = 0;
    caps.push({
      p0: hips.getWorldPosition(new THREE.Vector3()),
      p1: chest.getWorldPosition(new THREE.Vector3()),
      r: torsoR, movable0: false, movable1: false,
    });
    let headIdx = -1;
    if (head) {
      headIdx = caps.length;
      const hp = head.getWorldPosition(new THREE.Vector3());
      caps.push({ p0: hp, p1: hp.clone(), r: headR, movable0: false, movable1: false });
    }

    const live = [];
    for (const limb of limbs) {
      const rootP = limb.upper.getWorldPosition(new THREE.Vector3());
      const midP = limb.lower.getWorldPosition(new THREE.Vector3());
      const endP = limb.end.getWorldPosition(new THREE.Vector3()); // 腕(手骨原点)/脚踝
      const upperR = limb.leg ? legUpperR : armUpperR;
      const lowerR = limb.leg ? legLowerR : armLowerR;
      const upperIdx = caps.length;
      caps.push({ p0: rootP, p1: midP, r: upperR, movable0: false, movable1: true });
      const lowerIdx = caps.length;
      caps.push({ p0: midP, p1: endP, r: lowerR, movable0: true, movable1: true });
      // 手(仅手臂):腕→指尖单独一段。之前把"手"并进前臂段(半径取 max),手掌实际不在胶囊里,
      // 手深陷胸腔时只有前臂在挡、手掌照插。这里单独建一段,p0 与 lower 的 p1 共享同一个
      // Vector3(腕),分离时相邻段自动一致;写回时只转手骨,不拽前臂。
      let handIdx = -1;
      let tipP = null;
      if (!limb.leg) {
        const tip = limb.end.children.find((c) => c.isBone);
        if (tip) {
          tipP = tip.getWorldPosition(new THREE.Vector3());
          handIdx = caps.length;
          caps.push({ p0: endP, p1: tipP, r: handR, movable0: true, movable1: true });
        }
      }
      live.push({ limb, upperIdx, lowerIdx, handIdx, rootP, midP, endP, tipP });
    }

    const pairs = [];
    for (const lc of live) {
      pairs.push([lc.upperIdx, torsoIdx]);
      pairs.push([lc.lowerIdx, torsoIdx]);
      if (headIdx >= 0 && !lc.limb.leg) {
        pairs.push([lc.lowerIdx, headIdx]);
        if (lc.handIdx >= 0) pairs.push([lc.handIdx, headIdx]);
      }
      if (lc.handIdx >= 0) pairs.push([lc.handIdx, torsoIdx]);
    }
    const cross = (A, B) => {
      for (const a of A) for (const b of B) {
        pairs.push([a.upperIdx, b.upperIdx]);
        pairs.push([a.lowerIdx, b.lowerIdx]);
        pairs.push([a.upperIdx, b.lowerIdx]);
        pairs.push([a.lowerIdx, b.upperIdx]);
      }
    };
    const legs = live.filter((l) => l.limb.leg);
    const arms = live.filter((l) => !l.limb.leg);
    for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) cross([legs[i]], [legs[j]]);
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) cross([arms[i]], [arms[j]]);
    for (const a of arms) for (const l of legs) cross([a], [l]);

    const before = live.map((lc) => ({ mid: lc.midP.clone(), end: lc.endP.clone(), tip: lc.tipP ? lc.tipP.clone() : null }));
    separateCapsulePairs(caps, pairs, { iterations, pushFactor, margin: allowance });

    let fixed = 0;
    live.forEach((lc, i) => {
      const moved = lc.midP.distanceTo(before[i].mid) + lc.endP.distanceTo(before[i].end)
        + (lc.tipP ? lc.tipP.distanceTo(before[i].tip) : 0);
      if (moved < 1e-4) return;
      const upperDir = lc.midP.clone().sub(lc.rootP);
      const lowerDir = lc.endP.clone().sub(lc.midP);
      if (upperDir.lengthSq() > 1e-12) aimBone(root, lc.limb.upper, upperDir);
      if (lowerDir.lengthSq() > 1e-12) aimBone(root, lc.limb.lower, lowerDir);
      // 手:只转手骨(腕不动),把被推开的指尖写回
      if (lc.tipP) {
        const handDir = lc.tipP.clone().sub(lc.endP);
        if (handDir.lengthSq() > 1e-12) aimBone(root, lc.limb.end, handDir.normalize());
      }
      fixed += 1;
    });
    return fixed;
  };
}
