import { describe, expect, it } from "vitest";
import { buildChart, perFrameVelocity } from "../src/chartBuilder.js";
import { makeReference, STANDARD_BEATS } from "./helpers/synthetic.js";
const ref = makeReference(STANDARD_BEATS, "test", 30);
describe("buildChart (uniform)", () => {
  it("samples every intervalFrames and keeps window/weights", () => {
    const events = buildChart(ref, { mode: "uniform" });
    expect(events.length).toBe(7);
    expect(events[0].t).toBeCloseTo(0, 6);
    expect(events[1].t - events[0].t).toBeCloseTo(0.5, 6);
    expect(events.every((e) => e.window.early === -0.25 && e.window.late === 0.25)).toBe(true);
  });
  it("supports custom spacing", () => {
    const events = buildChart(ref, { mode: "uniform", intervalFrames: 30 });
    expect(events.length).toBe(4);
  });
});
describe("buildChart (extrema)", () => {
  it("produces fewer, well-spaced keyframes", () => {
    const uniform = buildChart(ref, { mode: "uniform" });
    const events = buildChart(ref, {
      mode: "extrema",
      minSpacingSec: 0.5,
      velocityThresholdQuantile: 0.4
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(uniform.length);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].t - events[i - 1].t).toBeGreaterThanOrEqual(0.5 - 1e-6);
    }
  });
});
describe("perFrameVelocity", () => {
  it("is non-negative with the same length as frames", () => {
    const vel = perFrameVelocity(ref, [0.285, 0.095, 0.095, 0.095, 0.095, 0.07125, 0.07125, 0.07125, 0.07125, 0.05]);
    expect(vel.length).toBe(ref.frames.length);
    expect(vel.every((v) => v >= 0)).toBe(true);
    expect(vel[0]).toBe(0);
  });
});
