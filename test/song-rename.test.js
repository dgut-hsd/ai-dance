/**
 * test/song-rename.test.js — 歌曲改名 + 作品改名同步到歌单。
 *
 * 背景(踩过的坑):
 *   1. songs[] 那条歌曲卡的 label 只在「创建」时被写死,之后没有任何入口能改 ——
 *      工坊里看得到「Copy Dance 1」却改不掉。
 *   2. 工坊有两条改名路径,以前只有「绑定音乐/视频」会同步回 songs/index.json,
 *      「打开编辑」里的标题框只写草稿文件 → 同一个作品在工坊是新名字、在游戏里是旧名字。
 *
 * 这里把两条语义钉死:改歌名只动 label(不动 file/bpm/id);已上架作品改名必须同步到歌单。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';

const DEVICE = 'test-device';
const HEADERS = { 'X-Device-Token': DEVICE, 'Content-Type': 'application/json' };

/** 造一份临时 songs/ + .drafts/,起服务,再交一条「已上架」作品给回调。 */
async function withServer(fn) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dance-rename-'));
  let service, server;
  try {
    const songsDir = path.join(temp, 'songs');
    const draftsDir = path.join(temp, '.drafts');
    await mkdir(songsDir, { recursive: true });
    await mkdir(draftsDir, { recursive: true });
    const indexFile = path.join(songsDir, 'index.json');
    // 复刻现场:舞曲「简易舞蹈1」指向歌曲 dance1-video;另一支舞指向 copydance1
    const original = {
      schema: 'songs/index/v1',
      dances: [
        { id: 'copydance1', label: '风萧萧雨萧萧', danceId: 'copydance1', defaultSongId: 'copydance1', musicFile: 'copyDance1_30s.wav', mode: '3d' },
        { id: 'dance1-video', label: '简易舞蹈1', danceId: 'dance1-video', defaultSongId: 'dance1-video', musicFile: '舞蹈1.wav', mode: 'video' },
      ],
      songs: [
        { id: 'copydance1', label: 'Copy Dance 1', file: 'copyDance1_30s.wav', bpm: 103.36 },
        { id: 'dance1-video', label: '简易舞蹈1', file: '舞蹈1.wav', bpm: 120 },
      ],
    };
    await writeFile(indexFile, JSON.stringify(original, null, 2));
    const readIndex = async () => JSON.parse(await readFile(indexFile, 'utf8'));

    service = await createApp({ dataDir: path.join(temp, '.jobs'), songsDir, draftsDir, deviceToken: DEVICE, storage: 'local' });
    server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (url, options = {}) => fetch(base + url, options);
    const json = async (url, options = {}) => {
      const r = await req(url, options);
      const body = await r.json().catch(() => ({}));
      return { status: r.status, body };
    };

    await fn({ json, req, readIndex, indexFile, original, songsDir, draftsDir });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    await service?.close();
    await rm(temp, { recursive: true, force: true });
  }
}

test('T-RN-1 改歌名只动 label,file/bpm/id 一个不碰', async () => {
  await withServer(async ({ json, readIndex }) => {
    const before = await readIndex();
    const song = before.songs.find((s) => s.id === 'copydance1');

    const out = await json('/api/songs/copydance1', { method: 'PUT', headers: HEADERS, body: JSON.stringify({ label: '风萧萧·主题曲' }) });
    assert.equal(out.status, 200);
    assert.equal(out.body.song.label, '风萧萧·主题曲');

    const after = await readIndex();
    const updated = after.songs.find((s) => s.id === 'copydance1');
    assert.equal(updated.label, '风萧萧·主题曲');
    assert.equal(updated.file, song.file, 'file 不能被改:音频解析全靠它');
    assert.equal(updated.bpm, song.bpm, 'bpm 不能被改');
    assert.equal(updated.id, 'copydance1', 'id 不能被改:舞曲绑定靠它');
    // 舞曲条目本身不动 —— 改的是歌曲名,不是舞曲名
    assert.equal(after.dances.find((d) => d.id === 'copydance1').label, '风萧萧雨萧萧');
    assert.equal(after.dances.find((d) => d.id === 'copydance1').defaultSongId, 'copydance1');
  });
});

test('T-RN-2 空名/不存在的歌曲 → 400/404,且不落盘', async () => {
  await withServer(async ({ json, readIndex }) => {
    const before = JSON.stringify(await readIndex());

    const empty = await json('/api/songs/copydance1', { method: 'PUT', headers: HEADERS, body: JSON.stringify({ label: '   ' }) });
    assert.equal(empty.status, 400, '空名必须拒绝,否则选曲页会出现没有名字的歌曲卡');

    const missing = await json('/api/songs/nope', { method: 'PUT', headers: HEADERS, body: JSON.stringify({ label: 'x' }) });
    assert.equal(missing.status, 404);

    assert.equal(JSON.stringify(await readIndex()), before, '失败的请求不能改动歌单');
  });
});

