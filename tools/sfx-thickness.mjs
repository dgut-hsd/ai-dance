/**
 * 打击音「厚度」改造原型 —— A/B 对照,导出成 wav 让人耳判断。
 *
 * 诊断出来的问题(实测,见输出):
 *   · PERFECT 在起音后 50ms 只剩起音的 7%,150ms 剩 0.1% —— 余韵几乎没有
 *   · 分音用 decay/(1+i*0.55):第 6 个分音衰减时间只有基频的 23%,
 *     50ms 时只有基频活着(实测 RMS 50-150ms 仅 0.0074)→ 听感"干瘪的一声哨"
 *   · 低频占比 PERFECT 1.2% / GREAT 0.6% —— 没有任何"重量"
 *
 * 改造三件事:
 *   1. 分音衰减比从 1+0.55i 放缓到 1+0.18i(真实金属体的模态衰减差异没这么夸张)
 *   2. 加 body 层:80~160Hz 的短脉冲,负责"重量感"
 *   3. 加 room 层:极短卷积混响,给声音一个"房间",去掉耳机里的"贴脸电子味"
 *
 * 用法: node tools/sfx-thickness.mjs
 * 输出: shots/sfx-ab/{A-当前,B-改造}-<tier>.wav  以及一张包络/频谱对照图
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'shots', 'sfx-ab');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

// 注意:用普通字符串数组拼,不用模板字符串(里层有 JS,嵌套模板会让中文变乱码)
const HARNESS = [
  '<!DOCTYPE html><body style="margin:0;background:#070a12">',
  '<canvas id="c" width="1700" height="900"></canvas>',
  '<script type="module">',
  "import { Sfx } from '/web_dance/sfx.js';",
  '',
  '/* ---------- B 方案:改造后的钟声 ---------- */',
  'function bellB(ctx, out, t, o) {',
  '  const base = o.base, gain = o.gain, decay = o.decay;',
  '  const ratios = [1, 2.01, 2.99, 4.21, 5.43, 6.79];',
  '  const amps = [1, 0.5, 0.34, 0.22, 0.14, 0.09];',
  '  for (let i = 0; i < ratios.length; i++) {',
  '    for (let d = -1; d <= 1; d += 2) {',
  '      const osc = ctx.createOscillator(); osc.type = "sine";',
  '      osc.frequency.value = base * ratios[i] * (1 + d * 0.0016);',
  '      const g = ctx.createGain();',
  '      const amp = amps[i] * gain * (i === 0 ? 1 : 0.5);',
  '      // 关键改动:1+0.18i 而不是 1+0.55i —— 泛音也要活得够久,才有金属体感',
  '      const dec = decay / (1 + i * 0.18);',
  '      g.gain.setValueAtTime(0.0001, t);',
  '      g.gain.linearRampToValueAtTime(amp, t + 0.004);',
  '      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.004 + dec);',
  '      osc.connect(g).connect(out);',
  '      osc.start(t); osc.stop(t + 0.01 + dec + 0.05);',
  '    }',
  '  }',
  '  // body 层:80~160Hz 短脉冲做"重量",这是当前版本完全缺失的',
  '  const body = ctx.createOscillator(); body.type = "sine";',
  '  body.frequency.setValueAtTime(150, t);',
  '  body.frequency.exponentialRampToValueAtTime(78, t + 0.09);',
  '  const bg = ctx.createGain();',
  '  bg.gain.setValueAtTime(0.0001, t);',
  '  bg.gain.linearRampToValueAtTime(gain * 0.42, t + 0.003);',
  '  bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);',
  '  body.connect(bg).connect(out); body.start(t); body.stop(t + 0.16);',
  '  // 噪声瞬态:bandpass 而不是 highpass,给起音一点"空气感"',
  '  const n = ctx.createBufferSource();',
  '  const nb = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.2), ctx.sampleRate);',
  '  const nd = nb.getChannelData(0);',
  '  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.02));',
  '  n.buffer = nb;',
  '  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = base * 1.8; bp.Q.value = 0.9;',
  '  const ng = ctx.createGain(); ng.gain.value = gain * 0.5;',
  '  n.connect(bp).connect(ng).connect(out); n.start(t); n.stop(t + 0.1);',
  '}',
  '',
  '/* ---------- 一间很小的房间的 IR:两个早期反射 + 短尾 ---------- */',
  'function makeIR(ctx, seconds, reflectMs, decayMs) {',
  '  const n = Math.ceil(ctx.sampleRate * seconds);',
  '  const ir = ctx.createBuffer(2, n, ctx.sampleRate);',
  '  for (let c = 0; c < 2; c++) {',
  '    const d = ir.getChannelData(c);',
  '    // 直声之后的早期反射(两支略微不同的时间,制造立体感)',
  '    for (const [ms, amp] of reflectMs) {',
  '      const i0 = Math.round((ms / 1000) * ctx.sampleRate) + (c ? 7 : 0);',
  '      for (let k = 0; k < 40 && i0 + k < n; k++) d[i0 + k] += amp * (1 - k / 40) * (c ? 1 : 0.86);',
  '    }',
  '    // 指数衰减的扩散尾',
  '    for (let i = 0; i < n; i++) d[i] += (Math.random() * 2 - 1) * 0.28 * Math.exp(-i / (ctx.sampleRate * decayMs / 1000));',
  '  }',
  '  return ir;',
  '}',
  'function roomB(ctx, out, t, soundIn) {',
  '  const conv = ctx.createConvolver();',
  '  conv.buffer = makeIR(ctx, 0.22, [[11, 0.5], [19, 0.34], [27, 0.22]], 45);',
  '  const wet = ctx.createGain(); wet.gain.value = 0.26;',
  '  const dry = ctx.createGain(); dry.gain.value = 1;',
  '  soundIn.connect(dry).connect(out);',
  '  soundIn.connect(conv).connect(wet).connect(out);',
  '}',
  '',
  'window.__render = async (which, tier) => {',
  '  const RATE = 48000;',
  '  const ctx = new OfflineAudioContext(2, RATE * 1.2, RATE);',
  '  const out = ctx.createGain(); out.gain.value = 0.35;',
  '  out.connect(ctx.destination);   // 忘了这一行:room 层整条链挂在 out 上,不接 destination 就是全程静音',
  '  let bus = out;',
  '  if (which === "A") {',
  '    // A = 当前实现:直接调用生产 Sfx',
  '    out.gain.value = 1;',
  '    const sfx = new Sfx(ctx, { volume: 0.5, destination: ctx.destination });',
  '    sfx.hit(tier, { when: 0.05, count: 0 });',
  '    const bufA = await ctx.startRendering();',
  '    return { data: bufA.getChannelData(0), rate: RATE };',
  '  }',
  '  const dry = ctx.createGain();',
  '  bus = dry;',
  '  const tiers = {',
  '    PERFECT: { base: 1760, gain: 0.34, decay: 0.30 },',
  '    GREAT:   { base: 2600, gain: 0.30, decay: 0.10 },',
  '    GOOD:    { base: 1174, gain: 0.28, decay: 0.14 },',
  '    MISS:    { base: 220,  gain: 0.30, decay: 0.20 },',
  '  };',
  '  const cfg = tiers[tier];',
  '  if (tier === "MISS") {',
  '    const osc = ctx.createOscillator(); osc.type = "sine";',
  '    osc.frequency.setValueAtTime(170, 0.05);',
  '    osc.frequency.exponentialRampToValueAtTime(62, 0.25);',
  '    const g = ctx.createGain();',
  '    g.gain.setValueAtTime(0.0001, 0.05); g.gain.linearRampToValueAtTime(cfg.gain, 0.054);',
  '    g.gain.exponentialRampToValueAtTime(0.0001, 0.27);',
  '    osc.connect(g).connect(dry); osc.start(0.05); osc.stop(0.32);',
  '  } else {',
  '    bellB(ctx, dry, 0.05, cfg);',
  '  }',
  '  roomB(ctx, out, 0.05, dry);',
  '  const buf = await ctx.startRendering();',
  '  return { data: buf.getChannelData(0), rate: RATE };',
  '};',
  '',
  'function encodeWav(d, rate, channels) {',
  '  const frames = Math.floor(d.length / channels);',
  '  const dataBytes = frames * channels * 2;',
  '  const ab = new ArrayBuffer(44 + dataBytes), dv = new DataView(ab);',
  '  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };',
  '  str(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); str(8, "WAVE");',
  '  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);',
  '  dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);',
  '  dv.setUint32(28, rate * channels * 2, true); dv.setUint16(32, channels * 2, true);',
  '  dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, dataBytes, true);',
  '  let o = 44;',
  '  for (let i = 0; i < frames * channels; i++) {',
  '    const v = Math.max(-1, Math.min(1, d[i]));',
  '    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;',
  '  }',
  '  return new Uint8Array(ab);',
  '}',
  'const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };',
  '',
  'window.__envOf = (d, rate) => {',
  '  const win = (ms) => { let p = 0; const s = Math.round(ms/1000*rate), e = Math.round((ms+10)/1000*rate);',
  '    for (let i = s; i < e && i < d.length; i++) p = Math.max(p, Math.abs(d[i])); return +p.toFixed(4); };',
  '  const rms = (a, b) => { let s = 0; const i0 = Math.round(a/1000*rate), i1 = Math.round(b/1000*rate);',
  '    for (let i = i0; i < i1 && i < d.length; i++) s += d[i]*d[i]; return +Math.sqrt(s/Math.max(1,i1-i0)).toFixed(5); };',
  '  let lp = 0, lpSum = 0, hpSum = 0; const k = 1 - Math.exp(-2*Math.PI*200/rate);',
  '  for (let i = 0; i < 0.4*rate && i < d.length; i++) { lp += (d[i]-lp)*k; lpSum += lp*lp; hpSum += (d[i]-lp)*(d[i]-lp); }',
  '  return { peak0: win(0), peak50: win(50), peak150: win(150),',
  '           rms50: rms(50,150), rms150: rms(150,400), lf: +(lpSum/Math.max(lpSum+hpSum,1e-9)).toFixed(3) };',
  '};',
  'window.__all = async () => {',
  '  const out = {};',
  '  for (const tier of ["PERFECT","GREAT","GOOD","MISS"]) {',
  '    for (const which of ["A","B"]) {',
  '      const r = await window.__render(which, tier);',
  '      out[which + "-" + tier] = { wav: b64(encodeWav(r.data, r.rate, 1)), env: window.__envOf(r.data, r.rate) };',
  '    }',
  '  }',
  '  return out;',
  '};',
  'window.__ready = 1;',
  '<\/script></body>',
].join('\n');

