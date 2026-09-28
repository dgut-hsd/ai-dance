import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { selectHighlight, validateMetadata } from '../server/highlight.js';
import { createApp } from '../server/app.js';
import { runFFmpeg } from '../server/media.js';
import { AudioEngine } from '../web_dance/audio.js';

test('highlight: prefers visible continuous quality over missing-person high scores', () => {
  const samples = Array.from({ length: 70 }, (_, t) => ({ t, conf: t < 30 ? 0 : 1,
    acc: t < 30 || t >= 40 ? 1 : .1, combo: 50, tier: 'PERFECT' }));
  assert.equal(selectHighlight(samples, 70, 30).start, 40);
  assert.deepEqual(selectHighlight([], 5, 30), { start: 0, duration: 5 });
  assert.throws(() => validateMetadata({ duration: 601, samples: [] }));
  assert.throws(() => validateMetadata({ duration: 30, samples: [{ t: 2, acc: 1, conf: NaN, combo: 0 }] }));
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
      body: JSON.stringify({ duration: 3, samples: [], result: { score: 1234, maxCombo: 12, grade: 'A' } }) });
    assert.equal((await complete()).status, 200);
    let info;
    for (let i = 0; i < 150; i++) {
      info = await (await request(url)).json(); if (['ready', 'failed'].includes(info.status)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(info.status, 'ready', info.error); assert.equal(info.duration, 5);
    assert.equal((await complete()).status, 200, 'completion is idempotent');
    const video = await request(url + '/media', { headers: { Range: 'bytes=0-127' } });
    assert.equal(video.status, 206); assert.equal((await video.arrayBuffer()).byteLength, 128);
    assert.match((await request(url + '/media?download=1')).headers.get('content-disposition'), /attachment/);
    assert.equal((await request(`/api/highlights/${other.id}`)).status, 200);
    const output = await readFile(path.join(temp, '.jobs', job.id, 'highlight.mp4'));
    assert.ok(output.indexOf(Buffer.from('moov')) < output.indexOf(Buffer.from('mdat')), 'faststart metadata precedes video');
    // Decode the complete output, including audio and score card, to detect broken output streams.
    await runFFmpeg(['-i', path.join(temp, '.jobs', job.id, 'highlight.mp4'), '-f', 'null', '-']);
    await stop(); base = await start();
    assert.equal((await (await request(url)).json()).status, 'ready');
    assert.equal((await request(url, { method: 'DELETE', headers })).status, 200);
    assert.ok([404, 410].includes((await request(url + '/media')).status));
    service.jobs.get(other.id).expiresAt = Date.now() - 1;
    assert.equal((await request(`/api/highlights/${other.id}`)).status, 410);
    await service.cleanup();
  } finally { await stop(); await rm(temp, { recursive: true, force: true }); }
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
