/**
 * 连击热度曲线 一览图:同一套 CSS,四个热度档位并成一张对比图。
 *
 * 为什么每行用一个 iframe:徽章是 #combo-badge,而热度是一组写在 :root 上的 CSS 变量。
 * 同一个文档里不可能同时呈现四种热度(变量只有一份),所以每行一个隔离文档,
 * 各自把自己的热度摆好再截图。这是唯一能"一张图看全曲线"的干净做法。
 *
 * 用法: node tools/heat-sheet.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, 'shots');
const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// 档位与说明:必须与 main.js 的 HEAT_* / comboHeatTarget 保持同一套模型
const LEVELS = [
  { label: 'COMBO 3', note: '起始 · 金铜色,安静', combo: 3 },
  { label: 'COMBO 15', note: '预热 · 转橙,字号开始变大', combo: 15 },
  { label: 'COMBO 30', note: '发烫 · 珊瑚红,速度线浮现', combo: 30 },
  { label: 'COMBO 50', note: '满热 · 紫红,微颤 + 速度线最长', combo: 50 },
];

/** 单档位舞台(iframe 内容):把热度算到稳态再画。 */
function stageHtml(combo) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="/web_dance/style.css">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden;
    background:
      radial-gradient(ellipse 34% 130% at 50% 50%, rgba(255,80,140,0.055), transparent 72%),
      linear-gradient(180deg, #070a14, #0c1120 60%, #121a2c); }
  /* 生产里徽章是 fixed + translateX(-50%),这里改成相对定位以便摆进表格 */
  #combo-badge { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
  #combo-badge[data-heat-tier="hot"], #combo-badge[data-heat-tier="blaze"] { animation: none; }
</style></head><body>
<div id="combo-badge" class="hidden"><div id="combo-badge-n">0</div><div id="combo-badge-label">COMBO</div></div>
<script type="module">
  const HEAT_RAMP = 50, HEAT_EXP = 0.8, HEAT_UP_TAU = 0.35, HEAT_DOWN_TAU = 1.1;
  const HEAT_STOPS = [[255,213,74],[255,152,61],[255,87,96],[214,61,255]];
  const HEAT_STOPS2 = [[255,61,129],[255,61,129],[214,61,255],[255,61,255]];
  const root = document.documentElement;
  const badge = document.getElementById('combo-badge');
  const num = document.getElementById('combo-badge-n');
  const combo = ${combo};
  const lerpRgb = (a,b,t) => [0,1,2].map(i => Math.round(a[i] + (b[i]-a[i]) * t));
  function heatColors(h) {
    const x = Math.max(0, Math.min(1, h)) * (HEAT_STOPS.length - 1);
    const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x)), t = x - i;
    return { main: lerpRgb(HEAT_STOPS[i], HEAT_STOPS[i+1], t), hot: lerpRgb(HEAT_STOPS2[i], HEAT_STOPS2[i+1], t) };
  }
  const tierOf = (h) => h >= 0.88 ? 'blaze' : h >= 0.62 ? 'hot' : h >= 0.32 ? 'warm' : 'cool';
  const comboHeatTarget = (c) => c <= 1 ? 0 : Math.pow(Math.min(Math.max(c-1,0)/(HEAT_RAMP-1), 1), HEAT_EXP);
  // 用真实惯性爬到稳态(而不是直接赋值),这样"追上去"的过程被真实复现
  let heatNow = 0;
  const target = comboHeatTarget(combo);
  for (let s = 0; s < 300; s++) {
    const tau = target > heatNow ? HEAT_UP_TAU : HEAT_DOWN_TAU;
    heatNow += (target - heatNow) * (1 - Math.exp(-(1/60) / tau));
  }
  const { main, hot } = heatColors(heatNow);
  root.style.setProperty('--heat', heatNow.toFixed(3));
  root.style.setProperty('--hot-rgb', main.join(', '));
  root.style.setProperty('--hot2-rgb', hot.join(', '));
  root.style.setProperty('--badge-size', (44 + 14 * heatNow).toFixed(1) + 'px');
  root.style.setProperty('--badge-jitter', (heatNow > 0.62 ? (heatNow-0.62)/0.38*1.6 : 0).toFixed(2));
  badge.dataset.heatTier = tierOf(heatNow);
  num.textContent = String(combo);
  num.dataset.text = String(combo);
  badge.classList.remove('hidden');
  window.__posed = { heat: +heatNow.toFixed(3), tier: tierOf(heatNow) };
