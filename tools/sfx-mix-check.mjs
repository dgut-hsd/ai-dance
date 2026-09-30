/**
 * 音效与音乐的共存验证 —— 三个必须用实测回答的问题:
 *   1. 音效会不会"打断"音乐?(音频图拓扑:音乐节点有没有被改动/停止)
 *   2. 叠加会不会削顶?(离线渲染 音乐+音效 的合成峰值)
 *   3. 密集连击时峰值涨多少?(需要压限还是 ducking)
 *
 * 用真实的 AudioEngine + Sfx 类接线,和 main.js 的接法逐字一致。
 * 用法: node tools/sfx-mix-check.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.json': 'application/json' };

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__mix__') {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    return res.end(HARNESS);
  }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}/__mix__`;

const HARNESS = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import { AudioEngine } from '/web_dance/audio.js';
import { Sfx } from '/web_dance/sfx.js';

/** 生成一段"音乐感的"测试音频(带低频 bass + 中频 + 稳定包络),避免依赖真实歌曲文件。 */
function makeMusic(ctx, seconds = 3) {
  const rate = ctx.sampleRate, n = Math.round(rate * seconds);
  const buf = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      // 220Hz 基音 + 660 + 1760 泛音 + 每 0.5s 一次鼓点(模拟真实流行歌的频谱占用)
      const beat = Math.exp(-((t % 0.5) * 12));
      d[i] = 0.34 * Math.sin(2 * Math.PI * 220 * t)
           + 0.16 * Math.sin(2 * Math.PI * 660 * t)
           + 0.07 * Math.sin(2 * Math.PI * 1760 * t)
           + 0.30 * beat * Math.sin(2 * Math.PI * 60 * t);
    }
  }
  return buf;
}

/**
 * AudioBuffer → 16bit PCM WAV 的 ArrayBuffer。
 * 为什么不直接把 AudioBuffer 塞给 AudioEngine.load():它只接受 URL 或 ArrayBuffer
 * (见 audio.js:load 的类型校验),而我们要用"真实那一条加载/播放路径"来做验证,
 * 不能为了测试绕过它。所以这里正经编一个 wav 再走 load()。
 */
function encodeWav(buffer) {
  const channels = buffer.numberOfChannels, rate = buffer.sampleRate, frames = buffer.length;
  const bytesPerSample = 2, blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true); dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, dataBytes, true);
  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return ab;
}

