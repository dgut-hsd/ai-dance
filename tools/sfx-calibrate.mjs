/**
 * 用**真实歌曲文件**与**真实谱面间隔**标定打击音电平,并量化抗疲劳变体的区分度。
 *
 * 为什么不用合成音乐:实测项目里的歌峰值 0.80~0.85、RMS 0.11~0.18,
 * 而我之前用的合成替代品峰值 0.67 —— 差了 2dB,余量估多了。标定必须用真素材。
 *
 * 为什么不用 140ms 间隔压测:真实谱面最小间隔是 0.569s(songs/copydance1),
 * 140ms 是根本不存在的场景,按它标定会把音量压到听不见。
 *
 * 用法: node tools/sfx-calibrate.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.json': 'application/json' };

const HARNESS = `<!DOCTYPE html><html><body><script type="module">
import { Sfx } from '/web_dance/sfx.js';

const cache = {};
async function loadSong(ctx, url) {
  if (!cache[url]) {
    const res = await fetch(url);
    cache[url] = await res.arrayBuffer();
  }
  return ctx.decodeAudioData(cache[url].slice(0));
}
const scan = (buf) => {
  let peak = 0, sum = 0, n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; n++; }
  }
  return { peak: +peak.toFixed(4), rms: +Math.sqrt(sum / n).toFixed(4) };
};

/** 音乐 + 打击音,按真实谱面间隔触发。 */
window.__mixSong = async ({ url, startAt, noteTimes, tier, volume, sfxOn }) => {
  const rate = 48000;
  // 够长的离线上下文:覆盖最后一个音符 + 1s 尾巴
  const dur = Math.max(4, (noteTimes.at(-1) ?? 0) + 1.5);
  const ctx = new OfflineAudioContext(2, Math.ceil(rate * dur), rate);
  const buf = await loadSong(ctx, url);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, startAt, dur);
  if (sfxOn) {
    const sfx = new Sfx(ctx, { volume });
    noteTimes.forEach((t, i) => sfx.hit(tier, { when: t, heat: 1 + (i / Math.max(1, noteTimes.length - 1)) * 0.15, count: i }));
  }
  const out = await ctx.startRendering();
  return { ...scan(out), duration: +dur.toFixed(2) };
};

/** 只渲染音乐,给出这首歌在这一段里的真实峰值(RMS 也带上,便于判断"响度"而非"峰值")。 */
window.__musicOnly = async ({ url, startAt, noteTimes }) => {
  const rate = 48000;
  const dur = Math.max(4, (noteTimes.at(-1) ?? 0) + 1.5);
  const ctx = new OfflineAudioContext(2, Math.ceil(rate * dur), rate);
  const buf = await loadSong(ctx, url);
  const src = ctx.createBufferSource();
  src.buffer = buf; src.connect(ctx.destination); src.start(0, startAt, dur);
  return { ...scan(await ctx.startRendering()), duration: +dur.toFixed(2) };
};

/** 四个变体的音色差异:用短时谱重心做客观代理(耳朵对"亮度变化"最敏感)。 */
window.__variants = async (tier) => {
  const rate = 48000;
  const out = [];
  for (let k = 0; k < Sfx.VARIANTS.length; k++) {
    const ctx = new OfflineAudioContext(1, rate, rate);
    const sfx = new Sfx(ctx, { volume: 1 });
    sfx.hit(tier, { when: 0, count: k });
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, zc = 0, prev = 0, energy = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i], a = Math.abs(v);
      if (a > peak) peak = a;
      if ((v >= 0) !== (prev >= 0)) zc++;
      prev = v;
      energy += v * v;
    }
    out.push({
      variant: k,
      peak: +peak.toFixed(4),
      rms: +Math.sqrt(energy / d.length).toFixed(5),
      centroidHz: Math.round((zc / 2) / (d.length / rate)),
    });
  }
  return out;
};
window.__ready = 1;
<\/script></body></html>`;

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__cal__') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(HARNESS); }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const buf = await readFile(abs); res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' }); res.end(buf); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${app.address().port}/__cal__`);
await page.waitForFunction(() => window.__ready === 1);

// 真实谱面:从项目里的 chart 取音符时刻
const CASES = [
  { name: 'copydance1 (最密, 0.569s)', seq: 'songs/copydance1/copydance1.json', audio: 'songs/copydance1/copyDance1_30s.wav' },
  { name: 'hiphop (2.0s)', seq: 'songs/hiphop/hiphop.json', audio: 'songs/hiphop/pop-demo.wav' },
  { name: 'salsa (1.2s)', seq: 'songs/salsa/salsa.json', audio: 'songs/salsa/samba-demo.wav' },
];

console.log('=== 第一步:真实歌曲的电平 ===');
const cases = [];
for (const c of CASES) {
  let times;
  try {
    const raw = JSON.parse(await readFile(path.join(root, c.seq), 'utf8'));
    times = (raw.chart?.notes ?? raw.notes ?? []).map((n) => n.t).sort((a, b) => a - b);
  } catch { console.log(`  ${c.name}: 跳过(谱面读不到)`); continue; }
  if (!times.length) { console.log(`  ${c.name}: 跳过(无音符)`); continue; }
  const r = await page.evaluate((a) => window.__musicOnly(a), { url: '/' + c.audio, startAt: times[0], noteTimes: times });
  console.log(`  ${c.name.padEnd(26)} 音符 ${String(times.length).padStart(3)} 个 · 音乐 peak=${r.peak} rms=${r.rms}`);
  cases.push({ ...c, times, musicPeak: r.peak });
}

console.log('\n=== 第二步:音乐 + 打击音(真实间隔,逐个音量) ===');
const TARGET = 0.95;
let volume = 0.5;
for (let iter = 0; iter < 5; iter++) {
  let worst = 0, worstCase = '';
  for (const c of cases) {
    for (const tier of ['PERFECT', 'GREAT']) {
      const r = await page.evaluate((a) => window.__mixSong(a), { url: '/' + c.audio, startAt: c.times[0], noteTimes: c.times, tier, volume, sfxOn: true });
      if (r.peak > worst) { worst = r.peak; worstCase = `${c.name}/${tier}`; }
    }
  }
  console.log(`  volume=${volume.toFixed(3)} → 最坏合成峰值 ${worst} (${worstCase})`);
  if (worst <= TARGET) break;
  volume = Math.max(0.08, volume * (TARGET / worst));
}
console.log(`  → 建议体量级 ≈ ${volume.toFixed(2)}`);

console.log('\n=== 第三步:抗疲劳变体区分度 ===');
for (const tier of ['PERFECT', 'GREAT', 'GOOD', 'MISS']) {
  const vars = await page.evaluate((t) => window.__variants(t), tier);
  const cents = vars.map((v) => Math.round(1200 * Math.log2(v.centroidHz / vars[0].centroidHz)));
  const peakSpread = (Math.max(...vars.map((v) => v.peak)) - Math.min(...vars.map((v) => v.peak))) / vars[0].peak * 100;
  console.log(`  ${tier.padEnd(8)} 谱重心(Hz) ${vars.map((v) => String(v.centroidHz).padStart(5)).join(' ')}  相对差 ${cents.join('/')} 音分  峰值极差 ${peakSpread.toFixed(1)}%`);
}

console.log('\n页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
