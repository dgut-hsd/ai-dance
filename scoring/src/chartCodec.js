/**
 * chartCodec.js — chart/v2 谱面文件 <-> 引擎判定事件 的双向编解码。
 *
 * 谱面文件采用组长冻结的 contract §4.2 `chart/v2`(v1 兼容;notes 仅 pose|gesture,
 * gesture 暂无手部模型故跳过),
 * 本模块把它解析成 ScoringEngine 可消费的事件流;并支持反向导出。
 * v2 相比 v1:音符类型精简为 pose|gesture(删除 beat/hold/lanes)。
 *
 * 扩展字段(可选,均已校验):
 *   chart.judgeWindow   采样窗 { early, late },缺省 ±0.25
 *   chart.difficulty    全局难度(总分加权),缺省 = 序列 meta.difficulty ?? 2
 *   chart.boneWeights   全局骨骼权重表 [10],缺省 = DEFAULT_BONE_WEIGHTS
 *   note.weights        [10] 事件级全量覆盖
 *   note.bones          [idx] 骨骼子集:非子集骨骼权重归零(判"局部"谱)
 *   note.difficulty     事件级难度
 *   note.window         事件级采样窗
 * chart.timingWindows   判定档位(序号 perfect<great<good)由 parseTimingWindows 导出 bands
 */
import { BONE_COUNT, DEFAULT_BONE_WEIGHTS } from "./schema.js";
import { DEFAULT_WINDOW } from "./chartBuilder.js";

