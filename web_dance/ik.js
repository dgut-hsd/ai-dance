/**
 * ik.js — 两骨 IK 求解器(位置级)。
 *
 * 已知上骨根 p0、末端目标 p2、两骨长度 l1/l2、以及弯折方向参考点 pole,
 * 求中间关节 p1(肘/膝)与上/下骨方向。pole 用来决定关节往哪边弯(肘朝后、膝朝前),
 * 从而避免方向对齐法里"肘/膝反折、手臂扭转"的问题。
 */

import * as THREE from "three";

const EPS = 1e-4;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function solveTwoBone(p0, p2, l1, l2, pole) {
  const a = new THREE.Vector3().copy(p0);
  const b = new THREE.Vector3().copy(p2);
  const poleV = new THREE.Vector3().copy(pole);

  // 夹取目标距离到可达区间(避免 NaN / 完全伸直导致的方向退化)
  const d = clamp(a.distanceTo(b), Math.abs(l1 - l2) + EPS, l1 + l2 - EPS);
  const dir = b.clone().sub(a).normalize();

  // 余弦定理求 p0 处夹角
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const ang = Math.acos(cosA);

  // 中间关节 = 在 dir 上的投影 + 垂直偏移(偏移方向朝 pole 一侧)
  const mid = a.clone().addScaledVector(dir, l1 * Math.cos(ang));
  let bend = poleV.clone().sub(a).addScaledVector(dir, -poleV.clone().sub(a).dot(dir));
  if (bend.lengthSq() < 1e-12) {
    // pole 与 dir 平行(退化):任选一个正交方向
    const any = Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    bend = any.clone().addScaledVector(dir, -any.dot(dir));
  }
  bend.normalize();
  const p1 = mid.clone().addScaledVector(bend, l1 * Math.sin(ang));

  return {
    p1,
    upperDir: p1.clone().sub(a).normalize(),
    lowerDir: b.clone().sub(p1).normalize(),
  };
}
