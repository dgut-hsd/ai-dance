/**
 * rom.js — 人体关节活动度(ROM)常量 + 姿态运动学约束助手(纯函数,可单测)。
 *
 * 医学依据(AAOS / 中国骨科标准 ROM 查表)——单位统一为弧度：
 *   颈椎:旋转(转头)各侧 60–80°,屈曲(点头/下颌贴胸) 45–50°,后伸(仰头) 45°,侧屈 45°。
 *   肩:  屈曲 180°/后伸 60°/外展 180°/内收 40°/外旋 90°/内旋 70°。
 *   肘:  屈曲 0°→约 140–150°,伸展 0°(过伸罕见 <10°)。
 *   髋:  屈曲 120–145°/后伸 20–40°/外展 45°/内收 30°/内外旋 45°。
 *   膝:  屈曲 0°→约 135–145°,伸展 0°(过伸罕见)。
 *   踝:  背屈 20°/跖屈 50°。
 *
 * 约定(与 ik.js/retarget.js 一致):中间关节「内角」γ,π=完全伸直,0=完全折叠。
 * 因此:
 *   - 肘取 minBend = degToRad(40°):对应该关节最大屈曲约 140°(残余内角约 40°)。
 *   - 膝取 minBend = degToRad(40°):对应膝最大屈曲约 140°(残余内角约 40°),
 *       比旧的 0.55 rad(≈31.5°)更贴近生理极限,消除「非生理深折」。
 *   - maxBend 统一 degToRad(177°):略低于 π,防肘/膝反折(hyperextension)。
 */

import * as THREE from "three";

const RAD = (deg) => (deg * Math.PI) / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// 归一化角度到 (-π, π]
export function normAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** 医学关节活动度常量(rad)。单一权威来源,retarget.js / ik.test.js 共用。 */
export const ROM = {
  // —— 颈椎(头部) ——
  neckYaw: RAD(75),       // 轴向旋转(转头):各侧 60–80°,取 75°
  neckFlexion: RAD(50),   // 屈曲(点头/下颌贴胸):45–50°,取 50°
  neckExtension: RAD(45), // 后伸(仰头):45°

  // —— 肘 ——
  elbowMinBend: RAD(40),  // 最大屈曲 140–150° → 残余内角 30–40°,保守取 40°
  elbowMaxBend: RAD(177), // 伸展 0°,留 3° 防反折

  // —— 膝 ——
  kneeMinBend: RAD(40),   // 最大屈曲 135–145° → 残余内角 35–45°,保守取 40°
  kneeMaxBend: RAD(177),  // 伸展 0°,留 3° 防反折

  // —— 肩(用于上臂方向约束,防止穿躯干/过度反折) ——
  shoulderExtension: RAD(60),  // 后伸(上臂向后摆):20–40°(舞蹈挥臂留余量,按文档头部取 60°)
  // 内收(上臂跨身体中线对侧)。原为 40°,实测对 copydance1 太紧:这支舞有「手跨到对侧身体」的段落,
  // 肩→腕向量的横向分量到 −0.93(≈68° 内收),被 40°(−0.643)钳住后方向被拧掉 20–42°,
  // 直接表现为上臂误差最大 33°(占全片 6.6% 的帧触发)。放宽到 60°:均值 1.55°→1.04°、最大 33°→18°,
  // 且碰撞层照常开时穿模仍为 0 帧(侧穿由碰撞层兜,和 hipAdduction 的处理一致)。
  // 注意别完全放开:180°(等于不钳)实测反而恶化到均值 8.2°/最大 62° —— 锥约束本身在帮 IK 选解。
  shoulderAdduction: RAD(60),
  shoulderAbduction: RAD(180), // 外展(上臂侧举):180°(上限,一般不做硬钳,仅供引用)

  // —— 髋(用于大腿方向约束) ——
  hipFlexion: RAD(125),   // 屈曲(大腿前摆):120–145°
  hipExtension: RAD(30),  // 后伸(大腿后摆):20–40°
  hipAbduction: RAD(45),  // 外展(大腿侧抬):45°
  hipAdduction: RAD(30),  // 内收(腿跨身体中线):30°(保留交叉步空间,防侧穿靠碰撞层)

  // —— 踝(预留,当前消费端未做足部) ——
  ankleDorsiflexion: RAD(20),
  anklePlantarflexion: RAD(50),
};

/** 由 ROM 派生的两骨 IK 生理限位(与 ik.js `limits` 字段同构)。 */
export const ARM_LIMITS = { minBend: ROM.elbowMinBend, maxBend: ROM.elbowMaxBend };
export const LEG_LIMITS = { minBend: ROM.kneeMinBend, maxBend: ROM.kneeMaxBend };

