/**
 * 判定字效方案对比台 —— 同一个 DOM,4 套 CSS 皮肤并排定格。
 *
 * 用法: node tools/judge-styles.mjs --shot
 *   输出 shots/style-<variant>-<tier>.png
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const port = Number(flag('port', 8101));
const at = Number(flag('at', 0.34));
const outDir = path.resolve(root, flag('out', 'shots'));

const TIERS = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
const VARIANTS = [
  { id: 'v0', name: '现状(平涂+白描边+大光晕)' },
  { id: 'v1', name: '精致化(深描边+纵向渐变+倒角+投影)' },
  { id: 'v2', name: '顶级感(渐变+倒角+色散+逐字弹出)' },
  { id: 'v3', name: '克制版(细描边+金属渐变,少光晕)' },
];

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>判定字效方案对比</title>
<link rel="stylesheet" href="/web_dance/style.css" />
<style>
  :root { --font-display: "Impact", "Haettenschweiler", "Arial Black", "Microsoft YaHei", sans-serif; }
  html, body { margin: 0; min-height: 100%; background: #07090f; color: #cfd8ee;
    font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
  body { display: grid; gap: 18px; padding: 22px; }
  header h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: 1px; }
  header p { margin: 0; font-size: 13px; color: #7f8aa8; }
  .row {
    position: relative; display: grid; grid-template-columns: 200px 1fr 1fr 1fr 1fr;
    gap: 14px; align-items: center; padding: 16px 18px; border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.08);
    background:
      radial-gradient(ellipse 50% 60% at 50% 70%, rgba(57,255,207,0.07), transparent 70%),
      linear-gradient(180deg, #05070f, #0e1424 60%, #141c30);
    overflow: hidden;
  }
  .row-label { font-size: 12px; line-height: 1.5; color: #9fb0d0; }
  .row-label b { display: block; font-size: 13px; color: #e6edff; margin-bottom: 4px; }
  .row-label code { color: #57ffd0; font-size: 11px; }
  /* 每个格子是一个"判定槽":只放字,不放其它 UI */
  .cell { position: relative; height: 190px; display: grid; place-items: center; }
  .cell::before {
    content: ""; position: absolute; inset: 8px 0; border-radius: 10px;
    border: 1px dashed rgba(255,255,255,0.06);
  }

  /* ---------- 判定字核心 ---------- */
  .jt {
    --jtier: #ffd54a;
    --jtier-deep: #a35b00;
    position: relative;
    font-family: var(--font-display);
    font-weight: 900;
    font-style: italic;
    line-height: 1;
    letter-spacing: 2px;
    text-transform: uppercase;
    white-space: nowrap;
    transform: rotate(-2deg);
    isolation: isolate;
  }
  .jt .ch { display: inline-block; }

  /* ============ V0:现状复刻(对照组) ============ */
  .jt.v0 {
    font-size: 60px; color: var(--jtier);
    -webkit-text-stroke: 1px rgba(255,255,255,0.28);
    text-shadow: 0 0 6px #fff, 0 0 22px var(--jtier), 0 0 54px var(--jtier), 0 4px 0 rgba(0,0,0,0.45);
  }

  /* ============ V1:深描边 + 纵向渐变 + 倒角 + 投影 ============ */
  .jt.v1 { font-size: 60px; color: transparent; }
  .jt.v1 .ch {
    background: linear-gradient(180deg, #ffffff 0%, var(--jtier) 42%, var(--jtier-deep) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    /* 描边宽度必须远小于字号:7px 会整条盖住渐变,字形变成一坨实色(踩过的坑) */
    -webkit-text-stroke: 2.5px var(--jtier-deep);
    paint-order: stroke fill;
    filter:
      drop-shadow(0 2px 0 rgba(0,0,0,0.8))
      drop-shadow(0 5px 7px rgba(0,0,0,0.65))
      drop-shadow(0 0 13px color-mix(in srgb, var(--jtier) 50%, transparent));
  }

  /* ============ V2:V1 + 色散 + 逐字弹出 + 外发光层 ============ */
  .jt.v2 { font-size: 60px; }
  .jt.v2 .ch {
    background: linear-gradient(180deg, #ffffff 0%, var(--jtier) 44%, var(--jtier-deep) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    -webkit-text-stroke: 3px var(--jtier-deep);
    paint-order: stroke fill;
    filter:
      drop-shadow(0 2px 0 rgba(0,0,0,0.8))
      drop-shadow(0 5px 8px rgba(0,0,0,0.68))
      drop-shadow(0 0 16px color-mix(in srgb, var(--jtier) 60%, transparent));
  }
  .jt.v2::after {
    content: attr(data-text); position: absolute; inset: 0; z-index: -1;
    display: flex; align-items: center; justify-content: center;
    font: inherit; font-size: inherit; letter-spacing: inherit;
    color: transparent; -webkit-text-stroke: 10px var(--jtier); opacity: 0.42;
    filter: blur(9px);
  }
  .jt.v2 .ch:nth-child(odd) { text-shadow: 2px 0 0 rgba(255,0,90,0.5), -2px 0 0 rgba(0,200,255,0.5); }

  /* ============ V3:克制 ============ */
  .jt.v3 { font-size: 60px; transform: skewX(-8deg); letter-spacing: 1px; }
  .jt.v3 .ch {
    background: linear-gradient(180deg, #ffffff 0%, #ffe9a8 26%, var(--jtier) 62%, var(--jtier-deep) 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    -webkit-text-stroke: 1.8px rgba(6,8,16,0.92);
    paint-order: stroke fill;
    filter: drop-shadow(0 3px 1px rgba(0,0,0,0.75)) drop-shadow(0 0 8px color-mix(in srgb, var(--jtier) 38%, transparent));
  }
</style>
</head>
<body>
<header>
  <h1>判定字效方案对比 · 定格 ${Math.round(at * 100)}%</h1>
  <p>同一套 DOM,四套 CSS。左侧为方案说明;每一格都用真实的 tier 配色。</p>
</header>
${VARIANTS.map((v) => `
  <section class="row" data-variant="${v.id}">
    <div class="row-label"><b>${v.name}</b><code>${v.id}</code></div>
    ${TIERS.map((t) => `
      <div class="cell">
        <div class="jt ${v.id}" data-tier="${t}" data-text="${t}"
             style="--jtier:COLOR_${t}; --jtier-deep:DEEP_${t}; font-size:SIZE_${t}px">
          ${[...t].map((c) => `<span class="ch">${c}</span>`).join('')}
        </div>
      </div>`).join('')}
  </section>`).join('')}
<script>
  window.__ready = true;
</script>
</body>
</html>`;

/** tier → 主色/暗部/字号,与 style.css 的判分配色保持一致。 */
function withTierVars(body) {
  const COLORS = { PERFECT: ['#ffd54a', '#8a4a00', 78], GREAT: ['#39ffcf', '#006b57', 64], GOOD: ['#4d7cff', '#132a72', 54], MISS: ['#ff5f6d', '#7a1220', 68] };
  let out = body;
  for (const [t, [main, deep, size]] of Object.entries(COLORS)) {
    out = out.replaceAll(`COLOR_${t}`, main).replaceAll(`DEEP_${t}`, deep).replaceAll(`SIZE_${t}`, String(size));
  }
  return out;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/__judge_styles__') {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return res.end(withTierVars(html));
  }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}/__judge_styles__`;
console.log(`字效方案对比: ${base}`);

if (has('shot')) {
  mkdirSync(outDir, { recursive: true });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1720, height: 1080 }, deviceScaleFactor: 2 });
  await page.goto(base);
  await page.waitForFunction(() => window.__ready);
  const file = path.join(outDir, `judge-styles-at${String(at).replace('.', '')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`已保存 ${path.relative(root, file)}`);
  await browser.close();
  server.closeAllConnections();
  server.close();
} else {
  console.log('Ctrl+C 退出。加 --shot 截图。');
}

