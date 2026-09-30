// One chart, one judgement stream for feedback, score and final results.
// 运行时判定主机:scoring/src 的 ScoringEngine(chart/v2 → 事件 → 流式判定),
// 替代 audio.js 的 NoteJudge;姿态匹配复用 poseScore + DEFAULT_BONE_WEIGHTS。
import { LatencyModel } from "./audio.js";
import { BONE_DEFS, resolveMode } from "../pose_capture/contract.js";
import { framePoseScore, frameCompleteness, boneDot } from "../scoring/src/poseScore.js";
import { DEFAULT_BONE_WEIGHTS } from "../scoring/src/schema.js";
import { ScoringEngine } from "../scoring/src/engine.js";
import { parseChart, parseTimingWindows } from "../scoring/src/chartCodec.js";
import { createScoringLog, recordScoringFrame, finalizeScoringLog } from "./scoring-log.js";
import { loadConfig, gradeFor, tierMultipliers, bandsFor } from "./scoring-config.js";
const BONE_COUNT = DEFAULT_BONE_WEIGHTS.length;
// 设置页存的是布尔(勾选框),引擎内部按 "rootYaw"/"none" 字符串分支
// (eventScorer 判的是 yawMode !== "none")。两处构造 engine 的路径都必须过这里,
// 否则 false 也会被当成"开启",朝向对齐就关不掉。
const yawModeArg = (v) => (v ? "rootYaw" : "none");
export class ScoringAdapter {
  constructor(sequence) {
    this.seq = sequence;
    this.fps = sequence.meta?.fps || 30;
    this.defs = sequence.bones || resolveMode(sequence.meta?.danceType).bones;
    this.latency = new LatencyModel();
    this.cfg = loadConfig();
    this.chart = sequence.chart || { version: "chart/v2", notes: sequence.frames
      .filter((_, i) => i % Math.max(1, Math.round(this.fps * .5)) === 0)
      .map((f, i) => ({ id: `auto-${i}`, t: f.t, type: "pose" })) };
    // 谱面自带的 timingWindows 优先;设置页旋钮是「全局缺省」,不覆盖谱面作者意图。
    this.chartBands = parseTimingWindows(this.chart);
    try { this.events = parseChart(sequence, this.chart); } catch (e) {
      console.warn("[ScoringAdapter] chart parse failed, judging disabled:", e);
      this.events = [];
    }
    this.reset();
  }
  // 热更新:设置页改了旋钮时调用。保留已积累的分数/连击,只换判定参数。
  applyConfig(cfg) {
    this.cfg = cfg || loadConfig();
    this._applyEngine();
    // 监测开关可以在对局中途切:开→新建采集缓冲,关→丢弃(半截数据没有分析价值)。
    if (this.cfg.monitorLog && !this.log) this.log = createScoringLog();
    else if (!this.cfg.monitorLog) this.log = null;
    // 采样窗逐音符覆盖(events 上已固化),需重算未结算事件的窗口。
    const w = this.cfg.judgeWindow;
    for (const p of this.engine.pending) p.event = { ...p.event, window: { early: -w, late: w } };
    for (const p of this.engine.pending) p.closeAt = p.event.t + p.event.window.late;
    this.engine.pending.sort((a, b) => a.closeAt - b.closeAt);
  }
  _applyEngine() {
    const c = this.cfg;
    const bands = this.chartBands ?? bandsFor(c);
    this.timingBands = bands;
    // engine.opts 是每次 scoreEvent 时读取的 live 对象,直接改字段即热生效。
    Object.assign(this.engine.opts, {
      bands,
      windowEdge: c.judgeWindow,
      minPoseScore: c.minPoseScore,
      minCompleteness: c.minCompleteness,
      poseWeight: c.poseWeight,
      timingWeight: 1 - c.poseWeight,
      posePerfect: c.posePerfect,
      poseGreat: c.poseGreat,
      yawMode: yawModeArg(c.yawMode),
    });
  }
  reset() {
    this.score = 0; this.combo = 0; this.maxCombo = 0; this.hits = 0; this.totalAcc = 0;
    this.lastTier = null; this.results = []; this.finished = false;
    this.tallies = {}; this._pendingFeedback = [];
    this.lastFrameT = Number.NEGATIVE_INFINITY;
    // 监测关闭时 this.log 保持 null:judge() 里整段采集连同逐骨相似度计算一起跳过,
    // 每帧开销为零;finalize() 也就不会产出 log,main.js 自然不会上报。
    this.log = this.cfg.monitorLog ? createScoringLog() : null;
    // 采样窗在谱面层放宽(逐音符 window 优先于 chart 缺省值,故逐条覆盖)
    const w = this.cfg.judgeWindow;
    this.events = this.events.map((e) => ({ ...e, window: { early: -w, late: w } }));
    this.engine = new ScoringEngine(this.events, {
      bands: this.chartBands ?? bandsFor(this.cfg),
      windowEdge: w,
      minPoseScore: this.cfg.minPoseScore,
      minCompleteness: this.cfg.minCompleteness,
      poseWeight: this.cfg.poseWeight,
      timingWeight: 1 - this.cfg.poseWeight,
      posePerfect: this.cfg.posePerfect,
      poseGreat: this.cfg.poseGreat,
      yawMode: yawModeArg(this.cfg.yawMode),
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
  // 与 _similarity 同口径的逐骨相似度(ref stock weight × conf 归一前的裸 dot),仅供评分日志分析。
  _boneSims(ref, player) {
    if (!ref || !player) return null;
    return ref.bones.map((rb, i) => {
      const pb = player.bones?.[i];
      if (!rb || !pb) return 0;
      const l = Math.hypot(pb[0], pb[1], pb[2]);
      if (l < 1e-6) return 0;
      return Math.max(0, boneDot(rb, [pb[0] / l, pb[1] / l, pb[2] / l]));
    });
  }
  judge(t, frame) {
    if (this.finished || !frame || t < 0) return null;
    this._ingest(t, frame);
    const ref = this.frameAt(t);
    const acc = this._similarity(ref, frame);
    const conf = frame.conf?.length ? frame.conf.reduce((a, b) => a + b, 0) / frame.conf.length : 1;
    // 监测关闭(this.log === null)时不做逐骨计算,只留判定要用的 acc。
    if (this.log) {
      recordScoringFrame(this.log, {
        t: Math.round(t * 1000) / 1000,
        acc: Math.round(acc * 1000) / 1000,
        conf: Math.round(conf * 1000) / 1000,
        bones: this._boneSims(ref, frame),
      });
    }
    return { acc, combo: this.combo, tier: this.lastTier };
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
    const tiers = tierMultipliers(this.cfg);
    const quality = n ? this.results.reduce((s, r) => s + (tiers[r.tier] ?? 0) * r.acc, 0) / n : 0;
    const log = finalizeScoringLog(this.log, {
      score: Math.round(this.score), avgAcc, maxCombo: this.maxCombo,
      grade: gradeFor(quality, this.cfg), tallies, hitRate,
    });
    return { score: Math.round(this.score), avgAcc, maxCombo: this.maxCombo,
      grade: gradeFor(quality, this.cfg), tallies, hitRate, log };
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
    const c = this.cfg;
    const mult = 1 + Math.min(this.combo, c.comboCap) * c.comboStep;
    const addend = Math.round(r.eventScore * c.scoreBase * mult * (tierMultipliers(c)[tier] ?? 0));
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