/**
 * 头部朝向分解:把「头向量」(鼻 − 肩中点,单位)相对其中性朝向,分解为躯干坐标系下的
 * 俯仰 pitch(点头/仰头)与偏航 yaw(转头),从而与躯干转动解耦。
 *
 * @param {THREE.Vector3} headDir   当前头方向(单位,已映射到模型世界基)
 * @param {THREE.Vector3} neutralDir 中性头方向(单位,同基)
 * @param {THREE.Vector3} up        世界「上」(basis.up)
 * @param {THREE.Vector3} right     世界「右」(basis.right;镜像已由 headDir 的坐标翻转体现)
 * @returns {{pitch:number, yaw:number}} 相对中性的俯仰/偏航(rad,已归一化到 (-π,π])
 */
export function decomposeHead(headDir, neutralDir, up, right) {
  const H = headDir.clone().normalize();
  const N = neutralDir.clone().normalize();
  const U = up.clone().normalize();
  const R = right.clone().normalize();
  const F = new THREE.Vector3().crossVectors(R, U).normalize(); // 世界「前」

  // 俯仰:在矢状面(上–前)内的倾角差
  const pitch = normAngle(
    Math.atan2(H.dot(F), H.dot(U)) - Math.atan2(N.dot(F), N.dot(U))
  );
  // 偏航:绕「上」轴的有向旋转(用水平分量叉积,对小前向分量也稳健)
  const Nh = N.clone().addScaledVector(U, -N.dot(U));
  const Hh = H.clone().addScaledVector(U, -H.dot(U));
  let yaw = 0;
  const nLen = Nh.length(), hLen = Hh.length();
  if (nLen > 1e-4 && hLen > 1e-4) {
    const c = new THREE.Vector3().crossVectors(Nh, Hh);
    yaw = Math.atan2(U.dot(c), Nh.dot(Hh));
  }
  return { pitch, yaw: normAngle(yaw) };
}

/**
 * 颈椎 ROM 限幅。
 */
export function clampNeck(pitch, yaw) {
  return {
    pitch: clamp(pitch, -ROM.neckExtension, ROM.neckFlexion),
    yaw: clamp(yaw, -ROM.neckYaw, ROM.neckYaw),
  };
}

/**
 * 由限幅后的 pitch/yaw 重建「躯干局部颈旋」四元数(世界基)。
 * 顺序:先绕侧向右轴俯仰,再绕上轴偏航(小角度下与 Euler 顺序等价)。
 */
export function neckQuaternion(pitch, yaw, up, right) {
  const U = up.clone().normalize();
  const R = right.clone().normalize();
  return new THREE.Quaternion()
    .setFromAxisAngle(U, yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(R, pitch));
}

/**
 * 腿部方向约束(髋 ROM):把「髋→踝」方向钳到生理矢状锥内(仅改方向、长度守恒)。
 *
 * 只约束矢状面(前后摆):前向分量 ∈ [−sin(hipExtension), sin(hipFlexion)],即限制腿
 * 向后摆不超过后伸极限、向前不超过屈曲极限;再按比例 renormalize,保持腿的侧向/竖直
 * 朝向不变,避免轴对齐钳位造成「抬升/侧歪」伪影。外展(侧抬)在舞蹈数据中极少超界,
 * 本版不强加(避免引入伪影,见 docs §10.8 的已知边界)。
 *
 * @param {THREE.Vector3} rel      髋→踝向量(世界)
 * @param {THREE.Vector3} up       世界「上」
 * @param {THREE.Vector3} forward  身体前向(世界,通常 = bodyYaw·basis.forward)
 * @param {THREE.Vector3} right    身体侧向(世界,通常 = bodyYaw·basis.right)
 * @returns {THREE.Vector3} 约束后的髋→踝向量
 */
export function clampLegDirection(rel, up, forward, right) {
  const len = rel.length();
  if (len < 1e-8) return rel.clone();
  const dir = rel.clone().normalize();
  const U = up.clone().normalize();
  const F = forward.clone().normalize();
  const R = right.clone().normalize();

  const dFwd = dir.dot(F);
  const backMax = -Math.sin(ROM.hipExtension);
  const fwdMax = Math.sin(ROM.hipFlexion);
  const cFwd = clamp(dFwd, backMax, fwdMax);
  if (Math.abs(cFwd - dFwd) < 1e-9) return rel.clone(); // 未触发,原样返回

  // 把前向分量钳到边界后,在「上–侧」平面内等比例缩放垂直分量以保持单位方向,
  // 使最终方向的前向分量恰为 cFwd(角度限位严格成立),且不引入侧歪/抬升伪影。
  const dRgt = dir.dot(R);
  const dUp = dir.dot(U);
  const perp = Math.hypot(dRgt, dUp);
  if (perp < 1e-6) return rel.clone(); // 方向几乎沿 F(极端),跳过避免 NaN

  const newPerp = Math.sqrt(Math.max(0, 1 - cFwd * cFwd));
  const scale = newPerp / perp;
  const out = F.clone().multiplyScalar(cFwd)
    .addScaledVector(R, dRgt * scale)
    .addScaledVector(U, dUp * scale);
  return out.normalize().multiplyScalar(len);
}

