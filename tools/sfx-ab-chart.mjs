/**
 * 打击音 A/B 可视化对照 —— 2×2 面板(每行一个版本,左包络右频谱)。
 *
 * 两个实现注意(都踩过):
 *   1. 中文字面量不要写转义的 \\uXXXX —— 那不是转义,会原样打印成 \u6253 这种乱码。
 *      直接从源码里写中文即可(页面已声明 charset=utf-8)。
 *   2. 行高和画布高度必须对得上,否则两张图会画在同一块区域上。
 *
 * 用法: node tools/sfx-ab-chart.mjs
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'shots');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

// 普通字符串数组拼接(不用模板字符串:里层还有 JS,嵌套模板会让中文编码错乱)
const HARNESS = [
  '<!DOCTYPE html><body style="margin:0;background:#070a12">',
  '<canvas id="c" width="1640" height="960"></canvas>',
  '<script type="module">',
  "import { Sfx } from '/web_dance/sfx.js';",
  'function bellB(ctx, out, t, o) {',
  '  const ratios = [1, 2.01, 2.99, 4.21, 5.43, 6.79], amps = [1, 0.5, 0.34, 0.22, 0.14, 0.09];',
  '  for (let i = 0; i < ratios.length; i++) for (let d = -1; d <= 1; d += 2) {',
  '    const osc = ctx.createOscillator(); osc.type = "sine";',
  '    osc.frequency.value = o.base * ratios[i] * (1 + d * 0.0016);',
  '    const g = ctx.createGain(); const amp = amps[i] * o.gain * (i === 0 ? 1 : 0.5);',
  '    const dec = o.decay / (1 + i * 0.18);',
  '    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(amp, t + 0.004);',
  '    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.004 + dec);',
  '    osc.connect(g).connect(out); osc.start(t); osc.stop(t + 0.01 + dec + 0.05);',
  '  }',
  '  const body = ctx.createOscillator(); body.type = "sine";',
  '  body.frequency.setValueAtTime(150, t); body.frequency.exponentialRampToValueAtTime(78, t + 0.09);',
  '  const bg = ctx.createGain();',
  '  bg.gain.setValueAtTime(0.0001, t); bg.gain.linearRampToValueAtTime(o.gain * 0.42, t + 0.003);',
  '  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);',
  '  body.connect(bg).connect(out); body.start(t); body.stop(t + 0.16);',
  '  const nb = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.2), ctx.sampleRate);',
  '  const nd = nb.getChannelData(0);',
  '  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.02));',
  '  const n = ctx.createBufferSource(); n.buffer = nb;',
  '  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = o.base * 1.8; bp.Q.value = 0.9;',
  '  const ng = ctx.createGain(); ng.gain.value = o.gain * 0.5;',
  '  n.connect(bp).connect(ng).connect(out); n.start(t); n.stop(t + 0.1);',
  '}',
  'function makeIR(ctx, seconds, refl, decayMs) {',
  '  const n = Math.ceil(ctx.sampleRate * seconds), ir = ctx.createBuffer(2, n, ctx.sampleRate);',
  '  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c);',
  '    for (const r of refl) { const i0 = Math.round(r[0] / 1000 * ctx.sampleRate) + (c ? 7 : 0);',
  '      for (let k = 0; k < 40 && i0 + k < n; k++) d[i0 + k] += r[1] * (1 - k / 40) * (c ? 1 : 0.86); }',
  '    for (let i = 0; i < n; i++) d[i] += (Math.random() * 2 - 1) * 0.28 * Math.exp(-i / (ctx.sampleRate * decayMs / 1000)); }',
  '  return ir;',
  '}',
  'window.__renderBoth = async (tier) => {',
  '  const RATE = 48000, out = {};',
  '  {',
  '    const ctx = new OfflineAudioContext(2, RATE * 0.8, RATE);',
  '    const sfx = new Sfx(ctx, { volume: 0.5, destination: ctx.destination });',
  '    sfx.hit(tier, { when: 0.05, count: 0 });',
  '    out.A = (await ctx.startRendering()).getChannelData(0);',
  '  }',
  '  {',
  '    const ctx = new OfflineAudioContext(2, RATE * 0.8, RATE);',
  '    const dest = ctx.createGain(); dest.gain.value = 0.35; dest.connect(ctx.destination);',
  '    const dry = ctx.createGain();',
  '    const cfg = { PERFECT: { base: 1760, gain: 0.34, decay: 0.30 }, GREAT: { base: 2600, gain: 0.30, decay: 0.10 },',
  '                  GOOD: { base: 1174, gain: 0.28, decay: 0.14 }, MISS: { base: 220, gain: 0.30, decay: 0.20 } }[tier];',
  '    if (tier === "MISS") {',
  '      const osc = ctx.createOscillator(); osc.type = "sine";',
  '      osc.frequency.setValueAtTime(170, 0.05); osc.frequency.exponentialRampToValueAtTime(62, 0.25);',
  '      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, 0.05);',
  '      g.gain.linearRampToValueAtTime(cfg.gain, 0.054); g.gain.exponentialRampToValueAtTime(0.0001, 0.27);',
  '      osc.connect(g).connect(dry); osc.start(0.05); osc.stop(0.32);',
  '    } else bellB(ctx, dry, 0.05, cfg);',
  '    const conv = ctx.createConvolver(); conv.buffer = makeIR(ctx, 0.22, [[11, 0.5], [19, 0.34], [27, 0.22]], 45);',
  '    const wet = ctx.createGain(); wet.gain.value = 0.26;',
  '    dry.connect(dest); dry.connect(conv).connect(wet).connect(dest);',
  '    out.B = (await ctx.startRendering()).getChannelData(0);',
  '  }',
  '  return out;',
  '};',
  'window.__ready = 1;',
  '<\/script></body>',
].join('\n');

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__chart__') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(HARNESS); }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, { 'content-type': abs.endsWith('.js') ? MIME['.js'] : 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1640, height: 960 }, deviceScaleFactor: 1.5 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${app.address().port}/__chart__`);
await page.waitForFunction(() => window.__ready === 1);

await page.evaluate(async () => {
  const RATE = 48000;
  const both = await window.__renderBoth('PERFECT');
  const cv = document.getElementById('c'), g = cv.getContext('2d');
  g.fillStyle = '#070a12'; g.fillRect(0, 0, cv.width, cv.height);
  const text = (w, s, c, str, x, y) => { g.fillStyle = c; g.font = w + ' ' + s + 'px system-ui, sans-serif'; g.fillText(str, x, y); };

  const spanMs = 350, span = Math.round(spanMs / 1000 * RATE);
  // 音效是排在 50ms 处的(与生产代码一致),所以所有测量都要从起音点开始 ——
  // 从 sample 0 开始量会得到一片静音(踩过的坑:频谱栏全空白就是这原因)。
  const ONSET = Math.round(0.05 * RATE);
  const env = (d) => {
    const out = [], step = Math.max(1, Math.floor(span / 300));
    for (let i = 0; i < span; i += step) {
      let p = 0;
      for (let k = 0; k < step && ONSET + i + k < d.length; k++) p = Math.max(p, Math.abs(d[ONSET + i + k]));
      out.push(p);
    }
    return out;
  };
  const spec = (d) => {
    const N = 2048, bins = 200, out = new Array(bins).fill(0), win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = d[ONSET + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    for (let b = 0; b < bins; b++) {
      const f = (b + 1) * 40; let re = 0, im = 0;
      for (let i = 0; i < N; i++) { const a = 2 * Math.PI * f * i / RATE; re += win[i] * Math.cos(a); im -= win[i] * Math.sin(a); }
      out[b] = Math.sqrt(re * re + im * im) / N;
    }
    const max = Math.max(...out, 1e-9);
    return out.map((v) => v / max);
  };

  // 面板布局:标题区 100,每行 400 高
  const PAD = 24, X0 = 150, W = cv.width - X0 - PAD;
  const ROW_H = 400, PLOT_H = 250;
  text('700', 26, '#e6edff', 'PERFECT 打击音 A / B 对照', PAD, 44);
  text('500', 16, '#8496b6', '看包络:B 在 50ms 之后仍然有实体余韵(泛音延寿 + body 层),A 已经快归零 —— 这就是"干瘪"的来源', PAD, 70);

  ['A', 'B'].forEach((which, ri) => {
    const d = both[which];
    const top = 100 + ri * ROW_H;
    const color = which === 'A' ? '#ff7d8c' : '#57ffd0';
    text('700', 20, color, which === 'A' ? 'A · 当前实现(纯振荡器合成)' : 'B · 改造后(泛音延寿 + body 层 + room 混响)', PAD, top + 6);

    // 左:包络
    const lx = X0, ly = top + 24;
    text('600', 14, '#9fb0d0', '包络 (0-350ms)', lx, ly - 6);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let db = 0; db >= -60; db -= 15) {
      const yy = ly + PLOT_H * (1 - (db + 60) / 60);
      g.beginPath(); g.moveTo(lx, yy); g.lineTo(lx + W / 2 - 30, yy); g.stroke();
      text('500', 12, '#5d6b86', db + ' dB', PAD, yy + 4);
    }
    const x50 = lx + (W / 2 - 30) * (50 / spanMs);
    g.strokeStyle = 'rgba(255,213,74,0.55)'; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(x50, ly); g.lineTo(x50, ly + PLOT_H); g.stroke(); g.setLineDash([]);
    text('600', 12, '#ffd54a', '50ms', x50 + 4, ly + 13);
    const e = env(d);
    g.strokeStyle = color; g.lineWidth = 1.8; g.beginPath();
    e.forEach((v, i) => {
      const db = 20 * Math.log10(Math.max(v, 1e-5));
      const yy = ly + PLOT_H * (1 - Math.max(0, Math.min(1, (db + 60) / 60)));
      const xx = lx + (i / e.length) * (W / 2 - 30);
      i ? g.lineTo(xx, yy) : g.moveTo(xx, yy);
    });
    g.stroke();

    // 右:频谱
    const rx = X0 + W / 2 + 30, ry = ly;
    text('600', 14, '#9fb0d0', '频谱 (0-8kHz)', rx, ry - 6);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let f = 0; f <= 8000; f += 2000) {
      const xx = rx + (W / 2 - 30) * (f / 8000);
      g.beginPath(); g.moveTo(xx, ry); g.lineTo(xx, ry + PLOT_H); g.stroke();
      text('500', 12, '#5d6b86', (f / 1000) + 'k', xx + 3, ry + PLOT_H + 16);
    }
    const s = spec(d);
    g.fillStyle = which === 'A' ? 'rgba(255,125,140,0.8)' : 'rgba(87,255,208,0.8)';
    s.forEach((v, i) => {
      const h = v * PLOT_H * 0.95;
      g.fillRect(rx + (i / s.length) * (W / 2 - 30), ry + PLOT_H - h, Math.max(1.6, (W / 2 - 30) / s.length - 0.6), h);
    });
    // 200Hz 参考:低频"重量"就看这条线左边有没有东西
    const x200 = rx + (W / 2 - 30) * (200 / 8000);
    g.strokeStyle = 'rgba(255,213,74,0.4)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x200, ry); g.lineTo(x200, ry + PLOT_H); g.stroke(); g.setLineDash([]);
    text('600', 11, '#ffd54a', '200Hz', x200 + 3, ry + PLOT_H - 6);
  });
});

await mkdir(outDir, { recursive: true });
const png = await page.locator('#c').screenshot();
await writeFile(path.join(outDir, 'sfx-ab-chart.png'), png);
console.log('已保存 shots/sfx-ab-chart.png');
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));

