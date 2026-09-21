/**
 * simple-score.js — 最简评分模块(独立、零依赖)。
 *
 * 目标:给「跟跳挑战」做一个最小可用的评分识别。
 * 只依赖 dance-sequence/v1 契约帧格式(见 docs/interface-contract.md):
 *   - 参考序列: { meta.fps, frames: [{ bones: [[x,y,z],...], conf?: [...] }] }
 *   - 玩家帧:    { bones: [[x,y,z],...], conf?: [...] }
 * 不依赖 three.js / main.js / score.js,后续可直接替换更复杂的评分模块。
 *
 * 用法:
 *   import { SimpleScorer } from "./simple-score.js";
 *   const scorer = new SimpleScorer(sequence);
 *   scorer.reset();
 *   // 每帧(玩家帧随动捕回调到达时):
 *   const r = scorer.judge(t, playerFrame);   // t = 距本局开始的秒数
 *   // r: { acc, combo, tier }  tier ∈ PERFECT | GREAT | MISS
 *   // 结束:
 *   const final = scorer.finalize();          // { score, avgAcc, maxCombo, grade }
 */

// ---- 可调参数 ------------------------------------------------------------

const COMBO_THRESHOLD = 0.55; // 单帧匹配度超过该值算「命中」,连击 +1
const PERFECT_LINE    = 0.8;  // 判定线:PERFECT
const GREAT_LINE      = 0.55; // 判定线:GREAT(低于此即 MISS)
const COMBO_CAP       = 50;   // 连击加成封顶(50 连 = 1.5x)
const COMBO_BONUS     = 0.01; // 每 1 连击的加分倍率

// 结算评级线:平均匹配度 >= 阈值
const GRADES = [
  [0.9, "S"],
  [0.8, "A"],
  [0.7, "B"],
  [0.6, "C"],
  [0.0, "D"],
];

// ---- 工具 -----------------------------------------------------------------

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function tierFor(acc) {
  if (acc >= PERFECT_LINE) return "PERFECT";
  if (acc >= GREAT_LINE) return "GREAT";
  return "MISS";
}

function gradeFor(avgAcc) {
  for (const [line, g] of GRADES) {
    if (avgAcc >= line) return g;
  }
  return "D";
}

// ---- 评分器 ---------------------------------------------------------------

export class SimpleScorer {
  constructor(sequence) {
    this.frames = sequence?.frames || [];
    this.fps = sequence?.meta?.fps || 30;
    this.reset();
  }

  reset() {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.hits = 0;
    this.totalAcc = 0;
    this.lastAcc = 0;
    this.lastCombo = 0;
  }

  // 取 t 秒对应的参考帧(最近帧,不做 DTW;教练与玩家同步跳,时间天然对齐)
  frameAt(t) {
    if (!this.frames.length) return null;
    const i = clamp(Math.round(t * this.fps), 0, this.frames.length - 1);
    return this.frames[i] || null;
  }

  /**
   * 判定一帧。
   * @param {number} t 歌曲时间(秒)
   * @param {object} playerFrame 玩家实时契约帧(至少含 bones 数组)
   * @returns {{acc:number, combo:number, tier:string}|null}
   */
  judge(t, playerFrame) {
    const ref = this.frameAt(t);
    if (!ref || !playerFrame) return null;
    const acc = this._similarity(ref, playerFrame);
    this.lastAcc = acc;
    this.combo = acc >= COMBO_THRESHOLD ? this.combo + 1 : 0;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.lastCombo = this.combo;
    this.hits++;
    this.totalAcc += acc;
    // 连击加成:每 1 连击 +1%,封顶 1.5x
    const mult = 1 + Math.min(this.combo, COMBO_CAP) * COMBO_BONUS;
    this.score += acc * 100 * mult;
    return { acc, combo: this.combo, tier: tierFor(acc) };
  }

  // 单帧相似度:逐骨骼余弦相似度(映射到 0..1),按置信度加权平均
  _similarity(ref, player) {
    const rb = ref.bones || [];
    const pb = player.bones || [];
    const rc = ref.conf || [];
    const pc = player.conf || [];
    const n = Math.min(rb.length, pb.length);
    let sum = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const a = rb[i];
      const b = pb[i];
      if (!a || !b) continue;
      const la = Math.hypot(a[0], a[1], a[2]);
      const lb = Math.hypot(b[0], b[1], b[2]);
      if (la < 1e-6 || lb < 1e-6) continue; // 零向量(损坏帧)跳过
      let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
      dot = clamp(dot, -1, 1);
      const sim = (dot + 1) / 2; // 点积 -1..1 → 相似度 0..1
      const w = Math.min(rc[i] ?? 1, pc[i] ?? 1); // 取两端较低置信度
      sum += sim * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : 0;
  }

  // 结算
  finalize() {
    const avgAcc = this.hits ? this.totalAcc / this.hits : 0;
    return {
      score: Math.round(this.score),
      avgAcc,
      maxCombo: this.maxCombo,
      grade: gradeFor(avgAcc),
    };
  }
}
