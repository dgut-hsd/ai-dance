/**
 * scoring-adapter.js — 评分引擎(../scoring) 接入组长前端的中转层。
 *
 * 对 main.js 暴露与 SimpleScorer 完全相同的接口:
 *   reset() / frameAt(t) / judge(t, frame) / _similarity(ref, player) / finalize()
 * 维护 SimpleScorer 的同名现场字段(score/combo/maxCombo/hits/totalAcc),
 * 使 updateScoreHUD 等消费点零改动。
 *
 * 内部改为事件驱动:
 *   buildChart(seq) 生成判定事件 → ScoringEngine 流式 ingest,
 *   事件窗口闭合时出 EventScore(grade=perfect/great/good|miss),
 *   HUD 在事件间隙显示对"最近未来事件"的预览 acc(只显示,不入分)。
 *
 * 判定窗默认按组长契约冻结值: ±0.050/0.100/0.150(秒)。
 */

import { buildChart } from "../scoring/src/chartBuilder.js";
import { ScoringEngine } from "../scoring/src/engine.js";
import { DEFAULT_BONE_WEIGHTS, BONE_COUNT } from "../scoring/src/schema.js";
import { framePoseScore } from "../scoring/src/poseScore.js";

// 契约冻结判定窗: perfect ≤0.050s / great ≤0.100s / good ≤0.150s
const FROZEN_BANDS = [
  { edge: 0.05, grade: "perfect", value: 1 },
  { edge: 0.10, grade: "great", value: 0.8 },
  { edge: 0.15, grade: "good", value: 0.6 },
];

const GRADES = [
  [0.9, "S"],
  [0.8, "A"],
  [0.7, "B"],
  [0.6, "C"],
  [0.0, "D"],
];

const COMBO_CAP = 50;
const COMBO_BONUS = 0.01;

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function tierForGrade(g) {
  if (g === "perfect") return "PERFECT";
  if (g === "great" || g === "good") return "GREAT";
  return "MISS";
}

function gradeFor(avgAcc) {
  for (const [line, g] of GRADES) {
    if (avgAcc >= line) return g;
  }
  return "D";
}

// 玩家帧清洗:归一化骨骼 + 裁剪 conf, 让引擎的严格校验在直播流下不炸
function sanitizeFrame(frame) {
  const src = frame.bones || [];
  const rawConf = frame.conf || [];
  const bones = new Array(BONE_COUNT);
  const conf = new Array(BONE_COUNT);
  for (let i = 0; i < BONE_COUNT; i++) {
    const v = src[i];
    let x = 0, y = 0, z = 0;
    if (v && v.length >= 3) {
      x = v[0] || 0;
      y = v[1] || 0;
      z = v[2] || 0;
    }
    const len = Math.hypot(x, y, z);
    let w = typeof rawConf[i] === "number" ? clamp(rawConf[i], 0, 1) : 1;
    if (len > 1e-6) {
      bones[i] = [x / len, y / len, z / len];
    } else {
      bones[i] = [0, 0, 0];
      w = 0;
    }
    conf[i] = w;
  }
  return { t: frame.t, bones, conf };
}

export class ScoringAdapter {
  constructor(sequence, opts = {}) {
    this.seq = sequence;
    this.fps = sequence?.meta?.fps || 30;
    this.events = buildChart(sequence, {
      mode: opts.mode ?? "uniform",
      window: opts.window ?? { early: -0.25, late: 0.25 },
    });
    this.bands = opts.bands ?? FROZEN_BANDS;
    this.windowEdge = opts.windowEdge ?? 0.15;
    this.reset();
  }

  reset() {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.hits = 0;
    this.totalAcc = 0;
    this.lastTier = null;
    this.results = [];
    this._probeIdx = 0;
    this.engine = new ScoringEngine(this.events, {
      bands: this.bands,
      windowEdge: this.windowEdge,
    });
  }

  // 取 t 秒对应的参考帧(最近帧, 不回溯; 教练与玩家同步跳)
  frameAt(t) {
    const frames = this.seq?.frames;
    if (!frames || !frames.length) return null;
    const i = clamp(Math.round(t * this.fps), 0, frames.length - 1);
    return frames[i] || null;
  }

  judge(t, frame) {
    if (!frame) return null;
    const clean = sanitizeFrame({ ...frame, t });
    const released = this.engine.ingest(clean);
    for (const s of released) this._collect(s);
    const acc = this._previewAcc(clean);
    return { acc, combo: this.combo, tier: this.lastTier ?? "MISS" };
  }

  _collect(s) {
    this.results.push(s);
    if (!s.inWindow) {
      this.combo = 0;
      this.lastTier = "MISS";
      return;
    }
    this.hits++;
    this.totalAcc += s.poseScore;
    this.combo += 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.lastTier = tierForGrade(s.grade);
    const mult = 1 + Math.min(this.combo, COMBO_CAP) * COMBO_BONUS;
    this.score += s.eventScore * 100 * mult;
  }

  _previewAcc(clean) {
    const evs = this.events;
    while (this._probeIdx < evs.length && (evs[this._probeIdx]?.t ?? -1) < clean.t) {
      this._probeIdx++;
    }
    const target = evs[this._probeIdx] ?? evs[evs.length - 1];
    if (!target) return 0;
    const weights = target.weights ?? DEFAULT_BONE_WEIGHTS;
    return framePoseScore(target.targetBones, clean.bones, weights, clean.conf);
  }

  // SongSession 音符判定用的逐帧相似度
  _similarity(ref, player) {
    if (!ref || !player) return 0;
    const weights = ref.weights ?? DEFAULT_BONE_WEIGHTS;
    const conf = Array.isArray(player.conf) && player.conf.length === BONE_COUNT
      ? player.conf
      : new Array(BONE_COUNT).fill(1);
    return framePoseScore(ref.bones, player.bones, weights, conf);
  }

  finalize() {
    for (const s of this.engine.close()) this._collect(s);
    const tallies = { perfect: 0, great: 0, good: 0, miss: 0 };
    for (const s of this.results) tallies[s.grade] = (tallies[s.grade] ?? 0) + 1;
    const avgAcc = this.hits ? this.totalAcc / this.hits : 0;
    return {
      score: Math.round(this.score),
      avgAcc,
      maxCombo: this.maxCombo,
      grade: gradeFor(avgAcc),
      tallies,
    };
  }
}