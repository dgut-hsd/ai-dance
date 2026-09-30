/**
 * 打击音效「绝对电平」标定 —— 只测绝对峰值,不测差值。
 *
 * 为什么不用差值(mixed - solo):一旦合成超过软限幅拐点,音乐本身会被压下来,
 * 这时候差值里混进了"音乐被压低"的量,会把音效的贡献算得虚高(实测虚高 4 倍),
 * 标定必然跑偏。只认绝对峰值 + 削波计数才是可信的。
 *
 * 用法: node tools/sfx-level.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

const HARNESS = `<!DOCTYPE html><html><body><script type="module">
import { Sfx } from '/web_dance/sfx.js';

/** 模拟真实流行歌的频谱与电平:musicPeak 是这首歌的峰值。 */
function makeMusic(ctx, seconds, musicPeak) {
  const rate = ctx.sampleRate, n = Math.round(rate * seconds);
  const buf = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const beat = Math.exp(-((t % 0.5) * 12));
      d[i] = musicPeak * (
        0.50 * Math.sin(2 * Math.PI * 220 * t) +
        0.24 * Math.sin(2 * Math.PI * 660 * t) +
        0.10 * Math.sin(2 * Math.PI * 1760 * t) +
        0.44 * beat * Math.sin(2 * Math.PI * 60 * t));
    }
  }
  return buf;
}

const stats = (buf, ch) => {
  const d = buf.getChannelData(ch ?? 0);
  let peak = 0, clipped = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
    if (a > 0.999) clipped++;
  }
  return { peak: +peak.toFixed(4), clipped };
};
const maxOfChannels = (buf) => {
  let peak = 0, clipped = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = stats(buf, c);
    peak = Math.max(peak, s.peak);
    clipped += s.clipped;
  }
  return { peak: +peak.toFixed(4), clipped };
};

/** 只渲染音效总线:一次命中 / N 次密集命中。 */
window.__sfxOnly = async ({ tier, volume, count, spacingMs }) => {
  const rate = 48000;
  const ctx = new OfflineAudioContext(1, rate * 3, rate);
  const sfx = new Sfx(ctx, { volume });
  for (let i = 0; i < count; i++) {
    sfx.hit(tier, { when: 0.2 + i * (spacingMs / 1000), heat: 1 + (i / Math.max(1, count - 1)) * 0.15, seed: i * 3 });
  }
  return maxOfChannels(await ctx.startRendering());
};

/** 音乐 + 音效:同一上下文,和 main.js 的接法一致(各自直接进 destination)。 */
window.__mix = async ({ tier, volume, count, spacingMs, musicPeak, sfxOn }) => {
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, rate * 3, rate);
  const src = ctx.createBufferSource();
  src.buffer = makeMusic(ctx, 3, musicPeak);
  src.connect(ctx.destination);
  src.start(0);
  let sfx = null;
  if (sfxOn) {
    sfx = new Sfx(ctx, { volume });
    for (let i = 0; i < count; i++) {
      sfx.hit(tier, { when: 0.2 + i * (spacingMs / 1000), heat: 1 + (i / Math.max(1, count - 1)) * 0.15, seed: i * 3 });
    }
  }
  const buf = await ctx.startRendering();
  const all = maxOfChannels(buf);
  // 只统计"没有任何音效"的时间窗,用来确认音乐本身没被改动
  const quiet = (() => {
    const d = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < Math.round(0.15 * rate); i++) peak = Math.max(peak, Math.abs(d[i]));
    return +peak.toFixed(4);
  })();
  return { ...all, musicOnlyPeak: quiet, hits: count };
};
window.__ready = 1;
<\/script></body></html>`;

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__lv__') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(HARNESS); }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const b = await readFile(abs); res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${app.address().port}/__lv__`);
await page.waitForFunction(() => window.__ready === 1);

const MUSIC_PEAK = 0.67;   // 与真实素材量级一致(实测项目歌曲解码后峰值 ~0.6–0.75)
const TIERS = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];

// ---- 1) 单次命中:总线上的绝对峰值(音量 1.0,便于换算) ----
console.log('单次命中 · 总线绝对峰值(volume=1.0)');
const unit = {};
for (const tier of TIERS) {
  const r = await page.evaluate((c) => window.__sfxOnly(c), { tier, volume: 1, count: 1, spacingMs: 140 });
  unit[tier] = r.peak;
  console.log(`  ${tier.padEnd(8)} peak=${r.peak}`);
}

// ---- 2) 密集命中:看尾音叠加有多严重 ----
console.log('\n密集叠加(每 140ms 一次,volume=1.0)· 绝对峰值');
const train = {};
for (const tier of TIERS) {
  for (const count of [1, 3, 6, 10]) {
    const r = await page.evaluate((c) => window.__sfxOnly(c), { tier, volume: 1, count, spacingMs: 140 });
    train[`${tier}:${count}`] = r.peak;
    console.log(`  ${tier.padEnd(8)} ×${String(count).padEnd(3)} peak=${String(r.peak).padEnd(7)} 叠加倍数=${(r.peak / unit[tier]).toFixed(2)}×`);
  }
}

// ---- 3) 闭环定标:找"最坏叠加仍然不削波"的音量 ----
console.log(`\n闭环定标(音乐峰值 ${MUSIC_PEAK},目标合成峰值 ≤ 0.88)`);
const TARGET = 0.88;
let volume = 0.5;
for (let i = 0; i < 6; i++) {
  let worst = 0, worstAt = '', clipped = 0;
  for (const tier of TIERS) {
    const r = await page.evaluate((c) => window.__mix(c), { tier, volume, count: 10, spacingMs: 140, musicPeak: MUSIC_PEAK, sfxOn: true });
    if (r.peak > worst) { worst = r.peak; worstAt = tier; }
    clipped += r.clipped;
  }
  console.log(`  volume=${volume.toFixed(3)} → 最坏(${worstAt}) 合成峰值 ${worst},削波 ${clipped}`);
  if (clipped === 0 && worst <= TARGET + 0.005) break;
  volume = Math.max(0.05, volume * (TARGET / Math.max(worst, 1e-6)));
}

// ---- 4) 最终复核 ----
console.log(`\n用 volume=${volume.toFixed(2)} 复核(10 连密集命中)`);
const musicOnly = await page.evaluate((c) => window.__mix(c), { tier: 'PERFECT', volume, count: 10, spacingMs: 140, musicPeak: MUSIC_PEAK, sfxOn: false });
console.log(`  只有音乐             peak=${musicOnly.peak}  削波=${musicOnly.clipped}`);
for (const tier of TIERS) {
  const r = await page.evaluate((c) => window.__mix(c), { tier, volume, count: 10, spacingMs: 140, musicPeak: MUSIC_PEAK, sfxOn: true });
  const headroom = (1 - r.peak).toFixed(3);
  console.log(`  音乐 + ${tier.padEnd(8)} peak=${String(r.peak).padEnd(7)} 削波=${String(r.clipped).padEnd(4)} 余量=${headroom}`);
}
console.log(`\n最终建议 Sfx volume = ${volume.toFixed(2)}`);
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
