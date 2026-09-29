/**
 * test/collision.test.js — 验证胶囊碰撞检测与几何推开(web_dance/collision.js)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  closestSegmentPoints,
  capsulePenetration,
  separateCapsulePairs,
} from "../web_dance/collision.js";

test("T-COL-1 closestSegmentPoints 平行线段取垂线最近点", () => {
  // 两水平线段,竖直相隔 2
  const a0 = new THREE.Vector3(0, 0, 0);
  const a1 = new THREE.Vector3(4, 0, 0);
  const b0 = new THREE.Vector3(0, 2, 0);
  const b1 = new THREE.Vector3(4, 2, 0);
  const { pa, pb } = closestSegmentPoints(a0, a1, b0, b1);
  assert.ok(Math.abs(pa.x - pb.x) < 1e-9, "最近点应竖直对齐");
  assert.ok(Math.abs(pa.y) < 1e-9 && Math.abs(pb.y - 2) < 1e-9, "最近点应落在各自线段上");
  assert.ok(Math.abs(pa.distanceTo(pb) - 2) < 1e-9, "距离应为 2");
});

test("T-COL-2 closestSegmentPoints 交叉线段取交点", () => {
  const a0 = new THREE.Vector3(-1, 0, 0);
  const a1 = new THREE.Vector3(1, 0, 0);
  const b0 = new THREE.Vector3(0, -1, 0);
  const b1 = new THREE.Vector3(0, 1, 0);
  const { pa, pb } = closestSegmentPoints(a0, a1, b0, b1);
  assert.ok(pa.distanceTo(pb) < 1e-9, "交叉线段最近点应重合(交点)");
  assert.ok(Math.abs(pa.x) < 1e-9 && Math.abs(pa.y) < 1e-9, "交点应在原点");
});

test("T-COL-3 closestSegmentPoints 端点最近(不相交)", () => {
  const a0 = new THREE.Vector3(0, 0, 0);
  const a1 = new THREE.Vector3(1, 0, 0);
  const b0 = new THREE.Vector3(0, 0, 2);
  const b1 = new THREE.Vector3(0, 0, 5);
  const { pa, pb } = closestSegmentPoints(a0, a1, b0, b1);
  assert.ok(Math.abs(pa.distanceTo(pb) - 2) < 1e-9, "最近距离应为 2(a0 到 b0)");
  assert.ok(pa.distanceTo(a0) < 1e-9 && pb.distanceTo(b0) < 1e-9, "最近点应在端点 a0/b0");
});

test("T-COL-4 capsulePenetration 相交球体返回正向 overlap 与分离轴", () => {
  const A = { p0: new THREE.Vector3(0, 0, 0), p1: new THREE.Vector3(0, 0, 0), r: 1 };
  const B = { p0: new THREE.Vector3(1, 0, 0), p1: new THREE.Vector3(1, 0, 0), r: 1 };
  const pen = capsulePenetration(A, B);
  assert.ok(pen.overlap > 0, `应相交,overlap 应 >0,got ${pen.overlap}`);
  assert.ok(Math.abs(pen.overlap - 1) < 1e-6, `两个半径1球心距1,overlap 应为 1,got ${pen.overlap}`);
  assert.ok(Math.abs(pen.normal.x - 1) < 1e-6, "分离轴应沿 +x(A→B)");
});

test("T-COL-5 capsulePenetration 不相交返回负 overlap", () => {
  const A = { p0: new THREE.Vector3(0, 0, 0), p1: new THREE.Vector3(0, 0, 0), r: 0.5 };
  const B = { p0: new THREE.Vector3(3, 0, 0), p1: new THREE.Vector3(3, 0, 0), r: 0.5 };
  assert.ok(capsulePenetration(A, B).overlap < 0, "不相交 overlap 应 <0");
});

test("T-COL-6 separateCapsulePairs 把可动胶囊从固定胶囊里推出", () => {
  // 固定胶囊沿 x=0;可动胶囊初始穿透其中
  const fixed = { p0: new THREE.Vector3(0, -1, 0), p1: new THREE.Vector3(0, 1, 0), r: 0.5, movable0: false, movable1: false };
  const mov = { p0: new THREE.Vector3(0.4, -1, 0), p1: new THREE.Vector3(0.4, 1, 0), r: 0.5, movable0: true, movable1: true };
  const before = capsulePenetration(fixed, mov).overlap;
  assert.ok(before > 0, "初始应相交");

  separateCapsulePairs([fixed, mov], [[0, 1]], { iterations: 8, pushFactor: 0.6 });

  // 几何松弛迭代后应近似分离(残留 overlap 已收敛到极小)
  assert.ok(capsulePenetration(fixed, mov).overlap < 0.05, "推开后应近似分离");
  // 固定胶囊未移动
  assert.ok(Math.abs(fixed.p0.x) < 1e-9 && Math.abs(fixed.p1.x) < 1e-9, "固定胶囊不应移动");
  // 可动胶囊整体向右(远离)移动
  assert.ok(mov.p0.x > 0.4 && mov.p1.x > 0.4, `可动胶囊应向右推出,got ${mov.p0.x}`);
});

test("T-COL-7 separateCapsulePairs 共享关节(肘)随段一起移动且保持引用一致", () => {
  // 前臂(肘→腕,两端可动)从躯干胶囊里被推出;肘是共享 Vector3,亦是「上臂」的末端。
  const torso = { p0: new THREE.Vector3(0, 0, 0), p1: new THREE.Vector3(0, 2, 0), r: 0.5, movable0: false, movable1: false };
  const elbow = new THREE.Vector3(0.4, 0.6, 0);
  const wrist = new THREE.Vector3(0.4, 1.4, 0);
  const forearm = { p0: elbow, p1: wrist, r: 0.2, movable0: true, movable1: true };

  // 「上臂」末端 = 同一 elbow 对象(共享关节)
  const upperP1 = elbow;
  const elbowBefore = elbow.clone();

  separateCapsulePairs([torso, forearm], [[0, 1]], { iterations: 6, pushFactor: 0.6 });

  // 肘(共享对象)应随前臂被推出(+x 增大),且 upperP1 与 forearm.p0 仍为同一引用
  assert.ok(forearm.p0 === upperP1, "肘须为共享引用");
  assert.ok(forearm.p0.x > elbowBefore.x, "肘应被向右推出");
  assert.ok(wrist.x > 0.4, "腕应被向右推出");
  // 躯干不动
  assert.ok(Math.abs(torso.p0.x) < 1e-9 && Math.abs(torso.p1.x) < 1e-9, "躯干不应移动");
  // 前臂不再穿躯干
  const pen = capsulePenetration(torso, forearm);
  assert.ok(pen.overlap < 0.05, `前臂仍穿躯干:overlap=${pen.overlap}`);
});