test('T-RN-3 无设备密钥 → 401', async () => {
  await withServer(async ({ req, readIndex }) => {
    const before = JSON.stringify(await readIndex());
    const r = await req('/api/songs/copydance1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'x' }) });
    assert.equal(r.status, 401);
    assert.equal(JSON.stringify(await readIndex()), before);
  });
});

test('T-RN-4 已上架作品改名 → 同步到歌单;草稿改名 → 绝不污染歌单', async () => {
  await withServer(async ({ json, readIndex, draftsDir, songsDir }) => {
    const published = {
      schema: 'drafts/v2', id: 'pubwork', mode: 'video',
      label: '简易舞蹈1', status: 'published', external: false,
      danceId: 'dance1-video', bpm: 120, videoName: '舞蹈1.mp4', songId: 'dance1-video',
      files: { source: '舞蹈1.mp4', audio: '舞蹈1.wav', sequence: 'sequence.json', chart: 'chart.json', lane: null },
      publishedAt: Date.now(), trashedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    const draft = { ...published, id: 'draftwork', label: '还没上架的草稿', status: 'draft', danceId: 'dance1-video', publishedAt: null };
    for (const rec of [published, draft]) {
      await mkdir(path.join(draftsDir, rec.id), { recursive: true });
      await writeFile(path.join(draftsDir, rec.id, 'draft.json'), JSON.stringify(rec, null, 2));
    }

    const before = await readIndex();
    assert.equal(before.dances.find((d) => d.id === 'dance1-video').label, '简易舞蹈1');

    // ① 已上架 → 必须同步(以前这条路径只写草稿文件,游戏里还是旧名字)
    const pub = await json(`/api/drafts/${published.id}/meta`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ label: '简易舞蹈1(改过)' }) });
    assert.equal(pub.status, 200);
    assert.equal((await readIndex()).dances.find((d) => d.id === 'dance1-video').label, '简易舞蹈1(改过)',
      '已上架作品改名必须写回 songs/index.json');

    // ② 草稿 → 一个字都不能动
    const snapshot = JSON.stringify(await readIndex());
    const dft = await json(`/api/drafts/${draft.id}/meta`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ label: '草稿改名' }) });
    assert.equal(dft.status, 200);
    assert.equal(JSON.stringify(await readIndex()), snapshot, '草稿改名不能污染歌单');

    // ③ 歌曲名与作品名是两件事:改作品名不该顺手改掉歌曲名
    const after = await readIndex();
    assert.equal(after.songs.find((s) => s.id === 'dance1-video').label, '简易舞蹈1', '歌曲名保持独立');
    assert.equal(after.dances.find((d) => d.id === 'dance1-video').musicFile, '舞蹈1.wav');
  });
});

test('T-RN-5 改名的同时绑定了一首不存在的歌曲 → 改名照常生效,绑定不被清空', async () => {
  await withServer(async ({ json, readIndex, draftsDir }) => {
    // 现场复刻:dance1-video 的 defaultSongId 曾经失效过,面板下拉于是给出空值
    const rec = {
      schema: 'drafts/v2', id: 'edgework', mode: 'video',
      label: '简易舞蹈1', status: 'published', external: false,
      danceId: 'dance1-video', bpm: 120, videoName: '舞蹈1.mp4', songId: 'dance1-video',
      files: { source: '舞蹈1.mp4', audio: '舞蹈1.wav', sequence: 'sequence.json', chart: 'chart.json', lane: null },
      publishedAt: Date.now(), trashedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await mkdir(path.join(draftsDir, rec.id), { recursive: true });
    await writeFile(path.join(draftsDir, rec.id, 'draft.json'), JSON.stringify(rec, null, 2));

    const wrong = await json(`/api/works/${rec.id}`, { method: 'PUT', headers: HEADERS, body: JSON.stringify({ label: '改个名', songId: '不存在的歌' }) });
    assert.equal(wrong.status, 200, '绑定指向不存在的歌不该让整次保存失败');
    const after = await readIndex();
    assert.equal(after.dances.find((d) => d.id === 'dance1-video').label, '改个名', '改名必须照常生效');
    assert.equal(after.dances.find((d) => d.id === 'dance1-video').defaultSongId, 'dance1-video', '原有绑定不能被空值/坏值清掉');
  });
});

