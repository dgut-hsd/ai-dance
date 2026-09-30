/**
 * 全量素材频谱普查 —— 用真 FFT 找出"真的有高频"的素材。
 *
 * 为什么重做:第一版用的是 `tools/analyze-sfx-samples.mjs` 里的 "hiRatio",
 * 那个指标其实是"一阶低通 500Hz 之后的残差能量",并不是真的高频能量,
 * 结果我把一个**低频闷响**(impactPlate_heavy,实测 90.9% 能量在 125Hz 以下、
 * 1k~4kHz 只有 0.7%)当成了"金属板"来当 PERFECT 音。
 * 打击音要在密集混音里清晰可辨,2~8kHz 的占比是关键 —— 必须用真频谱重挑。
 *
 * 用法: node tools/sfx-survey.mjs [--dir=tmp/sfx-conv] [--min-hi=0.15]
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1];
const dir = path.resolve(root, arg('dir', 'tmp/sfx-conv'));

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

const EDGES = [0, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 24000];

/** 取"起音处"的频谱(不是全段):打击音的性质由起音瞬间决定。 */
function analyze(d, rate) {
  const N = 2048;
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) { peak = a; peakIdx = i; } }
  if (peak < 1e-3) return null;
  let onset = 0;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak * 0.05) { onset = i; break; }
  const from = onset;
  const n = Math.min(N, d.length - from);
  const re = new Float64Array(N), im = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += d[from + i];
  mean /= n;
  for (let i = 0; i < n; i++) re[i] = (d[from + i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  fft(re, im);
  const bands = new Array(EDGES.length - 1).fill(0);
  let tot = 0, num = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = k * rate / N, e = re[k] * re[k] + im[k] * im[k];
    tot += e; num += f * e;
    for (let b = 0; b < bands.length; b++) if (f >= EDGES[b] && f < EDGES[b + 1]) { bands[b] += e; break; }
  }
  const hi = bands.slice(4).reduce((a, c) => a + c, 0);      // >1kHz
  const click = bands.slice(5, 7).reduce((a, c) => a + c, 0); // 2k~8k = 清晰度/报时
  const body = bands.slice(0, 2).reduce((a, c) => a + c, 0);  // <250Hz = 重量
  // 时长
  let last = 0;
  for (let i = d.length - 1; i >= 0; i--) if (Math.abs(d[i]) > peak * 0.03) { last = i; break; }
  return {
    durMs: Math.round((last - onset) / rate * 1000),
    attackMs: +((peakIdx - onset) / rate * 1000).toFixed(2),
    centroid: Math.round(num / Math.max(tot, 1e-12)),
    hi: +(hi / tot).toFixed(3),
    click: +(click / tot).toFixed(3),
    body: +(body / tot).toFixed(3),
    peak: +peak.toFixed(3),
  };
}

const files = (await readdir(dir)).filter((f) => /\.wav$/.test(f));
const rows = [];
for (const f of files) {
  try {
    const { d, rate } = await readWav(path.join(dir, f));
    const m = analyze(d, rate);
    if (m) rows.push({ file: f, ...m });
  } catch { /* 跳过读不了的 */ }
}

rows.sort((a, b) => b.click - a.click);
const minHi = Number(arg('min-hi', 0));
console.log(`共测 ${rows.length} 个素材,按「2k~8kHz 清晰度占比」降序(>1kHz 占比 ≥ ${minHi} 才显示)\n`);
console.log('2k-8k    >1k     <250Hz  谱重心  起音ms  时长ms  峰值   素材');
for (const r of rows) {
  if (r.hi < minHi) continue;
  console.log(
    `${(r.click * 100).toFixed(1).padStart(5)}%  ${(r.hi * 100).toFixed(1).padStart(5)}%  ${(r.body * 100).toFixed(1).padStart(5)}%  ${String(r.centroid).padStart(6)}  ${String(r.attackMs).padStart(6)}  ${String(r.durMs).padStart(6)}  ${String(r.peak).padEnd(6)} ${r.file}`,
  );
}
console.log(`\n其中 2k~8kHz 占比 >10% 的:${rows.filter((r) => r.click > 0.1).length} 个`);
console.log(`其中 2k~8kHz 占比 >20% 的:${rows.filter((r) => r.click > 0.2).length} 个`);
