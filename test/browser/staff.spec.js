import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';

// 交付页要的是「扫完直接下载」:一张卡给 SHORT / LONG 两张码,由顾客自己选。
// 完整纪念版在高光成片之后再转一条(现场要等几十秒),这段时间不能给出一个扫了才发现没文件的码,
// 也不能让工作人员关掉弹窗再重开 —— 就绪后二维码要自己出现。
function cardPng() {
  // validPng 只认魔数和 IHDR 里的 1080×1920,不必真解码。
  const buffer = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1080, 16); buffer.writeUInt32BE(1920, 20);
  return buffer;
}

test('交付弹窗给两张直下码,完整版转完自动补上', async ({ page }, testInfo) => {
  const data = await mkdtemp(path.join(tmpdir(), 'dance-staff-'));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let releaseFull, fullStarted;
  const gate = new Promise(resolve => { releaseFull = resolve; });
  const longIsTranscoding = new Promise(resolve => { fullStarted = resolve; });
  // 转码换成注入实现:这个用例只验交付界面,不烧几分钟真编码。
  const service = await createApp({ dataDir: data, storage: 'local', publicBase: base, deviceToken: 'test-device',
    makeVideo: async (input, output) => { await writeFile(output, 'short bytes'); },
    makeFullVideo: async (input, output) => { fullStarted(); await gate; await writeFile(output, 'long bytes'); },
    // 取片台会拉缩略图;注入实现免得对假 mp4 起 ffmpeg(日志噪音)。
    extractThumb: async (src, destination) => { await writeFile(destination, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); } });
  server.on('request', service.app);
  try {
    const job = await (await fetch(`${base}/api/highlights`, { method: 'POST',
      headers: { 'X-Device-Token': 'test-device', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mime: 'video/webm' }) })).json();
    const owner = { 'X-Owner-Token': job.ownerToken };
    await fetch(`${base}/api/highlights/${job.id}/source`, { method: 'PUT', headers: owner, body: 'source bytes' });
    await fetch(`${base}/api/highlights/${job.id}/card`, { method: 'PUT',
      headers: { ...owner, 'Content-Type': 'image/png' }, body: cardPng() });
    await fetch(`${base}/api/highlights/${job.id}/complete`, { method: 'POST',
      headers: { ...owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 3, samples: [], highlights: [],
        result: { score: 1234, maxCombo: 12, grade: 'A' } }) });
    await longIsTranscoding;

    await page.addInitScript(() => localStorage.setItem('dance-device-token', 'test-device'));
    await page.goto(base + '/staff');
    await page.getByRole('button', { name: '领取码' }).click();

    // 高光版已就绪 → SHORT 码可用;完整版还在转 → 只显示「生成中」,不发无效码。
    await expect(page.locator('#short-qr')).toHaveAttribute('src', `/api/highlights/${job.id}/qr-short`);
    await expect(page.locator('#long-qr')).toBeHidden();
    await expect(page.locator('#long-waiting')).toContainText('生成中');
    await page.screenshot({ path: testInfo.outputPath('long-generating.png') });

    // 放开长版转码:后台 4 秒轮询应当自己把码补上,工作人员不必关掉重开。
    releaseFull();
    await expect(page.locator('#long-qr')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#long-qr')).toHaveAttribute('src', `/api/highlights/${job.id}/qr-long`);
    await expect(page.locator('#long-waiting')).toBeHidden();

    // 两张码都要真的渲染出图案(空白 src 也算「显示了二维码」,所以查 naturalWidth)。
    for (const selector of ['#short-qr', '#long-qr'])
      expect(await page.locator(selector).evaluate(img => img.naturalWidth)).toBeGreaterThan(0);

    // 码旁边的一键直链同样直下文件,而不是跳页面。
    await expect(page.locator('#short-link')).toHaveAttribute('href', `/api/highlights/${job.id}/media?download=1`);
    await expect(page.locator('#long-link')).toHaveAttribute('href', `/api/highlights/${job.id}/full-media?download=1`);
    await page.screenshot({ path: testInfo.outputPath('two-codes.png') });
  } finally {
    releaseFull?.(); await service.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(data, { recursive: true, force: true });
  }
});
