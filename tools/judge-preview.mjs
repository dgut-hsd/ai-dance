/**
 * 判定动效预览台 / 截图工具。
 *
 * 为什么需要它:主游戏 (dance.html) 要起摄像头、模型、谱面才能看到判定反馈,
 * 调一个 30px 的字效不值得走完整流程。这里把 style.css 的真实规则直接挂进
 * 一个 1280x720 的舞台环境,点一下就能看四个 tier 的弹字,并且能定格截图。
 *
 * 用法:
 *   node tools/judge-preview.mjs                  # 起本地预览(默认 8100)
 *   node tools/judge-preview.mjs --shot           # 定格截图到 shots/judge-*.png
 *   node tools/judge-preview.mjs --shot --at 0.35 # 定格在动画 35% 处
 *
 * 参数:
 *   --port 8100     监听端口
 *   --at 0.35       定格进度(0=刚触发,1=动画结束)
 *   --tiers PERFECT,GREAT,GOOD,MISS
 *   --out shots     截图输出目录
 *   --stage-color   舞台底色(默认 3D 场景那种冷蓝黑)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDance = path.join(root, 'web_dance');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const port = Number(flag('port', 8100));
const at = Number(flag('at', 0.32));
const outDir = path.resolve(root, flag('out', 'shots'));
const tiers = flag('tiers', 'PERFECT,GREAT,GOOD,MISS').split(',').map((s) => s.trim().toUpperCase());
const stageColor = flag('stage-color', '#0b1020');
const shot = has('shot');

const PREVIEW_PATH = '/__judge_preview__';

/** 预览页:复用生产 style.css,只补一层"舞台底"和触发按钮。 */
function previewHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>判定动效预览</title>
<link rel="stylesheet" href="/web_dance/style.css" />
<style>
  :root { --stage-bg: ${stageColor}; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--stage-bg); }
  /* 假装是 3D 舞台:一条地平线 + 中心地面光斑,方便看判定字在真实底色上的对比度 */
  #fake-stage {
    position: fixed; inset: 0;
    background:
      radial-gradient(ellipse 60% 38% at 50% 78%, rgba(57,255,207,0.13), transparent 70%),
      radial-gradient(ellipse 90% 60% at 50% 50%, rgba(77,124,255,0.10), transparent 75%),
      linear-gradient(180deg, #05070f 0%, #0b1020 55%, #131a2e 100%);
  }
  #fake-stage::after {
    content: ""; position: absolute; left: 0; right: 0; top: 62%;
    height: 1px; background: linear-gradient(90deg, transparent, rgba(57,255,207,0.35), transparent);
  }
  #fake-avatar {
    position: fixed; left: 50%; top: 46%; width: 120px; height: 260px;
    transform: translate(-50%, -50%); border-radius: 60px 60px 18px 18px;
    background: linear-gradient(180deg, rgba(255,255,255,0.20), rgba(120,160,255,0.06));
    filter: blur(2px);
  }
  #hud {
    position: fixed; left: 16px; bottom: 16px; right: 16px; z-index: 90;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  }
  #hud button {
    font: 700 13px/1 system-ui, sans-serif; padding: 10px 14px; border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.22); background: rgba(10,14,26,0.8);
    color: #e9f0ff; cursor: pointer;
  }
  #hud button:hover { border-color: rgba(57,255,207,0.6); }
  #hud .tag { font: 600 12px/1 system-ui, sans-serif; color: #7f8aa8; align-self: center; }
  #hud label { font: 600 12px/1 system-ui, sans-serif; color: #9fb0d0; display: flex; gap: 6px; align-items: center; }
  #hud input[type=range] { width: 120px; }
</style>
</head>
<body>
  <div id="fake-stage"></div>
  <div id="fake-avatar"></div>
  <div id="hud">
    ${tiers.map((t) => `<button data-tier="${t}">${t}</button>`).join('')}
    <button data-tier="AUTO">自动连打</button>
    <label>音量 <input id="vol" type="range" min="0" max="1" step="0.05" value="0.5" /></label>
    <label><input id="mute" type="checkbox" /> 静音</label>
    <span class="tag" id="stat">点击触发 · data-tier 决定配色与字号</span>
  </div>

  <!-- 与 dance.html 完全同构的判定 DOM -->
  <div id="judge" class="hidden">
    <div id="judge-tier">PERFECT</div>
    <div id="judge-sub"></div>
  </div>
  <!-- 连击徽章同样拉进来,方便一起调 -->
  <div id="combo-badge" class="hidden">
    <div id="combo-badge-n">0</div>
    <div id="combo-badge-label">COMBO</div>
  </div>

