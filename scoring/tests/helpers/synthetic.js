import { BONES, BONE_DEFS, BONE_COUNT } from "../../src/schema.js";
function norm(v) {
  const [x, y, z] = v;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}
function rotate(v, axis, angle) {
  const [x, y, z] = v;
  const [kx, ky, kz] = norm(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = kx * x + ky * y + kz * z;
  const crossX = ky * z - kz * y;
  const crossY = kz * x - kx * z;
  const crossZ = kx * y - ky * x;
  return [
    x * c + crossX * s + kx * dot * (1 - c),
    y * c + crossY * s + ky * dot * (1 - c),
    z * c + crossZ * s + kz * dot * (1 - c)
  ];
}
const STANDING = [
  norm([0, 0.97, -0.24]),
  // spine
  norm([-0.28, -0.95, -0.13]),
  // upper_arm_l
  norm([-0.1, -0.99, -0.05]),
  // forearm_l
  norm([0.28, -0.95, -0.13]),
  // upper_arm_r
  norm([0.1, -0.99, -0.05]),
  // forearm_r
  norm([-0.25, -0.9, -0.35]),
  // thigh_l
  norm([0.05, -0.9, -0.44]),
  // shin_l
  norm([0.25, -0.9, -0.35]),
  // thigh_r
  norm([-0.05, -0.9, -0.44]),
  // shin_r
  norm([0, 1, -0.06])
  // head
];
function withOverrides(base, overrides) {
  const out = base.map((b) => [...b]);
  for (const [k, v] of Object.entries(overrides)) {
    const idx = Number(k);
    if (Number.isInteger(idx) && idx >= 0 && idx < BONE_COUNT) out[idx] = norm(v);
  }
  return out;
}
const POSE_UP_ARMS = withOverrides(STANDING, {
  [BONES.UPPER_ARM_L]: [0.45, 0.87, 0.19],
  [BONES.FOREARM_L]: [0.35, 0.9, 0.26],
  [BONES.UPPER_ARM_R]: [-0.45, 0.87, 0.19],
  [BONES.FOREARM_R]: [-0.35, 0.9, 0.26]
});
const POSE_ARMS_OUT = withOverrides(STANDING, {
  [BONES.UPPER_ARM_L]: [-0.92, 0.25, 0.31],
  [BONES.FOREARM_L]: [-0.86, -0.4, 0.32],
  [BONES.UPPER_ARM_R]: [0.92, 0.25, 0.31],
  [BONES.FOREARM_R]: [0.86, -0.4, 0.32]
});
const POSE_RIGHT_WAVE = withOverrides(STANDING, {
  [BONES.UPPER_ARM_R]: [0.1, 0.9, 0.42],
  [BONES.FOREARM_R]: [0.62, 0.66, 0.42]
});
function lerp(a, b, alpha) {
  return norm([a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha, a[2] + (b[2] - a[2]) * alpha]);
}
function sampleBeats(beats, fps) {
  const last = beats[beats.length - 1];
  const duration = last ? last.t : 0;
  const n = Math.round(duration * fps) + 1;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    frames.push({ t, bones: poseAt(beats, t) });
  }
  return frames;
}
function poseAt(beats, t) {
  if (beats.length === 0) return STANDING;
  if (t <= beats[0].t) return beats[0].bones.map((b) => [...b]);
  const last = beats[beats.length - 1];
  if (last === void 0) return STANDING;
  if (t >= last.t) return last.bones.map((b) => [...b]);
  for (let i = 0; i < beats.length - 1; i++) {
    const a = beats[i];
    const b = beats[i + 1];
    if (a === void 0 || b === void 0) continue;
    if (t >= a.t && t <= b.t) {
      const alpha = (t - a.t) / (b.t - a.t);
      const bones = [];
      for (let j = 0; j < BONE_COUNT; j++) {
        bones.push(lerp(a.bones[j] ?? STANDING[j] ?? [0, 0, 1], b.bones[j] ?? STANDING[j] ?? [0, 0, 1], alpha));
      }
      return bones;
    }
  }
  return STANDING;
}
function makeReference(beats, danceId = "test-dance", fps = 30) {
  const frames = sampleBeats(beats, fps);
  return {
    schema: "dance-sequence/v1",
    danceId,
    meta: {
      fps,
      durationSec: frames.length > 0 ? frames[frames.length - 1].t : 0,
      numFrames: frames.length,
      boneCount: BONE_COUNT,
      source: "synthetic",
      coordinateSystem: "canonical-yup"
    },
    bones: BONE_DEFS.map((b) => ({ ...b })),
    frames
  };
}
function shiftTime(frames, offset) {
  return frames.map((f) => ({ ...f, t: f.t + offset }));
}
function perturb(frame, boneIdx, angle) {
  const bones = frame.bones.map((b) => [...b]);
  bones[boneIdx] = rotate(bones[boneIdx] ?? [0, 0, 1], [0, 0, 1], angle);
  return { ...frame, bones };
}
function occlude(frame, indices) {
  const bones = frame.bones.map((b) => [...b]);
  const conf = new Array(BONE_COUNT).fill(1);
  for (const i of indices) {
    bones[i] = [0, 0, 0];
    conf[i] = 0;
  }
  return { ...frame, bones, conf };
}
function rotateAll(bones, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return bones.map(([x, y, z]) => [x * c + z * s, y, -x * s + z * c]);
}
const STANDARD_BEATS = [
  { t: 0, bones: STANDING },
  { t: 1, bones: POSE_UP_ARMS },
  { t: 2, bones: POSE_ARMS_OUT },
  { t: 3, bones: POSE_RIGHT_WAVE }
];
export {
  POSE_ARMS_OUT,
  POSE_RIGHT_WAVE,
  POSE_UP_ARMS,
  STANDARD_BEATS,
  STANDING,
  makeReference,
  norm,
  occlude,
  perturb,
  poseAt,
  rotate,
  rotateAll,
  sampleBeats,
  shiftTime,
  withOverrides
};