<\/script></body></html>`;
}

const shellHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>连击热度曲线</title>
<style>
  html, body { margin: 0; background: #05070f; color: #cfd8ee;
    font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
  body { padding: 20px 26px 26px; }
  h1 { font-size: 17px; margin: 0 0 4px; color: #e8efff; letter-spacing: 1px; }
  p.sub { margin: 0 0 18px; font-size: 12.5px; color: #7f8aa8; line-height: 1.55; }
  .row {
    display: grid; grid-template-columns: 230px 1fr; gap: 14px; align-items: center;
    border-radius: 12px; border: 1px solid rgba(255,255,255,0.07); overflow: hidden;
    background: #080c16; margin-bottom: 10px; min-height: 134px;
  }
  .meta { padding: 14px 10px 14px 20px; font-size: 12px; color: #8fa0c0; line-height: 1.65; }
  .meta b { display: block; font-size: 14px; color: #e8efff; letter-spacing: 1px; margin-bottom: 4px; }
  .meta .heat { font-variant-numeric: tabular-nums; color: #57ffd0; font-weight: 700; }
  .meta .tier { display: inline-block; margin-left: 6px; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 700; letter-spacing: 1px;
    background: rgba(255,255,255,0.09); color: #dfe8ff; }
  iframe { width: 100%; height: 134px; border: 0; display: block; }
</style></head>
<body>
  <h1>连击热度曲线 · 同一套 CSS 的四个温度</h1>
  <p class="sub">热度 = 连击的幂曲线(50 连才满热)+ "只追不跳"的惯性滤波;颜色 / 字号 / 抖动 / 速度线 / 打击音高全部由这一个标量驱动。<br>
     每行一个隔离文档(热度是写在 :root 上的全局变量,同一文档里无法同时呈现四种温度)。</p>
  ${LEVELS.map((l, i) => `
  <div class="row">
    <div class="meta">
      <b>${l.label}</b>${l.note}<br>
      热度 <span class="heat" id="h-${i}">–</span><span class="tier" id="t-${i}">–</span>
    </div>
    <iframe id="f-${i}" src="/__stage__?combo=${l.combo}" scrolling="no"></iframe>
  </div>`).join('')}
</body></html>`;

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__heat_sheet__') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(shellHtml);
  }
  if (url.pathname === '/__stage__') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(stageHtml(Number(url.searchParams.get('combo')) || 1));
  }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const buf = await readFile(abs); res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' }); res.end(buf); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}/__heat_sheet__`;

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(base);
await page.waitForFunction(() => document.querySelectorAll('iframe').length > 0);

mkdirSync(outDir, { recursive: true });
for (let i = 0; i < LEVELS.length; i++) {
  const frame = page.frames().find((f) => f.url().includes('__stage__') && f.url().includes(`combo=${LEVELS[i].combo}`));
  const posed = await frame.waitForFunction(() => window.__posed).then((h) => h.jsonValue());
  await page.evaluate(([idx, heat, tier]) => {
    document.getElementById('h-' + idx).textContent = heat.toFixed(2);
    document.getElementById('t-' + idx).textContent = tier.toUpperCase();
  }, [i, posed.heat, posed.tier]);
  console.log(`row ${i} ${LEVELS[i].label}: heat=${posed.heat} tier=${posed.tier}`);
}
// 冻结循环动画(数字抖动),让四行的相位一致
await page.evaluate(() => {
  for (const f of document.querySelectorAll('iframe')) {
    for (const a of f.contentDocument.getAnimations()) {
      if (a.effect?.getComputedTiming?.().iterations === Infinity) { a.pause(); a.currentTime = 0; }
    }
  }
});
const out = path.join(outDir, 'combo-heat-sheet.png');
await page.screenshot({ path: out, fullPage: true, animations: 'disabled' });
console.log(`\n已保存 ${path.relative(root, out)}`);
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