function err(msg) {
  throw new Error("[chartCodec] " + msg);
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function resolveWeights(chart, note, index) {
  let w;
  if (Array.isArray(note.weights)) {
    if (note.weights.length !== BONE_COUNT) {
      err(`事件 ${index}(t=${note.t}) weights 长度须为 ${BONE_COUNT}`);
    }
    w = note.weights.slice();
  } else {
    const base = Array.isArray(chart.boneWeights) ? chart.boneWeights : DEFAULT_BONE_WEIGHTS;
    if (base.length !== BONE_COUNT) err("boneWeights 长度须为 " + BONE_COUNT);
    w = base.slice();
    if (Array.isArray(note.bones) && note.bones.length > 0) {
      const subset = new Set(note.bones.map(Number));
      for (let i = 0; i < BONE_COUNT; i++) {
        if (!subset.has(i)) w[i] = 0;
      }
    }
  }
  const sum = w.reduce((a, b) => a + (b || 0), 0);
  if (!(sum > 0)) err(`事件 ${index}(t=${note.t}) 权重和须 > 0`);
  return w;
}

function clampIdx(idx, len) {
  return Math.min(len - 1, Math.max(0, idx));
}

// 帧下标不能靠 t*fps 反推:抽帧间隔未必均匀(VFR 转码、解码丢帧都会让实际 PTS
// 偏离标称帧率),按标量算出的下标会随时间线性漂移(实测可达数秒)。
// 帧自带 t,直接找时间最近的那一帧。
export function nearestFrameIdx(frames, t) {
  if (!Array.isArray(frames) || frames.length === 0) return 0;
  let best = 0;
  let bestD = Math.abs(frames[0].t - t);
  for (let i = 1; i < frames.length; i++) {
    const d = Math.abs(frames[i].t - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function parseChart(sequence, chart) {
  const src = chart ?? sequence?.chart ?? null;
  if (!src) return [];
  const ver = String(src.version ?? src.schema ?? "");
  if (!/^chart\/v[12]$/.test(ver)) {
    err("缺少 chart.version(内嵌) 或 chart.schema(独立文件),且不是 chart/v1|v2");
  }
  if (!Array.isArray(src.notes)) err("chart.notes 须为数组");
  const frames = sequence?.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    err("参考序列 frames 为空,无法解析谱面");
  }
  const globalWindow = src.judgeWindow ?? DEFAULT_WINDOW;
  const globalDifficulty = src.difficulty ?? sequence.meta?.difficulty ?? 2;
  const events = [];
  src.notes.forEach((note, i) => {
    if (!note || typeof note.t !== "number" || !Number.isFinite(note.t)) {
      err(`note#${i} 缺少合法 t`);
    }
    const type = String(note.type ?? "pose");
    if (type === "gesture") {
      console.warn(`[chartCodec] note#${i}(t=${note.t}) gesture 型跳过:引擎暂无手部模型`);
      return;
    }
    const idx = Number.isInteger(note.refFrameIdx)
      ? clampIdx(note.refFrameIdx, frames.length)
      : nearestFrameIdx(frames, note.t);
    const frame = frames[idx];
    events.push({
      t: note.t,
      noteType: type,
      refFrameIdx: idx,
      targetBones: frame.bones.slice(),
      targetT: frame.t,
      targetYaw: frame.rootYaw,
      window: note.window ?? globalWindow,
      weights: resolveWeights(src, note, i),
      difficulty: note.difficulty ?? globalDifficulty,
      moveId: note.id !== undefined && note.id !== null ? String(note.id) : `${type}-${i}`
    });
  });
  if (events.length === 0) err("谱面无可用事件(全部被跳过)");
  events.sort((a, b) => a.t - b.t);
  return events;
}

// chart/v2 timingWindows → 引擎 bands(档位序号须 perfect<great<good)
export function parseTimingWindows(chart) {
  const tw = chart?.timingWindows;
  if (!tw) return null;
  const order = ["perfect", "great", "good"];
  const valueOf = { perfect: 1, great: 0.8, good: 0.6 };
  const bands = [];
  for (const g of order) {
    const e = Number(tw[g]);
    if (!Number.isFinite(e) || e <= 0) return null;
    bands.push({ edge: e, grade: g, value: valueOf[g] });
  }
  if (!(bands[0].edge < bands[1].edge && bands[1].edge < bands[2].edge)) return null;
  return bands;
}

function attachWeights(note, event, candidate) {
  const w = Array.isArray(event.weights) ? event.weights : candidate;
  if (!w || w.length !== BONE_COUNT) return;
  const same = w.every((v, i) => Math.abs(v - (candidate[i] ?? 0)) < 1e-9);
  if (same) return;
  const nonzero = [];
  let subsetOfCandidate = true;
  for (let i = 0; i < BONE_COUNT; i++) {
    const v = w[i] ?? 0;
    if (v > 0) {
      nonzero.push(i);
      if (Math.abs(v - (candidate[i] ?? 0)) >= 1e-9) subsetOfCandidate = false;
    }
  }
  if (subsetOfCandidate && nonzero.length < BONE_COUNT) note.bones = nonzero;
  else note.weights = w;
}

export function serializeChart(events, opts = {}) {
  const seq = opts.seq;
  const candidate = opts.boneWeights ?? DEFAULT_BONE_WEIGHTS;
  const globalDifficulty = opts.difficulty ?? seq?.meta?.difficulty ?? 2;
  const notes = events.map((e) => {
    const note = clean({
      id: e.moveId,
      t: +e.t.toFixed(3),
      type: e.noteType ?? "pose",
      refFrameIdx: e.refFrameIdx ?? (Number.isFinite(e.targetT) && seq?.frames
        ? nearestFrameIdx(seq.frames, e.targetT)
        : undefined),
      difficulty: e.difficulty && Math.abs(e.difficulty - globalDifficulty) > 1e-9 ? e.difficulty : undefined,
      window: e.window ? { early: e.window.early, late: e.window.late } : undefined
    });
    attachWeights(note, e, candidate);
    return note;
  });
  return clean({
    version: "chart/v2",
    danceId: opts.danceId ?? seq?.danceId,
    audio: opts.audio,
    audioOffsetSec: opts.audioOffsetSec ?? 0.0,
    judgeOffsetSec: opts.judgeOffsetSec ?? 0.0,
    timingWindows: opts.timingWindows ?? { perfect: 0.05, great: 0.1, good: 0.15 },
    judgeWindow: opts.window ? { early: opts.window.early, late: opts.window.late } : undefined,
    boneWeights: opts.boneWeights ?? undefined,
    notes,
    meta: clean({
      source: opts.source ?? "annotated",
      builtFromReference: opts.builtFromReference
    })
  });
}

// 独立 chart 文件(编辑器交换格式,契约 §4.2 末):schema + sequenceFile 包装,
// content = serializeChart 产出的内嵌形态(version/notes/...)
export function toStandaloneChart(content, opts = {}) {
  const seq = opts.seq;
  const sequenceFile = opts.sequenceFile
    ?? (seq?.danceId ? `${seq.danceId}.json` : undefined);
  const { version, meta, ...rest } = content ?? {};
  return clean({
    schema: "chart/v2",
    danceId: rest.danceId,
    sequenceFile,
    ...rest
  });
}

// 契约 §4.2:导出/打包时把 chart 内容合并进序列文件顶层 chart 字段(运行时权威位置)
export function mergeChartIntoSequence(sequence, chart) {
  return { ...sequence, chart };
}

export { DEFAULT_WINDOW };