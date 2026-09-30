/**
 * 连击热度曲线验证 + 徽章四档截图。
 * 用与 main.js 相同的热度模型离线推进(绕过 rAF),再按 combo 定格截图。
 * 用法: node tools/heat-check.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 8109);
const outDir = path.resolve(root, 'shots');

const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const base = `http://127.0.0.1:${port}`;

const HARNESS = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>热度曲线自检</title>
<link rel="stylesheet" href="/web_dance/style.css">
<style>
  html, body { margin: 0; height: 100%; background:
      radial-gradient(ellipse 60% 40% at 50% 82%, rgba(57,255,207,0.1), transparent 70%),
      linear-gradient(180deg, #05070f, #0b1020 55%, #131a2e); }
</style></head><body>
<div id="combo-badge" class="hidden"><div id="combo-badge-n">0</div><div id="combo-badge-label">COMBO</div></div>
<script type="module">
  // ---- 与 main.js 逐字一致的模型(改这里必须同步改 main.js) ----
  const HEAT_RAMP = 50, HEAT_EXP = 0.8, HEAT_UP_TAU = 0.35, HEAT_DOWN_TAU = 1.1;
  const HEAT_STOPS = [[255,213,74],[255,152,61],[255,87,96],[214,61,255]];
  const HEAT_STOPS2 = [[255,61,129],[255,61,129],[214,61,255],[255,61,255]];
  const badge = document.getElementById('combo-badge');
  const num = document.getElementById('combo-badge-n');
  const root = document.documentElement;
  let heatTarget = 0, heatNow = 0, heatTier = '';
  const lerpRgb = (a,b,t) => [0,1,2].map(i => Math.round(a[i] + (b[i]-a[i]) * t));
  function heatColors(h) {
    const x = Math.max(0, Math.min(1, h)) * (HEAT_STOPS.length - 1);
    const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x)), t = x - i;
    return { main: lerpRgb(HEAT_STOPS[i], HEAT_STOPS[i+1], t), hot: lerpRgb(HEAT_STOPS2[i], HEAT_STOPS2[i+1], t) };
  }
  const tierOf = (h) => h >= 0.88 ? 'blaze' : h >= 0.62 ? 'hot' : h >= 0.32 ? 'warm' : 'cool';
  const comboHeatTarget = (c) => c <= 1 ? 0 : Math.pow(Math.min(Math.max(c-1,0)/(HEAT_RAMP-1), 1), HEAT_EXP);
  function paint() {
    const { main, hot } = heatColors(heatNow);
    root.style.setProperty('--heat', heatNow.toFixed(3));
    root.style.setProperty('--hot-rgb', main.join(', '));
    root.style.setProperty('--hot2-rgb', hot.join(', '));
    root.style.setProperty('--badge-size', (44 + 14 * heatNow).toFixed(1) + 'px');
    root.style.setProperty('--badge-jitter', (heatNow > 0.62 ? (heatNow-0.62)/0.38*1.6 : 0).toFixed(2));
    const t = tierOf(heatNow);
    if (t !== heatTier) { heatTier = t; badge.dataset.heatTier = t; }
  }
  /** 按 60fps 步进,把热度推到目标(复现"追上去"的过程,而不是直接赋值) */
  function settle(combo, seconds = 3) {
    heatTarget = comboHeatTarget(combo);
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) step();
    paint();
  }
  /** 单帧推进(按 60fps),回落采样用它才能看到"追下来"的轨迹 */
  function step() {
    const tau = heatTarget > heatNow ? HEAT_UP_TAU : HEAT_DOWN_TAU;
    heatNow += (heatTarget - heatNow) * (1 - Math.exp(-(1 / 60) / tau));
    if (Math.abs(heatTarget - heatNow) < 0.0015) heatNow = heatTarget;
  }
  window.__probe = (combo, opts) => {
    if (opts && opts.steps) {
      heatTarget = comboHeatTarget(combo);
      const trail = [];
      for (let i = 0; i < opts.steps; i++) { step(); trail.push(+heatNow.toFixed(3)); }
      paint();
      return { trail };
    }
    if (combo === 0) { heatNow = 0; heatTier = ''; }
    settle(combo);
    num.textContent = String(combo);
    num.dataset.text = String(combo);
    badge.classList.toggle('hidden', combo < 2);
    const cs = getComputedStyle(num);
    const csRoot = getComputedStyle(root);
    return {
      combo,
      heat: +heatNow.toFixed(3),
      tier: heatTier,
      hotRgb: csRoot.getPropertyValue('--hot-rgb').trim(),
      badgeSize: csRoot.getPropertyValue('--badge-size').trim(),
      jitter: csRoot.getPropertyValue('--badge-jitter').trim(),
      fontSize: cs.fontSize,
      stroke: cs.webkitTextStrokeWidth,
      grad: cs.backgroundImage.slice(0, 78),
      glowContent: getComputedStyle(num, '::before').content,
      scale: cs.transform,
    };
  };
  window.__ready = true;
