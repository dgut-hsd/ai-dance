/**
 * test/ik.test.js — 验证两骨 IK 求解 solveTwoBone 的关节限位与解连续性。
 *
 * 覆盖动作优化测试计划中的 T-ARM-1~T-ARM-5(手臂/腿弯曲修复)。
 * 直接调用 solveTwoBone,并用与 web_dance/retarget.js 相同的限位常量驱动,
 * 锁定「肘/膝可弯曲、不反折、不 flip」的数值正确性。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { solveTwoBone } from "../web_dance/ik.js";
// 单一权威来源:web_dance/rom.js 统一提供医学 ROM 限位(避免测试与实现漂移)。
import { ARM_LIMITS, LEG_LIMITS } from "../web_dance/rom.js";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// 肘/膝夹角 γ:π = 完全伸直,0 = 完全折叠。γ = acos(−upperDir · lowerDir)
function jointAngle(upperDir, lowerDir) {
  return Math.acos(clamp(-upperDir.dot(lowerDir), -1, 1));
}

// 无 hint 的便捷求解
function solve(p0, p2, l1, l2, pole, limits) {
  return solveTwoBone(p0, p2, l1, l2, pole, { limits, hint: null });
}

test("T-ARM-1 关节限位:任意目标距离下解合法、不 NaN、γ∈[minBend,maxBend]", () => {
  const l1 = 0.3, l2 = 0.3;
  const p0 = new THREE.Vector3();
  const pole = new THREE.Vector3(0, 0.3, 0);
  for (let d = 0; d <= 0.8; d += 0.02) {
    const p2 = new THREE.Vector3(d, 0.03, 0);
    const sol = solve(p0, p2, l1, l2, pole, ARM_LIMITS);
    assert.ok([sol.p1.x, sol.p1.y, sol.p1.z].every(Number.isFinite), `p1 含 NaN/Inf @d=${d}`);
    // 上骨长恒守恒(中间关节按 l1 构造)
    assert.ok(Math.abs(sol.p1.distanceTo(p0) - l1) < 1e-4, `上骨长偏差 @d=${d}`);
    // 方向向量为单位向量
    assert.ok(Math.abs(sol.upperDir.length() - 1) < 1e-6, `upperDir 非单位 @d=${d}`);
    assert.ok(Math.abs(sol.lowerDir.length() - 1) < 1e-6, `lowerDir 非单位 @d=${d}`);
    // 生理限位
    const g = jointAngle(sol.upperDir, sol.lowerDir);
    assert.ok(g >= ARM_LIMITS.minBend - 1e-3 && g <= ARM_LIMITS.maxBend + 1e-3, `γ=${g} 越界 @d=${d}`);
  }
});

test("T-ARM-1b 可达目标:两骨长均严格守恒", () => {
  const l1 = 0.3, l2 = 0.3;
  const p0 = new THREE.Vector3();
  const pole = new THREE.Vector3(0, 1, 0);
  for (const d of [0.3, 0.4, 0.5]) { // 均在 [dMin,dMax] 内 → 目标可达,骨长守恒
    const p2 = new THREE.Vector3(d, 0, 0);
    const sol = solve(p0, p2, l1, l2, pole, ARM_LIMITS);
    assert.ok(Math.abs(sol.p1.distanceTo(p0) - l1) < 1e-4, `上骨长 @d=${d}`);
    assert.ok(Math.abs(sol.p1.distanceTo(p2) - l2) < 1e-4, `下骨长 @d=${d}`);
  }
});

test("T-ARM-2 过度弯曲防护:腕目标假性过近被钳到肘关节生理限位(minBend≈0.70rad≈40°)", () => {
  const l1 = 0.3, l2 = 0.3;
  const p0 = new THREE.Vector3();
  const pole = new THREE.Vector3(0, 0.3, 0);
  const p2 = new THREE.Vector3(0.02, 0, 0); // 目标极近 → 应被限位钳到最折(minBend)

  const sol = solve(p0, p2, l1, l2, pole, ARM_LIMITS);
  const g = jointAngle(sol.upperDir, sol.lowerDir);
  // γ 不应突破肘关节生理屈曲极限(残余内角约 40° → γ≈0.70),拒绝非生理的过度折叠
  assert.ok(Math.abs(g - ARM_LIMITS.minBend) < 1e-3, `γ=${g} 应钳到 minBend=${ARM_LIMITS.minBend},而非更深折叠`);
});

test("T-ARM-3 解连续性:伸直退化时 hint 阻止镜像 flip", () => {
  const l1 = 0.3, l2 = 0.3;
  const p0 = new THREE.Vector3();
  // 帧1:正常折叠,肘朝 +y
  const s1 = solveTwoBone(p0, new THREE.Vector3(0.3, 0.3, 0), l1, l2, new THREE.Vector3(0, 0.3, 0), { limits: ARM_LIMITS, hint: null });
  assert.ok(s1.p1.y > 0, "折叠帧肘应朝 +y");
  // 帧2:近伸直且 pole 与 dir 平行(退化),hint = 帧1 中间关节 → 应保持 +y 侧而非跳到镜像
  const s2 = solveTwoBone(p0, new THREE.Vector3(0.59, 0, 0), l1, l2, new THREE.Vector3(10, 0, 0), { limits: ARM_LIMITS, hint: s1.p1 });
  assert.ok(s2.p1.y >= 0, `退化帧肘回折到负侧(y=${s2.p1.y}),hint 未保持弯折方向连续`);
});

test("T-ARM-4 伸直态 + 退化 pole 不抛错、γ 逼近伸直", () => {
  const l1 = 0.3, l2 = 0.3;
  const p0 = new THREE.Vector3();
  const sol = solveTwoBone(p0, new THREE.Vector3(0.6, 0, 0), l1, l2, new THREE.Vector3(5, 0, 0), { limits: ARM_LIMITS, hint: null });
  assert.ok([sol.p1.x, sol.p1.y, sol.p1.z].every(Number.isFinite), "伸直态不应产出 NaN");
  const g = jointAngle(sol.upperDir, sol.lowerDir);
  assert.ok(g > 2.9, `γ=${g} 应逼近伸直(maxBend=π*0.985≈3.09)`);
});

test("T-ARM-5 腿限位:γ∈[minBend,maxBend]、可锁直、不反折", () => {
  const l1 = 0.44, l2 = 0.42;
  const p0 = new THREE.Vector3();
  const pole = new THREE.Vector3(0, 0.3, 0);
  for (let d = 0; d <= 1.0; d += 0.02) {
    const p2 = new THREE.Vector3(d, 0.03, 0);
    const sol = solve(p0, p2, l1, l2, pole, LEG_LIMITS);
    assert.ok([sol.p1.x, sol.p1.y, sol.p1.z].every(Number.isFinite), `p1 含 NaN/Inf @d=${d}`);
    const g = jointAngle(sol.upperDir, sol.lowerDir);
    assert.ok(g >= LEG_LIMITS.minBend - 1e-3 && g <= LEG_LIMITS.maxBend + 1e-3, `γ=${g} 越界 @d=${d}`);
  }
  // 伸直可达(膝盖可锁直):目标足够远 → γ≈π
  const s = solve(p0, new THREE.Vector3(1.0, 0, 0), l1, l2, pole, LEG_LIMITS);
  const g = jointAngle(s.upperDir, s.lowerDir);
  assert.ok(g > 3.05 && g <= Math.PI, `γ=${g} 腿应可近至锁直(≈maxBend=π*0.985≈3.09)但不反折`);
});

test("T-ARM-6 过度弯曲回归:末端假性过近时 γ 永不跌破生理下限", () => {
  const p0 = new THREE.Vector3();
  const pole = new THREE.Vector3(0, 0.3, 0);
  // 臂/腿两套限位,扫「极近→极远」全距离,γ 恒 >= minBend(「γ 不得低于生理下限」S5)
  for (const [limbLimits, l1, l2] of [[ARM_LIMITS, 0.3, 0.3], [LEG_LIMITS, 0.44, 0.42]]) {
    for (let d = 0.001; d <= (l1 + l2) * 1.2; d += 0.03) {
      const sol = solve(p0, new THREE.Vector3(d, 0.01, 0), l1, l2, pole, limbLimits);
      const g = jointAngle(sol.upperDir, sol.lowerDir);
      assert.ok(g >= limbLimits.minBend - 1e-3, `γ=${g} 低于生理下限 minBend=${limbLimits.minBend} @d=${d}`);
    }
    // 明确「假性过近」d≈0 时 γ 被钳到 minBend(过度弯曲被拦下)
    const near = solve(p0, new THREE.Vector3(0.001, 0, 0), l1, l2, pole, limbLimits);
    const gn = jointAngle(near.upperDir, near.lowerDir);
    assert.ok(Math.abs(gn - limbLimits.minBend) < 1e-2, `极近目标应钳到 minBend=${limbLimits.minBend},got γ=${gn}`);
  }
});

test("T-ARM-7 S4 γ 时序平滑:gammaHint 限幅单帧尖峰、保留连续深屈", () => {
  const l1 = 0.3, l2 = 0.3;
  const p0 = new THREE.Vector3();
  const pole = new THREE.Vector3(0, 0.3, 0);
  const step = 0.4;

  // 帧1:伸直(γ≈maxBend≈3.09)
  const s1 = solveTwoBone(p0, new THREE.Vector3(0.599, 0, 0), l1, l2, pole, { limits: ARM_LIMITS, hint: null });
  assert.ok(s1.gamma > 2.9, `帧1 应伸直,got γ=${s1.gamma}`);

  // 帧2:末端假性过近(自然 γ 会掉到 minBend=0.70),但被 gammaHint 限幅到 g1-step 附近
  const s2 = solveTwoBone(p0, new THREE.Vector3(0.02, 0, 0), l1, l2, pole, {
    limits: ARM_LIMITS, hint: null, gammaHint: s1.gamma, gammaMaxStep: step,
  });
  assert.ok(s2.gamma <= s1.gamma + step + 1e-3 && s2.gamma >= s1.gamma - step - 1e-3, "尖峰帧 γ 应被限幅在 step 内");
  assert.ok(s2.gamma > 2.5, `尖峰帧 γ=${s2.gamma} 应被平滑到中途,而非直接掉到 minBend`);

  // 连续深屈:持续给极近目标,每帧下降受 step 限制,逐渐逼近但不跌破生理下限
  let prev = s1.gamma, cur = s1.gamma;
  for (let i = 0; i < 8; i++) {
    const s = solveTwoBone(p0, new THREE.Vector3(0.02, 0, 0), l1, l2, pole, {
      limits: ARM_LIMITS, hint: null, gammaHint: prev, gammaMaxStep: step,
    });
    assert.ok(s.gamma >= prev - step - 1e-3 && s.gamma <= prev + step + 1e-3, `连续帧 γ 变化超 step:prev=${prev}→${s.gamma}`);
    prev = s.gamma; cur = s.gamma;
  }
  assert.ok(cur >= ARM_LIMITS.minBend - 1e-3, `连续深屈后 γ=${cur} 不应跌破 minBend=${ARM_LIMITS.minBend}`);
});