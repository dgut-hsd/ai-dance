/**
 * generate-pop-audio.mjs — 生成 web_dance/audio/pop-demo.wav。
 *
 * 流行风 @120BPM:four-on-the-floor 底鼓 + 2/4 拍手 + 8 分踩镲 + 8 分贝斯
 * + 反拍和声 stab + 合成器琶音。I-V-vi-IV(C-G-Am-F)经典流行进行。
 *
 * 用法:node tools/generate-pop-audio.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../web_dance/audio/pop-demo.wav");

const SR = 44100;
const DURATION = 24;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const N = Math.floor(SR * DURATION);
const BARS = 12; // 每小节 2s

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

// ---- 鼓 ----
const kick = (t) =>
  Math.sin(2 * Math.PI * (120 * Math.pow(50 / 120, clamp01(t / 0.1))) * t) * Math.exp(-t * 25);
const clap = (t) => {
  let s = noise() * Math.exp(-t * 30);
  if (t > 0.012) s += noise() * Math.exp(-(t - 0.012) * 30) * 0.7;
  if (t > 0.024) s += noise() * Math.exp(-(t - 0.024) * 30) * 0.5;
  return s * 0.8;
};
const hat = (t) => noise() * Math.exp(-t * 70) * 0.28;

// ---- 和声/旋律 ----
const bass = (freq) => (t) => {
  const env = clamp01(t / 0.004) * Math.exp(-t * 9);
  return (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * 2 * freq * t)) * env * 0.55;
};
const stab = (tones) => (t) => {
  const env = clamp01(t / 0.004) * Math.exp(-t * 13);
  let s = 0;
  for (const f of tones) s += Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * 1.5 * f * t);
  return s * env * 0.16;
};
const lead = (freq) => (t) => {
  const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t);
  const env = clamp01(t / 0.004) * Math.exp(-t * 9);
  return (Math.sin(2 * Math.PI * freq * vib * t) + 0.25 * Math.sin(2 * Math.PI * 2 * freq * t)) * env * 0.22;
};

// I - V - vi - IV(C - G - Am - F),3 轮 = 12 小节
const CHORDS = [
  { root: 130.81, tones: [261.63, 329.63, 392.0, 523.25] }, // C
  { root: 98.0, tones: [196.0, 246.94, 293.66, 392.0] }, // G
  { root: 110.0, tones: [220.0, 261.63, 329.63, 440.0] }, // Am
  { root: 87.31, tones: [174.61, 220.0, 261.63, 349.23] }, // F
];
const PROG = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * 4 * BEAT;
  const ch = CHORDS[PROG[bar]];
  const arp = ch.tones.map((f) => f * 2); // 高八度琶音

  // 底鼓:four-on-the-floor(每拍)
  for (let b = 0; b < 4; b++) add(t0 + b * BEAT, 0.3, kick, 0);

  // 拍手:2、4 拍
  add(t0 + BEAT, 0.2, clap, -0.1);
  add(t0 + 3 * BEAT, 0.2, clap, -0.1);

  // 踩镲:8 分音符(反拍略亮)
  for (let e = 0; e < 8; e++) {
    add(t0 + (e * BEAT) / 2, 0.05, (t) => hat(t) * (e % 2 === 1 ? 1.0 : 0.6), e % 2 === 1 ? 0.25 : -0.2);
  }

  // 贝斯:8 分音符,根音为主、偶有五度
  for (let e = 0; e < 8; e++) {
    const f = e % 4 === 2 ? ch.root * 1.5 : ch.root;
    add(t0 + (e * BEAT) / 2, 0.22, bass(f), 0);
  }

  // 和声 stab:反拍
  for (let e = 0; e < 8; e += 2) {
    add(t0 + ((e + 1) * BEAT) / 2, 0.25, stab(ch.tones), 0.1);
  }

  // 合成器琶音:8 分音符上行
  for (let e = 0; e < 8; e++) {
    add(t0 + (e * BEAT) / 2, 0.3, lead(arp[e % arp.length]), e % 2 === 1 ? 0.2 : -0.2);
  }
}

// 归一化
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const gain = peak > 0 ? 0.85 / peak : 1;
for (let i = 0; i < N; i++) { L[i] *= gain; R[i] *= gain; }

// 写 WAV
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
console.log(`wrote ${OUT} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${DURATION}s @${BPM}BPM pop)`);
