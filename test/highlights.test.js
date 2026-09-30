import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { buildHighlightStory, selectHighlight, validateMetadata } from '../server/highlight.js';
import { createApp } from '../server/app.js';
import { runFFmpeg, thumbTimestamp, ffmpegPath, makeVideo } from '../server/media.js';
import { AudioEngine } from '../web_dance/audio.js';

/** 用 ffmpeg 读一个视频的编码尺寸:[宽, 高] */
async function probeSize(file) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // ffmpeg 没有 ffprobe 子命令,但 -i 的输出里有 "1080x1920";用 -f null 解码到 stderr 即可
  const { stderr } = await run(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-'], { maxBuffer: 8 << 20 })
    .catch((e) => ({ stderr: e.stderr || '' }));
  const m = /Video:.*?\s(\d{2,5})x(\d{2,5})[\s,]/.exec(stderr);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

test('highlight: prefers visible continuous quality over missing-person high scores', () => {
  const samples = Array.from({ length: 70 }, (_, t) => ({ t, conf: t < 30 ? 0 : 1,
    acc: t < 30 || t >= 40 ? 1 : .1, combo: 50, tier: 'PERFECT' }));
  assert.equal(selectHighlight(samples, 70, 30).start, 40);
  assert.deepEqual(selectHighlight([], 5, 30), { start: 0, duration: 5 });
  assert.throws(() => validateMetadata({ duration: 601, samples: [] }));
  assert.throws(() => validateMetadata({ duration: 30, samples: [{ t: 2, acc: 1, conf: NaN, combo: 0 }] }));
});

test('phase 2: validates three marked moments and builds a chronological short-video story', () => {
  const metadata = validateMetadata({
    duration: 24,
    samples: [],
    highlightTitle: '精准舞者',
    highlights: [
      { start: 18.8, peak: 20, end: 21.8, tier: 'PERFECT', combo: 21, accuracy: .96 },
      { start: 4.8, peak: 6, end: 7.8, tier: 'GREAT', combo: 7, accuracy: .86 },
      { start: 11.8, peak: 13, end: 14.8, tier: 'PERFECT', combo: 15, accuracy: .93 },
    ],
    result: { score: 8888, maxCombo: 21, grade: 'S' },
  });
  assert.equal(metadata.highlights.length, 3);
  assert.equal(metadata.highlightTitle, '精准舞者');
  const story = buildHighlightStory(metadata);
  assert.deepEqual(story.segments.map(s => s.peak), [6, 13, 20]);
  assert.equal(story.segments.length, 3);
  assert.ok(story.segments.every(s => s.end - s.start === 5));
  assert.equal(story.duration, 15);
  assert.equal(story.transitionDuration, .12);
});

test('phase 2: old or low-score jobs still receive three five-second moments', () => {
  const metadata = validateMetadata({ duration: 5, samples: [], result: {} });
  const story = buildHighlightStory(metadata);
  assert.equal(story.segments.length, 3);
  assert.ok(story.segments.every(segment => segment.fallback));
  assert.equal(story.duration, 15);
});

test('music recording branches receive new sources and disconnect without muting speakers', async () => {
  const sources = [], track = { stop() { this.stopped = true; } };
  const destination = {}, ctx = { state: 'running', currentTime: 0, destination,
    createMediaStreamDestination: () => ({ stream: { getTracks: () => [track] } }),
    decodeAudioData: async () => ({ duration: 5 }),
    createBufferSource: () => {
      const source = { connections: [], connect(node) { this.connections.push(node); },
        disconnect(node) { this.connections = this.connections.filter(x => x !== node); }, start() {}, stop() {} };
      sources.push(source); return source;
    },
  };
  const engine = new AudioEngine({ audioContext: ctx });
  await engine.load(new ArrayBuffer(1));
  const tap = engine.createRecordingTap();
  await engine.play(0); assert.equal(sources[0].connections.length, 2);
  engine.stop(); await engine.play(0); assert.equal(sources[1].connections.length, 2);
  tap.disconnect(); assert.deepEqual(sources[1].connections, [destination]); assert.ok(track.stopped);
});

test('录制端 720×1280 的录像会被转码成 1080×1920 成片', { timeout: 120000 }, async () => {
  // 录制画布已从 1080×1920 降到 720×1280(= 设计空间;摄像头 720p、参考视频 832×1108,
  // 再大没有信息量,只是文件更大)。成片尺寸不能跟着变小 —— 由这里的 ffmpeg 放大。
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dance-720p-'));
  try {
    const source = path.join(temp, 'rec.webm');
    const card = path.join(temp, 'card.png');
    const intro = path.join(temp, 'intro.mp4');
    const out = path.join(temp, 'short.mp4');
    // 720×1280 的真实录像(带音轨,和浏览器录出来的形状一致)
    await runFFmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '4', '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', source]);
    await runFFmpeg(['-f', 'lavfi', '-i', 'color=c=navy:s=1080x1920', '-frames:v', '1', card]);
    await runFFmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=1080x1920:rate=60',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', intro]);
    await makeVideo(source, out, path.join(temp, 'poster.jpg'), card,
      { segments: [{ start: .5, end: 2.5 }] }, intro, path.join(temp, 'thumb.jpg'));
    assert.deepEqual(await probeSize(out), [1080, 1920], '成片必须放大回 1080×1920');
    // 能完整解码(音视频都对)才算过
    await runFFmpeg(['-i', out, '-f', 'null', '-']);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('API and real video: upload, transcode, QR, ranges, restart, expiry and isolation', { timeout: 120000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dance-highlights-'));
  let service, server;
  const start = async () => {
    // Dot-prefixed data dir mirrors the production default (.highlight-data); the
    // media/poster sendFile must allow that segment or it 404s as a hidden file.
    service = await createApp({ dataDir: path.join(temp, '.jobs'), deviceToken: 'test-device', storage: 'local' });
    server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await service?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  try {
    await runFFmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '3', '-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus', path.join(temp, 'source.webm')]);
    await runFFmpeg(['-f', 'lavfi', '-i', 'color=c=navy:s=1080x1920', '-frames:v', '1', path.join(temp, 'card.png')]);
    let base = await start();
    const request = (url, options = {}) => fetch(base + url, options);
    const create = () => request('/api/highlights', { method: 'POST', headers: { 'X-Device-Token': 'test-device', 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: 'video/webm' }) });
    assert.equal((await request('/api/highlights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await request('/api/highlights', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const job = await (await create()).json(), other = await (await create()).json();
    assert.notEqual(job.id, other.id);
    const url = `/api/highlights/${job.id}`, headers = { 'X-Owner-Token': job.ownerToken };
    assert.equal((await request(url + '/upload-url', { method: 'POST', headers: { 'X-Owner-Token': other.ownerToken } })).status, 403);
    const publicJob = await (await request(url)).json(); assert.equal(publicJob.ownerToken, undefined);
    assert.equal((await request(url + '/media')).status, 409);
    assert.equal((await request('/.env')).status, 404);
    assert.equal((await request('/server/app.js')).status, 404);
    const qr = await (await request(url + '/qr')).text(); assert.match(qr, /<svg/);
    assert.equal((await request(`/v/${job.id}`)).status, 200);
    assert.equal((await request(url + '/source', { method: 'PUT', headers, body: await readFile(path.join(temp, 'source.webm')) })).status, 200);
    assert.equal((await request(url + '/card', { method: 'PUT', headers, body: await readFile(path.join(temp, 'card.png')) })).status, 200);
    const complete = () => request(url + '/complete', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 3, samples: [], highlightTitle: '全场焦点', highlights: [
        { start: 0, peak: .4, end: 1, tier: 'GREAT', combo: 4, accuracy: .84 },
        { start: 1, peak: 1.4, end: 2, tier: 'PERFECT', combo: 8, accuracy: .94 },
        { start: 2, peak: 2.4, end: 3, tier: 'PERFECT', combo: 12, accuracy: .97 },
      ], result: { score: 1234, maxCombo: 12, grade: 'A' } }) });
    assert.equal((await complete()).status, 200);
    let info;
    for (let i = 0; i < 400; i++) {
      info = await (await request(url)).json();
      if (info.status === 'failed' || (info.status === 'ready' && info.fullStatus === 'ready')) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(info.status, 'ready', info.error); assert.equal(info.duration, 14.6);
    assert.equal(info.highlightCount, 3); assert.equal(info.highlightTitle, '全场焦点');
    assert.equal(info.fullStatus, 'ready');
    assert.equal(info.fullDuration, 8.6);
    const shortQr = await (await request(url + '/qr-short')).text();
    const longQr = await (await request(url + '/qr-long')).text();
    assert.match(shortQr, /<svg/); assert.match(longQr, /<svg/);
    assert.notEqual(shortQr, longQr, 'short 与 long 必须是两个不同的直下二维码');
    assert.equal((await complete()).status, 200, 'completion is idempotent');
    const video = await request(url + '/media', { headers: { Range: 'bytes=0-127' } });
    assert.equal(video.status, 206); assert.equal((await video.arrayBuffer()).byteLength, 128);
    assert.match((await request(url + '/media?download=1')).headers.get('content-disposition'), /attachment/);
    assert.equal((await request(`/api/highlights/${other.id}`)).status, 200);
    const output = await readFile(path.join(temp, '.jobs', job.id, 'short.mp4'));
    assert.ok(output.indexOf(Buffer.from('moov')) < output.indexOf(Buffer.from('mdat')), 'faststart metadata precedes video');
    // 成片必须始终是 1080×1920 —— 录制端已降到 720×1280(与设计空间一致),
    // 靠这里的 ffmpeg scale=1080:1920 放大;下面的 720p 专项用例盯住这一点。
    assert.deepEqual(await probeSize(path.join(temp, '.jobs', job.id, 'short.mp4')), [1080, 1920], 'short.mp4 必须是 1080×1920');
    // 缩略图由转码本身产出(不是靠按需补图),取片台靠它认人。
    const thumbFile = await readFile(path.join(temp, '.jobs', job.id, 'thumb.jpg'));
    assert.ok(thumbFile.byteLength > 1000, 'transcode emits a thumbnail');
    const thumb = await request(url + '/thumb');
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...Buffer.from(await thumb.arrayBuffer()).subarray(0, 3)], [0xff, 0xd8, 0xff], 'thumbnail is a JPEG');
    assert.equal((await request(url + '/thumb')).status, 200, 'thumbnail is served repeatedly');
    // Decode the complete output, including audio and score card, to detect broken output streams.
    await runFFmpeg(['-i', path.join(temp, '.jobs', job.id, 'short.mp4'), '-f', 'null', '-']);
    const full = await request(url + '/full-media', { headers: { Range: 'bytes=0-127' } });
    assert.equal(full.status, 206); assert.equal((await full.arrayBuffer()).byteLength, 128);
    await runFFmpeg(['-i', path.join(temp, '.jobs', job.id, 'long.mp4'), '-f', 'null', '-']);
    await stop(); base = await start();
    assert.equal((await (await request(url)).json()).status, 'ready');
    assert.equal((await request(url, { method: 'DELETE', headers })).status, 200);
    assert.ok([404, 410].includes((await request(url + '/media')).status));
    service.jobs.get(other.id).expiresAt = Date.now() - 1;
    assert.equal((await request(`/api/highlights/${other.id}`)).status, 410);
    await service.cleanup();
  } finally { await stop(); await rm(temp, { recursive: true, force: true }); }
});