/**
 * 肩关节立体锥约束(防穿躯干 + 防反折):把「肩→末端」方向(单位化后)钳到躯干坐标系下的
 * 生理锥内。以自身侧为轴向,两个独立下界:
 *   后伸(backward extension):前向分量 ≥ −sin(shoulderExtension) —— 上臂不能向后摆过头。
 *   内收(adduction):自身侧向分量 ≥ −sin(shoulderAdduction) —— 上臂不能跨身体中线对侧太多。
 * 外展、前屈保持自由(180°,不硬钳)。只改方向、长度守恒。
 *
 * sideSign:自身侧符号,模型右侧 = +1、左侧 = −1(消费端由骨骼名推导)。
 *   dL = dir·right × sideSign:正值=外展(向自身侧抬),负值=内收(跨向对侧)。
 *
 * @param {THREE.Vector3} rel      肩→末端向量(世界)
 * @param {THREE.Vector3} up       世界「上」
 * @param {THREE.Vector3} forward  身体前向(世界,通常 = bodyYaw·basis.forward)
 * @param {THREE.Vector3} right    身体侧向(世界,通常 = bodyYaw·basis.right)
 * @param {number} sideSign        自身侧符号(右 +1 / 左 −1)
 * @returns {THREE.Vector3} 约束后的肩→末端向量
 */
export function clampArmDirection(rel, up, forward, right, sideSign) {
  const len = rel.length();
  if (len < 1e-8) return rel.clone();
  const dir = rel.clone().normalize();
  const U = up.clone().normalize();
  const F = forward.clone().normalize();
  const R = right.clone().normalize();

  const dF = dir.dot(F);
  const dL = dir.dot(R) * sideSign; // 正值=外展,负值=内收
  const dU = dir.dot(U);

  const cF = Math.max(dF, -Math.sin(ROM.shoulderExtension));  // 后伸下限
  const cL = Math.max(dL, -Math.sin(ROM.shoulderAdduction));  // 内收下限
  if (Math.abs(cF - dF) < 1e-9 && Math.abs(cL - dL) < 1e-9) return rel.clone();

  // cF/cL 只可能把负向分量向 0 抬升(|·| 减小),故 1−cF²−cL² ≥ dU² ≥ 0,恒可补足。
  const cU = (dU >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, 1 - cF * cF - cL * cL));
  const cR = cL * sideSign; // 回世界侧向分量
  const out = F.clone().multiplyScalar(cF)
    .addScaledVector(R, cR)
    .addScaledVector(U, cU);
  return out.normalize().multiplyScalar(len);
}

/**
 * 髋冠状面约束(内/外展,治「腿侧向漂移超生理/轨迹异常」):把「髋→踝」方向的自身侧向分量
 * 钳到 [−sin(hipAdduction), sin(hipAbduction)]。只改方向、长度守恒,不引入前后/抬升伪影。
 *
 * sideSign:自身侧符号,模型右侧 = +1、左侧 = −1。
 *   dL = dir·right × sideSign:正值=外展(腿侧抬),负值=内收(腿跨身体中线)。
 *
 * @param {THREE.Vector3} rel      髋→踝向量(世界)
 * @param {THREE.Vector3} up       世界「上」
 * @param {THREE.Vector3} forward  身体前向(世界)
 * @param {THREE.Vector3} right    身体侧向(世界)
 * @param {number} sideSign        自身侧符号(右 +1 / 左 −1)
 * @returns {THREE.Vector3} 约束后的髋→踝向量
 */
export function clampLegCoronal(rel, up, forward, right, sideSign) {
  const len = rel.length();
  if (len < 1e-8) return rel.clone();
  const dir = rel.clone().normalize();
  const U = up.clone().normalize();
  const F = forward.clone().normalize();
  const R = right.clone().normalize();

  const dL = dir.dot(R) * sideSign; // 正值=外展,负值=内收
  const cL = clamp(dL, -Math.sin(ROM.hipAdduction), Math.sin(ROM.hipAbduction));
  if (Math.abs(cL - dL) < 1e-9) return rel.clone();

  // 等比例缩放「前向+上」平面分量以保持单位方向(侧向分量严格 = cL),不引入前后/抬升伪影。
  const dF = dir.dot(F);
  const dU = dir.dot(U);
  const perp = Math.hypot(dF, dU);
  if (perp < 1e-6) return rel.clone(); // 方向几乎沿 R(极端),跳过避免 NaN

  const newPerp = Math.sqrt(Math.max(0, 1 - cL * cL));
  const scale = newPerp / perp;
  const cR = cL * sideSign;
  const out = F.clone().multiplyScalar(dF * scale)
    .addScaledVector(U, dU * scale)
    .addScaledVector(R, cR);
  return out.normalize().multiplyScalar(len);
}