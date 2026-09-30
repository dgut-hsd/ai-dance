/**
 * 从 CC0 素材库里挑选并生成本项目用的打击音。
 *
 * 挑选依据来自 tools/analyze-sfx-samples.mjs 的实测(见下方 TIERS 注释里的数字),
 * 不是靠文件名好听。转换后统一:48kHz / 单声道 / 16bit PCM WAV。
 *
 * 三个必须做的处理:
 *   1) **裁掉头部静音**:素材自带 0~2ms 的静音,不裁掉就等于给打击音加了延迟。
 *      osu! 规范要求 hitsound 起始延迟 ≤5ms,这 2ms 是白送的损失。
 *   2) **两端 3ms 淡入淡出**:不淡出会在样本末端产生"咔"的爆音(波形被硬切断)。
 *   3) **不逐个归一化峰值**!档位之间的响度差是设计的一部分(PERFECT 最响),
 *      逐个拉到 1.0 会把四档的力度差抹平 —— 这正是之前合成版踩过的坑。
 *      统一用同一套增益系数,整体电平在运行时按音乐标定。
 *
 * 用法: node tools/build-sfx-samples.mjs
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const srcRoot = path.join(root, 'tmp', 'sfx-src');
const outDir = path.join(root, 'web_dance', 'audio', 'sfx');

/**
 * 四档的素材选择。每个注释里的数字都来自 analyze-sfx-samples.mjs 的实测输出。
 * 每档用多个同类变体 —— 这同时解决了**抗疲劳**(连续命中轮换)和"同一档位别老是一个音"。
 */
const TIERS = {
  // 金属/厚板:起音 0.4~1.31ms,时长 137~390ms,低频比 0.65~0.87,尾部能量 0.001~0.03 → 余韵最长、最重
  PERFECT: [
    'impact__impactPlate_heavy_001', 'impact__impactPlate_heavy_003', 'impact__impactPlate_heavy_000',
    'impact__impactPlate_heavy_004', 'impact__impactPlate_heavy_002',
  ],
  // 木板:起音 0.77~1.1ms(最快)、时长 55~57ms、低频比 0.35~0.49 → 干脆、有木头体感
  GREAT: [
    'impact__impactWood_light_004', 'impact__impactWood_light_001', 'impact__impactWood_light_003',
    'impact__impactWood_light_002', 'impact__impactWood_light_000',
  ],
  // 哑一点的软击:时长 51~60ms、亮度低于木板 → 存在感弱于 GREAT
  GOOD: [
    'impact__impactGeneric_light_001', 'impact__impactGeneric_light_004', 'impact__impactGeneric_light_003',
    'impact__impactGeneric_light_002', 'impact__impactGeneric_light_000',
  ],
  // 低频占比 0.84~0.88(最闷)、起音 4.25~4.79ms(最慢) → 闷响,不需要报时精度
  MISS: [
    'impact__impactSoft_medium_000', 'impact__impactSoft_medium_001', 'impact__impactSoft_medium_003',
    'impact__impactSoft_medium_004', 'impact__impactSoft_medium_002',
  ],
};

/** 每档的**目标相对电平**(以 PERFECT = 1.0 为基准)。
 *  这是设计权重:打得越好越响越亮 —— 打击音存在的唯一理由就是让玩家听出自己打得准不准。 */
const TIER_TARGET = { PERFECT: 1.00, GREAT: 0.60, GOOD: 0.39, MISS: 0.44 };

/**
 * 裁到多长(毫秒)。
 * 上限必须 ≥ 该档最长的素材,否则会硬切掉尾巴 —— 而尾巴正是 PERFECT"厚"的来源。
 * plate_heavy 最长 390ms,所以 PERFECT 给到 420。
 */
const MAX_MS = { PERFECT: 420, GREAT: 180, GOOD: 160, MISS: 260 };

async function findSource(base) {
  const pack = base.split('__')[0];
  const name = base.split('__')[1];
  for (const ext of ['ogg', 'wav', 'mp3']) {
    const p = path.join(srcRoot, pack, 'Audio', `${name}.${ext}`);
    try { await stat(p); return p; } catch { /* 继续试下个扩展名 */ }
  }
  throw new Error(`找不到素材 ${base}`);
}

