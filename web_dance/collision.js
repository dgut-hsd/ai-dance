/**
 * collision.js — 胶囊碰撞检测 + 轻量几何推开(纯函数,可单测)。
 *
 * 目的:解决舞蹈动作中「交叠穿模」(手臂穿透躯干/头、双腿相互穿插)。在 IK 之后,把肢体
 * 抽象为「胶囊」(线段 + 半径),与躯干/头等固定胶囊做最小平移分离,再把位移写回关节方向。
 *
 * 单元约定:
 *   - 胶囊 = { p0: Vector3, p1: Vector3, r: number }。p0/p1 可被替换,但为支持「共享关节」,
 *     separateCapsulePairs 假定 p0/p1 是共享的 Vector3 引用(如肘 = 上臂 p1 = 前臂 p0),
 *     从而只改端点坐标即可让相邻段自动保持一致。
 *   - 分离把重叠量 overlap 按最近点在线段上的参数 t 分配到两端点的可动权重上。
 */

import * as THREE from "three";

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * 线段–线段最近点(经典解析解,含端点夹取)。
 * @returns {{pa: THREE.Vector3, pb: THREE.Vector3}} 两线段上距离最近的点
 */
export function closestSegmentPoints(a0, a1, b0, b1) {
  const d1 = a1.clone().sub(a0);
  const d2 = b1.clone().sub(b0);
  const r = a0.clone().sub(b0);
  const a = d1.lengthSq();
  const e = d2.lengthSq();
  const f = r.dot(d2);
  const EPS = 1e-10;
  let s = 0;
  let t = 0;

  if (a <= EPS && e <= EPS) {
    return { pa: a0.clone(), pb: b0.clone() };
  }
  if (a <= EPS) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = r.dot(d1);
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  return {
    pa: a0.clone().addScaledVector(d1, s),
    pb: b0.clone().addScaledVector(d2, t),
  };
}

/**
 * 胶囊穿透检测。overlap > 0 表示两胶囊相交;normal 为「A → B」方向的单位分离轴。
 * @returns {{overlap:number, normal:THREE.Vector3, pa:THREE.Vector3, pb:THREE.Vector3}}
 */
export function capsulePenetration(capA, capB) {
  const { pa, pb } = closestSegmentPoints(capA.p0, capA.p1, capB.p0, capB.p1);
  const delta = pb.clone().sub(pa);
  const d = delta.length();
  const overlap = capA.r + capB.r - d;

  let normal;
  if (d > 1e-9) {
    normal = delta.clone().normalize();
  } else {
    // 线段几乎重合/共点:用两胶囊中心连线的方向兜底,再退化到 +Y。
    const cA = capA.p0.clone().add(capA.p1).multiplyScalar(0.5);
    const cB = capB.p0.clone().add(capB.p1).multiplyScalar(0.5);
    normal = cB.clone().sub(cA);
    if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
    else normal.normalize();
  }
  return { overlap, normal, pa, pb };
}

/**
 * 把一段胶囊沿 dir 推开 amount:所有可动端点整体平移 amount(固定端点不动)。
 * 端点为共享 Vector3 引用,就地修改;相邻段共享的关节点会随同一对象一起移动。
 */
function distribute(cap, dir, amount) {
  if (cap.movable0) cap.p0.addScaledVector(dir, amount);
  if (cap.movable1) cap.p1.addScaledVector(dir, amount);
}

/**
 * 对给定胶囊对做若干轮最小平移分离(就地修改可动端点,共享关节自动一致)。
 *
 * @param {Array<{p0:Vector3,p1:Vector3,r:number,movable0?:boolean,movable1?:boolean}>} capsules
 * @param {Array<[number,number]>} pairs 需要检测的胶囊下标对
 * @param {{iterations?:number, pushFactor?:number, margin?:number}} [opts]
 *   iterations 迭代轮数(稳定收敛);pushFactor 每轮推开量占比(0..1,防过冲);margin 最小间隙。
 */
export function separateCapsulePairs(capsules, pairs, opts = {}) {
  const { iterations = 3, pushFactor = 0.5, margin = 0 } = opts;
  for (let it = 0; it < iterations; it++) {
    for (const [ia, ib] of pairs) {
      const A = capsules[ia];
      const B = capsules[ib];
      const { overlap, normal } = capsulePenetration(A, B);
      if (overlap <= margin) continue;
      // 只推「超出允许量的那一部分」:允许量用来放过"衣服本来就会互相贴住/轻微压住"的情况
      // (目标的衣服比源厚,源里正常的贴身姿势在目标上就是袖子压进外套 —— 全推会把姿势推歪)。
      const amount = (overlap - margin) * pushFactor;
      // A 沿 −normal、B 沿 +normal 相互推开
      distribute(A, normal.clone().negate(), amount);
      distribute(B, normal, amount);
    }
  }
}