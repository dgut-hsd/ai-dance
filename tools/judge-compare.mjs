/**
 * 判定字效 前/后 对比台。
 *
 * 左列 = 改造前的实现(CSS 内联快照,不依赖 git 历史);
 * 右列 = 直接引用生产 web_dance/style.css 的 #judge 规则,并用与 main.js 相同的 DOM 结构。
 * 两列都定格在动画早期(默认 26%),对比的是"落在脸上的那一帧"。
 *
 * 用法: node tools/judge-compare.mjs --shot [--at 0.26]
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
const port = Number(flag('port', 8106));
const at = Number(flag('at', 0.26));
const outDir = path.resolve(root, flag('out', 'shots'));

const TIERS = [
  { id: 'PERFECT', color: '#ffd54a', size: 82 },
  { id: 'GREAT', color: '#39ffcf', size: 68 },
  { id: 'MISS', color: '#ff5f6d', size: 74 },
];

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>判定字效 前/后 对比</title>
<link rel="stylesheet" href="/web_dance/style.css" />
<style>
  html, body { margin: 0; background: #05070f; color: #cfd8ee;
    font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; }
  body { padding: 20px 24px 28px; }
  h1 { font-size: 17px; margin: 0 0 3px; letter-spacing: 1px; color: #e8efff; }
  p.sub { margin: 0 0 16px; font-size: 12.5px; color: #7f8aa8; }
  .grid { display: grid; grid-template-columns: 92px 1fr 1fr; gap: 12px; }
  .head { font-size: 12px; color: #9fb0d0; align-self: end; padding-bottom: 6px; }
  .head b { display: block; font-size: 13px; color: #e6edff; margin-bottom: 2px; }
  .head.old b { color: #ff9f9f; }
  .head.new b { color: #7dffd8; }
  .rowlabel { display: grid; place-items: center; font: 700 13px system-ui; color: #9fb0d0; }
  .stage {
    position: relative; display: grid; place-items: center; height: 210px; border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.08); overflow: hidden;
    background:
      radial-gradient(ellipse 46% 58% at 50% 68%, rgba(57,255,207,0.07), transparent 72%),
      linear-gradient(180deg, #070a14, #0d1322 58%, #141c30);
  }

  /* ---------- 左列:改造前的规则快照(照抄改造前的 style.css) ---------- */
  .old-judge {
    --font-display: "Impact", "Haettenschweiler", "Arial Black", "Microsoft YaHei", sans-serif;
    position: relative; text-align: center; --jtier: #fff;
  }
  .old-judge::before {
    content: ""; position: absolute; left: 50%; top: 50%; width: 280px; height: 280px;
    transform: translate(-50%, -50%); border-radius: 50%;
    background: radial-gradient(circle, var(--jtier, #fff) 0%, transparent 62%);
    opacity: 0.6;
  }
  .old-tier {
    font-family: var(--font-display); font-size: 56px; font-weight: 900; font-style: italic;
    letter-spacing: 2px; line-height: 1; color: var(--jtier, #fff);
    -webkit-text-stroke: 1px rgba(255,255,255,0.28);
    text-shadow: 0 0 6px #fff, 0 0 22px var(--jtier, #fff), 0 0 54px var(--jtier, #fff), 0 4px 0 rgba(0,0,0,0.45);
    transform: skewX(-6deg);
  }
</style>
</head>
<body>
<h1>判定字效 前 / 后 对比 · 定格 ${Math.round(at * 100)}%</h1>
<p class="sub">同一底色、同一档位配色。左列 = 改造前的内联快照;右列 = 直接引用生产 style.css 的 #judge 规则与 main.js 的逐字 DOM。</p>
<div class="grid">
  <div class="head">档位</div>
  <div class="head old"><b>改造前</b>平涂 + 白描边 + 54px 半径大光晕 + 整体斜切</div>
  <div class="head new"><b>改造后</b>深描边 + 纵向渐变 + 倒角投影 + 紧光晕 + 逐字弹出</div>
  ${TIERS.map((t) => `
  <div class="rowlabel">${t.id}</div>
  <div class="stage">
    <div class="old-judge" style="--jtier:${t.color}">
      <div class="old-tier" style="font-size:${t.size}px">${t.id}</div>
    </div>
  </div>
  <div class="stage">
    <div id="judge" class="pop" data-tier="${t.id}" style="--jtier:${t.color}; position: static; transform: none">
      <div id="judge-tier" data-text="${t.id}">
        ${[...t.id].map((c, i) => `<span class="jt-ch" style="animation-delay:${Math.round((i * 65) / Math.max(1, t.id.length - 1))}ms">${c}</span>`).join('')}
      </div>
      <div id="judge-sub"></div>
    </div>
  </div>`).join('')}
</div>
<script>window.__ready = true;</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/__judge_compare__') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, {
      'content-type': path.extname(abs) === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream',
    });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}/__judge_compare__`;
console.log(`前后对比: ${base}`);

if (has('shot')) {
  mkdirSync(outDir, { recursive: true });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1240, height: 820 }, deviceScaleFactor: 2 });
  await page.goto(base);
  await page.waitForFunction(() => window.__ready);
  await page.evaluate((p) => {
    for (const a of document.getAnimations()) {
      const d = a.effect?.getComputedTiming?.();
      const delay = d?.delay ?? 0, active = d?.activeDuration ?? 0;
      if (!delay + active) continue;
      a.pause();
      a.currentTime = delay + p * active;
    }
  }, at);
  const file = path.join(outDir, `judge-before-after-at${String(at).replace('.', '')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`已保存 ${path.relative(root, file)}`);
  await browser.close();
  server.closeAllConnections();
  server.close();
} else {
  console.log('Ctrl+C 退出。加 --shot 截图。');
}
