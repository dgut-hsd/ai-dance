/**
 * 抗疲劳 A/B 波形对照图 —— 用图片证明"4 变体轮换"真的改变了每次命中的波形。
 *
 * 实现注意(踩过的坑):页面 HTML 用**普通单引号字符串**拼,不能用模板字符串 ——
 * 里层 JS 再嵌 template literal 会让中文字面量编码错乱,标签直接变乱码。
 *
 * 用法: node tools/sfx-waveform.mjs
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'shots');

// 注意:这里是单引号普通字符串,里面的 JS 用双引号 —— 不要改成模板字符串
const HARNESS = [
  '<!DOCTYPE html><body style="margin:0;background:#070a12">',
  '<canvas id="c" width="1800" height="640"></canvas>',
  '<script type="module">',
  "import { Sfx } from '/web_dance/sfx.js';",
  'window.__draw = async () => {',
  '  const RATE = 48000, N = 12, GAP = 0.42;',
  '  const dur = N * GAP + 0.8;',
  '  async function render(countFn) {',
  '    const ctx = new OfflineAudioContext(1, Math.ceil(RATE * dur), RATE);',
  '    const sfx = new Sfx(ctx, { volume: 0.5 });',
  '    for (let i = 0; i < N; i++) sfx.hit("PERFECT", { when: 0.15 + i * GAP, seed: i, ...countFn(i) });',
  '    return (await ctx.startRendering()).getChannelData(0);',
  '  }',
  '  const same = await render(() => ({ count: 0 }));',
  '  const varied = await render((i) => ({ count: i }));',
  '  const cv = document.getElementById("c"), g = cv.getContext("2d");',
  '  g.fillStyle = "#070a12"; g.fillRect(0, 0, cv.width, cv.height);',
  '  const draw = (data, y0, h, color, label, sub) => {',
  '    g.fillStyle = "#dbe6ff"; g.font = "700 25px system-ui, sans-serif";',
  '    g.fillText(label, 26, y0 - 34);',
  '    g.fillStyle = "#7f93b8"; g.font = "500 19px system-ui, sans-serif";',
  '    g.fillText(sub, 26, y0 - 8);',
  '    g.strokeStyle = "rgba(255,255,255,0.08)"; g.beginPath();',
  '    g.moveTo(0, y0 + h / 2); g.lineTo(cv.width, y0 + h / 2); g.stroke();',
  '    g.strokeStyle = color; g.lineWidth = 1.1; g.beginPath();',
  '    const step = Math.floor(data.length / cv.width);',
  '    for (let x = 0; x < cv.width; x++) {',
  '      let lo = 1, hi = -1;',
  '      for (let k = 0; k < step; k++) { const v = data[x * step + k] || 0; if (v < lo) lo = v; if (v > hi) hi = v; }',
  '      g.moveTo(x, y0 + h / 2 - hi * h * 0.45);',
  '      g.lineTo(x, y0 + h / 2 - lo * h * 0.45);',
  '    }',
  '    g.stroke();',
  '  };',
  '  draw(same, 80, 220, "#ff7d8c",',
  '    "\\u4fee\\u590d\\u524d\\uff1a12 \\u8fde\\u5168\\u7528\\u540c\\u4e00\\u4e2a\\u53d8\\u4f53",',
  '    "\\u6bcf\\u4e00\\u4e0b\\u7684\\u6ce2\\u5f62\\u5b8c\\u5168\\u91cd\\u5408 \\u2014\\u2014 \\u542c\\u611f\\u5c31\\u662f\\u201c\\u673a\\u5173\\u67aa\\u201d");',
  '  draw(varied, 390, 220, "#57ffd0",',
  '    "\\u4fee\\u590d\\u540e\\uff1a4 \\u4e2a\\u53d8\\u4f53\\u8f6e\\u6362",',
  '    "\\u57fa\\u9891 / \\u5206\\u97f3\\u5c55\\u5bbd / \\u6572\\u51fb\\u529b\\u5ea6\\u5404\\u6362\\u4e00\\u5904 \\u2014\\u2014 \\u540c\\u4e00\\u53ea\\u94c3\\u7684\\u4e0d\\u540c\\u6572\\u6cd5");',
  '  return true;',
  '};',
  'window.__ready = 1;',
  '<\/script></body>',
].join('\n');

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__wf__') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HARNESS);
  }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, { 'content-type': abs.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1800, height: 640 }, deviceScaleFactor: 1.5 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${app.address().port}/__wf__`);
await page.waitForFunction(() => window.__ready === 1);
await page.evaluate(() => window.__draw());
await mkdir(outDir, { recursive: true });
const png = await page.locator('#c').screenshot();
await writeFile(path.join(outDir, 'sfx-antifatigue-waveform.png'), png);
console.log('已保存 shots/sfx-antifatigue-waveform.png');
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
