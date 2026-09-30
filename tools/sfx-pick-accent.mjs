/**
 * 找出 milestone(每 10 连)与 stinger(开场/结算)可用的采样素材。
 *
 * 这两类音效目前仍是程序合成。采样库里其实有合适的候选:
 *   · 上行琶音 → 一串"铃/确认音"按音高排列(interface 的 confirmation/select/bong 系列)
 *   · 开场/结算 → 更亮的"玻璃/钟"类(interface 的 glass 系列)
 * 本工具按频谱与时长把候选列出来,便于挑选。
 *
 * 用法: node tools/sfx-pick-accent.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'tmp', 'sfx-conv');

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

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
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

/** 主频(峰值 bin)与谱重心 —— 挑琶音素材要按音高排序,所以需要主频。 */
function analyze(d, rate) {
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) { peak = a; peakIdx = i; } }
  const N = 4096;
  const from = Math.max(0, peakIdx - 200);
  const n = Math.min(N, d.length - from);
  const re = new Float64Array(N), im = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[from + i];
  mean /= n;
  for (let i = 0; i < n; i++) re[i] = (d[from + i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  fft(re, im);
  let best = 0, bestK = 0, tot = 0, num = 0;
  for (let k = 1; k < N / 2; k++) {
    const e = re[k] * re[k] + im[k] * im[k];
    tot += e; num += (k * rate / N) * e;
    if (e > best) { best = e; bestK = k; }
  }
  let last = 0;
  for (let i = d.length - 1; i >= 0; i--) if (Math.abs(d[i]) > peak * 0.03) { last = i; break; }
  return {
    f0: Math.round(bestK * rate / N),
    centroid: Math.round(num / Math.max(tot, 1e-12)),
    durMs: Math.round(last / rate * 1000),
    peak: +peak.toFixed(3),
  };
}

const files = (await readdir(dir)).filter((f) => /\.wav$/.test(f));
const rows = [];
for (const f of files) {
  if (/^impact(__|_)/.test(f) && !/impactMetal|impactGlass/.test(f)) continue; // 只挑"有音高"的候选用作琶音
  try {
    const { d, rate } = await readWav(path.join(dir, f));
    rows.push({ file: f, ...analyze(d, rate) });
  } catch { /* 跳过 */ }
}

// 按主频排序,便于挑出"音高阶梯"
rows.sort((a, b) => a.f0 - b.f0);
console.log('候选(按主频升序,适合做上行琶音的按 f0 挑几个)\n');
console.log('主频Hz   谱重心   时长ms  峰值   素材');
for (const r of rows) {
  if (r.durMs < 20 || r.durMs > 700) continue;
  console.log(`${String(r.f0).padStart(6)}   ${String(r.centroid).padStart(6)}   ${String(r.durMs).padStart(6)}  ${String(r.peak).padEnd(6)} ${r.file}`);
}
