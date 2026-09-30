/**
 * bpm.js — 浏览器端音频 BPM 粗测。
 *
 * 做法:解码 → 单声道能量包络(RMS, hop 512) → 起始函数(能量正向差分)
 * → 在 60–200 BPM 对应的滞后区间做自相关取峰 → 八度校正到 70–180。
 * 纯数据计算,不碰 DOM;decode 失败或信号太平返回 null,由调用方提示。
 */

const BPM_MIN = 60;
const BPM_MAX = 200;
const OCTAVE_LO = 70;   // 校正后希望落进的区间
const OCTAVE_HI = 180;
const ANALYZE_MAX_SEC = 90; // 只分析前 90s,够用且不卡
const HOP = 512;
const FRAME = 1024;

export async function detectBpm(arrayBuffer) {
  const AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AC) return null;
  let buf;
  try {
    const ctx = new AC(1, 1, 44100);
    buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    return null;
  }
  return detectBpmFromPcm(mixMono(buf), buf.sampleRate);
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

export function detectBpmFromPcm(pcm, sampleRate) {
  const frames = Math.floor((pcm.length - FRAME) / HOP);
  if (frames < sampleRate / HOP * 4) return null; // 少于约 4s 测不准

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
  if (mean <= 1e-9) return null; // 太平,没有明显拍点
  for (let i = 0; i < frames; i++) onset[i] -= mean;

  const fps = sampleRate / HOP; // 包络帧率
  const lagMin = Math.max(1, Math.round(fps * 60 / BPM_MAX));
  const lagMax = Math.min(frames >> 1, Math.round(fps * 60 / BPM_MIN));
  if (lagMax <= lagMin) return null;

  let bestLag = -1, bestVal = -Infinity;
  const corr = new Float32Array(lagMax + 1);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += onset[i] * onset[i + lag];
    corr[lag] = s;
    if (s > bestVal) { bestVal = s; bestLag = lag; }
  }
  if (bestLag < 0 || bestVal <= 0) return null;

  // 抛物线插值:整数 lag 的分辨率太粗(120BPM 附近一格就差 ~2BPM),用峰值左右邻居拟合出小数 lag
  let lag = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = corr[bestLag - 1], y1 = corr[bestLag], y2 = corr[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) lag = bestLag + 0.5 * (y0 - y2) / denom;
  }

  let bpm = 60 * fps / lag;
  // 八度校正:自相关经常打到半拍/双拍上,折回常见舞曲区间
  while (bpm < OCTAVE_LO) bpm *= 2;
  while (bpm > OCTAVE_HI) bpm /= 2;
  bpm = Math.round(bpm);
  return bpm >= 20 && bpm <= 300 ? bpm : null;
}
