/**
 * generate-samba-audio.mjs — 生成 web_dance/audio/samba-demo.wav。
 *
 * 桑巴风 @100BPM:surdo(1/3 强拍低音鼓)+ ganzá(16 分沙锤)+ agogô(双音牛铃)
 * + caixa(2/4 拍军鼓)+ 切分和弦 comping(Cmaj7-Am7-Dm7-G7 进行)。
 * 供「舞者表演」模式循环播放(与 120BPM 的挑战 demo 节拍分开)。
 *
 * 用法:node tools/generate-samba-audio.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../web_dance/audio/samba-demo.wav");

const SR = 44100;
const DURATION = 24;
const BPM = 100;
const BEAT = 60 / BPM; // 0.6s
const N = Math.floor(SR * DURATION);
const BARS = 10; // 每小节 4 拍 = 2.4s → 10 小节 = 24s

const L = new Float32Array(N);
const R = new Float32Array(N);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function add(startSec, durSec, fn, pan = 0) {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(durSec * SR);
  const gl = 1 - clamp01(pan);
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

// ---- 打击乐 ----
const surdo = (t, strong) =>
  Math.sin(2 * Math.PI * (strong ? 68 : 52) * t) * Math.exp(-t * 9) * (strong ? 1.0 : 0.85);
const caixa = (t) =>
  (noise() * Math.exp(-t * 28) + Math.sin(2 * Math.PI * 210 * t) * Math.exp(-t * 40) * 0.35) * 0.5;
const shaker = (t) => noise() * Math.exp(-t * 70) * 0.22;
const agogo = (t, high) => {
  const f = high ? 660 : 440;
  const s = Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f * t) + 0.25 * Math.sin(2 * Math.PI * 3 * f * t);
  return s * Math.exp(-t * 16) * 0.28;
};

// ---- 和声 ----
const pluck = (freq) => (t) =>
  (Math.sin(2 * Math.PI * freq * t) + 0.4 * Math.sin(2 * Math.PI * 2 * freq * t)) * Math.exp(-t * 12) * 0.38;
const bass = (freq) => (t) =>
  Math.sin(2 * Math.PI * freq * t) * clamp01(t / 0.01) * Math.exp(-t * 2.8) * 0.5;

// I - vi - ii - V(C - Am - Dm - G)经典拉丁进行,10 小节
const CHORDS = [
  { root: 130.81, tones: [261.63, 329.63, 392.0, 493.88] }, // Cmaj7
  { root: 110.0, tones: [220.0, 261.63, 329.63, 392.0] }, // Am7
  { root: 146.83, tones: [293.66, 349.23, 440.0, 523.25] }, // Dm7
  { root: 98.0, tones: [196.0, 246.94, 293.66, 349.23] }, // G7
];
const PROG = [0, 1, 2, 3, 0, 1, 2, 3, 0, 3];

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * 4 * BEAT;
  const ch = CHORDS[PROG[bar]];

  // 贝斯:1、3 拍
  add(t0, BEAT * 1.4, bass(ch.root), 0);
  add(t0 + 2 * BEAT, BEAT * 1.2, bass(ch.root), 0);

  // surdo:1 强、3 中、2/4 轻
  add(t0, 0.5, (t) => surdo(t, true), 0);
  add(t0 + BEAT, 0.4, (t) => surdo(t, false) * 0.7, 0);
  add(t0 + 2 * BEAT, 0.5, (t) => surdo(t, false), 0);
  add(t0 + 3 * BEAT, 0.4, (t) => surdo(t, false) * 0.7, 0);

  // caixa:2、4 拍
  add(t0 + BEAT, 0.2, caixa, 0.08);
  add(t0 + 3 * BEAT, 0.2, caixa, 0.08);

  // agogô:1/3 低铃、2&/4& 高铃
  add(t0, 0.3, (t) => agogo(t, false), -0.15);
  add(t0 + 2 * BEAT, 0.3, (t) => agogo(t, false), -0.15);
  add(t0 + 1.5 * BEAT, 0.3, (t) => agogo(t, true), 0.15);
  add(t0 + 3.5 * BEAT, 0.3, (t) => agogo(t, true), 0.15);

  // 和弦 comping:1、&2、4、&4 切分
  add(t0, 0.35, pluck(ch.tones[0]), -0.12);
  add(t0, 0.35, pluck(ch.tones[2]), 0.12);
  add(t0 + 1.5 * BEAT, 0.3, pluck(ch.tones[1]), -0.12);
  add(t0 + 1.5 * BEAT, 0.3, pluck(ch.tones[3]), 0.12);
  add(t0 + 3 * BEAT, 0.35, pluck(ch.tones[2]), -0.12);
  add(t0 + 3 * BEAT, 0.35, pluck(ch.tones[0]), 0.12);
  add(t0 + 3.5 * BEAT, 0.3, pluck(ch.tones[3]), 0.12);

  // ganzá:16 分音符
  for (let s = 0; s < 16; s++) {
    const acc = s % 4 === 0 ? 1.0 : s % 2 === 1 ? 0.7 : 0.45;
    add(t0 + (s * BEAT) / 4, 0.05, (t) => shaker(t) * acc, 0);
  }
}

// 归一化到 0.85
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const gain = peak > 0 ? 0.85 / peak : 1;
for (let i = 0; i < N; i++) { L[i] *= gain; R[i] *= gain; }

// 写 16-bit PCM 立体声 WAV
const dataSize = N * 4;
const buf = Buffer.alloc(44 + dataSize);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataSize, 40);

let off = 44;
const s16 = (v) => Math.round((v < -1 ? -1 : v > 1 ? 1 : v) * 32767);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(s16(L[i]), off); off += 2;
  buf.writeInt16LE(s16(R[i]), off); off += 2;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${DURATION}s @${BPM}BPM samba)`);