test('thumbnail frame comes from the first highlight, never from the intro card', () => {
  // 片头前几秒是品牌动画(实测 poster.jpg 就抽到过动画角色),抽到它等于没有缩略图。
  // 缩略图必须落在正片里,取第一段高光的中点。
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);
  near(thumbTimestamp({ introDuration: 3.6, duration: 15, segments: [{ start: 4, peak: 6.5, end: 9 }] }), 6.1);
  // 老任务没有 segments,只有整段时长 → 退回片头之后 2 秒
  near(thumbTimestamp({ introDuration: 3.6, duration: 5 }), 5.6);
  // 连 clip 都没有
  near(thumbTimestamp({}), 2);
  // 夹在正片范围内,不能越过正片末尾取到成绩卡
  near(thumbTimestamp({ introDuration: 3.6, duration: 1, segments: [{ start: 0, peak: 2.5, end: 5 }] }), 4.5);
  near(thumbTimestamp({ duration: 1 }), 0.9);
});

test('thumbnail backfill is serialized so it cannot starve the transcode worker', async () => {
  // 取片台打开会同时请求所有卡片的缩略图,历史任务要在这些请求里现场抽帧。
  // 若并发执行,9 条老任务会在一瞬间拉起 9 个 ffmpeg,和正在给顾客转码的 worker 抢 CPU。
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dance-thumb-'));
  const { mkdir } = await import('node:fs/promises');
  const id = 'b'.repeat(32), dir = path.join(temp, id);
  await mkdir(dir);
  await writeFile(path.join(dir, 'job.json'), JSON.stringify({ id, ownerToken: 'owner', status: 'ready',
    mime: 'video/webm', createdAt: Date.now(), expiresAt: Date.now() + 100000, clip: {} }));
  await writeFile(path.join(dir, 'highlight.mp4'), 'source bytes');
  let active = 0, peak = 0, calls = 0;
  const service = await createApp({ dataDir: temp, storage: 'local', deviceToken: 'test-device',
    extractThumb: async (src, dst) => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 30));
      await writeFile(dst, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      active--;
    } });
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const responses = await Promise.all([1, 2, 3, 4].map(() => fetch(`${base}/api/highlights/${id}/thumb`)));
    assert.deepEqual(responses.map(r => r.status), [200, 200, 200, 200]);
    assert.equal(peak, 1, '抽帧必须串行');
    assert.equal(calls, 1, '同一张图只抽一次');
  } finally { await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(temp, { recursive: true, force: true }); }
});

