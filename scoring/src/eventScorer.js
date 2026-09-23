import { resolveConf } from "./contractValidate.js";
import { DEFAULT_BONE_WEIGHTS } from "./schema.js";
import { alignPlayer, getYaw } from "./yawAlign.js";
import { frameCompleteness, framePoseScore } from "./poseScore.js";
import { expTimingValue, gradeOf, timingValue } from "./timing.js";
function scoreFrameAgainstEvent(event, frame, opts) {
  const weights = opts.weights ?? event.weights ?? DEFAULT_BONE_WEIGHTS;
  const conf = resolveConf(frame);
  const yawMode = opts.yawMode ?? "none";
  let bones = frame.bones;
  if (yawMode !== "none") {
    const playerYaw = getYaw(frame, yawMode);
    const refYaw = event.targetYaw ?? opts.refYaw ?? 0;
    bones = alignPlayer(bones, playerYaw, refYaw);
  }
  const s = framePoseScore(event.targetBones, bones, weights, conf);
  return { t: frame.t, poseScore: s };
}
function scanEvent(event, frames, opts) {
  const lo = event.t + event.window.early;
  const hi = event.t + event.window.late;
  let best = null;
  for (const f of frames) {
    if (f.t < lo) continue;
    if (f.t > hi) break;
    const scored = scoreFrameAgainstEvent(event, f, opts);
    if (best === null || scored.poseScore > best.poseScore) {
      best = { t: scored.t, poseScore: scored.poseScore, conf: resolveConf(f) };
    }
  }
  return best;
}
function scoreEvent(event, best, opts) {
  const weights = opts.weights ?? event.weights ?? DEFAULT_BONE_WEIGHTS;
  const windowEdge = opts.windowEdge ?? 0.25;
  const poseWeight = opts.poseWeight ?? 0.65;
  const timingWeight = opts.timingWeight ?? 0.35;
  if (best === null) {
    return {
      moveId: event.moveId,
      t: event.t,
      difficulty: event.difficulty,
      grade: "miss",
      deltaT: null,
      poseScore: 0,
      timingValue: 0,
      eventScore: 0,
      completeness: 0,
      inWindow: false
    };
  }
  const deltaT = best.t - event.t;
  const inWindow = Math.abs(deltaT) <= windowEdge;
  const grade = gradeOf(deltaT, opts.bands, windowEdge);
  const timing = opts.timingFn === "exponential" ? expTimingValue(deltaT, opts.timingSigma ?? 0.2) : timingValue(deltaT, opts.bands, windowEdge);
  const raw = poseWeight * best.poseScore + timingWeight * timing;
  const eventScore = inWindow ? Math.min(1, Math.max(0, raw)) : 0;
  const completeness = frameCompleteness(weights, best.conf);
  return {
    moveId: event.moveId,
    t: event.t,
    difficulty: event.difficulty,
    grade: inWindow ? grade : "miss",
    deltaT,
    poseScore: best.poseScore,
    timingValue: timing,
    eventScore,
    completeness: inWindow ? completeness : 0,
    inWindow
  };
}
export {
  scanEvent,
  scoreEvent,
  scoreFrameAgainstEvent
};
