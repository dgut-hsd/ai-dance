/**
 * generate-demo-audio.mjs — 生成 web_dance/audio/demo-beat.wav。
 *
 * 24s @120BPM 的合成 groove:底鼓(每拍)+ 军鼓(2/4 拍)+ 踩镲(每 1/8 拍)
 * + 贝斯(每小节一个和弦, A2/F2/C3/G2 进行)。与 demo 序列的 4/4 节拍、下拍音符对齐。
 *
 * 用法:node tools/generate-demo-audio.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../web_dance/audio/demo-beat.wav");

const SR = 44100;
const DURATION = 24;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const N = Math.floor(SR * DURATION);

const L = new Float32Array(N);
const R = new Float32Array(N);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// 在 [startSec, startSec+durSec) 叠加一段信号;pan ∈ [-1,1](线性声像)
function add(startSec, durSec, fn, pan = 0) {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(durSec * SR);
  const gl = 1 - clamp01(pan); // pan>0 → 右移
  const gr = 1 - clamp01(-pan);
  for (let k = 0; k < len; k++) {
    const i = start + k;
    if (i < 0 || i >= N) continue;
    const s = fn(k / SR);
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

const noise = () => Math.random() * 2 - 1;

// 底鼓:120→45Hz 指数扫频正弦 + 快速衰减
const kick = (t) => {
  const f = 120 * Math.pow(45 / 120, clamp01(t / 0.12));
  return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 28);
};

// 军鼓:噪声 + 180Hz 底,快速衰减
const snare = (t) =>
  noise() * Math.exp(-t * 22) + Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 30) * 0.4;

// 踩镲:短噪声
const hat = (t) => noise() * Math.exp(-t * 90);

// 贝斯:正弦 + 慢衰减
const bass = (freq) => (t) =>
  Math.sin(2 * Math.PI * freq * t) * clamp01(t / 0.01) * Math.exp(-t * 2.5) * 0.9;

const BASS = [110.0, 87.31, 130.81, 98.0]; // A2 F2 C3 G2

for (let bar = 0; bar < 12; bar++) {
  const barT = bar * 4 * BEAT; // 每小节 2s
  // 贝斯:每小节下拍一个和弦音
  add(barT, BEAT * 2, bass(BASS[bar % 4]), 0);
  for (let b = 0; b < 4; b++) {
    const t = barT + b * BEAT;
    add(t, 0.4, (tt) => kick(tt) * (b === 0 ? 1.0 : 0.85));
    if (b === 1 || b === 3) add(t, 0.25, snare, -0.1); // 2/4 拍军鼓
  }
  // 踩镲:每 1/8 拍,轻重交替、左右微摆
  for (let e = 0; e < 8; e++) {
    const t = barT + (e * BEAT) / 2;
    add(t, 0.06, (tt) => hat(tt) * (e % 2 === 1 ? 0.5 : 0.3), e % 2 === 1 ? 0.3 : -0.25);
  }
}

// 归一化到 0.85,避免削波
let peak = 0;
for (let i = 0; i < N; i++) {
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = peak > 0 ? 0.85 / peak : 1;
for (let i = 0; i < N; i++) {
  L[i] *= gain;
  R[i] *= gain;
}

// 写 16-bit PCM 立体声 WAV
const dataSize = N * 4; // 2 声道 × 2 字节
const buf = Buffer.alloc(44 + dataSize);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);          // fmt 块大小
buf.writeUInt16LE(1, 20);           // PCM
buf.writeUInt16LE(2, 22);           // 声道数
buf.writeUInt32LE(SR, 24);          // 采样率
buf.writeUInt32LE(SR * 4, 28);      // 字节率
buf.writeUInt16LE(4, 32);           // 块对齐
buf.writeUInt16LE(16, 34);          // 位深
buf.write("data", 36);
buf.writeUInt32LE(dataSize, 40);

let off = 44;
const s16 = (v) => {
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(c * 32767);
};
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(s16(L[i]), off); off += 2;
  buf.writeInt16LE(s16(R[i]), off); off += 2;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${DURATION}s @${BPM}BPM)`);
