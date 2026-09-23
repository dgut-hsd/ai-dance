import { describe, expect, it } from "vitest";
import { ScoringEngine } from "../src/engine.js";
import { DEFAULT_BONE_WEIGHTS } from "../src/schema.js";
import { makeReference, STANDARD_BEATS } from "./helpers/synthetic.js";
const events = [
  { t: 1, targetBones: STANDARD_BEATS[1].bones, window: { early: -0.25, late: 0.25 }, weights: DEFAULT_BONE_WEIGHTS, difficulty: 2, moveId: "a" },
  { t: 2, targetBones: STANDARD_BEATS[2].bones, window: { early: -0.25, late: 0.25 }, weights: DEFAULT_BONE_WEIGHTS, difficulty: 3, moveId: "b" }
];
describe("ScoringEngine", () => {
  it("releases events once their window closes", () => {
    const ref = makeReference(STANDARD_BEATS);
    const engine = new ScoringEngine(events, {});
    let count = 0;
    for (const f of ref.frames) {
      if (f.t > 1.3) break;
      const out = engine.ingest(f);
      count += out.length;
    }
    expect(count).toBe(1);
    expect(engine.close().length).toBe(1);
  });
  it("scores a perfect playback as all perfect", () => {
    const ref = makeReference(STANDARD_BEATS);
    const engine = new ScoringEngine(events, {});
    const all = [...ref.frames.flatMap((f) => engine.ingest(f)), ...engine.close()];
    expect(all.length).toBe(2);
    expect(all.every((r) => r.grade === "perfect")).toBe(true);
    expect(all.every((r) => r.eventScore > 0)).toBe(true);
  });
  it("throws on non-monotonic frame time", () => {
    const engine = new ScoringEngine(events, {});
    engine.ingest({ t: 1, bones: STANDARD_BEATS[0].bones });
    expect(() => engine.ingest({ t: 0.5, bones: STANDARD_BEATS[0].bones })).toThrow(/monotonic/);
  });
  it("flushes all pending events with close()", () => {
    const engine = new ScoringEngine(events, {});
    const all = engine.close();
    expect(all.length).toBe(2);
    expect(all.every((r) => r.inWindow === false && r.eventScore === 0)).toBe(true);
  });
});
