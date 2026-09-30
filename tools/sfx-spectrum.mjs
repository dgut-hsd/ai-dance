/**
 * 打击音的频谱重心与频段分布 —— 判断"档位亮度排序是否合理"。
 *
 * 为什么不用过零率:过零率对直流偏移、低频噪声、量化噪声都极敏感。
 * 之前用它量出"GOOD(3080Hz)比 PERFECT(2197Hz)还亮",那明显是假象 ——
 * 这里改用 Goertzel 在固定频段上取能量,再算真正的频谱重心 Σ(f·E)/Σ(E)。
 *
 * 用法: node tools/sfx-spectrum.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'web_dance', 'audio', 'sfx');

async function readWav(file) {
  const b = await readFile(file);
  let off = 12, dataOff = -1, dataLen = 0, rate = 48000;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(off + 12);
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  const n = Math.floor(dataLen / 2);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = b.readInt16LE(dataOff + i * 2) / 32768;
  return { d, rate };
}

/**
 * 真 FFT(radix-2,原地 Cooley-Tukey)。
 *
 * 为什么必须上 FFT,而不是"在几个频点上探测":
 *   打击音是**宽带**信号,能量连续分布在整个频谱上。用 9 个离散频点去探,
 *   落在探针之间的能量全被丢掉,结果自相矛盾(第一版量出 PERFECT 有 91% 能量在 63Hz、
 *   GREAT 比 GOOD 更钝 —— 那些都是测量假象,不是声音的性质)。
 *   正确做法:算完整频谱,再按频段把 |X(f)|² 求和。
 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** 频段划分(Hz 边界),覆盖到 16k 以便看清高频瞬态。 */
const BAND_EDGES = [0, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 24000];
const BAND_LABELS = ['<125', '125-250', '250-500', '500-1k', '1k-2k', '2k-4k', '4k-8k', '8k-16k', '16k+'];

/** 返回各频段能量占比 + 频谱重心 + 高频占比。 */
function analyzeSpectrum(d, rate, windowMs = 60) {
  const N = 4096; // radix-2,必须 2 的幂
  const n = Math.min(N, d.length);
  // 去直流 + Hann 窗:不去直流的话 0Hz 附近的泄漏会主导一切
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[i];
  mean /= n;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = (d[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  fft(re, im);
  const bins = N / 2;
  const bandE = new Array(BAND_EDGES.length - 1).fill(0);
  let total = 0, centroidNum = 0;
  for (let k = 1; k < bins; k++) {
    const f = k * rate / N;
    const e = re[k] * re[k] + im[k] * im[k];
    total += e;
    centroidNum += f * e;
    for (let b = 0; b < bandE.length; b++) {
      if (f >= BAND_EDGES[b] && f < BAND_EDGES[b + 1]) { bandE[b] += e; break; }
    }
  }
  const hi = bandE.slice(4).reduce((a, c) => a + c, 0); // >1kHz
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  return {
    centroid: total > 0 ? Math.round(centroidNum / total) : 0,
    bands: bandE.map((e) => e / Math.max(total, 1e-12)),
    hiRatio: total > 0 ? hi / total : 0,
    peak,
  };
}

const files = (await readdir(dir)).filter((f) => /^hit-.*\.wav$/.test(f)).sort();
const byTier = {};
for (const f of files) {
  const tier = f.split('-')[1].toUpperCase();
  const { d, rate } = await readWav(path.join(dir, f));
  (byTier[tier] ??= []).push({ file: f, ...analyzeSpectrum(d, rate) });
}

const ORDER = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
const avgOf = (t, key) => {
  const l = byTier[t] ?? [];
  return l.length ? l.reduce((s, x) => s + x[key], 0) / l.length : 0;
};

console.log('档位      平均谱重心   >1kHz占比   各变体谱重心');
for (const tier of ORDER) {
  const list = byTier[tier] ?? [];
  if (!list.length) continue;
  console.log(`${tier.padEnd(9)} ${String(Math.round(avgOf(tier, 'centroid'))).padStart(6)} Hz   ${(avgOf(tier, 'hiRatio') * 100).toFixed(1).padStart(5)}%   ${list.map((x) => x.centroid).join(' ')}`);
}

console.log('\n各档平均频段能量分布(占比 %):');
console.log('档位      ' + BAND_LABELS.map((s) => s.padStart(9)).join(''));
for (const tier of ORDER) {
  const list = byTier[tier] ?? [];
  if (!list.length) continue;
  const avg = BAND_LABELS.map((_, i) => list.reduce((s, x) => s + x.bands[i], 0) / list.length);
  console.log(tier.padEnd(10) + avg.map((v) => (v * 100).toFixed(1).padStart(9)).join(''));
}

// 判断亮度排序是否与设计意图一致:设计上 PERFECT/GREAT 应当亮于 GOOD
console.log('\n亮度排序检查:');
const [p, g, good] = [avgOf('PERFECT', 'centroid'), avgOf('GREAT', 'centroid'), avgOf('GOOD', 'centroid')];
console.log(`  PERFECT ${Math.round(p)}Hz  GREAT ${Math.round(g)}Hz  GOOD ${Math.round(good)}Hz`);
console.log(`  GREAT/GOOD = ${(g / Math.max(good, 1)).toFixed(2)}×  ${g > good ? '✓ GREAT 更亮' : '✗ GREAT 比 GOOD 更钝 —— 需要补高频'}`);