test('abandoned uploads never consume the transcode limit', async () => {
  // A tab that is closed mid-round leaves a job in `uploading` for its whole 7-day life.
  // Those jobs hold no transcode capacity, so they must not push new rounds into a 429.
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dance-throttle-'));
  const { mkdir } = await import('node:fs/promises');
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    const id = String(i).padStart(32, '0'), dir = path.join(temp, id);
    await mkdir(dir);
    await writeFile(path.join(dir, 'job.json'), JSON.stringify({ id, ownerToken: `owner-${i}`,
      status: 'uploading', mime: 'video/webm', createdAt: now, expiresAt: now + 604800000 }));
  }
  const service = await createApp({ dataDir: temp, storage: 'local', deviceToken: 'test-device' });
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const create = () => fetch(`http://127.0.0.1:${server.address().port}/api/highlights`, {
    method: 'POST', headers: { 'X-Device-Token': 'test-device', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mime: 'video/webm' }) });
  try {
    assert.equal(service.jobs.size, 25, 'abandoned jobs are restored from disk');
    assert.equal((await create()).status, 201, 'a new round still starts');
    for (const job of service.jobs.values()) job.status = 'queued';
    assert.equal((await create()).status, 429, 'the real transcode backlog is still bounded');
  } finally { await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(temp, { recursive: true, force: true }); }
});

