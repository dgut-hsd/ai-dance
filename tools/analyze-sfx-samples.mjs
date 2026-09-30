/**
 * 判断是否适合当打击音。
 *
 * 关键指标(都是有意义的物理量,不是"感觉"):
 *   · 起音时间 attackMs —— 从第一个超过峰值 50% 的采样点到峰值。**必须极小**:
 *     osu! 规范要求 hitsound 起始延迟 ≤5ms,起音一慢,玩家就无法用它判断早晚。
 *     这是筛选的第一道硬门槛,很多"好听的 impact" 就死在这里(它们是给电影用的,起音可以慢)。
 *   · 谱重心 centroidHz —— 亮度代理。重采样到固定长度后比较,不用 DFT(见下)。
 *   · 尾部能量 tailRatio —— 200ms 之后的能量占比,决定"余韵"。判定音要短,bell 类会偏高。
 *   · 低频比 lowRatio —— 200Hz 以下占比,决定"重量感"。
 *
 * 实现说明:这里不用 FFT,而是用**一阶低通分离低频** + **一阶高通(信号减低通)算高频能量**,
 * 比过零率稳健(过零率对直流偏移和噪声极敏感,前面踩过这个坑)。
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const srcRoot = path.join(root, 'tmp', 'sfx-src');
const convDir = path.join(root, 'tmp', 'sfx-conv');

/** 读 16bit 单声道 wav → Float32 数组,不依赖任何解码库。 */
async function readWav(file) {
  const b = await readFile(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 RIFF');
  let off = 12, dataOff = -1, dataLen = 0, rate = 0, channels = 1, bits = 16;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0 || bits !== 16) throw new Error('需要 16bit PCM');
  const n = Math.floor(dataLen / (2 * channels));
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = b.readInt16LE(dataOff + i * 2 * channels) / 32768;
  return { d, rate };
}

/** 把音频指标算成一组可比数字。 */
function measure(d, rate) {
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) { peak = a; peakIdx = i; } }
  if (peak < 1e-4) return null;
  // 起音:从最近一次"低于峰值 5%"到峰值点的距离
  let onset = peakIdx;
  for (let i = peakIdx; i >= 0; i--) { if (Math.abs(d[i]) < peak * 0.05) { onset = i; break; } }
  const attackMs = (peakIdx - onset) / rate * 1000;
  // 尾部能量占比(200ms 之后)
  const cut = Math.round(0.2 * rate);
  let eTail = 0, eAll = 0;
  for (let i = 0; i < d.length; i++) { const e = d[i] * d[i]; eAll += e; if (i >= cut) eTail += e; }
  const tailRatio = eTail / Math.max(eAll, 1e-12);
  // 一阶低通 200Hz → 低频能量比
  const k = 1 - Math.exp(-2 * Math.PI * 200 / rate);
  let lp = 0, eLow = 0, eHigh = 0;
  for (let i = 0; i < d.length; i++) { lp += (d[i] - lp) * k; eLow += lp * lp; const hp = d[i] - lp; eHigh += hp * hp; }
  const lowRatio = eLow / Math.max(eLow + eHigh, 1e-12);
  // 谱重心近似:一阶高通(信号-低通)配几档截止,看能量落在哪个频段
  const bandE = [];
  for (const fc of [500, 1500, 3000, 6000]) {
    const kk = 1 - Math.exp(-2 * Math.PI * fc / rate);
    let l = 0, e = 0;
    for (let i = 0; i < d.length; i++) { l += (d[i] - l) * kk; const h = d[i] - l; e += h * h; }
    bandE.push(e / Math.max(eAll, 1e-12));
  }
  // 有效时长:最后一个超过峰值 3% 的采样点
  let last = d.length - 1;
  for (let i = d.length - 1; i >= 0; i--) { if (Math.abs(d[i]) > peak * 0.03) { last = i; break; } }
  const durMs = last / rate * 1000;
  return {
    peak: +peak.toFixed(4), attackMs: +attackMs.toFixed(2), durMs: +durMs.toFixed(0),
    tailRatio: +tailRatio.toFixed(3), lowRatio: +lowRatio.toFixed(3),
    hiRatio: +(1 - bandE[0]).toFixed(3), vhiRatio: +(1 - bandE[2]).toFixed(3),
  };
}

async function collect(patterns) {
  const out = [];
  for (const pack of ['impact', 'interface']) {
    const dir = path.join(srcRoot, pack, 'Audio');
    if (!(await exists(dir))) continue;
    for (const name of await readdir(dir)) {
      if (!/\.(ogg|wav|mp3)$/i.test(name)) continue;
      if (!patterns.test(name)) continue;
      out.push({ pack, name, file: path.join(dir, name) });
    }
  }
  return out;
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const CANDIDATES = /^(impactBell_heavy|impactWood_(light|medium|heavy)|impactPlate_(light|medium|heavy)|impactSoft_(medium|heavy)|impactMetal_light|impactGeneric_light|impactTin_medium|bong|click|tick|glass|pluck|select)_?\d*\.(ogg|wav|mp3)$/i;

async function main() {
  await mkdir(convDir, { recursive: true });
  const list = await collect(CANDIDATES);
  console.log(`候选素材 ${list.length} 个,转码并测量…\n`);
  const rows = [];
  for (const item of list) {
    const outName = `${item.pack}__${item.name.replace(/\.(ogg|wav|mp3)$/i, '')}.wav`;
    const outPath = path.join(convDir, outName);
    if (!(await exists(outPath))) {
      try {
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', item.file,
          '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', outPath], { maxBuffer: 1024 * 1024 });
      } catch (e) { console.log(`  转码失败 ${item.name}: ${e.message.split('\n')[0]}`); continue; }
    }
    try {
      const { d, rate } = await readWav(outPath);
      const m = measure(d, rate);
      if (m) rows.push({ ...item, outName, ...m });
    } catch (e) { console.log(`  读取失败 ${outName}: ${e.message}`); }
  }
  rows.sort((a, b) => a.attackMs - b.attackMs);
  console.log('按起音时间排序(≤5ms 才有资格做打击音;括号内为文件名)');
  console.log('起音ms  时长ms  峰值   低频比  高音比  尾部比  素材');
  for (const r of rows) {
    const flag = r.attackMs > 5 ? ' ✗' : '';
    console.log(`${String(r.attackMs).padStart(5)}  ${String(r.durMs).padStart(5)}  ${String(r.peak).padEnd(6)} ${String(r.lowRatio).padEnd(6)} ${String(r.hiRatio).padEnd(6)} ${String(r.tailRatio).padEnd(6)} ${r.outName}${flag}`);
  }
  await writeFile(path.join(convDir, 'measure.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log(`\n共测 ${rows.length} 个,明细写入 tmp/sfx-conv/measure.json`);
  console.log(`其中起音 ≤5ms 的 ${rows.filter((r) => r.attackMs <= 5).length} 个`);
}

await main().catch((e) => { console.error('失败:', e); process.exit(1); });
