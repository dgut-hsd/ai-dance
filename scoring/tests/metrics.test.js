import { describe, expect, it } from "vitest";
import { summarize } from "../src/metrics.js";
function ev(partial) {
  return {
    moveId: void 0,
    t: 0,
    difficulty: 1,
    grade: "miss",
    deltaT: 0,
    poseScore: 0,
    timingValue: 0,
    eventScore: 0,
    completeness: 0,
    inWindow: false,
    ...partial
  };
}
describe("summarize", () => {
  it("returns zeroed aggregates for empty input", () => {
    const r = summarize([]);
    expect(r.total).toBe(0);
    expect(r.perEvent).toEqual([]);
    expect(r.tallies).toEqual({ perfect: 0, great: 0, good: 0, miss: 0 });
  });
  it("tallies grades and averages in-window dims", () => {
    const r = summarize([
      ev({ difficulty: 2, grade: "perfect", eventScore: 1, poseScore: 1, timingValue: 1, completeness: 1, inWindow: true }),
      ev({ difficulty: 2, grade: "great", eventScore: 0.93, poseScore: 1, timingValue: 0.8, completeness: 0.9, inWindow: true }),
      ev({ difficulty: 2, grade: "miss", eventScore: 0, poseScore: 0, timingValue: 0, completeness: 0, inWindow: false })
    ]);
    expect(r.tallies).toEqual({ perfect: 1, great: 1, good: 0, miss: 1 });
    expect(r.poseAccuracy).toBeCloseTo(1, 6);
    expect(r.rhythmScore).toBeCloseTo(0.9, 6);
    expect(r.completeness).toBeCloseTo(0.95, 6);
    expect(r.total).toBeCloseTo((1 + 0.93) / 3, 6);
  });
  it("weights the total by difficulty", () => {
    const r = summarize([
      ev({ difficulty: 1, eventScore: 1, inWindow: true }),
      ev({ difficulty: 3, eventScore: 0.5, inWindow: true })
    ]);
    expect(r.total).toBeCloseTo((1 * 1 + 0.5 * 3) / 4, 6);
  });
});
