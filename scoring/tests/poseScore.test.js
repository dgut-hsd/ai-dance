import { describe, expect, it } from "vitest";
import { frameCompleteness, framePoseScore } from "../src/poseScore.js";
import { STANDING } from "./helpers/synthetic.js";
const mirrored = STANDING.map(([x, y, z]) => [-x, y, z]);
describe("framePoseScore", () => {
  it("returns 1 for identical skeletons", () => {
    expect(framePoseScore(STANDING, STANDING)).toBe(1);
  });
  it("is bounded to [0, 1] and drops on mismatch", () => {
    const s = framePoseScore(STANDING, mirrored);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(1);
  });
  it("zeroes conf contributions and rescales denominator", () => {
    const conf = [1, 1, 1, 1, 1, 0, 0, 0, 0, 1];
    expect(framePoseScore(STANDING, STANDING, void 0, conf)).toBeCloseTo(1, 6);
  });
  it("returns 0 when every bone is occluded", () => {
    expect(framePoseScore(STANDING, STANDING, void 0, new Array(10).fill(0))).toBe(0);
  });
});
describe("frameCompleteness", () => {
  it("is 1 with full confidence", () => {
    expect(frameCompleteness(void 0, new Array(10).fill(1))).toBe(1);
  });
  it("drops by the weights of occluded bones", () => {
    const conf = [1, 1, 1, 1, 1, 0, 0, 0, 0, 1];
    expect(frameCompleteness(void 0, conf)).toBeCloseTo(0.715, 6);
  });
  it("is 0 when everything is occluded", () => {
    expect(frameCompleteness(void 0, new Array(10).fill(0))).toBe(0);
  });
});