/**
 * accent 素材 —— 给 milestone(每 10 连)与 stinger(开场/结算)用。
 *
 * 挑选依据(见 tools/sfx-pick-accent.mjs 的主频实测):按**主频阶梯**选,
 * 这样可以直接按顺序播出上行琶音,不需要变调(变调会让音色跟着变,不像"同一组钟")。
 *   586Hz select_002 → 1254Hz pluck_002 → 1980Hz glass_002 → 7336Hz glass_004
 * 另外 bong_001(234Hz)做失败的落音。
 */
const ACCENTS = [
  { name: 'accent-1.wav', src: 'interface__select_002', maxMs: 200 },  // 586Hz
  { name: 'accent-2.wav', src: 'interface__pluck_002', maxMs: 200 },   // 1254Hz
  { name: 'accent-3.wav', src: 'interface__glass_002', maxMs: 200 },   // 1980Hz
  { name: 'accent-4.wav', src: 'interface__glass_004', maxMs: 420 },   // 7336Hz(余韵最长)
  { name: 'accent-low.wav', src: 'interface__bong_001', maxMs: 160 },  // 234Hz,失败落音
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), rate: 48000, channels: 1, tiers: {} };
  let total = 0;

  for (const [tier, bases] of Object.entries(TIERS)) {
    manifest.tiers[tier] = { files: [] };
    const built = [];
    for (let i = 0; i < bases.length; i++) {
      const src = await findSource(bases[i]);
      // 先转成 48k 单声道 16bit 到一个临时文件,便于做裁剪与淡入淡出
      const tmp = path.join(outDir, `.tmp-${tier}-${i}.wav`);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
        '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', tmp], { maxBuffer: 1024 * 1024 });

      const buf = await readFile(tmp);
      const { data, rate } = parseWav(buf);
      const trim = trimAndFade(data, rate, MAX_MS[tier]);
      const outName = `hit-${tier.toLowerCase()}-${i + 1}.wav`;
      await writeFile(path.join(outDir, outName), writeWav(trim.d, rate));
      await rm(tmp, { force: true });
      total += trim.d.length * 2;
      built.push({
        file: outName, source: bases[i], peak: trim.peak,
        // 响度用 RMS 而不是峰值:
        //   这些素材尾长差异极大(137ms vs 390ms),峰值相同听感差很多。
        //   第一版按峰值矫正,实测同档内 RMS 仍有 20~29% 极差 —— 轮换时明显忽大忽小。
        rms: rmsOf(trim.d, rate, 150),
        leadTrimMs: trim.leadSamples / rate * 1000, lengthMs: trim.d.length / rate * 1000,
      });
    }
    // ---- 档位电平平衡 ----
    // 素材来自不同录音,原始响度是乱的。不平衡的话"打得好"反而比"打得一般"更轻,
    // 档位区分度直接反了 —— 这正是合成版踩过的坑。
    // 用每档的**平均 RMS** 算档位增益,再按各自 RMS 做同档内矫正。
    const avgRms = built.reduce((s, b) => s + b.rms, 0) / Math.max(1, built.length);
    const gain = TIER_TARGET[tier] / Math.max(avgRms, 1e-9);
    manifest.tiers[tier].gain = +gain.toFixed(4);
    manifest.tiers[tier].avgSourceRms = +avgRms.toFixed(5);
    manifest.tiers[tier].target = TIER_TARGET[tier];
    for (const b of built) {
      manifest.tiers[tier].files.push({
        file: b.file, source: b.source,
        leadTrimMs: +b.leadTrimMs.toFixed(3), lengthMs: +b.lengthMs.toFixed(0),
        sourcePeak: +b.peak.toFixed(4), sourceRms: +b.rms.toFixed(5),
        // 同档内按各自 RMS 矫正,让 5 个变体听感一致(否则轮换时会忽大忽小)
        variantGain: +(gain * (avgRms / Math.max(b.rms, 1e-9))).toFixed(4),
      });
    }
    console.log(`  ${tier.padEnd(8)} 素材平均RMS ${avgRms.toFixed(5)} → 档位增益 ${gain.toFixed(2)} (目标相对电平 ${TIER_TARGET[tier]})`);
  }

  // ---- accent:milestone 琶音 + stinger 用的素材 ----
  // 按 RMS 归一到**同一个**响度(取所有 accent 的平均值),这样琶音每一步一样响,
  // 不会出现"某一步特别重"的失衡。绝对电平由 hitsound.js 的 ACCENT_GAIN 统一给。
  const built = [];
  for (const a of ACCENTS) {
    const src = await findSource(a.src);
    const tmp = path.join(outDir, `.tmp-${a.name}`);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', tmp], { maxBuffer: 1024 * 1024 });
    const { data, rate } = parseWav(await readFile(tmp));
    const trim = trimAndFade(data, rate, a.maxMs);
    await writeFile(path.join(outDir, a.name), writeWav(trim.d, rate));
    await rm(tmp, { force: true });
    total += trim.d.length * 2;
    built.push({ ...a, rms: rmsOf(trim.d, rate, 150), lengthMs: Math.round(trim.d.length / rate * 1000) });
  }
  const avgAccentRms = built.reduce((s, b) => s + b.rms, 0) / Math.max(1, built.length);
  manifest.accents = { gain: +(1 / Math.max(avgAccentRms, 1e-9)).toFixed(4), avgSourceRms: +avgAccentRms.toFixed(5), files: [] };
  for (const b of built) {
    manifest.accents.files.push({
      file: b.name, source: b.src, lengthMs: b.lengthMs, sourceRms: +b.rms.toFixed(5),
      variantGain: +((1 / Math.max(avgAccentRms, 1e-9)) * (avgAccentRms / Math.max(b.rms, 1e-9))).toFixed(4),
    });
    console.log(`  ${b.name.padEnd(16)} ← ${b.src.padEnd(24)} 长度 ${String(b.lengthMs).padStart(3)}ms 源RMS ${b.rms.toFixed(5)}`);
  }

  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n共生成 ${Object.values(TIERS).reduce((s, a) => s + a.length, 0) + ACCENTS.length} 个 wav,${(total / 1024).toFixed(0)} KB → web_dance/audio/sfx/`);
  console.log('清单: web_dance/audio/sfx/index.json');
}

/** 极简 wav 解析:拿采样数据 + 原 header(转发时复用 fmt 块)。 */
function parseWav(b) {
  let off = 12, dataOff = -1, dataLen = 0, channels = 1, rate = 48000, bits = 16, fmtOff = -1, fmtLen = 0;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { fmtOff = off; fmtLen = sz; channels = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0 || bits !== 16) throw new Error('需要 16bit PCM');
  const n = Math.floor(dataLen / (2 * channels));
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = b.readInt16LE(dataOff + i * 2 * channels) / 32768;
  return { data: d, rate };
}

/**
 * 裁掉头部静音 + 限制总长 + 两端 3ms 淡入淡出。
 * 淡入必须保留:裁掉头部静音后起点是"第一个有声采样",直接播会有台阶爆音。
 */
function trimAndFade(d, rate, maxMs) {
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const thr = peak * 0.002;
  let start = 0;
  for (let i = 0; i < d.length; i++) { if (Math.abs(d[i]) > thr) { start = i; break; } }
  // 回退 0.5ms,保留起音的"前沿",不要切掉瞬态
  start = Math.max(0, start - Math.round(rate * 0.0005));
  const maxN = Math.round(maxMs / 1000 * rate);
  const end = Math.min(d.length, start + maxN);
  const n = Math.max(1, end - start);
  const out = new Float32Array(n);
  const fade = Math.round(rate * 0.003);
  for (let i = 0; i < n; i++) {
    let v = d[start + i];
    if (i < fade) v *= i / fade;                    // 3ms 淡入
    if (i > n - fade - 1) v *= (n - 1 - i) / fade;  // 3ms 淡出
    out[i] = v;
  }
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
  return { d: out, leadSamples: start, peak: pk };
}

/**
 * 起音后 windowMs 内的 RMS —— 响度的可比指标。
 * 不用整段:PERFECT 类素材有 300ms+ 的尾巴,整段 RMS 会被尾巴长度带偏,
 * 而打击音的"响度"主要是起音后那一小段决定的。
 */
function rmsOf(d, rate, windowMs) {
  const n = Math.min(d.length, Math.round(windowMs / 1000 * rate));
  let s = 0;
  for (let i = 0; i < n; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, n));
}

function writeWav(d, rate, header) {
  const dataBytes = d.length * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < d.length; i++) {
    const v = Math.max(-1, Math.min(1, d[i]));
    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return Buffer.from(ab);
}

await main().catch((e) => { console.error('失败:', e); process.exit(1); });
