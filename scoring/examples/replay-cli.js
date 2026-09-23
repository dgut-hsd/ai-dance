import { readFileSync } from "node:fs";
import { buildChart } from "../src/chartBuilder.js";
import { assertValidSequence } from "../src/contractValidate.js";
import { BONES } from "../src/schema.js";
import { replay } from "../src/replay.js";
import {
  makeReference,
  occlude,
  perturb,
  rotateAll,
  shiftTime,
  STANDARD_BEATS
} from "../tests/helpers/synthetic.js";
function loadReference() {
  const srcPath = process.argv[2];
  if (!srcPath) return makeReference(STANDARD_BEATS, "demo");
  const parsed = JSON.parse(readFileSync(srcPath, "utf8"));
  assertValidSequence(parsed);
  console.log(
    `loaded ${srcPath}: ${parsed.danceId}, ${parsed.frames.length} frames, ${parsed.meta.fps} fps, ${parsed.meta.durationSec}s, boneCount=${parsed.meta.boneCount}`
  );
  return parsed;
}
const ref = loadReference();
const events = buildChart(ref, { mode: "uniform" });
const scenarios = [
  ["perfect", ref.frames, void 0],
  ["shifted +0.1s", shiftTime(ref.frames, 0.1), void 0],
  ["forearm perturbed", ref.frames.map((f) => perturb(f, BONES.FOREARM_L, 1.2)), void 0],
  ["legs occluded", ref.frames.map((f) => occlude(f, [BONES.THIGH_L, BONES.SHIN_L, BONES.THIGH_R, BONES.SHIN_R])), void 0],
  ["yawed 0.9 rad (hip-line aligned)", ref.frames.map((f) => ({ ...f, bones: rotateAll(f.bones, 0.9) })), { yawMode: "hip-line" }]
];
function fmt(v) {
  return v.toFixed(3);
}
function printResult(name, r) {
  console.log(`
${name}`);
  console.log(
    `  total=${fmt(r.total)}  pose=${fmt(r.poseAccuracy)}  rhythm=${fmt(r.rhythmScore)}  completeness=${fmt(r.completeness)}`
  );
  console.log(`  tallies: perfect=${r.tallies.perfect} great=${r.tallies.great} good=${r.tallies.good} miss=${r.tallies.miss}`);
  for (const s of r.perEvent) {
    const dt = s.deltaT === null ? "  -- " : (s.deltaT >= 0 ? "+" : "") + s.deltaT.toFixed(3);
    console.log(
      `    t=${s.t.toFixed(2)} ${s.grade.padEnd(7)} dt=${dt}s  pose=${fmt(s.poseScore)}  timing=${fmt(s.timingValue)}  event=${fmt(s.eventScore)}`
    );
  }
}
const t0 = performance.now();
for (const [name, frames, opts] of scenarios) {
  const r = replay(events, frames, opts ?? {});
  printResult(name, r);
}
const dtMs = performance.now() - t0;
console.log(`
${scenarios.length} replay runs in ${dtMs.toFixed(1)} ms; events=${events.length}, refFrames=${ref.frames.length}`);
