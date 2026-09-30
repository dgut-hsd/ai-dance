/**
 * bpm.js — 浏览器端音频 BPM 粗测。
 *
 * 做法:解码 → 单声道能量包络(RMS, hop 512) → 起始函数(能量正向差分)
 * → 对每个候选 BPM 做拍网格 comb 打分(落在拍上的起始能量越高分越高)
 * → 返回按分数降序的候选列表(点/两个节 BPM 会同时出现,由调用方给用户挑)。
 * 纯数据计算,不碰 DOM;decode 失败或信号太平返回空数组,由调用方提示。
 */

const BPM_MIN = 40;
const BPM_MAX = 300;
const ANALYZE_MAX_SEC = 90; // 只分析前 90s,够用且不卡
const HOP = 512;
const FRAME = 1024;
const MAX_CANDIDATES = 5;   // 最多返回几个候选
const COMB_MIN_BEATS = 8;   // 至少覆盖几个拍才算分

/** 解码 + 返回候选 BPM 列表:[{ bpm, score }, …] 按 score 降序。失败返回 []。 */
export async function detectBpmCandidates(arrayBuffer) {
  const AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AC) return [];
  let buf;
  try {
    const ctx = new AC(1, 1, 44100);
    buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    return [];
  }
  return detectBpmFromPcm(mixMono(buf), buf.sampleRate);
}

/** 兼容旧接口:返回最佳 BPM 或 null。 */
export async function detectBpm(arrayBuffer) {
  const list = await detectBpmCandidates(arrayBuffer);
  return list.length ? list[0].bpm : null;
}

function mixMono(buf) {
  const n = Math.min(buf.length, Math.floor(ANALYZE_MAX_SEC * buf.sampleRate));
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(0 + c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  const inv = 1 / Math.max(1, buf.numberOfChannels);
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

// 拍网格 comb 打分:候选把音频当成"每隔一拍一个重音"。
// 打分 = 拍位(±2 帧窗)起始能量均值 − 拍位中点(±2 帧窗)起始能量均值,
// 再乘拍数权重。窗很窄(≈一个鼓点),节奏对得上的候选拍位分高;
// 若候选其实漏掉了真实拍点(半速),中点位置会顶着鼓点,分就被扣掉。
function combScore(onset, frames, fps, bpm) {
  const P = fps * 60 / bpm; // 一拍对应的包络帧数
  if (P < 2) return 0;
  const nBeats = Math.min(Math.floor((frames - 1) / P), 40);
  if (nBeats < COMB_MIN_BEATS) return 0;
  let beat = 0, mid = 0;
  for (let b = 1; b <= nBeats; b++) {
    const c = Math.round(b * P);
    const lo = Math.max(0, Math.min(c - 2, frames - 1));
    const hi = Math.max(lo, Math.min(c + 2, frames - 1));
    let m = onset[lo];
    for (let i = lo + 1; i <= hi; i++) if (onset[i] > m) m = onset[i];
    beat += m;
    const m1 = Math.round(b * P + P / 2);
    const mlo = Math.max(0, Math.min(m1 - 2, frames - 1));
    const mhi = Math.max(mlo, Math.min(m1 + 2, frames - 1));
    let m2 = onset[mlo];
    for (let i = mlo + 1; i <= mhi; i++) if (onset[i] > m2) m2 = onset[i];
    mid += m2;
  }
  return (beat - mid) / nBeats;
}

export function detectBpmFromPcm(pcm, sampleRate) {
  const frames = Math.floor((pcm.length - FRAME) / HOP);
  if (frames < sampleRate / HOP * 4) return []; // 少于约 4s 测不准

  // 能量包络
  const energy = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    const off = i * HOP;
    for (let j = 0; j < FRAME; j++) { const v = pcm[off + j]; s += v * v; }
    energy[i] = s / FRAME;
  }

  // 起始函数:正向能量差分,去均值
  const onset = new Float32Array(frames);
  let mean = 0;
  for (let i = 1; i < frames; i++) {
    const d = energy[i] - energy[i - 1];
    onset[i] = d > 0 ? d : 0;
    mean += onset[i];
  }
  mean /= Math.max(1, frames - 1);
  if (mean <= 1e-9) return []; // 太平,没有明显拍点
  for (let i = 0; i < frames; i++) onset[i] -= mean;

  const fps = sampleRate / HOP; // 包络帧率

  // 自相关粗测:找几个候选的"拍周期"局部峰(可能偏一倍/半拍,都先收下)
  const lagMin = Math.max(1, Math.round(fps * 60 / BPM_MAX));
  const lagMax = Math.min(frames >> 1, Math.round(fps * 60 / BPM_MIN));
  if (lagMax <= lagMin) return [];

  const corr = new Float32Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += onset[i] * onset[i + lag];
    corr[lag] = s;
  }

  // 取局部峰(比两边都高),最多 4 个、按值排序
  const lagPeaks = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const prev = lag > lagMin ? corr[lag - 1] : -Infinity;
    const next = lag < lagMax ? corr[lag + 1] : -Infinity;
    const v = corr[lag];
    if (v > 0 && v >= prev && v >= next) {
      // 抛物线插值细化 lag
      const y0 = lag > lagMin ? corr[lag - 1] : v;
      const y1 = v, y2 = lag < lagMax ? corr[lag + 1] : v;
      const denom = y0 - 2 * y1 + y2;
      if (denom < 0) lagPeaks.push({ lag: lag + 0.5 * (y0 - y2) / denom, val: v });
      else lagPeaks.push({ lag, val: v });
    }
  }
  lagPeaks.sort((a, b) => b.val - a.val);
  if (!lagPeaks.length) return [];

  // 每个 lag 峰生成八度族(base/4 … base*4),合并去重后统一 comb 打分
  const raw = [];
  for (const p of lagPeaks.slice(0, 4)) {
    const base = 60 * fps / p.lag;
    raw.push(base / 4, base / 2, base, base * 2, base * 4);
  }
  const out = [];
  const seen = new Set();
  for (const b of raw) {
    if (b < 20 || b > 300) continue;
    const bpm = Math.round(b);
    if (seen.has(bpm)) continue;
    seen.add(bpm);
    const sc = combScore(onset, frames, fps, bpm);
    out.push({ bpm, score: +sc.toFixed(3) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_CANDIDATES);
}