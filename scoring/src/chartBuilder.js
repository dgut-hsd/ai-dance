import { BONE_COUNT, DEFAULT_BONE_WEIGHTS } from "./schema.js";
const DEFAULT_WINDOW = { early: -0.25, late: 0.25 };
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function perFrameVelocity(sequence, weights) {
  const out = [0];
  const frames = sequence.frames;
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    if (prev === void 0 || cur === void 0) {
      out.push(0);
      continue;
    }
    const dt = cur.t - prev.t;
    let ang = 0;
    for (let b = 0; b < BONE_COUNT; b++) {
      const w = weights[b] ?? 0;
      const u = prev.bones[b];
      const v = cur.bones[b];
      if (w === 0 || u === void 0 || v === void 0) continue;
      const dot = clamp(u[0] * v[0] + u[1] * v[1] + u[2] * v[2], -1, 1);
      ang += w * Math.acos(dot);
    }
    out.push(dt > 0 ? ang / dt : 0);
  }
  return out;
}
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx] ?? 0;
}
function buildChart(reference, opts = {}) {
  const weights = opts.weights ?? DEFAULT_BONE_WEIGHTS;
  const window = opts.window ?? DEFAULT_WINDOW;
  const difficulty = opts.difficulty ?? reference.meta.difficulty ?? 2;
  const frames = reference.frames;
  if (opts.mode === "extrema") {
    const vel = perFrameVelocity(reference, weights);
    const threshold = quantile(
      [...vel].sort((a, b) => a - b),
      opts.velocityThresholdQuantile ?? 0.4
    );
    const minSpacing = opts.minSpacingSec ?? 0.5;
    const events2 = [];
    let lastT = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < frames.length - 1; i++) {
      const vPrev = vel[i - 1] ?? 0;
      const vCur = vel[i] ?? 0;
      const vNext = vel[i + 1] ?? 0;
      const frame = frames[i];
      if (frame === void 0) continue;
      if (vCur <= threshold && vCur <= vPrev && vCur < vNext) {
        if (frame.t - lastT < minSpacing) continue;
        lastT = frame.t;
        events2.push({
          t: frame.t,
          targetBones: frame.bones.slice(),
          window,
          weights,
          difficulty,
          targetT: frame.t,
          targetYaw: frame.rootYaw
        });
      }
    }
    return events2;
  }
  const step = opts.intervalFrames ?? Math.max(1, Math.round(reference.meta.fps * 0.5));
  const events = [];
  for (let i = 0; i < frames.length; i += step) {
    const frame = frames[i];
    if (frame === void 0) continue;
    events.push({
      t: frame.t,
      targetBones: frame.bones.slice(),
      window,
      weights,
      difficulty,
      targetT: frame.t,
      targetYaw: frame.rootYaw
    });
  }
  return events;
}
export {
  DEFAULT_WINDOW,
  buildChart,
  perFrameVelocity
};
