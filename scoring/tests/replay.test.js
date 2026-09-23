import { describe, expect, it } from "vitest";
import { buildChart } from "../src/chartBuilder.js";
import { replay } from "../src/replay.js";
import { BONES } from "../src/schema.js";
import { makeReference, occlude, perturb, rotateAll, shiftTime, STANDARD_BEATS } from "./helpers/synthetic.js";
const ref = makeReference(STANDARD_BEATS);
const events = buildChart(ref, { mode: "uniform" });
describe("replay \u2014 acceptance scenarios", () => {
  it("perfect player scores ~1.0 with all perfect", () => {
    const r = replay(events, ref.frames, {});
    expect(r.total).toBeGreaterThan(0.999);
    expect(r.tallies.perfect).toBe(events.length);
    expect(r.tallies.miss).toBe(0);
  });
  it("time-shifted player loses only the rhythm dimension", () => {
    const player = shiftTime(ref.frames, 0.1);
    const r = replay(events, player, {});
    expect(r.poseAccuracy).toBeGreaterThan(0.99);
    expect(r.rhythmScore).toBeGreaterThan(0.7);
    expect(r.rhythmScore).toBeLessThan(0.9);
    expect(r.total).toBeLessThan(0.999);
  });
  it("perturbed player loses pose and overall score", () => {
    const player = ref.frames.map((f) => perturb(f, BONES.FOREARM_L, 1.2));
    const r = replay(events, player, {});
    expect(r.poseAccuracy).toBeLessThan(0.98);
    expect(r.total).toBeLessThan(0.999);
  });
  it("occluded player keeps pose but drops completeness", () => {
    const legs = [BONES.THIGH_L, BONES.SHIN_L, BONES.THIGH_R, BONES.SHIN_R];
    const player = ref.frames.map((f) => occlude(f, legs));
    const r = replay(events, player, {});
    expect(r.poseAccuracy).toBeGreaterThan(0.999);
    expect(r.completeness).toBeGreaterThan(0.65);
    expect(r.completeness).toBeLessThan(0.75);
  });
  it("yaw-offset player recovers with hip-line alignment", () => {
    const yaw = 0.9;
    const player = ref.frames.map((f) => ({
      ...f,
      bones: rotateAll(f.bones, yaw)
    }));
    const none = replay(events, player, {});
    const aligned = replay(events, player, { yawMode: "hip-line" });
    expect(none.poseAccuracy).toBeLessThan(0.96);
    expect(aligned.poseAccuracy).toBeGreaterThan(0.97);
    expect(aligned.poseAccuracy).toBeGreaterThan(none.poseAccuracy + 0.05);
    expect(aligned.total).toBeGreaterThan(none.total);
  });
});
