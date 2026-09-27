/**
 * gen-silhouettes.mjs — 生成选曲卡片的「3D 舞者白影剪影」。
 *
 * 原理:离屏加载 Michelle.glb → 换纯白材质 → 透明背景 → 对每支舞挑「最展开的
 * 招牌动作」帧 → 渲染 → 按 alpha 裁剪,输出成白色剪影 PNG。
 *
 * 输出:web_dance/assets/silhouettes/{demo,hiphop,salsa,free}.png
 *
 * 前置:需要 DANCE ARENA 服务已在 8000 端口运行(serve /web_dance、/pose_capture、
 * /models、/fbx),且可访问 jsdelivr CDN 加载 three.js。
 * 用法:node tools/gen-silhouettes.mjs
 *
 * 换模型 / 加舞曲后重跑一次即可刷新剪影。`bestT` 用「重建关节的最大间距」自动
 * 挑最展开的招牌帧,无需手动指定时刻。
 */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../web_dance/assets/silhouettes');
const BASE = 'http://127.0.0.1:8000';
mkdirSync(OUT, { recursive: true });

const GEN_HTML = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}</script>
</head><body style="margin:0"><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import * as THREE from "three";
import { loadAvatar } from "/web_dance/avatar.js";
import { buildDemoSequence } from "/web_dance/demo-sequence.js";
import { loadFbxSequence, CHALLENGE_DANCES, SONGS } from "/web_dance/challenge-library.js";
import { BONE_DEFS } from "/pose_capture/contract.js";
import { reconstructJoints } from "/pose_capture/playback.js";

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.setSize(512, 512);
const scene = new THREE.Scene();
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);

const avatar = await loadAvatar('/models/Michelle.glb');
avatar.object.traverse(o => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: 0xffffff }); });
scene.add(avatar.object);
avatar.retargeter.reset();

function applyFrame(seq, t) {
  const fps = seq.meta?.fps || 30;
  const i = Math.min(seq.frames.length - 1, Math.max(0, Math.round(t * fps)));
  avatar.retargeter.applyFrame(seq.frames[i], { boneDefs: BONE_DEFS, mirror: false, rootMotion: false });
  avatar.skeletons.forEach((s) => s.update());
  avatar.object.updateMatrixWorld(true);
}
function render() {
  const half = 1.7;
  cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
  cam.position.set(0, 0.9, 12);
  cam.lookAt(0, 0.9, 0);
  cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  return canvas.toDataURL('image/png');
}
// 裁剪到非透明内容(带边距),让剪影尽量填满画布
function crop(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width, h = img.height;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.06);
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      const out = document.createElement('canvas'); out.width = cw; out.height = ch;
      out.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, cw, ch);
      resolve(out.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}
// 用重建关节的最大间距衡量「展开度」,挑招牌动作
function spreadOf(seq, t) {
  const fps = seq.meta?.fps || 30;
  const frame = seq.frames[Math.min(seq.frames.length - 1, Math.max(0, Math.round(t * fps)))];
  const j = reconstructJoints(frame, avatar.retargeter.dims, BONE_DEFS);
  const pts = Object.values(j).filter((p) => Array.isArray(p));
  let m = 0;
  for (const a of pts) for (const b of pts) { const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); if (d > m) m = d; }
  return m;
}
function bestT(seq) {
  const fps = seq.meta?.fps || 30;
  const step = Math.max(1, Math.floor(fps / 4));
  let best = 0, bs = -1;
  for (let i = 0; i < seq.frames.length; i += step) { const t = i / fps; const s = spreadOf(seq, t); if (s > bs) { bs = s; best = t; } }
  return best;
}

const seqDemo = buildDemoSequence();
const hp = CHALLENGE_DANCES.find(d => d.id === 'hiphop');
const sa = CHALLENGE_DANCES.find(d => d.id === 'salsa');
const seqHiphop = await loadFbxSequence(hp.fbx, SONGS.find(s => s.id === hp.defaultSongId));
const seqSalsa = await loadFbxSequence(sa.fbx, SONGS.find(s => s.id === sa.defaultSongId));

const results = {};
for (const [name, seq] of Object.entries({ demo: seqDemo, hiphop: seqHiphop, salsa: seqSalsa })) {
  const t = bestT(seq);
  applyFrame(seq, t);
  results[name] = { dataUrl: await crop(render()), t: +t.toFixed(2) };
}
applyFrame(seqDemo, 0.5);
results.free = { dataUrl: await crop(render()), t: 0.5 };
window.__results = results;
window.__ready = true;
</script></body></html>`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
page.on('pageerror', e => console.log('pageerror:', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('console.error:', m.text()); });
await page.route('**/gen-silhouette', r => r.fulfill({ contentType: 'text/html', body: GEN_HTML }));
await page.goto(`${BASE}/gen-silhouette`);
await page.waitForFunction(() => window.__ready, null, { timeout: 90000 });
const results = await page.evaluate(() => window.__results);
for (const [name, r] of Object.entries(results)) {
  const b64 = r.dataUrl.split(',')[1];
  const file = resolve(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('saved', name, 'at t=' + r.t, '->', file);
}
await browser.close();
console.log('DONE');