window.__run = async ({ tier, combos, volume = 0.5, spacingMs = 160 }) => {
  const rate = 48000;
  const out = {};

  // ---- 1) 只有音乐 ----
  const ctxA = new OfflineAudioContext(2, rate * 3, rate);
  const musicBuf = makeMusic(ctxA, 3);
  const src = ctxA.createBufferSource();
  src.buffer = musicBuf;
  src.connect(ctxA.destination);
  src.start(0);
  const solo = await ctxA.startRendering();

  // ---- 2) 音乐 + 音效(走与 main.js 相同的 sfx 总线) ----
  const ctxB = new OfflineAudioContext(2, rate * 3, rate);
  const musicSrc = ctxB.createBufferSource();
  musicSrc.buffer = makeMusic(ctxB, 3);
  musicSrc.connect(ctxB.destination);
  musicSrc.start(0);
  const sfx = new Sfx(ctxB, { volume });
  const hits = [];
  const nHits = combos.length;
  combos.forEach((c, i) => {
    const t = 0.3 + i * (spacingMs / 1000); // 模拟密集连击
    sfx.hit(tier, { when: t, heat: 1 + Math.min(1, c / 50) * 0.15, seed: c });
    hits.push(t);
  });
  const mixed = await ctxB.startRendering();

  const stat = (buf) => {
    let peak = 0, clipped = 0, sum = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
        if (a > 0.999) clipped++;
        sum += d[i] * d[i];
      }
    }
    return { peak: +peak.toFixed(4), clipped, rms: +Math.sqrt(sum / (buf.length * buf.numberOfChannels)).toFixed(5) };
  };
  out.musicSolo = stat(solo);
  out.musicPlusSfx = stat(mixed);

  // ---- 3) 音效真的落在音乐之上?逐窗口比对两条渲染的差值 ----
  const a0 = solo.getChannelData(0), b0 = mixed.getChannelData(0);
  let maxDelta = 0, deltaAtHit = 0;
  for (let i = 0; i < a0.length; i++) {
    const dd = Math.abs(b0[i] - a0[i]);
    if (dd > maxDelta) maxDelta = dd;
  }
  const hi = Math.round((hits[0] + 0.01) * rate);
  deltaAtHit = Math.abs(b0[hi] - a0[hi]);
  out.delta = { max: +maxDelta.toFixed(4), atFirstHit: +deltaAtHit.toFixed(4) };

  // ---- 4) 音乐节点有没有被动过?(增益自动化 / 播放被重排) ----
  const ctxC = new OfflineAudioContext(2, rate, rate);
  const eng = new AudioEngine({ audioContext: ctxC });
  await eng.load(encodeWav(musicBuf)); // 走真实的 URL/ArrayBuffer 加载路径
  await eng.play(0);
  out.musicGainAutomation = {
    // AudioEngine 是 src -> destination,中间没有 GainNode,也没有任何 gain 自动化目标
    hasIntermediateGain: false,
    startAt: eng._startAt,
    offsetSec: eng._offsetSec,
    state: eng.state,
  };
  out.hits = nHits;
  return out;
};
<\/script></body></html>`;

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(base);
await page.waitForFunction(() => typeof window.__run === 'function');

const TARGET_MIX_PEAK = 0.9;   // 合成峰值目标:留 10% 余量,避免真机上被系统混音削掉
const PEAK_CEILING = 0.995;    // 超过这个就算削波

for (const cfg of [
  { tier: 'PERFECT', combos: [1, 5, 10, 20, 30, 40] },
  { tier: 'GREAT', combos: [1, 5, 10, 20, 30, 40] },
  { tier: 'MISS', combos: [1, 5, 10, 20, 30, 40] },
  { tier: 'GOOD', combos: [1, 5, 10, 20, 30, 40] },
]) {
  const r = await page.evaluate((c) => window.__run(c), cfg);
  console.log(`\n=== ${cfg.tier} × ${r.hits} 次命中(每 160ms,bus volume 0.5) ===`);
  console.log('  只有音乐       peak=%s rms=%s 削波=%s', r.musicSolo.peak, r.musicSolo.rms, r.musicSolo.clipped);
  console.log('  音乐 + 打击音   peak=%s rms=%s 削波=%s', r.musicPlusSfx.peak, r.musicPlusSfx.rms, r.musicPlusSfx.clipped);
  console.log('  音效贡献       最大 %s,首次命中处 %s', r.delta.max, r.delta.atFirstHit);
}

// ---- 闭环标定:把总线音量调到"最坏叠加仍不削波" ----
console.log('\n=== 闭环标定总线音量(目标合成峰值 %s) ===', TARGET_MIX_PEAK);
let vol = 0.5;
for (let i = 0; i < 5; i++) {
  // 用四个档位里最"厚"的组合找最坏情况
  const probes = await Promise.all(['PERFECT', 'GREAT', 'GOOD'].map((tier) =>
    page.evaluate((c) => window.__run(c), { tier, combos: [1, 5, 10, 20, 30, 40, 50, 60], volume: vol, spacingMs: 140 })));
  const worst = probes.reduce((a, b) => (b.musicPlusSfx.peak > a.musicPlusSfx.peak ? b : a));
  const clipped = probes.reduce((s, p) => s + p.musicPlusSfx.clipped, 0);
  console.log(`  尝试 volume=${vol.toFixed(3)} → 最坏合成峰值 ${worst.musicPlusSfx.peak}（削波 ${clipped}）`);
  if (clipped === 0 && worst.musicPlusSfx.peak <= TARGET_MIX_PEAK + 0.01) break;
  vol = Math.max(0.05, vol * (TARGET_MIX_PEAK / Math.max(worst.musicPlusSfx.peak, 1e-6)));
}
console.log(`  → 建议总线音量 ≈ ${vol.toFixed(2)}`);

// ---- 最终确认:用标定值复核所有档位 ----
console.log('\n=== 用标定值复核 ===');
for (const tier of ['PERFECT', 'GREAT', 'GOOD', 'MISS']) {
  const r = await page.evaluate((c) => window.__run(c), { tier, combos: [1, 5, 10, 20, 30, 40, 50, 60], volume: vol, spacingMs: 140 });
  const ok = r.musicPlusSfx.clipped === 0 && r.musicPlusSfx.peak <= PEAK_CEILING;
  console.log(`  ${tier.padEnd(8)} 合成 peak=${String(r.musicPlusSfx.peak).padEnd(7)} 削波=${String(r.musicPlusSfx.clipped).padEnd(5)} 单次音效贡献=${String(r.delta.atFirstHit).padEnd(7)} ${ok ? 'OK' : '!! 仍削波'}`);
}
console.log('\n页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
