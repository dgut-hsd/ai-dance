/**
 * 打击音响度闭环标定。
 *
 * 为什么需要"闭环":采样素材的响度无法一次算准。
 *   · 构建期只能按"裁切后 200ms 的 RMS"归一,而运行时量的是"起音后 120ms";
 *   · 更要命的是总线里的 tanh 软限幅是**非线性**的 —— 越响的样本被压得越多,
 *     所以"按 RMS 线性归一"不可能一次到位(实测同档内仍残留 9~25% 极差)。
 * 做法:渲染出**运行时真实输出**,量每档每变体的 RMS,反推需要的增益,写回清单,
 * 反复几次直到收敛。这比讲道理可靠:量的是最终听到的东西。
 *
 * 用法:
 *   node tools/sfx-tune-levels.mjs           迭代 3 轮并写回 index.json
 *   node tools/sfx-tune-levels.mjs --dry      只看当前状态,不写回
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(root, 'web_dance', 'audio', 'sfx', 'index.json');
const DRY = process.argv.includes('--dry');
const ROUNDS = Number((process.argv.find((a) => a.startsWith('--rounds=')) || '--rounds=3').split('=')[1]);

const MIME = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav' };

/** 在浏览器里量:每档每变体的运行时 RMS,以及合成层参考 RMS。 */
const HARNESS = [
  '<!DOCTYPE html><body><script type="module">',
  "import { Sfx } from '/web_dance/sfx.js';",
  "import { SampleHitSound, HitSound } from '/web_dance/hitsound.js';",
  'const RATE = 48000;',
  'const rmsOf = (d) => {',
  '  const i0 = Math.round(0.05*RATE), i1 = i0 + Math.round(0.12*RATE);',
  '  let s = 0, c = 0;',
  '  for (let i = i0; i < i1 && i < d.length; i++) { s += d[i]*d[i]; c++; }',
  '  return Math.sqrt(s/Math.max(1,c));',
  '};',
  '// 关键:每次测量都**重新构造**离线上下文,确保读到的是最新的 index.json',
  'window.__measure = async (cal) => {',
  '  const saved = HitSound.TIER_RMS_CAL;',
  '  if (cal) HitSound.TIER_RMS_CAL = cal;',
  '  const out = {};',
  '  for (const tier of ["PERFECT","GREAT","GOOD","MISS"]) {',
  '    const probe = new SampleHitSound(new OfflineAudioContext(1,1024,RATE), { baseUrl: "/web_dance/audio/sfx/" });',
  '    await probe.load();',
  '    const n = probe.buffers.get(tier).length;',
  '    const vals = [];',
  '    for (let k = 0; k < n; k++) {',
  '      const ctx = new OfflineAudioContext(1, RATE, RATE);',
  '      const synth = new Sfx(ctx, { volume: 0.45 });',
  '      const sm = new SampleHitSound(ctx, { baseUrl: "/web_dance/audio/sfx/", masterGain: HitSound.MASTER_GAIN });',
  '      new HitSound(synth, sm);',
  '      await sm.load();',
  '      sm._rr.set(tier, k);',
  '      sm.play(tier, 0.05, { heat: 1 });',
  '      vals.push(rmsOf((await ctx.startRendering()).getChannelData(0)));',
  '    }',
  '    out[tier] = vals;',
  '  }',
  '  const syn = {};',
  '  for (const tier of ["PERFECT","GREAT","GOOD","MISS"]) {',
  '    const ctx = new OfflineAudioContext(1, RATE, RATE);',
  '    const s = new Sfx(ctx, { volume: 0.45 });',
  '    s.hit(tier, { when: 0.05, heat: 1, count: 0 });',
  '    syn[tier] = rmsOf((await ctx.startRendering()).getChannelData(0));',
  '  }',
  '  HitSound.TIER_RMS_CAL = saved;',
  '  return { out, syn };',
  '};',
  'window.__ready = 1;',
  '<\/script></body>',
].join('\n');

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ns = { 'cache-control': 'no-store' };
  if (url.pathname === '/__tune__') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...ns }); return res.end(HARNESS); }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const b = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', ...ns });
    res.end(b);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/__tune__`);
await page.waitForFunction(() => window.__ready === 1);

const index = JSON.parse(await readFile(INDEX, 'utf8'));
let cal = { PERFECT: 1, GREAT: 1, GOOD: 1, MISS: 1 };

for (let round = 1; round <= ROUNDS; round++) {
  const r = await page.evaluate((c) => window.__measure(c), cal);
  console.log(`\n=== 第 ${round} 轮 ===`);
  console.log('档位      变体 RMS                                平均      合成参考  vs合成   同档极差');
  const nextCal = {};
  for (const [tier, vals] of Object.entries(r.out)) {
    const avg = vals.reduce((a, c) => a + c, 0) / vals.length;
    const spread = (Math.max(...vals) - Math.min(...vals)) / avg * 100;
    const target = r.syn[tier];
    nextCal[tier] = +(cal[tier] * (target / avg)).toFixed(4);
    console.log(`${tier.padEnd(9)} ${vals.map((v) => v.toFixed(4)).join(' ')} ${avg.toFixed(5).padEnd(9)} ${target.toFixed(5).padEnd(9)} ${(avg / target).toFixed(2)}×    ${spread.toFixed(1)}%`);
    // 同档内按各自 RMS 反推:让 5 个变体彼此一致
    const tierAvgTarget = avg; // 本轮先对齐档位,同档内由 variantGain 修
    index.tiers[tier].files.forEach((f, i) => {
      const want = tierAvgTarget / Math.max(vals[i], 1e-9);
      f.variantGain = +((f.variantGain ?? index.tiers[tier].gain) * want).toFixed(4);
    });
  }
  cal = nextCal;
  if (!DRY) await writeFile(INDEX, JSON.stringify(index, null, 2), 'utf8');
}

console.log('\n最终 TIER_RMS_CAL =', JSON.stringify(cal));
if (DRY) console.log('(--dry:index.json 未写回)');
else console.log('已写回 web_dance/audio/sfx/index.json');
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
