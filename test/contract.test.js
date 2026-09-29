/**
 * test/contract.test.js — 验证肩轴(shoulderAxis)/朝向相关契约函数。
 *
 * 覆盖动作优化测试计划中的 T-TURN-1(computeShoulderAxis 正确性)。
 * canonical 坐标: x=右, y=上, z=朝镜头。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeShoulderAxis, constrainLimbDepth } from "../pose_capture/contract.js";

function assertVecClose(actual, expected, eps = 1e-6, msg = "") {
  assert.equal(actual.length, expected.length, msg);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < eps,
      `${msg} 分量${i}: ${actual[i]} ≈ ${expected[i]} (eps=${eps})`);
  }
}

// 水平投影偏航:身体朝向角 = atan2(z, x)
function yawOf(axis) {
  return Math.atan2(axis[2], axis[0]);
}
// 躯干侧倾(roll):肩轴相对水平面的夹角
function rollOf(axis) {
  return Math.atan2(axis[1], Math.hypot(axis[0], axis[2]));
}
// 归一化角度到 (-π, π]
function normAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

test("T-TURN-1a 面朝无侧倾 → 单位肩轴 (1,0,0)、偏航 0、roll 0", () => {
  const axis = computeShoulderAxis({
    left_shoulder: [-0.2, 1.4, 0],
    right_shoulder: [0.2, 1.4, 0],
  });
  assertVecClose(axis, [1, 0, 0]);
  assert.ok(Math.abs(yawOf(axis)) < 1e-6, `偏航应为 0,got ${yawOf(axis)}`);
  assert.ok(Math.abs(rollOf(axis)) < 1e-6, `roll 应为 0,got ${rollOf(axis)}`);
});

test("T-TURN-1b 转身 → 肩轴水平投影偏航随身体转动 ~90°", () => {
  const front = computeShoulderAxis({ left_shoulder: [-0.2, 1.4, 0], right_shoulder: [0.2, 1.4, 0] });
  const turned = computeShoulderAxis({ left_shoulder: [0, 1.4, 0.2], right_shoulder: [0, 1.4, -0.2] });
  const delta = Math.abs(normAngle(yawOf(turned) - yawOf(front)));
  assert.ok(Math.abs(delta - Math.PI / 2) < 1e-6, `偏航差应为 90°,got ${delta}rad`);
});

test("T-TURN-1c 侧倾 → shoulderAxis.y 分量反映 roll 符号", () => {
  // 右肩低于左肩(向一侧倾斜)→ roll 为负
  const lean = computeShoulderAxis({ left_shoulder: [-0.2, 1.5, 0], right_shoulder: [0.2, 1.3, 0] });
  assert.ok(lean[1] < 0, `侧倾时 y 分量应为负,got ${lean[1]}`);
  assert.ok(rollOf(lean) < 0, `侧倾 roll 应为负,got ${rollOf(lean)}`);
  assert.ok(Math.abs(Math.hypot(lean[0], lean[1], lean[2]) - 1) < 1e-6, "肩轴应为单位向量");
});

test("T-TURN-1d 退化(双肩重合)→ 返回 null", () => {
  const axis = computeShoulderAxis({ left_shoulder: [0.2, 1.4, 0], right_shoulder: [0.2, 1.4, 0] });
  assert.equal(axis, null);
});

// 3D 关节夹角(顶点 mid 处),用于 T-DEPTH 用例
function angle3(root, mid, end) {
  const u = [root[0] - mid[0], root[1] - mid[1], root[2] - mid[2]];
  const v = [end[0] - mid[0], end[1] - mid[1], end[2] - mid[2]];
  const lu = Math.hypot(...u), lv = Math.hypot(...v);
  return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv))));
}
const lm = (x, y) => ({ x, y, z: 0, visibility: 1, presence: 1 });

test("T-DEPTH-1 深度约束:3D 折叠过深时用 2D 夹角抬升、前臂长守恒", () => {
  const img = Array.from({ length: 33 }, () => lm(0, 0));
  img[11] = lm(0.4, 0.5);  // left_shoulder
  img[13] = lm(0.55, 0.5); // left_elbow
  img[15] = lm(0.55, 0.7); // left_wrist(2D 夹角 ≈ 90°)

  const joints = {
    left_shoulder: [0, 0, 0],
    left_elbow: [0.3, 0, 0],
    left_wrist: [0.05, 0.2, 0], // 3D 肘夹角 ≈ 0.67rad(过度折叠)
  };

  const before = angle3(joints.left_shoulder, joints.left_elbow, joints.left_wrist);
  assert.ok(before < 0.9, `前置:3D 应过度折叠,got ${before}`);

  const out = constrainLimbDepth(joints, img);
  const after = angle3(out.left_shoulder, out.left_elbow, out.left_wrist);
  assert.ok(after > before + 0.1, `修正后夹角应抬升:${before} → ${after}`);
  assert.ok(after > 0.9, `修正后夹角应摆脱过度折叠,got ${after}`);

  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(Math.abs(len(joints.left_wrist, joints.left_elbow) - len(out.left_wrist, out.left_elbow)) < 1e-6,
    "修正前后前臂长度应守恒(|E'-M| == |E-M|)");
});

test("T-DEPTH-2 深度约束:3D 未过度折叠时不修正", () => {
  const img = Array.from({ length: 33 }, () => lm(0, 0));
  img[11] = lm(0.4, 0.5);
  img[13] = lm(0.55, 0.5);
  img[15] = lm(0.55, 0.7);

  // 3D 里肘近伸直(夹角大),不应被修正
  const joints = {
    left_shoulder: [0, 0, 0],
    left_elbow: [0.3, 0, 0],
    left_wrist: [0.58, 0, 0], // 沿 +x 伸直
  };
  const out = constrainLimbDepth(joints, img);
  assert.deepEqual(out, joints, "未触发时不应改动 joints");
});