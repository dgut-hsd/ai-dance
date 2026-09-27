/** Neon Snap — 原创摆摊挑战舞：120 BPM / 16 秒 / 32 拍。 */
import { BONE_DEFS, poseFromJoints } from "../pose_capture/contract.js";

const FPS = 30, BPM = 120, BEAT = 0.5, DURATION = 24, TAU = Math.PI * 2;
const smooth = (x) => x * x * (3 - 2 * x);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

function jointsAt(t) {
  const beat = t / BEAT, b = beat % 32;
  const side = Math.sin(TAU * beat / 4);
  const groove = 0.06 * Math.sin(TAU * beat / 2);
  const bounce = 0.035 * Math.max(0, Math.sin(Math.PI * (beat % 4) / 2));
  let turn = 0;
  if (b >= 16 && b < 20) turn = smooth((b - 16) / 4) * Math.PI * 0.5;
  if (b >= 20 && b < 24) turn = Math.PI * 0.5 * (1 - smooth((b - 20) / 4));
  const sideAxis = [-Math.sin(turn), 0, Math.cos(turn)];
  const forward = [Math.cos(turn), 0, Math.sin(turn)];
  const hips = [0, -0.035 + bounce, 0];
  const chest = [0.035 * side, 0.58 + hips[1], 0.025 * Math.sin(TAU * beat / 4)];
  const lh = add(hips, mul(sideAxis, -0.16)), rh = add(hips, mul(sideAxis, 0.16));
  const ls = add(chest, mul(sideAxis, -0.20)), rs = add(chest, mul(sideAxis, 0.20));
  const lk = add(lh, [0, -0.40 + (side < 0 ? 0.06 : 0), 0.04]);
  const rk = add(rh, [0, -0.40 + (side > 0 ? 0.06 : 0), 0.04]);
  const la = add(lk, [0, -0.40, 0.015 * Math.sin(TAU * beat)]);
  const ra = add(rk, [0, -0.40, -0.015 * Math.sin(TAU * beat)]);
  const signature = b < 4 ? Math.sin(Math.PI * b / 4) : 0;
  const out = 0.10 + 0.15 * signature + 0.05 * Math.abs(side);
  const punch = 0.18 * Math.max(0, Math.sin(Math.PI * (beat % 2)));
  const le = add(ls, add(mul(sideAxis, -0.12 - out * 0.15), [0, 0.06 + groove, 0.02]));
  const re = add(rs, add(mul(sideAxis, 0.12 + out * 0.15), [0, 0.06 - groove, 0.02]));
  const lw = add(le, add(mul(sideAxis, -out), [0, 0.10 + signature * 0.30, -punch]));
  const rw = add(re, add(mul(sideAxis, out), [0, 0.10 + signature * 0.30, punch]));
  if ((b >= 0 && b < 2) || (b >= 24 && b < 28)) { lw[1] += 0.18; rw[1] += 0.18; lw[2] -= 0.15; rw[2] -= 0.15; }
  return {
    hips_center: hips, left_hip: lh, right_hip: rh, shoulders_center: chest,
    left_shoulder: ls, right_shoulder: rs, left_elbow: le, right_elbow: re,
    left_wrist: lw, right_wrist: rw, left_knee: lk, right_knee: rk,
    left_ankle: la, right_ankle: ra, nose: add(chest, add(mul(forward, 0.04), [0, 0.24, 0.03])),
    rootYaw: turn, shoulderAxis: sideAxis,
  };
}

export function buildDemoSequence() {
  const frames = [], previous = [0, 0, 0];
  for (let i = 0; i < DURATION * FPS; i++) {
    const t = i / FPS, j = jointsAt(t), p = poseFromJoints(j, {}, BONE_DEFS);
    const rootVel = mul(sub(j.hips_center, previous), FPS);
    frames.push({ t: +t.toFixed(3), bones: p.bones, conf: p.conf, rootYaw: j.rootYaw, rootYawConf: 1, shoulderAxis: j.shoulderAxis, rootVel, grounded: true });
    previous[0] = j.hips_center[0]; previous[1] = j.hips_center[1]; previous[2] = j.hips_center[2];
  }
  const beatTimesSec = Array.from({ length: DURATION * 2 }, (_, i) => +(i * BEAT).toFixed(3));
  // 每两秒结算一次，给玩家明确的“招牌动作”目标；转身由连续 rootYaw 轨道表现。
  const notes = Array.from({ length: 12 }, (_, i) => ({ id: `neon-snap-${i}`, t: i * 2, type: "pose", lane: i % 2 ? "body" : "signature" }));
  return {
    schema: "dance-sequence/v1", danceId: "neon-snap",
    meta: { fps: FPS, durationSec: DURATION, numFrames: frames.length, boneCount: BONE_DEFS.length, danceType: "full-body", source: "original-parametric-choreography", coordinateSystem: "canonical-yup", difficulty: 2, beatTimesSec, timing: { version: "timing/v1", bpm: BPM, offsetSec: 0, tempoMap: [{ t: 0, bpm: BPM }] }, dimensions: { spineLen: 0.52, shoulderWidth: 0.40, hipWidth: 0.32, upperArm: 0.28, forearm: 0.26, thigh: 0.44, shin: 0.42, headLen: 0.22 }, choreography: { title: "Neon Snap", hook: "双手上提—左右击拍—半转身—定格", bars: 8, signatureBeats: [0, 4, 16, 24] } },
    bones: BONE_DEFS.map(({ name, parent, child }) => ({ name, parent, child })), frames,
    chart: { version: "chart/v1", audio: "audio/pop-demo.wav", notes },
  };
}
