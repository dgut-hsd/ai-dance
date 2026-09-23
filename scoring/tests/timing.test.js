import { describe, expect, it } from "vitest";
import { expTimingValue, gradeOf, GAME_BANDS, timingValue } from "../src/timing.js";
describe("gradeOf", () => {
  it("maps exact band edges inclusively", () => {
    expect(gradeOf(0, GAME_BANDS)).toBe("perfect");
    expect(gradeOf(0.05, GAME_BANDS)).toBe("perfect");
    expect(gradeOf(0.12, GAME_BANDS)).toBe("great");
    expect(gradeOf(0.2, GAME_BANDS)).toBe("good");
    expect(gradeOf(0.25, GAME_BANDS)).toBe("miss");
  });
  it("maps just outside edges to the next band", () => {
    expect(gradeOf(0.0501, GAME_BANDS)).toBe("great");
    expect(gradeOf(0.121, GAME_BANDS)).toBe("good");
  });
  it("is miss beyond the window edge", () => {
    expect(gradeOf(0.3, GAME_BANDS)).toBe("miss");
    expect(gradeOf(-0.4, GAME_BANDS, 0.25)).toBe("miss");
  });
});
describe("timingValue", () => {
  it("is a piecewise step function", () => {
    expect(timingValue(0, GAME_BANDS)).toBe(1);
    expect(timingValue(0.04, GAME_BANDS)).toBe(1);
    expect(timingValue(0.1, GAME_BANDS)).toBe(0.8);
    expect(timingValue(0.19, GAME_BANDS)).toBe(0.6);
    expect(timingValue(0.3, GAME_BANDS)).toBe(0);
    expect(timingValue(-0.31, GAME_BANDS)).toBe(0);
  });
});
describe("expTimingValue", () => {
  it("is 1 at zero offset and decays exponentially", () => {
    expect(expTimingValue(0, 0.2)).toBe(1);
    expect(expTimingValue(0.2, 0.2)).toBeCloseTo(Math.exp(-1), 6);
    expect(expTimingValue(0.4, 0.2)).toBeCloseTo(Math.exp(-2), 6);
  });
});
