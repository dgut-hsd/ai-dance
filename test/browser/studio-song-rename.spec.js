/**
 * studio-song-rename.spec.js — 作品工坊齿轮面板里的「歌曲名」输入框。
 *
 * 背景:songs[] 那条歌曲卡的 label 以前只在「创建」时被写死,工坊里看得到「Copy Dance 1」却改不掉;
 * 而「作品名」和「歌曲名」是两件事(作品「风萧萧雨萧萧」绑的歌叫「Copy Dance 1」)。
 * 这里用真浏览器把点名路径钉死:齿轮 → 绑定音乐/视频 → 歌曲名 → 失焦即存。
 */
import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';

let service, server, base, temp, indexFile;

test.beforeAll(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'dance-studio-rename-'));
  const songsDir = path.join(temp, 'songs');
  const draftsDir = path.join(temp, '.drafts');
  await mkdir(songsDir, { recursive: true });
  await mkdir(draftsDir, { recursive: true });
  indexFile = path.join(songsDir, 'index.json');
  await writeFile(indexFile, JSON.stringify({
    schema: 'songs/index/v1',
    dances: [
      { id: 'copydance1', label: '风萧萧雨萧萧', danceId: 'copydance1', defaultSongId: 'copydance1', musicFile: 'copyDance1_30s.wav', mode: '3d' },
    ],
    songs: [
      { id: 'copydance1', label: 'Copy Dance 1', file: 'copyDance1_30s.wav', bpm: 103.36 },
      { id: 'pop-demo', label: 'Hip Hop Beat', file: 'pop-demo.wav', bpm: 120 },
    ],
  }, null, 2));
  // 一条「已上架」作品,齿轮面板才会渲染「绑定音乐 / 视频」
  await mkdir(path.join(draftsDir, 'work1'), { recursive: true });
  await writeFile(path.join(draftsDir, 'work1', 'draft.json'), JSON.stringify({
    schema: 'drafts/v2', id: 'work1', mode: '3d', label: '风萧萧雨萧萧',
    status: 'published', external: true, danceId: 'copydance1', bpm: 103.36,
    videoName: '', songId: 'copydance1',
    files: { source: 'copydance1.fbx', audio: 'copyDance1_30s.wav', sequence: 'copydance1.json', chart: 'copydance1.chart.json', lane: null },
    publishedAt: Date.now(), trashedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
  }, null, 2));

  server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  service = await createApp({ dataDir: path.join(temp, '.jobs'), songsDir, draftsDir, storage: 'local', publicBase: base });
  server.on('request', service.app);
});

test.afterAll(async () => {
  await service?.close(); server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
});

const readSongs = async () => JSON.parse(await readFile(indexFile, 'utf8')).songs;

/** 打开齿轮 → 绑定音乐 / 视频 面板 */
async function openBindPanel(page) {
  await page.goto(`${base}/studio`);
  const card = page.locator('.work-card').first();
  await expect(card).toBeVisible();
  await card.locator('.work-gear').click();
  await page.getByRole('button', { name: /绑定音乐/ }).click();
  return page.locator('.bind-panel');
}

test('T-UI-1 面板里有「歌曲名」,初值是选中歌曲的名字', async ({ page }) => {
  const panel = await openBindPanel(page);
  await expect(panel.locator('select')).toHaveValue('copydance1');
  const songName = panel.locator('input[type="text"]').nth(1); // 0 = 作品名
  await expect(songName).toHaveValue('Copy Dance 1');
  await expect(songName).toBeEnabled();
  // 作品名是另一个字段,两者互不干扰
  await expect(panel.locator('input[type="text"]').first()).toHaveValue('风萧萧雨萧萧');
});

test('T-UI-2 选「(不绑定)」时歌曲名不可编辑(没有可改的对象)', async ({ page }) => {
  const panel = await openBindPanel(page);
  const songSel = panel.locator('select');
  const songName = panel.locator('input[type="text"]').nth(1);
  await songSel.selectOption('');
  await expect(songName).toBeDisabled();
  await expect(songName).toHaveValue('');
  await songSel.selectOption('pop-demo');
  await expect(songName).toBeEnabled();
  await expect(songName).toHaveValue('Hip Hop Beat');
});

test('T-UI-3 改歌名失焦即存,写入 songs/index.json 且不动 file/bpm', async ({ page }) => {
  const before = (await readSongs()).find((s) => s.id === 'copydance1');
  const panel = await openBindPanel(page);
  const songName = panel.locator('input[type="text"]').nth(1);
  await songName.fill('风萧萧·主题曲');
  await songName.blur();
  await expect(page.locator('#studio-toast')).toContainText('歌曲已改名');

  const after = (await readSongs()).find((s) => s.id === 'copydance1');
  expect(after.label).toBe('风萧萧·主题曲');
  expect(after.file).toBe(before.file);
  expect(after.bpm).toBe(before.bpm);

  // 刷新后仍是新名字(说明真的落盘了,不是只改了内存)
  await page.reload();
  const card = page.locator('.work-card').first();
  await expect(card.locator('.tag').first()).toContainText('风萧萧·主题曲');

  // 还原,别影响别的用例
  await writeFile(indexFile, JSON.stringify({
    ...JSON.parse(await readFile(indexFile, 'utf8')),
    songs: (await readSongs()).map((s) => s.id === 'copydance1' ? { ...s, label: 'Copy Dance 1' } : s),
  }, null, 2));
});

test('T-UI-4 「保存绑定」改作品名时不会顺手把歌曲名也改掉', async ({ page }) => {
  const panel = await openBindPanel(page);
  const workName = panel.locator('input[type="text"]').first();
  const songName = panel.locator('input[type="text"]').nth(1);
  await workName.fill('风萧萧雨萧萧(改)');
  await panel.getByRole('button', { name: /保存绑定/ }).click();
  await expect(page.locator('#studio-toast')).toContainText('已保存绑定');

  const songs = await readSongs();
  expect(songs.find((s) => s.id === 'copydance1').label).toBe('Copy Dance 1', '歌曲名保持独立');
});
