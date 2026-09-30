/**
 * click 层强度标定:找"不削波前提下的最大清晰度"。
 *
 * 背景:click 补的是素材缺失的 2~8kHz(见 hitsound.js 的 TIER_CLICK 说明),
 * 但它直接把峰值往上推 —— 第一版定在 4.0/6.0/2.5 时,四档 × 三首歌里有 6 个组合削波
 * (salsa/GREAT 冲到 1.42)。清晰度和余量是直接冲突的两个目标,必须**扫描找平衡点**,
 * 而不是拍一个数然后反复手调。
 *
 * 做法:按统一缩放系数扫 click 强度,每个系数测全部 12 个组合的合成峰值与削波数,
 * 取"削波为 0 的最大系数"。
 *
 * 用法: node tools/sfx-click-tune.mjs
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HS = path.join(root, 'web_dance', 'hitsound.js');
const TARGET = 0.99;
const MIME = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav' };

const SONGS = [
  ['hiphop', '/songs/hiphop/pop-demo.wav', 'songs/hiphop/hiphop.json'],
  ['salsa', '/songs/salsa/samba-demo.wav', 'songs/salsa/salsa.json'],
  ['copydance1', '/songs/copydance1/copyDance1_30s.wav', 'songs/copydance1/copydance1.json'],
];
const TIERS = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];

const HARNESS = [
  '<!DOCTYPE html><body><script type="module">',
  "import { Sfx } from '/web_dance/sfx.js';",
  "import { SampleHitSound, HitSound } from '/web_dance/hitsound.js';",
  'const RATE = 48000;',
  'const cache = {};',
  'async function load(ctx, url) { if (!cache[url]) cache[url] = await (await fetch(url)).arrayBuffer(); return ctx.decodeAudioData(cache[url].slice(0)); }',
  '// 一次调用测一个组合:返回合成峰值、削波数、以及 >2kHz 的清晰度',
  'window.__mix = async ({ url, times, tier }) => {',
  '  const dur = (times.at(-1) || 0) + 2;',
  '  const ctx = new OfflineAudioContext(2, Math.ceil(RATE*dur), RATE);',
  '  const buf = await load(ctx, url);',
  '  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination); src.start(0, times[0], dur);',
  '  const synth = new Sfx(ctx, { volume: 0.45 });',
  '  const sm = new SampleHitSound(ctx, { baseUrl: "/web_dance/audio/sfx/", masterGain: HitSound.MASTER_GAIN });',
  '  const hs = new HitSound(synth, sm);',
  '  await sm.load();',
  '  times.forEach((t) => hs.hit(tier, { when: t - times[0], heat: 1 }));',
  '  const d = (await ctx.startRendering()).getChannelData(0);',
  '  let peak = 0, clipped = 0;',
  '  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; if (a > 0.999) clipped++; }',
  '  return { peak: +peak.toFixed(4), clipped };',
  '};',
  'window.__ready = 1;',
  '<\/script></body>',
].join('\n');

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ns = { 'cache-control': 'no-store' };
  if (url.pathname === '/__ct__') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...ns }); return res.end(HARNESS); }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const b = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', ...ns });
    res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${app.address().port}/__ct__`);
await page.waitForFunction(() => window.__ready === 1);

const songs = [];
for (const [name, audio, seq] of SONGS) {
  const raw = JSON.parse(await readFile(path.join(root, seq), 'utf8'));
  songs.push({ name, audio, times: (raw.chart?.notes ?? raw.notes ?? []).map((n) => n.t).sort((a, b) => a - b) });
}

const src = await readFile(HS, 'utf8');
const m = src.match(/static TIER_CLICK = \{([^}]+)\}/);
if (!m) throw new Error('找不到 TIER_CLICK');
const BASE = Object.fromEntries(m[1].split(',').map((s) => {
  const [k, v] = s.split(':').map((x) => x.trim());
  return [k, Number(v)];
}));
console.log('当前基准 TIER_CLICK =', JSON.stringify(BASE), '\n');

const results = [];
for (const scale of [1.0, 0.6, 0.4, 0.25, 0.15, 0.08]) {
  // 把缩放后的值写进源码,浏览器就会加载新值
  const scaled = Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, +(v * scale).toFixed(3)]));
  const patched = src.replace(/static TIER_CLICK = \{[^}]+\}/,
    `static TIER_CLICK = { PERFECT: ${scaled.PERFECT}, GREAT: ${scaled.GREAT}, GOOD: ${scaled.GOOD}, MISS: ${scaled.MISS} }`);
  await writeFile(HS, patched, 'utf8');

  let worst = 0, worstAt = '', clip = 0;
  for (const s of songs) {
    for (const tier of TIERS) {
      const r = await page.evaluate((a) => window.__mix(a), { url: s.audio, times: s.times, tier });
      if (r.peak > worst) { worst = r.peak; worstAt = `${s.name}/${tier}`; }
      clip += r.clipped;
    }
  }
  const ok = clip === 0 && worst <= TARGET;
  results.push({ scale, scaled, worst, worstAt, clip, ok });
  console.log(`  scale=${String(scale).padEnd(5)} click=${JSON.stringify(scaled).padEnd(60)} 最坏峰值 ${String(worst).padEnd(7)}(${worstAt.padEnd(18)}) 削波 ${String(clip).padEnd(4)} ${ok ? '✓' : ''}`);
}

const best = results.find((r) => r.ok) ?? results[results.length - 1];
const patched = src.replace(/static TIER_CLICK = \{[^}]+\}/,
  `static TIER_CLICK = { PERFECT: ${best.scaled.PERFECT}, GREAT: ${best.scaled.GREAT}, GOOD: ${best.scaled.GOOD}, MISS: ${best.scaled.MISS} }`);
await writeFile(HS, patched, 'utf8');
console.log(`\n采用 scale=${best.scale} → TIER_CLICK = ${JSON.stringify(best.scaled)}`);
console.log(`(已写回 web_dance/hitsound.js;最坏合成峰值 ${best.worst},削波 ${best.clip})`);
console.log('注意:改完 click 强度后必须重跑 tools/sfx-tune-levels.mjs —— 峰值变了标定就失效。');
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
