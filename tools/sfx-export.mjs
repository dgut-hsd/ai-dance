/**
 * 把打击音效渲染成真实 wav 文件 —— 让你能直接听。
 *
 * 为什么需要这个:离线测峰值只能证明"电平对",证明不了"好不好听"。
 * 判定音色这种事必须用耳朵定,所以把四档、里程碑、开场/结算音效各导一个 wav,
 * 另外导一组"抗疲劳变体 A/B 对照"(16 连,开变体 vs 关变体)——
 * 后者是唯一能听出"机关枪感"有没有被解决的办法。
 *
 * 用法: node tools/sfx-export.mjs
 * 输出: shots/sfx/*.wav
 */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'shots', 'sfx');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav' };

const HARNESS = `<!DOCTYPE html><html><body><script type="module">
import { Sfx } from '/web_dance/sfx.js';
import { SampleHitSound, HitSound } from '/web_dance/hitsound.js';

/* 16bit PCM WAV 编码:导出给媒体播放器听,不再是 Float32 的 AudioBuffer。 */
function encodeWav(buffer) {
  const channels = buffer.numberOfChannels, rate = buffer.sampleRate, frames = buffer.length;
  const blockAlign = channels * 2, dataBytes = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataBytes), dv = new DataView(ab);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true); dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, dataBytes, true);
  const chans = []; for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true); off += 2;
  }
  return ab;
}

const RATE = 48000;
/** 渲染一段音效,返回 base64 wav。build(synth, samples, hs) */
async function render(seconds, build, volume = 0.45) {
  const ctx = new OfflineAudioContext(2, Math.ceil(RATE * seconds), RATE);
  const synth = new Sfx(ctx, { volume });
  const samples = new SampleHitSound(ctx, { baseUrl: '/web_dance/audio/sfx/', masterGain: HitSound.MASTER_GAIN });
  const hs = new HitSound(synth, samples);
  await samples.load();   // 本次导出以采样层为准(合成层只作兜底演示)
  build(synth, samples, hs);
  const buf = await ctx.startRendering();
  // 自检:在**编码之前**量一次起音,把"渲染偏移"与"编码偏移"分开。
  // (踩过的坑:导出的 wav 起音比 schedule 点晚 54ms,靠这个自检才定位到是哪一段的问题。)
  {
    const d = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    let onset = -1;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > peak * 0.05) { onset = i; break; }
    if (!globalThis.__renderDiag) globalThis.__renderDiag = [];
    globalThis.__renderDiag.push({ seconds, peak: +peak.toFixed(4), onsetMs: onset < 0 ? null : +(onset / RATE * 1000).toFixed(2) });
  }
  const bytes = new Uint8Array(encodeWav(buf));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

window.__exportAll = async () => {
  const files = {};
  const tiers = ['PERFECT', 'GREAT', 'GOOD', 'MISS'];
  // 1) 四档单次(采样层),音量用生产默认 0.45
  for (const tier of tiers) {
    files['1-single-' + tier.toLowerCase() + '.wav'] = await render(1.2, (s, sm) => {
      sm.play(tier, 0.05, { heat: 1 });
    });
  }
  // 2) 四档连续对照:每档连打 3 次,听档位之间的力度/音色差
  files['2-tier-compare.wav'] = await render(3.4, (s, sm) => {
    tiers.forEach((tier, ti) => {
      for (let i = 0; i < 3; i++) sm.play(tier, 0.1 + ti * 0.8 + i * 0.24, { heat: 1 });
    });
  });
  // 3) 抗疲劳:16 连 PERFECT。off 版固定播第 1 个变体做对照,on 版走正常轮换
  files['3-antifatigue-off.wav'] = await render(7.0, (s, sm) => {
    // 直接反复播第一个变体,绕开 round-robin。
    // 注意 gains 是**逐变体数组**(不是标量) —— 这里要取下标,
    // 忘了取下标就会把数组赋给 AudioParam,浏览器直接抛 non-finite。
    const list = sm.buffers.get('PERFECT');
    const gain = sm.gains.get('PERFECT')[0];
    for (let i = 0; i < 16; i++) {
      const t = 0.15 + i * 0.4;
      const src = sm.ctx.createBufferSource();
      src.buffer = list[0];
      const g = sm.ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(sm.master);
      src.start(t);
    }
  });
  files['4-antifatigue-on.wav'] = await render(7.0, (s, sm) => {
    // 5 个变体轮换 + 热度做相位偏移(与运行时同一条代码路径)
    for (let i = 0; i < 16; i++) sm.play('PERFECT', 0.15 + i * 0.4, { heat: 1 + (i / 15) * 0.15 });
  });
  // 4) 里程碑 + 开场/结算 —— 走采样 accent(主频阶梯 586→1254→1980→7336Hz)
  files['5-milestone.wav'] = await render(2.0, (s, sm) => sm.playAccents([0, 1, 2, 3], 0.05, 55, 0.5), 0.45);
  files['6-stinger-start.wav'] = await render(2.2, (s, sm) => sm.playAccents([0, 2, 3], 0.05, 90, 0.5), 0.45);
  files['7-stinger-success.wav'] = await render(2.4, (s, sm) => sm.playAccents([0, 1, 2, 3], 0.05, 90, 0.5), 0.45);
  // 5) 合成兜底:证明采样未就绪时也出声,且响度与采样层接近(同一音量便于对比)
  files['8-fallback-synth.wav'] = await render(2.4, (s) => {
    ['PERFECT', 'GREAT', 'GOOD', 'MISS'].forEach((tier, i) => s.hit(tier, { when: 0.1 + i * 0.5, heat: 1, count: 0 }));
  });
  return files;
};
window.__ready = 1;
<\/script></body></html>`;

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__export__') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(HARNESS); }
  const abs = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(root)) { res.writeHead(403); return res.end(); }
  try { const buf = await readFile(abs); res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' }); res.end(buf); }
  catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));

const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${app.address().port}/__export__`);
await page.waitForFunction(() => window.__ready === 1);

const files = await page.evaluate(() => window.__exportAll());
const diag = await page.evaluate(() => globalThis.__renderDiag || []);
console.log('渲染自检(编码之前,单位 ms):');
for (const d of diag) console.log('  seconds=' + d.seconds + '  peak=' + d.peak + '  onset=' + d.onsetMs);
await mkdir(outDir, { recursive: true });
let total = 0;
for (const [name, b64] of Object.entries(files)) {
  const buf = Buffer.from(b64, 'base64');
  await writeFile(path.join(outDir, name), buf);
  total += buf.length;
  console.log(`  ${name.padEnd(28)} ${(buf.length / 1024).toFixed(0)} KB`);
}
console.log(`\n共 ${Object.keys(files).length} 个文件,${(total / 1024 / 1024).toFixed(2)} MB → shots/sfx/`);
console.log('重点听:3-antifatigue-off.wav vs 4-antifatigue-on.wav(16 连,同一音色 vs 轮换变体)');
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));