<\/script></body></html>`;

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__heat__') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(HARNESS); }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const buf = await readFile(abs); res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' }); res.end(buf); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(port, '127.0.0.1', r));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1000, height: 460 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/__heat__`);
await page.waitForFunction(() => window.__ready);

console.log('combo | heat  | tier  | --hot-rgb       | 字号   | 描边  | 抖动');
console.log('------+-------+-------+-----------------+--------+-------+-----');
for (const combo of [0, 2, 5, 10, 15, 20, 30, 40, 50, 70]) {
  const r = await page.evaluate((c) => window.__probe(c), combo);
  console.log(
    String(r.combo).padStart(5), '|',
    String(r.heat).padEnd(5), '|',
    r.tier.padEnd(5), '|',
    r.hotRgb.padEnd(15), '|',
    r.fontSize.padEnd(6), '|',
    r.stroke.padEnd(5), '|',
    r.jitter
  );
}

// 断连回落:先到满热,再按帧推进到 combo=0 的目标,看颜色是"追下来"还是瞬跳
await page.evaluate(() => window.__probe(50));
const fall = await page.evaluate(() => window.__probe(0, { steps: 40 }).trail);
console.log('\n断连回落(满热 → 0,每帧采样):');
console.log('  ' + fall.filter((_, i) => i % 4 === 0).join(' → ') + ' → ' + fall[fall.length - 1]);
const up = await page.evaluate(() => window.__probe(50, { steps: 40 }).trail);
console.log('爬升(第 1 击 → 满连,每帧采样):');
console.log('  ' + up.filter((_, i) => i % 4 === 0).join(' → ') + ' → ' + up[up.length - 1]);

mkdirSync(outDir, { recursive: true });
for (const [name, combo] of [['cool', 3], ['warm', 12], ['hot', 25], ['blaze', 55]]) {
  await page.evaluate((c) => window.__probe(c), combo);
  await page.waitForTimeout(60);
  // 徽章上是无限循环动画(--badge-jitter / comboBreathe),Playwright 会一直等"元素稳定"而超时。
  // 定格在 45%:这样每张图比较的是同一个动画相位,而不是"碰巧抓到的那一帧"。
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      const d = a.effect?.getComputedTiming?.();
      const delay = d?.delay ?? 0, active = d?.activeDuration ?? 0;
      if (!Number.isFinite(active) || delay + active <= 0) continue;
      a.pause();
      a.currentTime = delay + 0.45 * active;
    }
  });
  const el = page.locator('#combo-badge');
  await el.screenshot({ path: path.join(outDir, `combo-badge-${name}.png`), animations: 'disabled' });
  // 速度线 / 光晕都画在徽章盒子之外,元素截图看不全,再存一张整页图
  await page.screenshot({ path: path.join(outDir, `combo-badge-${name}-full.png`), animations: 'disabled' });
}
console.log('\n已保存 shots/combo-badge-{cool,warm,hot,blaze}[-full].png');
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));

