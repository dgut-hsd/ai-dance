/**
 * test/rom.test.js — 验证医学 ROM 常量与姿态运动学约束助手(web_dance/rom.js)。
 *
 * 覆盖:ROM 值合理性、头部 yaw/pitch 分解(decomposeHead)、颈椎 ROM 限幅(clampNeck)、
 * 颈旋四元数重建(neckQuaternion)、腿部髋 ROM 方向约束(clampLegDirection)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  ROM,
  ARM_LIMITS,
  LEG_LIMITS,
  normAngle,
  decomposeHead,
  clampNeck,
  neckQuaternion,
  clampLegDirection,
  clampArmDirection,
  clampLegCoronal,
} from "../web_dance/rom.js";

const RAD = (d) => (d * Math.PI) / 180;
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const FORWARD = new THREE.Vector3().crossVectors(RIGHT, UP); // (0,0,1)

test("T-ROM-1 医学 ROM 常量与派生限位一致", () => {
  assert.ok(Math.abs(ROM.elbowMinBend - RAD(40)) < 1e-9);
  assert.ok(Math.abs(ROM.kneeMinBend - RAD(40)) < 1e-9);
  assert.ok(Math.abs(ROM.elbowMaxBend - RAD(177)) < 1e-9);
  assert.ok(Math.abs(ROM.kneeMaxBend - RAD(177)) < 1e-9);
  assert.ok(Math.abs(ROM.neckYaw - RAD(75)) < 1e-9);
  assert.ok(Math.abs(ROM.neckFlexion - RAD(50)) < 1e-9);
  assert.ok(Math.abs(ROM.neckExtension - RAD(45)) < 1e-9);
  assert.ok(Math.abs(ROM.hipExtension - RAD(30)) < 1e-9);
  assert.ok(Math.abs(ROM.hipFlexion - RAD(125)) < 1e-9);
  assert.ok(Math.abs(ROM.hipAbduction - RAD(45)) < 1e-9);
  assert.equal(ARM_LIMITS.minBend, ROM.elbowMinBend);
  assert.equal(ARM_LIMITS.maxBend, ROM.elbowMaxBend);
  assert.equal(LEG_LIMITS.minBend, ROM.kneeMinBend);
  assert.equal(LEG_LIMITS.maxBend, ROM.kneeMaxBend);
  // 膝 minBend 已从旧 0.55(≈31.5°)收紧到 40°(生理残余内角 35–45° 内)
  assert.ok(LEG_LIMITS.minBend > 0.60, "膝 minBend 应收紧到 ≥ 35° 内角(>2rad 前向)");
});

test("T-HEAD-1 decomposeHead 点头(屈曲)→ pitch>0", () => {
  const N = new THREE.Vector3(0, 0.95, 0.3).normalize(); // 中性:微前倾
  const H = new THREE.Vector3(0, 0.7, 0.7).normalize();  // 更前倾 = 点头
  const { pitch, yaw } = decomposeHead(H, N, UP, RIGHT);
  assert.ok(pitch > 0.2, `点头 pitch 应 >0,got ${pitch}`);
  assert.ok(Math.abs(yaw) < 0.1, `点头不应有 yaw,got ${yaw}`);
});

test("T-HEAD-2 decomposeHead 仰头(后伸)→ pitch<0", () => {
  const N = new THREE.Vector3(0, 0.95, 0.3).normalize();
  const H = new THREE.Vector3(0, 0.99, 0.02).normalize(); // 更少前倾 = 仰头
  const { pitch } = decomposeHead(H, N, UP, RIGHT);
  assert.ok(pitch < -0.1, `仰头 pitch 应 <0,got ${pitch}`);
});

test("T-HEAD-3 decomposeHead 转头(向右)→ yaw>0", () => {
  const N = new THREE.Vector3(0, 0.95, 0.3).normalize();
  const H = new THREE.Vector3(0.25, 0.93, 0.27).normalize(); // 向右偏
  const { yaw } = decomposeHead(H, N, UP, RIGHT);
  assert.ok(yaw > 0.2, `向右转头 yaw 应 >0,got ${yaw}`);
});

test("T-HEAD-4 decomposeHead 中性同向 → pitch/yaw ≈ 0", () => {
  const N = new THREE.Vector3(0, 0.95, 0.3).normalize();
  const { pitch, yaw } = decomposeHead(N.clone(), N, UP, RIGHT);
  assert.ok(Math.abs(pitch) < 1e-6, `pitch got ${pitch}`);
  assert.ok(Math.abs(yaw) < 1e-6, `yaw got ${yaw}`);
});

test("T-HEAD-5 clampNeck 把超界俯仰/偏航钳到颈椎 ROM", () => {
  const c = clampNeck(2.0, -2.0); // 远超 ±范围
  assert.ok(Math.abs(c.pitch - ROM.neckFlexion) < 1e-9);
  assert.ok(Math.abs(c.yaw - (-ROM.neckYaw)) < 1e-9);
});

test("T-HEAD-6 neckQuaternion 重建:零旋转恒等;小角度往返可复现", () => {
  const N = new THREE.Vector3(0, 0.95, 0.3).normalize();
  // 零旋转 → 应用后方向不变
  const q0 = neckQuaternion(0, 0, UP, RIGHT);
  const H0 = N.clone().applyQuaternion(q0);
  assert.ok(H0.distanceTo(N) < 1e-6, "零旋转不应改变方向");

  // 给定 pitch/yaw 重建方向后,分解应近似还原(小角度,容差 0.15 rad)
  const H = N.clone().applyQuaternion(neckQuaternion(0.3, 0.2, UP, RIGHT));
  const { pitch, yaw } = decomposeHead(H, N, UP, RIGHT);
  assert.ok(Math.abs(pitch - 0.3) < 0.15, `往返 pitch 偏差过大:${pitch}`);
  assert.ok(Math.abs(yaw - 0.2) < 0.15, `往返 yaw 偏差过大:${yaw}`);
});

test("T-LEG-1 clampLegDirection 站立(直下)不触发,原样返回", () => {
  const rel = new THREE.Vector3(0, -0.86, 0);
  const out = clampLegDirection(rel, UP, FORWARD, RIGHT);
  assert.ok(out.distanceTo(rel) < 1e-6, "直下站立不应被改动");
  assert.ok(Math.abs(out.length() - rel.length()) < 1e-6, "长度应守恒");
});

test("T-LEG-2 clampLegDirection 腿向后摆超后伸极限被钳回,方向前向分量紧贴边界", () => {
  const rel = new THREE.Vector3(0, -0.6, -0.8); // len=1,向后/向下,前向分量 -0.8 < -sin30
  const out = clampLegDirection(rel, UP, FORWARD, RIGHT);
  const dir = out.clone().normalize();
  const backMax = -Math.sin(ROM.hipExtension);
  // 钳回后前向分量应 == backMax(角度限位严格成立)
  assert.ok(Math.abs(dir.dot(FORWARD) - backMax) < 1e-6, `前向分量应钳到 ${backMax},got ${dir.dot(FORWARD)}`);
  assert.ok(Math.abs(out.length() - rel.length()) < 1e-6, "长度应守恒");
  // 侧向分量守恒(本用例为 0,始终 0)
  assert.ok(Math.abs(dir.dot(RIGHT)) < 1e-9, "不应引入侧向漂移");
});

test("T-LEG-3 clampLegDirection 腿向前高抬不超屈曲极限时不改动", () => {
  const rel = new THREE.Vector3(0, -0.8, 0.6); // 前向分量 0.6 < sin125≈0.819
  const out = clampLegDirection(rel, UP, FORWARD, RIGHT);
  assert.ok(out.distanceTo(rel) < 1e-6, "正常前摆不应被改动");
});

test("T-ROM-2 normAngle 归一化到 (-π,π]", () => {
  assert.ok(Math.abs(normAngle(3 * Math.PI) - Math.PI) < 1e-9);
  assert.ok(Math.abs(normAngle(-3 * Math.PI) - Math.PI) < 1e-9);
  assert.ok(Math.abs(normAngle(2.5) - 2.5) < 1e-9);
});

// ---------------------------------------------------------------------------
// 肩关节立体锥 clampArmDirection / 髋冠状面 clampLegCoronal
// (本会话新增:治「手臂关节弯曲异常 / 腿部轨迹异常 / 交叠穿模」)
// ---------------------------------------------------------------------------

test("T-ARM-1 clampArmDirection 手臂自然下垂(直下)不触发,原样返回", () => {
  const rel = new THREE.Vector3(0, -0.6, 0);
  const out = clampArmDirection(rel, UP, FORWARD, RIGHT, +1);
  assert.ok(out.distanceTo(rel) < 1e-6, "直下手臂不应被改动");
  assert.ok(Math.abs(out.length() - rel.length()) < 1e-6, "长度应守恒");
});

test("T-ARM-2 clampArmDirection 上臂向后摆超后伸极限被钳回(前向分量贴 −sin60)", () => {
  // 方向后摆:前向分量 −0.95 < −sin60(≈−0.866),侧向 0(右臂,sideSign +1)
  const rel = new THREE.Vector3(0, 0.32, -0.95).normalize().multiplyScalar(0.9);
  const out = clampArmDirection(rel, UP, FORWARD, RIGHT, +1);
  const dir = out.clone().normalize();
  const backMax = -Math.sin(ROM.shoulderExtension);
  assert.ok(Math.abs(dir.dot(FORWARD) - backMax) < 1e-6,
    `前向分量应钳到 ${backMax},got ${dir.dot(FORWARD)}`);
  assert.ok(Math.abs(dir.dot(RIGHT)) < 1e-9, "本用例不应引入侧向");
  assert.ok(Math.abs(out.length() - rel.length()) < 1e-6, "长度应守恒");
});

test("T-ARM-3 clampArmDirection 上臂跨过中线(内收超上限)被钳回", () => {
  // 右臂(sideSign +1)重度探向对侧:自身侧向分量 ≈ −0.95 < −sin(内收上限)
  const rel = new THREE.Vector3(-0.95, 0.28, 0.15).normalize().multiplyScalar(0.7);
  const out = clampArmDirection(rel, UP, FORWARD, RIGHT, +1);
  const dir = out.clone().normalize();
  const addMax = -Math.sin(ROM.shoulderAdduction);
  assert.ok(Math.abs(dir.dot(RIGHT) * 1 - addMax) < 1e-6,
    `自身侧向分量应钳到 ${addMax},got ${dir.dot(RIGHT)}`);
  assert.ok(Math.abs(out.length() - rel.length()) < 1e-6, "长度应守恒");
});

test("T-ARM-4 clampArmDirection 左臂(sideSign −1)镜像对称:内收符号正确", () => {
  // 左臂(sideSign −1)探向自身对侧(= 向右,+x):dL = dir·R×(−1) 应变负并触发内收钳
  const rel = new THREE.Vector3(0.95, 0.28, 0.15).normalize().multiplyScalar(0.7);
  const out = clampArmDirection(rel, UP, FORWARD, RIGHT, -1);
  const dir = out.clone().normalize();
  const addMax = -Math.sin(ROM.shoulderAdduction);
  // 自身侧向 = dir·R × sideSign,应为内收下限
  assert.ok(Math.abs(dir.dot(RIGHT) * -1 - addMax) < 1e-6,
    `左臂自身侧向分量应钳到 ${addMax},got ${dir.dot(RIGHT) * -1}`);
  // 且世界侧向(+x)应仍为正(腿/臂在身体右侧)
  assert.ok(dir.dot(RIGHT) > 0, "左臂探向右侧应保持 +x 侧向为正");
});

test("T-LEG-C1 clampLegCoronal 腿过度外展(侧抬 > 45°)被钳回", () => {
  // 右腿(sideSign +1)侧抬:dL = dir·R ≈ 0.77 > sin45(≈0.707)
  const rel = new THREE.Vector3(0.8, -0.5, 0.33).normalize().multiplyScalar(0.8);
  const out = clampLegCoronal(rel, UP, FORWARD, RIGHT, +1);
  const dir = out.clone().normalize();
  const abdMax = Math.sin(ROM.hipAbduction);
  assert.ok(Math.abs(dir.dot(RIGHT) - abdMax) < 1e-6,
    `侧向分量应钳到 ${abdMax},got ${dir.dot(RIGHT)}`);
  assert.ok(Math.abs(out.length() - rel.length()) < 1e-6, "长度应守恒");
});

test("T-LEG-C2 clampLegCoronal 腿过度内收(跨中线 > 30°)被钳回", () => {
  // 右腿(sideSign +1)跨向对侧:dL = dir·R ≈ −0.7 < −sin30(≈−0.5)
  const rel = new THREE.Vector3(-0.7, -0.58, 0.41).normalize().multiplyScalar(0.8);
  const out = clampLegCoronal(rel, UP, FORWARD, RIGHT, +1);
  const dir = out.clone().normalize();
  const addMax = -Math.sin(ROM.hipAdduction);
  assert.ok(Math.abs(dir.dot(RIGHT) - addMax) < 1e-6,
    `内收侧向分量应钳到 ${addMax},got ${dir.dot(RIGHT)}`);
  assert.ok(Math.abs(out.length() - rel.length()) < 1e-6, "长度应守恒");
});

test("T-LEG-C3 clampLegCoronal 站立(直下)不触发,原样返回", () => {
  const rel = new THREE.Vector3(0, -0.86, 0);
  const out = clampLegCoronal(rel, UP, FORWARD, RIGHT, +1);
  assert.ok(out.distanceTo(rel) < 1e-6, "直下站立不应被改动");
});