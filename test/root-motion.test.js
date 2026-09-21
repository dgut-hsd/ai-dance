/**
 * test/root-motion.test.js — 验证根运动通道(RootMotionTracker)。
 *
 * 方案 C:髋中点速度(有限差分)+ 地面接触(最低脚踝 vs 地面估计)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { RootMotionTracker } from "../pose_capture/root-motion.js";

// 构造命名关节点:双脚踝同高,便于单独控制地面/腾空
function joints(hips, ankleY) {
  return {
    hips_center: hips,
    left_ankle: [0, ankleY, 0],
    right_ankle: [0, ankleY, 0],
  };
}

test("根速度 = 髋中点相邻帧差分(米/秒)", () => {
  const tr = new RootMotionTracker();
  // 首帧:建立上一帧,无速度
  let r = tr.update(joints([0, 0, 0], -0.9), 0.0);
  assert.deepEqual(r.rootVel, [0, 0, 0]);

  // 第二帧:髋向右上各移动 0.1m,dt=0.1s → 速度 (1, 1, 0) m/s
  r = tr.update(joints([0.1, 0.1, 0], -0.9), 0.1);
  assert.deepEqual(r.rootVel, [1, 1, 0]);
});

test("双脚踝贴地 → grounded=true", () => {
  const tr = new RootMotionTracker();
  tr.update(joints([0, 0, 0], -0.9), 0.0);
  tr.update(joints([0, 0, 0], -0.9), 0.1);
  const r = tr.update(joints([0, 0, 0], -0.9), 0.2);
  assert.equal(r.grounded, true);
});

test("双脚踝离地(跳跃)→ grounded=false", () => {
  const tr = new RootMotionTracker();
  // 先建立地面
  tr.update(joints([0, 0, 0], -0.9), 0.0);
  tr.update(joints([0, 0, 0], -0.9), 0.1);
  // 髋上跳 0.8m,双脚踝同时离地
  const r = tr.update(joints([0, 0.8, 0], 0.1), 0.2);
  assert.equal(r.grounded, false);
});

test("间隔过大(丢帧)速度清零,避免尖峰", () => {
  const tr = new RootMotionTracker();
  tr.update(joints([0, 0, 0], -0.9), 0.0);
  // dt=1.0s > maxDt(0.1s),即使位移很大也清零速度
  const r = tr.update(joints([1, 0, 0], -0.9), 1.0);
  assert.deepEqual(r.rootVel, [0, 0, 0]);
});

test("reset() 后重新建立地面与速度", () => {
  const tr = new RootMotionTracker();
  tr.update(joints([0, 0, 0], -0.9), 0.0);
  tr.update(joints([0, 0.5, 0], 0.5), 0.1);
  tr.reset();
  // reset 后首帧无速度、地面重新建立
  const r = tr.update(joints([0, 0, 0], -0.9), 5.0);
  assert.deepEqual(r.rootVel, [0, 0, 0]);
  assert.equal(r.grounded, true);
});
