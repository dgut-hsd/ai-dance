/**
 * playback.js — 参考序列 JSON 的回放(可视化)。
 *
 * 用"方向 × 长度"重建关节位置。骨骼表从序列自带 bones 数组读,
 * 所以全身(9)和手势(5)序列都能正确回放。
 */

import { BONE_DEFS } from "./contract.js";
import { renderStickFigure } from "./stick-figure.js";

const DEFAULT_DIMS = {
  spineLen: 0.52,
  shoulderWidth: 0.38,
  hipWidth: 0.32,
  upperArm: 0.28,
  forearm: 0.26,
  thigh: 0.44,
  shin: 0.42,
  headLen: 0.22,
};

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function computeDimensions(joints) {
  return {
    spineLen: dist(joints.hips_center, joints.shoulders_center),
    shoulderWidth: dist(joints.left_shoulder, joints.right_shoulder),
    hipWidth: dist(joints.left_hip, joints.right_hip),
    upperArm:
      (dist(joints.left_shoulder, joints.left_elbow) +
        dist(joints.right_shoulder, joints.right_elbow)) / 2,
    forearm:
      (dist(joints.left_elbow, joints.left_wrist) +
        dist(joints.right_elbow, joints.right_wrist)) / 2,
    thigh:
      (dist(joints.left_hip, joints.left_knee) +
        dist(joints.right_hip, joints.right_knee)) / 2,
    shin:
      (dist(joints.left_knee, joints.left_ankle) +
        dist(joints.right_knee, joints.right_ankle)) / 2,
    headLen: dist(joints.shoulders_center, joints.nose),
  };
}

// boneDefs: 序列自带的骨骼表(名称→帧里 bones 数组的索引)
export function reconstructJoints(frame, dims = {}, boneDefs = BONE_DEFS) {
  const D = { ...DEFAULT_DIMS, ...dims };
  const bones = frame.bones || [];

  const getBone = (name) => {
    const i = boneDefs.findIndex((b) => b.name === name);
    return i >= 0 && bones[i] ? bones[i] : [0, 0, 0];
  };

  const yaw = frame.rootYaw || 0;
  const lateral = [Math.cos(yaw), 0, Math.sin(yaw)];

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s];

  const hips_center = [0, 0, 0];
  const shoulders_center = add(hips_center, scale(getBone("spine"), D.spineLen));

  const left_hip = add(hips_center, scale(lateral, -D.hipWidth / 2));
  const right_hip = add(hips_center, scale(lateral, D.hipWidth / 2));
  const shoulderAxis = frame.shoulderAxis || lateral;
  const left_shoulder = add(shoulders_center, scale(shoulderAxis, -D.shoulderWidth / 2));
  const right_shoulder = add(shoulders_center, scale(shoulderAxis, D.shoulderWidth / 2));

  const left_elbow = add(left_shoulder, scale(getBone("upper_arm_l"), D.upperArm));
  const left_wrist = add(left_elbow, scale(getBone("forearm_l"), D.forearm));
  const right_elbow = add(right_shoulder, scale(getBone("upper_arm_r"), D.upperArm));
  const right_wrist = add(right_elbow, scale(getBone("forearm_r"), D.forearm));

  const left_knee = add(left_hip, scale(getBone("thigh_l"), D.thigh));
  const left_ankle = add(left_knee, scale(getBone("shin_l"), D.shin));
  const right_knee = add(right_hip, scale(getBone("thigh_r"), D.thigh));
  const right_ankle = add(right_knee, scale(getBone("shin_r"), D.shin));

  const nose = add(shoulders_center, scale(getBone("head"), D.headLen));

  return {
    hips_center,
    shoulders_center,
    left_hip,
    right_hip,
    left_shoulder,
    right_shoulder,
    left_elbow,
    left_wrist,
    right_elbow,
    right_wrist,
    left_knee,
    left_ankle,
    right_knee,
    right_ankle,
    nose,
  };
}

/**
 * 在两帧之间线性插值,得到 t 时刻的平滑帧(B-1:关键帧插值,消除低帧率硬切的接缝抖动)。
 * - bones:单位向量 lerp 后再归一化(相邻帧角差小,slerp 的线性近似,足够用)。
 * - rootYaw:线性插值;conf 沿用前帧(插值帧无新置信度)。
 * 帧须按 t 升序;t 越界时钳到首/尾帧。
 */
