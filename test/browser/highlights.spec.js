import { test, expect } from '@playwright/test';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';

let service, server, base, data;
test.beforeAll(async () => {
  data = await mkdtemp(path.join(tmpdir(), 'dance-browser-'));
  server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  service = await createApp({ dataDir: data, storage: 'local', publicBase: base });
  server.on('request', service.app);
});
test.afterAll(async () => {
  await service?.close(); server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(data, { recursive: true, force: true });
});

async function harness(page) {
  // Run the production controller with deterministic moving canvases and real audio.
  // No camera or microphone is used; the browser still produces real MediaRecorder chunks.
  await page.route('**/browser-harness', route => route.fulfill({ contentType: 'text/html', body: `
    <canvas id="stage" width="1280" height="720"></canvas>
    <canvas id="camera" width="640" height="480"></canvas>
    <canvas id="fx" width="1280" height="720"></canvas>
    <input id="consent" type="checkbox" checked><input id="token">
    <p id="highlight-message"></p><div id="jobs"></div>
    <script type="module">
      import { HighlightController } from '/web_dance/highlights.js';
      import { AudioEngine } from '/web_dance/audio.js';
      const stage = document.querySelector('#stage'), camera = document.querySelector('#camera');
      const ctx = stage.getContext('2d'), cam = camera.getContext('2d');
      window.engine = new AudioEngine(); await engine.load('/web_dance/audio/pop-demo.wav');
      window.controller = new HighlightController({ stage, camera, fx: document.querySelector('#fx'),
        consent: document.querySelector('#consent'), deviceInput: document.querySelector('#token'), panel: document.querySelector('#jobs'),
        getState: () => ({score:1234, combo:12, acc:.95, conf:1, tier:'PERFECT'}) });
      // setInterval (not rAF) keeps the canvas repainting deterministically even when
      // headless Chrome throttles requestAnimationFrame, which would otherwise starve
      // captureStream and make MediaRecorder emit empty chunks.
      let frame = 0;
      function draw() {
        frame++;
        ctx.fillStyle = '#252080'; ctx.fillRect(0,0,1280,720);
        ctx.fillStyle = '#52ffd0'; ctx.fillRect(820 + Math.sin(frame/10)*80,200,100,330);
        cam.fillStyle = '#de7135'; cam.fillRect(0,0,640,480);
        cam.fillStyle = '#ffffff'; cam.fillRect(200+Math.sin(frame/7)*60,80,90,310);
        controller.draw();
      }
      setInterval(draw, 33); window.harnessReady = true;
    </script>` }));
  await page.goto(base + '/browser-harness');
  await page.waitForFunction(() => window.harnessReady);
}
async function start(page) {
  await page.locator('#token').click(); // A user gesture unlocks browser audio.
  return page.evaluate(async () => {
    await controller.prepare(engine); await engine.play(0); controller.start();
    return controller.active.job.id;
  });
}
async function finish(page) {
  await page.evaluate(async () => {
    await controller.finish({grade:'A',score:1234,maxCombo:12}); engine.stop();
  });
}

test('real browser recording becomes playable MP4 with score card and download', async ({ page }, testInfo) => {
  await harness(page); const id = await start(page);
  await page.waitForTimeout(8000);
  console.log(await page.evaluate(() => ({ bytes:controller.active?.bytes, samples:controller.active?.samples.length,
    audio:engine.ctx.state, visibility:document.visibilityState,
    tracks:controller.active?.stream.getTracks().map(t => ({kind:t.kind, muted:t.muted, state:t.readyState})),
    state:controller.active?.recorder.state })));
  await finish(page);
  // 上传已改为后台异步执行;等待服务器完成选段+转码即可(不再断言同步清空 blob)。
  await expect.poll(() => service.jobs.get(id)?.status, { timeout: 90000 }).toBe('ready');
  await page.goto(base + '/v/' + id);
  await expect(page.locator('#view-status')).toHaveText('你的高光已就绪');
  await expect(page.locator('#view-result')).toContainText('1234');
  await expect.poll(() => page.locator('video').evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
  const media = await page.locator('video').evaluate(async v => {
    v.muted = true; await v.play();
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  });
  expect(media.width).toBe(1080); expect(media.height).toBe(1920);
  expect(media.duration).toBeGreaterThan(6); expect(media.duration).toBeLessThan(12);
  const download = await page.request.get(base + `/api/highlights/${id}/media?download=1`);
  expect(download.headers()['content-disposition']).toContain('attachment');
  await copyFile(path.join(data, id, 'highlight.mp4'), testInfo.outputPath('highlight-demo.mp4'));
  await page.screenshot({ path: testInfo.outputPath('claim-page.png'), fullPage: true });
});

test('failed upload survives reload and another round, then retries independently', async ({ page }) => {
  await harness(page); const first = await start(page);
  await page.waitForTimeout(8000);
  await page.route('**/api/highlights/*/source', route => route.abort('internetdisconnected'));
  await finish(page);
  expect(await page.evaluate(id => !!controller.jobs.get(id).blob, first)).toBe(true);
  await page.reload(); await page.waitForFunction(() => window.harnessReady);
  await page.evaluate(() => controller.restored);
  expect(await page.evaluate(id => !!controller.jobs.get(id).blob, first)).toBe(true);
  await page.unroute('**/api/highlights/*/source');
  const second = await start(page); expect(second).not.toBe(first);
  await page.evaluate(id => controller.upload(controller.jobs.get(id)), first);
  expect(await page.evaluate(() => controller.active.recorder.state)).toBe('recording');
  await page.waitForTimeout(8000); await finish(page);
  await expect.poll(() => [first, second].map(id => service.jobs.get(id)?.status).join(','), { timeout: 90000 }).toBe('ready,ready');
});

test('missing backend silently skips recording instead of throwing', async ({ page }) => {
  await page.route('**/api/highlights', route => route.fulfill({status:404, body:'Not found'}));
  await harness(page);
  // prepare() 后台不可用时应静默返回 null,不抛错,玩家照常跳舞。
  expect(await page.evaluate(async () => {
    try { return await controller.prepare(engine) === null; } catch (e) { return false; }
  })).toBe(true);
});
