// One chart, one judgement stream for feedback, score and final results.
import { NoteJudge, LatencyModel } from "./audio.js";
import { BONE_DEFS, resolveMode } from "../pose_capture/contract.js";
import { framePoseScore, frameCompleteness } from "../scoring/src/poseScore.js";
import { DEFAULT_BONE_WEIGHTS } from "../scoring/src/schema.js";
const gradeFor = (value) => value >= .9 ? "S" : value >= .8 ? "A" : value >= .7 ? "B" : value >= .6 ? "C" : "D";
export class ScoringAdapter {
  constructor(sequence) {
    this.seq = sequence;
    this.fps = sequence.meta?.fps || 30;
    this.defs = sequence.bones || resolveMode(sequence.meta?.danceType).bones;
    this.latency = new LatencyModel();
    this.chart = sequence.chart || { version: "chart/v1", notes: sequence.frames
      .filter((_, i) => i % Math.max(1, Math.round(this.fps * .5)) === 0)
      .map((f, i) => ({ id: `auto-${i}`, t: f.t, type: "pose", lane: "body" })) };
    this.reset();
  }
  reset() {
    this.score = 0; this.combo = 0; this.maxCombo = 0; this.hits = 0; this.totalAcc = 0;
    this.lastTier = null; this.results = []; this.finished = false;
    this.judgeEngine = new NoteJudge(this.chart, (r, p) => this._similarity(r, p), {
      latency: this.latency,
      durationSec: this.seq.meta?.durationSec ?? Infinity,
      refAt: (t, note) => note?.refFrameIdx != null ? this.seq.frames[note.refFrameIdx] : this.frameAt(t),
      onJudgement: (r) => {
        if (r.ongoing) return;
        this.results.push(r); this.score += r.score; this.combo = r.combo;
        this.maxCombo = Math.max(this.maxCombo, this.combo); this.lastTier = r.tier;
        if (r.tier !== "MISS") { this.hits++; this.totalAcc += r.acc; }
      },
    });
  }
  frameAt(t) {
    // Exports may have missing frames: use timestamps rather than array index / fps.
    const frames = this.seq.frames;
    let lo = 0, hi = frames.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid].t < t) lo = mid + 1; else hi = mid; }
    if (!lo) return frames[0] ?? null;
    if (lo === frames.length) return frames[lo - 1];
    return t - frames[lo - 1].t <= frames[lo].t - t ? frames[lo - 1] : frames[lo];
  }
  _similarity(ref, player) {
    if (!ref || !player) return 0;
    const weights = this.defs.map((d) => DEFAULT_BONE_WEIGHTS[BONE_DEFS.findIndex((b) => b.name === d.name)] ?? 0);
    const conf = weights.map((_, i) => Math.min(ref.conf?.[i] ?? 1, player.conf?.[i] ?? 1));
    if (frameCompleteness(weights, conf) < .5) return 0;
    return framePoseScore(ref.bones, player.bones, weights, conf);
  }
  judge(t, frame) {
    if (this.finished || !frame || t < 0) return null;
    this.judgeEngine.feed(t, frame);
    return { acc: this._similarity(this.frameAt(t), frame), combo: this.combo, tier: this.lastTier };
  }
  advance(t) { return this.finished ? [] : this.judgeEngine.tick(t); }
  finalize() {
    if (!this.finished) { this.judgeEngine.finish(); this.finished = true; }
    const stats = this.judgeEngine.finalize();
    const avgAcc = stats.totalNotes ? this.totalAcc / stats.totalNotes : 0;
    const tallies = Object.fromEntries(["perfect", "great", "good", "miss"].map((k) => [k, stats[k]]));
    const quality = stats.totalNotes ? this.results.reduce((n, r) => n +
      ({ PERFECT: 1, GREAT: .8, GOOD: .6, MISS: 0 }[r.tier] * r.acc), 0) / stats.totalNotes : 0;
    return { score: Math.round(this.score), avgAcc, maxCombo: this.maxCombo,
      grade: gradeFor(quality), tallies, hitRate: stats.totalNotes ? this.hits / stats.totalNotes : 0 };
  }
}
