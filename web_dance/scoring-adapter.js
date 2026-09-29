// One chart, one judgement stream for feedback, score and final results.
// 运行时判定主机:scoring/src 的 ScoringEngine(chart/v2 → 事件 → 流式判定),
// 替代 audio.js 的 NoteJudge;姿态匹配复用 poseScore + DEFAULT_BONE_WEIGHTS。
import { LatencyModel } from "./audio.js";
import { BONE_DEFS, resolveMode } from "../pose_capture/contract.js";
import { framePoseScore, frameCompleteness } from "../scoring/src/poseScore.js";
import { DEFAULT_BONE_WEIGHTS } from "../scoring/src/schema.js";
import { ScoringEngine } from "../scoring/src/engine.js";
import { parseChart, parseTimingWindows } from "../scoring/src/chartCodec.js";
const BONE_COUNT = DEFAULT_BONE_WEIGHTS.length;
const TIER_MULT = { PERFECT: 1.0, GREAT: 0.8, GOOD: 0.6, MISS: 0 };
// 采样窗:契约 §4.2 的 ±0.050/0.100/0.150 是 timingWindows(判定档位),不是采样窗。
// 真机跟跳实测 ±0.25 偏紧(再加上音频延迟就系统性判 miss),放宽到 ±0.30。
// 上限受 test/scoring-regression.test.js「音符在 advance(0.8) 前结算」约束,不可再放大。
const JUDGE_WINDOW = 0.3;
// 采样窗放宽后档位同步放宽,否则 windowEdge 内仍被 GAME_BANDS 判成 miss。
const JUDGE_BANDS = [
  { edge: 0.10, grade: "perfect", value: 1 },
  { edge: 0.18, grade: "great", value: 0.8 },
  { edge: 0.26, grade: "good", value: 0.6 },
  { edge: JUDGE_WINDOW, grade: "miss", value: 0 },
];
// eventScorer 的 minPoseScore 缺省 0.55:姿态分被跨源/遮挡压到 0.55 以下会静默判 miss。
const MIN_POSE_SCORE = 0.4;
const gradeFor = (value) => value >= .9 ? "S" : value >= .8 ? "A" : value >= .7 ? "B" : value >= .6 ? "C" : "D";
export class ScoringAdapter {
  constructor(sequence) {
    this.seq = sequence;
    this.fps = sequence.meta?.fps || 30;
    this.defs = sequence.bones || resolveMode(sequence.meta?.danceType).bones;
    this.latency = new LatencyModel();
    this.chart = sequence.chart || { version: "chart/v2", notes: sequence.frames
      .filter((_, i) => i % Math.max(1, Math.round(this.fps * .5)) === 0)
      .map((f, i) => ({ id: `auto-${i}`, t: f.t, type: "pose" })) };
    this.timingBands = parseTimingWindows(this.chart) ?? JUDGE_BANDS;
    try { this.events = parseChart(sequence, this.chart); } catch (e) {
      console.warn("[ScoringAdapter] chart parse failed, judging disabled:", e);
      this.events = [];
    }
    // 采样窗在谱面层放宽(逐音符 window 优先于 chart 缺省值,故逐条覆盖)
    this.events = this.events.map((e) => ({ ...e, window: { early: -JUDGE_WINDOW, late: JUDGE_WINDOW } }));
    this.reset();
  }
  reset() {
    this.score = 0; this.combo = 0; this.maxCombo = 0; this.hits = 0; this.totalAcc = 0;
    this.lastTier = null; this.results = []; this.finished = false;
    this.tallies = {}; this._pendingFeedback = [];
    this.lastFrameT = Number.NEGATIVE_INFINITY;
    this.engine = new ScoringEngine(this.events, {
      bands: this.timingBands,
      windowEdge: JUDGE_WINDOW,
      minPoseScore: MIN_POSE_SCORE,
      yawMode: "rootYaw",
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
    this._ingest(t, frame);
    return { acc: this._similarity(this.frameAt(t), frame), combo: this.combo, tier: this.lastTier };
  }
  advance(t) {
    if (this.finished) return [];
    if (typeof t === "number" && Number.isFinite(t)) {
      try { for (const r of this.engine.releaseUpTo(t)) this._onEvent(r); } catch (e) { console.warn("[ScoringAdapter] advance:", e); }
    }
    const out = this._pendingFeedback;
    this._pendingFeedback = [];
    return out;
  }
  finalize() {
    if (!this.finished) {
      try { for (const r of this.engine.close()) this._onEvent(r); } catch (e) { console.warn("[ScoringAdapter] close:", e); }
      this.finished = true;
    }
    const n = this.events.length;
    const tallies = { perfect: this.tallies.perfect ?? 0, great: this.tallies.great ?? 0, good: this.tallies.good ?? 0, miss: this.tallies.miss ?? 0 };
    const avgAcc = n ? this.totalAcc / n : 0;
    const hitRate = n ? this.hits / n : 0;
    const quality = n ? this.results.reduce((s, r) => s + (TIER_MULT[r.tier] ?? 0) * r.acc, 0) / n : 0;
    return { score: Math.round(this.score), avgAcc, maxCombo: this.maxCombo,
      grade: gradeFor(quality), tallies, hitRate };
  }
  _ingest(t, frame) {
    // 与旧 NoteJudge 判定时刻对齐:采样窗中心 = note.t + 延迟补偿,镜像为玩家帧时间减补偿。
    const adj = t - this.latency.totalOffsetSec;
    if (adj < this.lastFrameT) return;
    this.lastFrameT = adj;
    const f = this._sanitize(frame, adj);
    if (!f) return;
    let released;
    try { released = this.engine.ingest(f); } catch (e) { console.warn("[ScoringAdapter] ingest:", e); released = []; }
    for (const r of released) this._onEvent(r);
  }
  _sanitize(frame, t) {
    const bones = frame.bones, conf = frame.conf;
    if (!Array.isArray(bones) || bones.length !== BONE_COUNT) return null;
    const nb = new Array(BONE_COUNT), nc = conf && conf.length === BONE_COUNT ? conf : null;
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = bones[i];
      if (!b || b.length !== 3 || !Number.isFinite(b[0] + b[1] + b[2])) { nb[i] = [0, 0, 0]; if (nc) nc[i] = 0; continue; }
      const l = Math.hypot(b[0], b[1], b[2]);
      if (l < 1e-6) { nb[i] = [0, 0, 0]; if (nc) nc[i] = 0; continue; }
      const inv = 1 / l;
      nb[i] = [b[0] * inv, b[1] * inv, b[2] * inv];
      if (nc) nc[i] = Math.min(1, Math.max(0, nc[i]));
    }
    // yawMode:"rootYaw" 依赖这个字段,丢了它 alignPlayer 会拿 ?? 0 当基准空转。
    // 契约 §1:rootYaw = atan2(hipAxis.z, hipAxis.x),hipAxis = right_hip - left_hip(canonical)。
    const out = { t, bones: nb, conf: nc ?? new Array(BONE_COUNT).fill(1) };
    if (Number.isFinite(frame.rootYaw)) out.rootYaw = frame.rootYaw;
    return out;
  }
  _onEvent(r) {
    const tier = String(r.grade).toUpperCase();
    const isMiss = r.grade === "miss";
    if (isMiss) { this.combo = 0; } else {
      this.combo++; this.hits++; this.totalAcc += r.poseScore;
    }
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const mult = 1 + Math.min(this.combo, 50) * 0.01;
    const addend = Math.round(r.eventScore * 100 * mult * (TIER_MULT[tier] ?? 0));
    this.score += addend;
    this.lastTier = tier;
    this.tallies[r.grade] = (this.tallies[r.grade] ?? 0) + 1;
    const result = {
      noteId: r.moveId, noteType: r.noteType ?? "pose", tier,
      acc: r.poseScore, deltaSec: r.deltaT, combo: this.combo,
      score: addend, ongoing: false,
    };
    this.results.push(result);
    this._pendingFeedback.push(result);
  }
}