test('long QR is withheld while the full video is still transcoding, and both codes download directly', { timeout: 30000 }, async () => {
  // 取片台的两张码是「扫完就下载」:short = 传播高光,long = 完整纪念版,落盘名就是这两个后缀。
  // 完整版在高光成片之后再转一条,现场要等几十秒;这段时间绝不能给出一个扫了才发现没文件的码。
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dance-long-qr-'));
  const id = 'c'.repeat(32), jobDir = path.join(temp, id);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(jobDir);
  await writeFile(path.join(jobDir, 'job.json'), JSON.stringify({ id, ownerToken: 'owner', status: 'queued',
    mime: 'video/webm', createdAt: Date.now(), expiresAt: Date.now() + 100000,
    metadata: { duration: 3, samples: [], highlights: [], result: { score: 1, maxCombo: 1, grade: 'A' } } }));
  await writeFile(path.join(jobDir, 'source'), 'source bytes');
  let releaseFull, fullStarted;
  const gate = new Promise(resolve => { releaseFull = resolve; });
  const fullIsTranscoding = new Promise(resolve => { fullStarted = resolve; });
  const artifacts = [];
  const service = await createApp({ dataDir: temp, storage: 'local', deviceToken: 'test-device',
    makeVideo: async (input, output) => { artifacts.push(path.basename(output)); await writeFile(output, 'short bytes'); },
    makeFullVideo: async (input, output) => { artifacts.push(path.basename(output)); fullStarted(); await gate; await writeFile(output, 'long bytes'); } });
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/highlights/${id}`;
  try {
    await fullIsTranscoding;
    assert.equal(service.jobs.get(id).status, 'ready');
    assert.equal(service.jobs.get(id).fullStatus, 'processing');
    assert.deepEqual(artifacts, ['short.mp4', 'long.mp4'], '两个产物就是 short / long 两个后缀');
    assert.equal((await fetch(`${url}/qr-short`)).status, 200, '高光码先可发');
    assert.equal((await fetch(`${url}/qr-long`)).status, 409, '完整版没就绪就不发码');
    releaseFull();
    for (let i = 0; i < 200 && service.jobs.get(id).fullStatus !== 'ready'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(service.jobs.get(id).fullStatus, 'ready');
    const shortQr = await (await fetch(`${url}/qr-short`)).text();
    const longQr = await (await fetch(`${url}/qr-long`)).text();
    assert.match(shortQr, /<svg/); assert.match(longQr, /<svg/);
    assert.notEqual(shortQr, longQr, '两个码必须指向不同的产物');
    // 码背后就是文件本身(attachment),不再绕回领取页让顾客自己再点一次。
    for (const [route, filename] of [['media', 'dance-short.mp4'], ['full-media', 'dance-long.mp4']]) {
      const response = await fetch(`${url}/${route}?download=1`);
      assert.equal(response.status, 200, `${route} 直下可用`);
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="${filename}"`);
    }
  } finally {
    releaseFull?.(); await service.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true });
  }
});

test('worker failure can retry, and processing state recovers after restart', { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dance-recovery-'));
  const id = 'a'.repeat(32), jobDir = path.join(temp, id);
  const { mkdir } = await import('node:fs/promises'); await mkdir(jobDir);
  await writeFile(path.join(jobDir, 'job.json'), JSON.stringify({ id, ownerToken: 'owner', status: 'processing',
    createdAt: Date.now(), expiresAt: Date.now() + 100000, metadata: { duration: 3, samples: [], result: {} } }));
  let attempts = 0;
  const service = await createApp({ dataDir: temp, storage: 'local', makeVideo: async () => { if (++attempts === 1) throw new Error('injected failure'); } });
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    for (let i = 0; i < 50 && service.jobs.get(id).status !== 'failed'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(service.jobs.get(id).status, 'failed');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/highlights/${id}/retry`, { method: 'POST', headers: { 'X-Owner-Token': 'owner' } });
    assert.equal(response.status, 200);
    for (let i = 0; i < 50 && service.jobs.get(id).status !== 'ready'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(service.jobs.get(id).status, 'ready'); assert.equal(attempts, 2);
  } finally { await service.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(temp, { recursive: true, force: true }); }
});
