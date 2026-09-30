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

/**
 * 两骨 IK 求解。
 *
 * opts:
 *  - limits: { minBend, maxBend } 肘/膝「夹角 γ」的生理范围(rad)。
 *      γ = 中间关节处的夹角:π=完全伸直,0=完全折叠。
 *      通过夹取目标距离 d 把解限制在关节可行域内,消除反折/超生理折叠。
 *  - hint: 上一帧中间关节的世界位置。近伸直/退化时 pole 会在帧间翻转,
 *      用 hint 选「离上一帧更近」的镜像解,保证肘/膝弯折方向时序连续。
 *  - gammaHint / gammaMaxStep: 上一帧折叠角 γ 与单帧最大变化量(rad)。用于 S4 时序平滑,
 *      在生理限位内进一步限制 γ 的帧间跳变,吃掉单帧尖峰(如末端假性过近)而保留连续深屈。
 */
export function solveTwoBone(p0, p2, l1, l2, pole, opts = {}) {
  const { limits = null, hint = null, gammaHint = null, gammaMaxStep = null } = opts;
  const a = new THREE.Vector3().copy(p0);
  const b = new THREE.Vector3().copy(p2);
  const poleV = new THREE.Vector3().copy(pole);

  // 方向:由根指向实际末端目标
  const dir = b.clone().sub(a);
  if (dir.lengthSq() < 1e-12) {
    // 目标与根重合,无法确定方向:退回沿 +Y 的伸直解
    const up = new THREE.Vector3(0, 1, 0);
    return { p1: a.clone().addScaledVector(up, l1), upperDir: up.clone(), lowerDir: up.clone(), gamma: Math.PI };
  }
  dir.normalize();

  // 夹取目标距离到可达区间(几何可达 + 生理限位,避免 NaN / 完全伸直导致的方向退化)。
  let d = clamp(a.distanceTo(b), Math.abs(l1 - l2) + EPS, l1 + l2 - EPS);
  if (limits) {
    //   cos γ = (l1² + l2² − d²) / (2·l1·l2)，γ 与 d 正相关(越直 d 越大)。
    //   γ ≤ maxBend → d ≤ sqrt(l1²+l2²−2·l1·l2·cos(maxBend))   (伸直端,d 上限)
    //   γ ≥ minBend → d ≥ sqrt(l1²+l2²−2·l1·l2·cos(minBend))   (折叠端,d 下限)
    const dMin = Math.sqrt(l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(limits.minBend));
    const dMax = Math.sqrt(l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(limits.maxBend));
    d = clamp(d, dMin, dMax);
    // S4 γ 时序平滑:在生理限位基础上限制折叠角帧间变化率(gammaMaxStep),
    // 吃掉单帧尖峰(如末端假性过近)、保留连续快速深屈。
    let gamma = Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
    if (gammaHint != null && gammaMaxStep != null) {
      gamma = clamp(gamma, gammaHint - gammaMaxStep, gammaHint + gammaMaxStep);
    }
    gamma = clamp(gamma, limits.minBend, limits.maxBend);
    d = Math.sqrt(l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(gamma));
  }
  // 夹取后按可达距离重新定位目标点,保证骨长守恒在 clamp 后依然成立(|p1−a|=l1、|target−p1|=l2)。
  const target = a.clone().addScaledVector(dir, d);

  // 余弦定理求 p0 处夹角
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const ang = Math.acos(cosA);

  // 中间关节 = 在 dir 上的投影 + 垂直偏移(偏移方向朝 pole 一侧)
  const mid = a.clone().addScaledVector(dir, l1 * Math.cos(ang));
  const poleOffset = poleV.clone().sub(a);
  let bend = poleOffset.clone().addScaledVector(dir, -poleOffset.dot(dir));
  // pole 是否能给出弯折方向(它相对 a 有垂直于 dir 的分量)。退化时才允许用 hint 兜底。
  const poleGivesDir = bend.lengthSq() > 1e-12;
  if (!poleGivesDir) {
    // S2 退化:pole 与 dir 平行(如膝点落在关节连线上)。优先用上一帧 hint 的侧向偏移
    // 锁定弯折方向(增强伸直态方向连续),再回退到任选正交方向。
    if (hint) bend = hint.clone().sub(mid);
    if (bend.lengthSq() < 1e-12) {
      const any = Math.abs(dir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      bend = any.clone().addScaledVector(dir, -any.dot(dir));
    }
  }
  bend.normalize();

  // 弯折幅度(沿 bend 法向的偏移量)
  const off = l1 * Math.sin(ang);
  let p1 = mid.clone().addScaledVector(bend, off);

  // 时序连续:取离上一帧中间关节更近的镜像解 —— 但**只在 pole 给不出方向时**才这么做。
  // 之前无条件按 hint 选边:源动作快速摆到另一侧时,hint(上一帧的肘/膝)离镜像解更近,
  // 关节就被锁在**反侧**并持续数帧(实测:前踢腿被摆到身后 100°,连续 4+ 帧)。
  if (hint && !poleGivesDir) {
    const alt = mid.clone().addScaledVector(bend, -off);
    if (alt.distanceTo(hint) < p1.distanceTo(hint)) p1 = alt;
  }

  return {
    p1,
    upperDir: p1.clone().sub(a).normalize(),
    lowerDir: target.clone().sub(p1).normalize(),
    // 折叠角 γ(=中间关节处夹角),供消费端作为下一帧 gammaHint 做时序平滑
    gamma: Math.acos(clamp(-p1.clone().sub(a).normalize().dot(target.clone().sub(p1).normalize()), -1, 1)),
  };
}
