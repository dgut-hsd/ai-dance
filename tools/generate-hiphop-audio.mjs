/**
 * generate-hiphop-audio.mjs — 生成 Hip Hop 舞曲的伴奏(严格 120 BPM)。
 *
 * 产出:<root>/songs/hiphop/pop-demo.wav(24s = 12 小节,44.1kHz 16bit 立体声)
 * 文件名保持 pop-demo.wav:歌曲 id / 文件名已被 songs/index.json、谱面音频字段与测试引用,
 * 换内容不换名字,避免牵动一串引用。显示名已在 index.json 里改为「Hip Hop Beat」。
 *
 * 为什么是这个速度/长度:hiphop 舞曲序列 meta 是 timing/v1 @120BPM、offset 0、24s,
 * 谱面判定点落在每 1s(= 每 2 拍)。所以伴奏把重音全部压在每小节第 1、3 拍,
 * 判定点和鼓点严格重合,不会再「对不上拍子」。
 *
 * 风格:boom bap —— 底鼓 + 军鼓 backbeat + 带 swing 的 16 分踩镲 + 次低音贝斯
 *      + FM 电钢琴和弦(Am7–Fmaj7–Cmaj7–G7)+ 黑胶底噪 + 后段稀疏旋律。
 *
 * 用法:node tools/generate-hiphop-audio.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../songs/hiphop/pop-demo.wav");

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM;      // 0.5s
const BAR = 4 * BEAT;       // 2s
const BARS = 12;
const DURATION = BARS * BAR; // 24s
const N = Math.floor(SR * DURATION);
const SWING = 0.035;        // 16 分反拍的 swing 偏移(秒)

const L = new Float32Array(N);
const R = new Float32Array(N);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const noise = () => Math.random() * 2 - 1;
const decay = (t, k) => Math.exp(-t * k);

function add(startSec, durSec, fn, pan = 0, gain = 1) {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(durSec * SR);
  const gl = (1 - clamp01(pan)) * gain;
  const gr = (1 - clamp01(-pan)) * gain;
  for (let k = 0; k < len; k++) {
    const i = start + k;
    if (i < 0 || i >= N) continue;
    const s = fn(k / SR);
    L[i] += s * gl;
    R[i] += s * gr;
  }
}

// ---------------------------------------------------------------------------
// 打击乐
// ---------------------------------------------------------------------------
// 底鼓:下滑正弦 + 点击瞬态(有"实体感"的 boom)
const kick = (t) => {
  const f = 52 + 90 * Math.exp(-t * 42);           // 142Hz → 52Hz
  const body = Math.sin(2 * Math.PI * f * t) * decay(t, 9);
  const click = noise() * decay(t, 260) * 0.35;
  return (body + click) * (t < 0.004 ? t / 0.004 : 1) * 1.15;
};
// 军鼓:噪声 + 185Hz 鼓皮音,尾部留一点房间感
const snare = (t) => {
  const body = Math.sin(2 * Math.PI * 185 * t) * decay(t, 34) * 0.45;
  const crisp = noise() * decay(t, 26);
  const tail = noise() * decay(Math.max(0, t - 0.05), 16) * 0.18;
  return (crisp + body + tail) * 0.85;
};
// 拍手:三层错位噪声(叠加出"群拍"感)
const clap = (t) => {
  let s = noise() * decay(t, 42);
  if (t > 0.010) s += noise() * decay(t - 0.010, 42) * 0.75;
  if (t > 0.021) s += noise() * decay(t - 0.021, 42) * 0.55;
  return s * 0.6;
};
// 闭镲:高通噪声(用相邻样本差分近似高通)
let lastHat = 0;
const hat = (t) => {
  const n = noise();
  const hp = n - lastHat * 0.92; // 一阶高通,去掉低频"沙"
  lastHat = n;
  return hp * decay(t, 95) * 0.16;
};
// 开镲:更长、更亮的尾巴
let lastOpen = 0;
const openHat = (t) => {
  const n = noise();
  const hp = n - lastOpen * 0.9;
  lastOpen = n;
  return hp * decay(t, 16) * 0.13;
};

// ---------------------------------------------------------------------------
// 音色
// ---------------------------------------------------------------------------
// 次低音贝斯:正弦为主 + 一点三角谐波 + 轻微饱和,尾巴长一点才有 groove
const bass = (freq) => (t) => {
  const env = clamp01(t / 0.008) * decay(t, 4.2);
  const raw = Math.sin(2 * Math.PI * freq * t) * 0.8 + Math.sin(2 * Math.PI * 2 * freq * t) * 0.12;
  return Math.tanh(raw * 1.6) * env * 0.62;
};
// FM 电钢琴:carrier + modulator,起音柔、衰减自然
const epiano = (freq) => (t) => {
  const env = clamp01(t / 0.006) * decay(t, 2.6);
  const mod = Math.sin(2 * Math.PI * freq * 2 * t) * 2.2 * decay(t, 7);
  const carrier = Math.sin(2 * Math.PI * freq * t + mod);
  return carrier * env * 0.2;
};
// 旋律:三角波质感 + 延迟,后段才出现
const lead = (freq) => (t) => {
  const env = clamp01(t / 0.012) * decay(t, 3.4);
  const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t);
  const s = Math.sin(2 * Math.PI * freq * vib * t) * 0.75
    + Math.sin(2 * Math.PI * 3 * freq * t) * 0.1;
  return s * env * 0.17;
};

// Am7 – Fmaj7 – Cmaj7 – G7(自然小调色彩,hip hop 最常用的走向)
const CHORDS = [
  { bass: 55.0, tones: [220.0, 261.63, 329.63, 392.0] },   // Am7
  { bass: 43.65, tones: [174.61, 220.0, 261.63, 329.63] }, // Fmaj7
  { bass: 65.41, tones: [196.0, 261.63, 329.63, 392.0] },  // Cmaj7
  { bass: 49.0, tones: [196.0, 246.94, 293.66, 349.23] },  // G7
];
const PROG = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];

// 旋律动机(A 小调:主音-三度-五度-四度)
const MOTIF = [440.0, 523.25, 659.25, 587.33];

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR;
  const ch = CHORDS[PROG[bar]];
  const lastBar = bar === BARS - 1;

  // 底鼓:每小节第 1、3 拍重音(= 谱面判定点),第 2 拍反拍和 4 拍后半加 ghost kick
  add(t0, 0.9, kick, 0, 1.0);
  add(t0 + 2 * BEAT, 0.9, kick, 0, 1.0);
  add(t0 + 1.5 * BEAT, 0.5, kick, 0, 0.55);
  add(t0 + 3.5 * BEAT + 0.06, 0.5, kick, 0, 0.5);
  if (bar % 4 === 3) add(t0 + 3.25 * BEAT, 0.5, kick, 0, 0.45); // 过门前的小 fill

  // 军鼓 + 拍手:2、4 拍(标准 backbeat)
  for (const b of [1, 3]) {
    add(t0 + b * BEAT, 0.45, snare, -0.05, 0.95);
    add(t0 + b * BEAT, 0.25, clap, 0.08, 0.5);
  }
  if (lastBar) add(t0 + 3.5 * BEAT, 0.5, snare, 0, 0.7); // 收尾加花

  // 踩镲:16 分,反拍 swing;每两小节的最后一拍开镲
  for (let e = 0; e < 16; e++) {
    const swing = e % 2 === 1 ? SWING * (e % 4 === 1 ? 1 : 0.5) : 0;
    const vel = e % 4 === 0 ? 1.0 : e % 2 === 0 ? 0.62 : 0.8;
    const isOpen = e === 14 && bar % 2 === 1;
    add(t0 + (e * BEAT) / 4 + swing, isOpen ? 0.5 : 0.12, isOpen ? openHat : hat, e % 4 === 2 ? 0.22 : -0.18, vel);
  }

  // 贝斯:切分节奏(根音为主、第 4 拍走五度),和鼓一起律动
  const bPat = [0, 0.75, 1.5, 2.0, 2.75, 3.5];
  for (let k = 0; k < bPat.length; k++) {
    const e = bPat[k];
    const f = (k === bPat.length - 1 && bar % 2 === 0) ? ch.bass * 1.5 : ch.bass;
    add(t0 + e * BEAT, 0.6, bass(f), 0);
  }

  // 电钢琴和弦:每小节第 1 拍铺一次,第 3 拍后半补一个短 stab
  for (const f of ch.tones) add(t0, 1.1, epiano(f), 0.12);
  for (const f of ch.tones) add(t0 + 2.5 * BEAT, 0.5, epiano(f), -0.1, 0.6);

  // 后 4 小节加稀疏旋律(留给副歌感)
  if (bar >= 8) {
    for (let e = 0; e < 4; e++) {
      const f = MOTIF[(bar + e) % MOTIF.length];
      add(t0 + e * BEAT + (e === 2 ? 0.06 : 0), 0.7, lead(f), -0.25, 0.9);
      // 简易延迟:右声道回声
      add(t0 + e * BEAT + 0.25, 0.6, lead(f), 0.35, 0.32);
    }
  }
}

// 黑胶底噪:极轻的宽带噪 + 少量稀疏爆点,营造 hip hop 质感(别盖过鼓)
for (let i = 0; i < N; i++) {
  const bed = (noise() * 0.0012);
  L[i] += bed; R[i] += bed;
}
for (let k = 0; k < 220; k++) {
  const at = Math.random() * (DURATION - 0.05);
  const pan = Math.random() * 1.2 - 0.6;
  add(at, 0.03, (t) => noise() * decay(t, 220) * 0.045, pan);
}

// 归一化 + 软削波(整体更"暖"、更接近唱片电平)
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const pre = peak > 0 ? 1.15 / peak : 1;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * pre * 0.95);
  R[i] = Math.tanh(R[i] * pre * 0.95);
}
// 首尾 8ms 淡入淡出,避免爆音
const fade = Math.floor(SR * 0.008);
for (let i = 0; i < fade; i++) {
  const g = i / fade;
  L[i] *= g; R[i] *= g;
  L[N - 1 - i] *= g; R[N - 1 - i] *= g;
}

// 写 WAV(16bit PCM 立体声)
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
console.log(`wrote ${OUT} (${(buf.length / 1024 / 1024).toFixed(2)} MB, ${DURATION}s @${BPM}BPM hip hop)`);