const app = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__ab__') { res.writeHead(200, { 'content-type': MIME['.html'] }); return res.end(HARNESS); }
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
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`http://127.0.0.1:${app.address().port}/__ab__`);
await page.waitForFunction(() => window.__ready === 1);

const all = await page.evaluate(() => window.__all());
await mkdir(outDir, { recursive: true });
console.log('档位      | 版本 | peak0   peak50  peak150 | RMS50-150  RMS150-400 | 低频占比');
console.log('----------+------+------------------------+-----------------------+---------');
for (const tier of ['PERFECT', 'GREAT', 'GOOD', 'MISS']) {
  for (const w of ['A', 'B']) {
    const { env, wav } = all[`${w}-${tier}`];
    await writeFile(path.join(outDir, `${w}-${tier.toLowerCase()}.wav`), Buffer.from(wav, 'base64'));
    console.log(
      `${tier.padEnd(9)} | ${w}    | ${String(env.peak0).padEnd(7)}${String(env.peak50).padEnd(7)}${String(env.peak150).padEnd(8)}| ${String(env.rms50).padEnd(10)}${String(env.rms150).padEnd(11)}| ${env.lf}`,
    );
  }
}
console.log(`\n已导出 ${Object.keys(all).length} 个 wav → shots/sfx-ab/`);
console.log('页面错误:', errs.length ? errs : 'none');
await browser.close();
app.closeAllConnections();
await new Promise((r) => app.close(r));
