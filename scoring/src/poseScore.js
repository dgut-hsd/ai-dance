import { assertValidFrame, resolveConf } from "./contractValidate.js";
import { BONE_COUNT, DEFAULT_BONE_WEIGHTS } from "./schema.js";
function boneDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function framePoseScore(ref, player, weights = DEFAULT_BONE_WEIGHTS, conf = new Array(BONE_COUNT).fill(1)) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < BONE_COUNT; i++) {
    const w = weights[i] ?? 0;
    const c = conf[i] ?? 0;
    if (w === 0 || c === 0) continue;
    const dot = boneDot(ref[i] ?? [0, 0, 0], player[i] ?? [0, 0, 0]);
    num += w * c * Math.max(0, dot);
    den += w * c;
  }
  if (den === 0) return 0;
  return Math.min(1, Math.max(0, num / den));
}
function frameCompleteness(weights = DEFAULT_BONE_WEIGHTS, conf = new Array(BONE_COUNT).fill(1)) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < BONE_COUNT; i++) {
    const w = weights[i] ?? 0;
    const c = conf[i] ?? 0;
    num += w * c;
    den += w;
  }
  if (den === 0) return 0;
  return Math.min(1, Math.max(0, num / den));
}
function scorePlayerFrame(refBones, player, weights = DEFAULT_BONE_WEIGHTS) {
  assertValidFrame(player);
  return framePoseScore(refBones, player.bones, weights, resolveConf(player));
}
export {
  boneDot,
  frameCompleteness,
  framePoseScore,
  scorePlayerFrame
};
