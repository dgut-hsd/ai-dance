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
  const left_shoulder = add(shoulders_center, scale(lateral, -D.shoulderWidth / 2));
  const right_shoulder = add(shoulders_center, scale(lateral, D.shoulderWidth / 2));

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
