import { describe, expect, it } from "vitest";
import { DEFAULT_BONE_WEIGHTS } from "../src/schema.js";
import { scanEvent, scoreEvent, scoreFrameAgainstEvent } from "../src/eventScorer.js";
import { POSE_UP_ARMS, poseAt, STANDARD_BEATS } from "./helpers/synthetic.js";
const event = {
  t: 1,
  targetBones: POSE_UP_ARMS,
  window: { early: -0.25, late: 0.25 },
  weights: DEFAULT_BONE_WEIGHTS,
  difficulty: 2,
  moveId: "m1"
};
const frames = [0.8, 0.95, 1, 1.1, 1.3].map((t) => ({
  t,
  bones: poseAt(STANDARD_BEATS, t)
}));
const conf1 = new Array(10).fill(1);
describe("scanEvent", () => {
  it("keeps the best (max pose) frame inside the window", () => {
    const best = scanEvent(event, frames, {});
    expect(best).not.toBeNull();
    expect(best.t).toBeCloseTo(1, 3);
    expect(best.poseScore).toBeGreaterThan(0.999);
  });
  it("returns null when no frame lands in the window", () => {
    const outside = frames.filter((f) => f.t < 0.1);
    expect(outside.length).toBe(0);
    const tooLate = frames.map((f) => ({ ...f, t: f.t + 5 }));
    expect(scanEvent(event, tooLate, {})).toBeNull();
  });
});
describe("scoreFrameAgainstEvent", () => {
  it("scores an individual frame", () => {
    const s = scoreFrameAgainstEvent(event, frames[2], {});
    expect(s.poseScore).toBeGreaterThan(0.999);
  });
  it("prefers per-event targetYaw over the global refYaw", () => {
    const evt = { ...event, targetYaw: 0.4 };
    const pFrame = { t: 1, bones: POSE_UP_ARMS, rootYaw: 0.4 };
    const withGlobal = scoreFrameAgainstEvent(evt, pFrame, { yawMode: "rootYaw", refYaw: 0.9 });
    const without = scoreFrameAgainstEvent(evt, pFrame, { yawMode: "rootYaw" });
    expect(withGlobal.poseScore).toBe(without.poseScore);
  });
  it("keeps identical self-playback perfect under rootYaw alignment", () => {
    const evt = { ...event, targetYaw: 0.4 };
    const pFrame = { t: 1, bones: POSE_UP_ARMS, rootYaw: 0.4 };
    const s = scoreFrameAgainstEvent(evt, pFrame, { yawMode: "rootYaw" });
    expect(s.poseScore).toBeGreaterThan(0.999);
  });
});
describe("scoreEvent", () => {
  it("scores perfect timing (dt=0) as 1.0", () => {
    const r = scoreEvent(event, { t: 1, poseScore: 1, conf: conf1 }, {});
    expect(r.grade).toBe("perfect");
    expect(r.eventScore).toBeCloseTo(1, 6);
  });
  it("applies additive S2 with discrete bands (dt=0.1 -> great)", () => {
    const r = scoreEvent(event, { t: 1.1, poseScore: 1, conf: conf1 }, {});
    expect(r.grade).toBe("great");
    expect(r.timingValue).toBe(0.8);
    expect(r.eventScore).toBeCloseTo(0.65 + 0.35 * 0.8, 6);
  });
  it("supports exponential timing in teaching mode", () => {
    const r = scoreEvent(event, { t: 1.1, poseScore: 1, conf: conf1 }, { timingFn: "exponential", timingSigma: 0.2 });
    expect(r.timingValue).toBeCloseTo(Math.exp(-0.5), 6);
    expect(r.eventScore).toBeCloseTo(0.65 + 0.35 * Math.exp(-0.5), 6);
  });
  it("records a miss with zero score when no candidate found", () => {
    const r = scoreEvent(event, null, {});
    expect(r.grade).toBe("miss");
    expect(r.inWindow).toBe(false);
    expect(r.eventScore).toBe(0);
  });
});
