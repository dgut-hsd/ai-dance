import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createSongStore } from '../server/songstore.js';

const FIXTURE = JSON.parse(await readFile(new URL('../songs/demo-arena-loop/demo-arena-loop.json', import.meta.url), 'utf8'));

test('songstore: create→upload→complete 落盘 songs/ 并更新 index.json(替换而非重复)', async () => {
  const songsDir = await mkdtemp(path.join(os.tmpdir(), 'songstore-'));
  const store = createSongStore({ songsDir });
  try {
    // 预置一个 index.json,与目标含同 id(验证替换语义)
    await writeFile(path.join(songsDir, 'index.json'), JSON.stringify({
      schema: 'songs/index/v1',
      dances: [{ id: 'mydance', label: '旧', danceId: 'mydance', defaultSongId: 'x', chartFile: 'x', musicFile: 'x', fbxFile: null }],
      songs: [{ id: 'mydance', label: '旧', file: 'x.wav', bpm: 90 }],
    }));

    const create = await store.create({ danceId: 'MyDance', label: 'My Dance', bpm: 120, fbxName: 'Salsa Dancing.fbx', audioName: 'beat.wav' });
    assert.equal(create.danceId, 'mydance');
    assert.ok(create.ownerToken.length > 8);
    await assert.rejects(() => store.create({ danceId: 'mydance', bpm: 120, audioName: 'a.wav' }), (e) => e.status === 409);

    await store.putFile('mydance', 'fbx', create.ownerToken, Readable.from(Buffer.from('FBXBIN')));
    await store.putFile('mydance', 'audio', create.ownerToken, Readable.from(Buffer.from('WAVBIN')));
    await assert.rejects(() => store.putFile('mydance', 'fbx', 'wrong-token', Readable.from(Buffer.from('x'))), (e) => e.status === 403);

    const seq = { ...FIXTURE, danceId: 'mydance', chart: { ...FIXTURE.chart, audio: 'beat.wav' } };
    await store.putSequence('mydance', create.ownerToken, JSON.stringify(seq));
    await assert.rejects(() => store.putSequence('mydance', create.ownerToken, 'not json'), (e) => e.status === 400);

    const done = await store.complete('mydance', create.ownerToken);
    assert.equal(done.danceId, 'mydance');

    const seqFile = JSON.parse(await readFile(path.join(songsDir, 'mydance', 'mydance.json'), 'utf8'));
    assert.equal(seqFile.chart.audio, 'beat.wav');
    assert.equal(seqFile.chart.notes.length, FIXTURE.chart.notes.length);
    const standalone = JSON.parse(await readFile(path.join(songsDir, 'mydance', 'mydance.chart.json'), 'utf8'));
    assert.equal(standalone.schema, 'chart/v1');
    assert.equal(standalone.sequenceFile, 'mydance.json');
    assert.equal(await readFile(path.join(songsDir, 'mydance', 'Salsa Dancing.fbx'), 'utf8'), 'FBXBIN');
    assert.equal(await readFile(path.join(songsDir, 'mydance', 'beat.wav'), 'utf8'), 'WAVBIN');

    const index = JSON.parse(await readFile(path.join(songsDir, 'index.json'), 'utf8'));
    assert.equal(index.dances.filter((d) => d.id === 'mydance').length, 1);
    assert.equal(index.songs.filter((s) => s.id === 'mydance').length, 1);
    assert.equal(index.dances[0].label, 'My Dance');
    assert.equal(index.dances[0].musicFile, 'beat.wav');
    assert.equal(index.dances[0].fbxFile, 'Salsa Dancing.fbx');
    assert.equal(index.songs[0].bpm, 120);

    // 覆盖重存 → 条目仍为 1(替换)
    const again = await store.create({ danceId: 'mydance', label: 'My Dance 2', bpm: 130, audioName: 'beat.wav', overwrite: true });
    await store.putSequence('mydance', again.ownerToken, JSON.stringify(seq));
    await store.complete('mydance', again.ownerToken);
    const index2 = JSON.parse(await readFile(path.join(songsDir, 'index.json'), 'utf8'));
    assert.equal(index2.dances.filter((d) => d.id === 'mydance').length, 1);
    assert.equal(index2.dances[0].label, 'My Dance 2');
    assert.equal(index2.songs[0].bpm, 130);
  } finally {
    await rm(songsDir, { recursive: true, force: true });
  }
});

test('songstore: 非法 danceId / 文件名被拒绝', async () => {
  const songsDir = await mkdtemp(path.join(os.tmpdir(), 'songstore-bad-'));
  const store = createSongStore({ songsDir });
  try {
    await assert.rejects(() => store.create({ danceId: 'a/b', bpm: 120, audioName: 'a.wav' }), (e) => e.status === 400);
    await assert.rejects(() => store.create({ danceId: 'ok', bpm: 120, audioName: '../../etc/passwd' }), (e) => e.status === 400);
    await assert.rejects(() => store.create({ danceId: 'ok', bpm: 2000, audioName: 'a.wav' }), (e) => e.status === 400);
    await assert.rejects(() => store.create({ danceId: 'ok2', bpm: 120, fbxName: 'evil.txt', audioName: 'a.wav' }), (e) => e.status === 400);
    const ok = await store.create({ danceId: 'ok', bpm: 120, audioName: 'a.wav' });
    await assert.rejects(() => store.complete('ok', 'nope'), (e) => e.status === 403);
    void ok;
  } finally {
    await rm(songsDir, { recursive: true, force: true });
  }
});