<script type="module">
  import { createJuice } from '/web_dance/ui-lab/juice.js';
  import { Sfx } from '/web_dance/sfx.js';

  const COLORS = { PERFECT: '#ffd54a', GREAT: '#39ffcf', GOOD: '#4d7cff', MISS: '#ff5f6d' };
  const judge = document.getElementById('judge');
  const judgeTier = document.getElementById('judge-tier');
  const judgeSub = document.getElementById('judge-sub');
  const comboBadge = document.getElementById('combo-badge');
  const comboN = document.getElementById('combo-badge-n');
  const stat = document.getElementById('stat');

  const canvas = document.createElement('canvas');
  canvas.id = 'fx';
  document.body.appendChild(canvas);
  const stageLayer = document.getElementById('fake-stage');
  const juice = createJuice({ canvas, shakeTarget: stageLayer });

  // 音效总线:与音乐共用 AudioContext(真实游戏里传 session.engine.ctx)
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const sfx = new Sfx(audioContext, { volume: 0.5 });
  const unlock = () => { if (audioContext.state === 'suspended') audioContext.resume(); };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  document.getElementById('vol').addEventListener('input', (e) => sfx.setVolume(Number(e.target.value)));
  document.getElementById('mute').addEventListener('change', (e) => { sfx.enabled = !e.target.checked; });

  let combo = 0;
  let autoTimer = null;
  let lettersShown = "";

  // ---------------------------------------------------------------------------
  // 热度曲线:与 main.js 的 heatTick 同一套模型(只追不跳 + 升降不同时间常数)。
  // 这里是独立实现而不是 import,因为 main.js 那份绑着整个游戏状态。
  // 参数必须与 main.js 的 HEAT_* 常量保持一致,否则预览台调出来的手感和实机不一样。
  // ---------------------------------------------------------------------------
  const HEAT_RAMP = 50, HEAT_EXP = 0.8, HEAT_UP_TAU = 0.35, HEAT_DOWN_TAU = 1.1;
  const HEAT_STOPS = [[255, 213, 74], [255, 152, 61], [255, 87, 96], [214, 61, 255]];
  const HEAT_STOPS2 = [[255, 61, 129], [255, 61, 129], [214, 61, 255], [255, 61, 255]];
  let heatTarget = 0, heatNow = 0, heatTier = "";
  const heatProbe = {};
  const rootStyle = document.documentElement.style;
  const lerpRgb = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  function heatColors(h) {
    const x = Math.max(0, Math.min(1, h)) * (HEAT_STOPS.length - 1);
    const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x)), t = x - i;
    return { main: lerpRgb(HEAT_STOPS[i], HEAT_STOPS[i + 1], t), hot: lerpRgb(HEAT_STOPS2[i], HEAT_STOPS2[i + 1], t) };
  }
  const tierOf = (h) => (h >= 0.88 ? 'blaze' : h >= 0.62 ? 'hot' : h >= 0.32 ? 'warm' : 'cool');
  const comboHeatTarget = (c) => (c <= 1 ? 0 : Math.pow(Math.min(Math.max(c - 1, 0) / (HEAT_RAMP - 1), 1), HEAT_EXP));
  function applyHeat() {
    const { main, hot } = heatColors(heatNow);
    rootStyle.setProperty('--heat', heatNow.toFixed(3));
    rootStyle.setProperty('--hot-rgb', main.join(', '));
    rootStyle.setProperty('--hot2-rgb', hot.join(', '));
    rootStyle.setProperty('--badge-size', (44 + 14 * heatNow).toFixed(1) + 'px');
    rootStyle.setProperty('--badge-jitter', (heatNow > 0.62 ? (heatNow - 0.62) / 0.38 * 1.6 : 0).toFixed(2));
    const t = tierOf(heatNow);
    if (t !== heatTier) { heatTier = t; comboBadge.dataset.heatTier = t; }
    heatProbe.value = heatNow; heatProbe.tier = t; heatProbe.target = heatTarget;
  }
  let lastHeatT = performance.now();
  function heatTick(now) {
    const dt = Math.min(0.1, (now - lastHeatT) / 1000);
    lastHeatT = now;
    const tau = heatTarget > heatNow ? HEAT_UP_TAU : HEAT_DOWN_TAU;
    heatNow += (heatTarget - heatNow) * (1 - Math.exp(-dt / tau));
    if (Math.abs(heatTarget - heatNow) < 0.0015) heatNow = heatTarget;
    applyHeat();
    requestAnimationFrame(heatTick);
  }
  requestAnimationFrame(heatTick);
  window.__heat = heatProbe;

  // 与 main.js renderJudgeLetters 同构:逐字 span + stagger 延迟
  function setJudgeLetters(tier) {
    judgeTier.dataset.text = tier;
    if (lettersShown === tier) return;
    lettersShown = tier;
    judgeTier.textContent = "";
    [...tier].forEach((ch, i) => {
      const s = document.createElement("span");
      s.className = "jt-ch";
      s.textContent = ch;
      s.style.animationDelay = \`\${Math.round((i * 65) / Math.max(1, tier.length - 1))}ms\`;
      judgeTier.appendChild(s);
    });
  }
  window.__hit = (tier) => {
    if (tier === 'AUTO') {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; stat.textContent = '自动连打:停'; return; }
      stat.textContent = '自动连打:开(每 160ms 一击)';
      const pool = ['PERFECT', 'PERFECT', 'PERFECT', 'GREAT', 'GREAT', 'GOOD'];
      autoTimer = setInterval(() => window.__hit(pool[(Math.random() * pool.length) | 0]), 160);
      return;
    }
    judge.dataset.tier = tier;
    judge.style.setProperty('--jtier', COLORS[tier] || '#fff');
    setJudgeLetters(tier);
    judgeSub.textContent = tier === 'MISS' ? '' : '+' + (1000 + combo * 7);
    judge.classList.remove('hidden', 'pop');
    void judge.offsetWidth;
    judge.classList.add('pop');

    // 打击音跟着热度走:与实机同一套算法(heat 1→1.15 ≈ +2.4 半音)
    sfx.hit(tier, { heat: 1 + heatNow * 0.15, seed: combo });
    combo = tier === 'MISS' ? 0 : combo + 1;
    heatTarget = comboHeatTarget(combo);
    if (combo >= 2) {
      comboN.textContent = String(combo);
      comboN.dataset.text = String(combo);
      comboBadge.classList.remove('hidden');
      comboBadge.classList.remove('pulse', 'milestone');
      void comboBadge.offsetWidth;
      const milestone = combo % 10 === 0;
      comboBadge.classList.add(milestone ? 'milestone' : 'pulse');
      if (milestone) sfx.milestone(combo);
    } else {
      comboBadge.classList.add('hidden');
    }

    const cx = innerWidth / 2, cy = innerHeight * 0.46;
    if (tier === 'PERFECT') {
      juice.flash('255,213,74', 0.16, 0.12);
      juice.ring(cx, cy, { size: 160, color: '255,213,74', width: 4, duration: 340 });
      juice.ring(cx, cy, { size: 92, color: '255,255,255', width: 2.5, duration: 220, delay: 40 });
      juice.sparks(cx, cy, { count: 28, rays: 14, speed: 420, colors: ['255,213,74', '255,255,255', '255,61,129'] });
    } else if (tier === 'GREAT') {
      juice.flash('57,255,207', 0.1, 0.09);
      juice.ring(cx, cy, { size: 120, color: '57,255,207', width: 3, duration: 280 });
      juice.sparks(cx, cy, { count: 14, rays: 8, speed: 300, colors: ['57,255,207', '255,255,255'] });
    } else if (tier === 'GOOD') {
      juice.ring(cx, cy, { size: 92, color: '77,124,255', width: 2.5, duration: 230 });
    } else {
      juice.flash('255,95,109', 0.18, 0.14);
      juice.vignette(0.28);
      juice.sparks(cx, cy, { count: 10, rays: 6, speed: 220, colors: ['255,95,109', '255,61,129'] });
    }
  };

  // 定格:把当前所有 CSS 动画暂停在指定进度,便于逐帧对比与截图。
  // 注意要把 animationDelay 算进去,否则逐字动画会停在各自"还没开始"的 0 帧。
  window.__freeze = (progress) => {
    const anims = document.getAnimations();
    let moved = 0;
    for (const a of anims) {
      const d = a.effect?.getComputedTiming?.();
      const delay = d?.delay ?? 0;
      const active = d?.activeDuration ?? 0;
      const total = delay + active;
      if (!total) continue;
      a.pause();
      a.currentTime = Math.max(0, Math.min(total, delay + progress * active));
      moved++;
    }
    return moved;
  };

  document.getElementById('hud').addEventListener('click', (e) => {
    const t = e.target.closest('button')?.dataset.tier;
    if (t) { unlock(); window.__hit(t); }
  });
  window.addEventListener('keydown', (e) => {
    const map = { p: 'PERFECT', g: 'GREAT', o: 'GOOD', m: 'MISS', a: 'AUTO' };
    const t = map[e.key.toLowerCase()];
    if (t) { unlock(); window.__hit(t); }
  });
  window.__ready = true;
</script>
</body>
</html>`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === PREVIEW_PATH || url.pathname === '/') {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return res.end(previewHtml());
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((r) => server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}${PREVIEW_PATH}`;
console.log(`判定动效预览: ${base}`);

if (shot) {
  mkdirSync(outDir, { recursive: true });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(base);
  await page.waitForFunction(() => window.__ready);
  for (const tier of tiers) {
    await page.evaluate((t) => window.__hit(t), tier);
    await page.waitForTimeout(60);
    await page.evaluate((p) => window.__freeze(p), at);
    const file = path.join(outDir, `judge-${tier.toLowerCase()}-at${String(at).replace('.', '')}.png`);
    await page.screenshot({ path: file });
    console.log(`已保存 ${path.relative(root, file)}`);
  }
  await browser.close();
  server.closeAllConnections();
  server.close();
} else {
  console.log('Ctrl+C 退出。加 --shot 可定格截图。');
}

