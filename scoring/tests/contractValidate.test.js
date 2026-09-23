import { describe, expect, it } from "vitest";
import { assertValidSequence, assertValidFrame, resolveConf, validateFrame, validateSequence } from "../src/contractValidate.js";
import { makeReference, STANDARD_BEATS, STANDING } from "./helpers/synthetic.js";
const valid = { t: 1, bones: STANDING };
describe("validateFrame", () => {
  it("accepts a valid 10-bone unit frame", () => {
    expect(validateFrame(valid)).toEqual([]);
    expect(() => assertValidFrame(valid)).not.toThrow();
  });
  it("rejects wrong bone count", () => {
    const frame = { ...valid, bones: valid.bones.slice(0, 5) };
    const issues = validateFrame(frame);
    expect(issues.some((i) => i.path === "bones" && i.message.includes("10"))).toBe(true);
  });
  it("rejects legacy 9-bone frames", () => {
    const frame = { ...valid, bones: valid.bones.slice(0, 9) };
    const issues = validateFrame(frame);
    expect(issues.some((i) => i.path === "bones" && i.message.includes("expected 10 bones"))).toBe(true);
  });
  it("rejects non-unit bones", () => {
    const bones = STANDING.map((b) => [...b]);
    bones[0] = [2, 0, 0];
    const issues = validateFrame({ ...valid, bones });
    expect(issues.some((i) => i.path === "bones[0]" && i.message.includes("unit"))).toBe(true);
  });
  it("rejects non-finite coordinates", () => {
    const bones = STANDING.map((b) => [...b]);
    bones[1] = [Number.NaN, 0, 1];
    const issues = validateFrame({ ...valid, bones });
    expect(issues.some((i) => i.path === "bones[1]" && i.message.includes("finite"))).toBe(true);
  });
  it("rejects malformed conf", () => {
    expect(validateFrame({ ...valid, conf: [1, 1] }).some((i) => i.path === "conf")).toBe(true);
    expect(validateFrame({ ...valid, conf: [-1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }).some((i) => i.path.startsWith("conf["))).toBe(true);
  });
  it("rejects zero bone without conf 0", () => {
    const bones = STANDING.map((b) => [...b]);
    bones[3] = [0, 0, 0];
    const issues = validateFrame({ ...valid, bones, conf: new Array(10).fill(1) });
    expect(issues.some((i) => i.message.includes("zero bone"))).toBe(true);
  });
  it("accepts zero bone paired with conf 0", () => {
    const bones = STANDING.map((b) => [...b]);
    bones[3] = [0, 0, 0];
    const conf = new Array(10).fill(1);
    conf[3] = 0;
    expect(validateFrame({ ...valid, bones, conf })).toEqual([]);
  });
  it("defaults conf to all ones", () => {
    expect(resolveConf(valid)).toEqual(new Array(10).fill(1));
  });
});
describe("validateSequence", () => {
  const seq = makeReference(STANDARD_BEATS);
  it("accepts a valid 10-bone sequence", () => {
    expect(validateSequence(seq)).toEqual([]);
    expect(() => assertValidSequence(seq)).not.toThrow();
  });
  it("rejects bones that deviate from the contract order", () => {
    const swizzled = { ...seq, bones: [...seq.bones].reverse() };
    const issues = validateSequence(swizzled);
    expect(issues.some((i) => i.path.startsWith("bones[") && i.message.includes("expected bone"))).toBe(true);
  });
  it("rejects a 9-bone sequence", () => {
    const legacy = { ...seq, bones: seq.bones.slice(0, 9) };
    const issues = validateSequence(legacy);
    expect(issues.some((i) => i.path === "bones" && i.message.includes("10"))).toBe(true);
  });
  it("surfaces invalid frames inside the sequence", () => {
    const frames = seq.frames.map((f, i) => i === 2 ? { ...f, bones: [...f.bones], t: Number.NaN } : f);
    const issues = validateSequence({ ...seq, frames });
    expect(issues.some((i) => i.path === "frames[2].t" && i.message.includes("finite"))).toBe(true);
    expect(() => assertValidSequence({ ...seq, frames })).toThrow(/frames\[2\]\.t/);
  });
});
