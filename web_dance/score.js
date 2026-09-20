/**
 * score.js — 舞蹈挑战的实时评分。
 *
 * 核心:参考序列帧 vs 玩家实时帧,逐骨骼做单位向量点积(余弦相似度),
 * 置信度加权,再叠加连击加成,产出分数 / 连击 / 平均匹配度 / 评级。
 */

const COMBO_THRESHOLD = 0.55; // 单帧匹配度超过该值算「命中」,连击 +1

export class DanceScorer {
  constructor(sequence) {
    this.sequence = sequence;
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
    this.grade = "D";
  }

  // 取某时刻对应的参考帧(按 fps 取整)
  frameAt(t) {
    if (!this.frames.length) return null;
    const i = Math.min(this.frames.length - 1, Math.max(0, Math.round(t * this.fps)));
    return this.frames[i] || null;
  }

  /**
   * 判定一帧。
   * @param {number} t 歌曲时间(秒)
   * @param {object} playerFrame 玩家实时契约帧
   * @param {Array} boneDefs 当前模式骨骼表
   * @returns {{acc:number, combo:number}|null}
   */
  judge(t, playerFrame, boneDefs) {
    const ref = this.frameAt(t);
    if (!ref || !playerFrame) return null;
    const acc = this._similarity(ref, playerFrame, boneDefs);
    this.lastAcc = acc;
    if (acc >= COMBO_THRESHOLD) {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    } else {
      this.combo = 0;
    }
    this.lastCombo = this.combo;
    this.hits++;
    this.totalAcc += acc;
    // 连击加成:每 1 combo +1% 倍率,封顶 1.5x
    const mult = 1 + Math.min(this.combo, 50) * 0.01;
    this.score += acc * 100 * mult;
    return { acc, combo: this.combo };
  }

  _similarity(ref, player, boneDefs) {
    const rb = ref.bones || [];
    const pb = player.bones || [];
    const rc = ref.conf || [];
    const pc = player.conf || [];
    const n = Math.min(rb.length, pb.length, boneDefs?.length ?? rb.length);
    let sum = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const a = rb[i];
      const b = pb[i];
      if (!a || !b) continue;
      const la = Math.hypot(a[0], a[1], a[2]);
      const lb = Math.hypot(b[0], b[1], b[2]);
      if (la < 1e-6 || lb < 1e-6) continue;
      let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
      dot = Math.max(-1, Math.min(1, dot));
      const sim = (dot + 1) / 2; // 映射到 0..1
      const w = Math.min(rc[i] ?? 1, pc[i] ?? 1);
      sum += sim * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : 0;
  }

  finalize() {
    const avg = this.hits ? this.totalAcc / this.hits : 0;
    if (avg >= 0.9) this.grade = "S";
    else if (avg >= 0.8) this.grade = "A";
    else if (avg >= 0.7) this.grade = "B";
    else if (avg >= 0.6) this.grade = "C";
    else this.grade = "D";
    return {
      score: Math.round(this.score),
      avgAcc: avg,
      maxCombo: this.maxCombo,
      grade: this.grade,
    };
  }
}