export function sampleFrame(frames, t) {
  if (!frames || !frames.length) return null;
  if (t <= frames[0].t) return frames[0];
  const last = frames[frames.length - 1];
  if (t >= last.t) return last;

  // 二分找 bracketing 两帧(lo.t <= t < hi.t)
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid; else hi = mid;
  }
  const f0 = frames[lo], f1 = frames[hi];
  const span = f1.t - f0.t;
  const k = span > 0 ? (t - f0.t) / span : 0;

  const b0 = f0.bones || [];
  const b1 = f1.bones || [];
  const bones = b0.map((b, i) => {
    const c = b1[i];
    if (!b || !c) return b || [0, 0, 0];
    const v = [
      b[0] + (c[0] - b[0]) * k,
      b[1] + (c[1] - b[1]) * k,
      b[2] + (c[2] - b[2]) * k,
    ];
    const len = Math.hypot(v[0], v[1], v[2]);
    return len > 1e-9 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
  });

  const yaw0 = f0.rootYaw ?? 0;
  const yaw1 = f1.rootYaw ?? 0;
  // 角度插值必须走「最短角差」:rootYaw/torsoTwist 是按帧独立算的 (−π,π],
  // 直接线性插值会在跨 ±π 的那一帧倒着转过一整圈(整条骨盆/胸腔猛甩一下)。
  const shortAngle = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

  // B-1.1(v2 可选字段插值):肩轴/胸椎扭转/躯干 roll·pitch/手臂轴向扭转。
  // 参考序列(v2)逐帧都带这些字段;插值帧按标量/数组线性过渡,肩轴插值后重新归一化。
  // 旧序列缺这些字段时返回 undefined,不污染下游(消费端按「字段是否存在」回退)。
  const lerpN = (a, b) => (a == null ? (b == null ? null : b) : (b == null ? a : a + (b - a) * k));
  const lerpA = (a, b) => {
    if (a == null && b == null) return null;
    const base = a == null ? b : a;
    return base.map((v, i) => {
      const av = a == null ? v : a[i];
      const bv = b == null ? v : b[i];
      return av + (bv - av) * k;
    });
  };

  const out = { t, bones, rootYaw: yaw0 + shortAngle(yaw0, yaw1) * k, conf: f0.conf };
  if (f0.rootYawConf !== undefined || f1.rootYawConf !== undefined) out.rootYawConf = f0.rootYawConf ?? f1.rootYawConf;
  if (f0.shoulderAxis != null || f1.shoulderAxis != null) {
    const sa = lerpA(f0.shoulderAxis, f1.shoulderAxis);
    if (sa) {
      const l = Math.hypot(sa[0], sa[1], sa[2]);
      out.shoulderAxis = l > 1e-9 ? [sa[0] / l, sa[1] / l, sa[2] / l] : sa;
    }
  }
  // 胸椎扭转同样是角度(−π,π],也走最短角差;roll/pitch 是 atan2 出来的 ±90° 量,不会绕圈。
  if (f0.torsoTwist != null || f1.torsoTwist != null) {
    out.torsoTwist = f0.torsoTwist == null ? f1.torsoTwist
      : f1.torsoTwist == null ? f0.torsoTwist
        : f0.torsoTwist + shortAngle(f0.torsoTwist, f1.torsoTwist) * k;
  }
  if (f0.torsoRoll != null || f1.torsoRoll != null) out.torsoRoll = lerpN(f0.torsoRoll, f1.torsoRoll);
  if (f0.torsoPitch != null || f1.torsoPitch != null) out.torsoPitch = lerpN(f0.torsoPitch, f1.torsoPitch);
  if (f0.armTwist != null || f1.armTwist != null) out.armTwist = lerpA(f0.armTwist, f1.armTwist);
  // 根位移(三维线性)与骨盆倾斜(角度)。旧序列没有这些字段 → 不产出,消费端按存在性回退。
  if (f0.rootPos != null || f1.rootPos != null) out.rootPos = lerpA(f0.rootPos, f1.rootPos);
  if (f0.pelvisPitch != null || f1.pelvisPitch != null) out.pelvisPitch = lerpN(f0.pelvisPitch, f1.pelvisPitch);
  if (f0.pelvisRoll != null || f1.pelvisRoll != null) out.pelvisRoll = lerpN(f0.pelvisRoll, f1.pelvisRoll);
  return out;
}

export function playSequence(
  canvas,
  sequence,
  { onProgress = () => {}, onDone = () => {}, fps } = {}
) {
  const dims = sequence.meta?.dimensions || {};
  const boneDefs = sequence.bones || BONE_DEFS;
  const frames = sequence.frames || [];
  const rate = fps || sequence.meta?.fps || 30;
  const frameDur = 1000 / rate;

  let i = 0;
  let timer = null;
  let stopped = false;

  function step() {
    if (stopped) return;
    if (i >= frames.length) {
      onDone();
      return;
    }
    renderStickFigure(
      canvas,
      reconstructJoints(frames[i], dims, boneDefs),
      boneDefs,
      frames[i].hands
    );
    onProgress(i / frames.length);
    i++;
    timer = setTimeout(step, frameDur);
  }

  step();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
