import { describe, expect, it } from "vitest";
import { alignPlayer, estimateYawFromHipLine, getYaw, rotateYaw } from "../src/yawAlign.js";
import { framePoseScore } from "../src/poseScore.js";
import { STANDING } from "./helpers/synthetic.js";
describe("estimateYawFromHipLine", () => {
  it("returns ~0 for a canonical standing pose", () => {
    expect(Math.abs(estimateYawFromHipLine(STANDING))).toBeLessThan(1e-3);
  });
  it("recovers a synthetic body yaw and realigns", () => {
    const yaw = 0.4;
    const rotated = rotateYaw(STANDING, yaw);
    const est = estimateYawFromHipLine(rotated);
    expect(Math.abs(est + yaw)).toBeLessThan(0.01);
    const realigned = alignPlayer(rotated, est, 0);
    expect(framePoseScore(STANDING, realigned)).toBeGreaterThan(0.995);
  });
});
describe("getYaw", () => {
  const frame = { bones: STANDING, rootYaw: 0.3 };
  it("uses rootYaw in rootYaw mode", () => {
    expect(getYaw(frame, "rootYaw")).toBe(0.3);
  });
  it("ignores rootYaw in hip-line mode", () => {
    expect(getYaw(frame, "hip-line")).toBeCloseTo(0, 3);
  });
});
