/**
 * recording.spec.js — 高光录制的画面产出回归测试。
 *
 * 为什么单独一个文件:录制画布的性能优化(脱离文档 + 主动推帧)有一条危险的失败模式 ——
 * 整段录像是空的。原来的 highlights.spec.js 依赖一个仓库里不存在的
 * web_dance/audio/pop-demo.wav,harness 页面根本起不来,等于没有覆盖。
 *
 * 这里不依赖任何音频素材,只关心"编码器到底有没有收到画面":
 *   1) 录制 3 秒后 blob 必须达到合理体积(空录像只有几百字节的容器头);
 *   2) blob 必须真的能解码播放,且分辨率是 1080×1920。
 */
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';

let service, server, base, data;
test.beforeAll(async () => {
  data = await mkdtemp(path.join(tmpdir(), 'dance-recording-'));
  server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  service = await createApp({ dataDir: data, storage: 'local', publicBase: base });
  server.on('request', service.app);
});
test.afterAll(async () => {
  await service?.close(); server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(data, { recursive: true, force: true });
});

test('录制画布真的产出可播放画面(不依赖音频素材)', async ({ page }) => {
  page.on('console', (m) => { if (m.type() === 'warning') console.log('[page.warn]', m.text()); });
  await page.goto(base + '/web_dance/highlights.js').catch(() => {});
  await page.goto(base + '/web_dance/dance.html');

  const result = await page.evaluate(async () => {
    const { HighlightController } = await import('/web_dance/highlights.js');
    // 舞台/摄像头用两块持续变化的画布顶替;不接音频引擎(createRecordingTap 会返回空流)
    const makeCanvas = (w, h, hueBase) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      let i = 0;
      setInterval(() => { i++; ctx.fillStyle = `hsl(${(hueBase + i * 4) % 360} 70% 45%)`; ctx.fillRect(0, 0, w, h); }, 33);
      return c;
    };
    const stage = makeCanvas(1280, 720, 0);
    const camera = makeCanvas(640, 480, 180);
    const fx = makeCanvas(1080, 1920, 300);
    fx.getContext('2d').clearRect(0, 0, 1080, 1920);   // 空特效层:走 fxIsIdle 跳过合成的路径

    const engine = { createRecordingTap: () => ({ stream: new MediaStream(), disconnect: () => {} }) };
    const controller = new HighlightController({
      stage, camera, fx, getState: () => ({ score: 1, combo: 1, acc: 1, conf: 1, tier: 'PERFECT' }),
      stageShift: () => 0,
      fxIsIdle: () => true,
    });
    // 不经过后端:直接造一个 job,复用 prepare 的画布/编码器路径
    controller.recordEnabled = true;
    controller.restored = Promise.resolve();
    const job = { id: 'local-test', ownerToken: 't', status: 'uploading', expiresAt: Date.now() + 3600e3 };
    controller.jobs.set(job.id, job);
    const savedApi = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/api/highlights') && options?.method === 'POST') {
        return new Response(JSON.stringify(job), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    let active;
    try {
      active = await controller.prepare(engine);
    } finally {
      globalThis.fetch = savedApi;
    }
    if (!active) return { error: 'prepare 未创建录制(浏览器不支持 MediaRecorder?)' };

    const detachedAtStart = active.detached;
    const attachedAtStart = active.canvas.isConnected;

    controller.start();
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      controller.draw();
      await new Promise((r) => setTimeout(r, 33));
    }
    const bytesDuring = active.bytes;
    const firstChunkDelayMs = active.firstChunkAt ? Math.round(active.firstChunkAt - t0) : null;

    // 收尾:停录制拿 blob(不走 finish,避免触发上传)
    const chunks = await new Promise((resolve) => {
      active.recorder.onstop = () => resolve(active.chunks);
      active.recorder.stop();
    });
    controller.release(active);
    const blob = new Blob(chunks, { type: active.recorder.mimeType });

    // 验证能解码播放
    const url = URL.createObjectURL(blob);
    const probe = document.createElement('video');
    probe.muted = true; probe.src = url;
    const playback = await new Promise((resolve) => {
      const done = (v) => resolve(v);
      probe.onloadeddata = () => done({ ok: true, w: probe.videoWidth, h: probe.videoHeight });
      probe.onerror = () => done({ ok: false, code: probe.error?.code });
      setTimeout(() => done({ ok: false, code: 'timeout' }), 8000);
    });
    URL.revokeObjectURL(url);
    return {
      bytes: blob.size, bytesDuring, firstChunkDelayMs,
      detachedAtStart, attachedAtStart,
      stillDetached: active.detached,
      mime: active.recorder.mimeType,
      playback,
    };
  });

  console.log('[录制产出]', JSON.stringify(result, null, 2));
  expect(result.error, result.error || '').toBeUndefined();
  // 3 秒 1080×1920 的画面不可能只有几百字节(空录像 = 容器头 + 无帧)
  expect(result.bytes, 'blob 必须有真实画面数据').toBeGreaterThan(20000);
  // 只做"病态"下限:实测首发分片在 ~1.8–2.2 秒之间波动,不能当成健康判据
  expect(result.firstChunkDelayMs, '第一片数据必须真的到达').toBeLessThan(4000);
  expect(result.playback.ok, `录像必须能解码播放(错误码 ${result.playback.code}）`).toBe(true);
  expect([result.playback.w, result.playback.h]).toEqual([1080, 1920]);
});

test('看门狗只在"推帧确实失败"时才把画布挂回文档', async ({ page }) => {
  await page.goto(base + '/web_dance/dance.html');

  const cases = await page.evaluate(async () => {
    const { HighlightController } = await import('/web_dance/highlights.js');
    const make = () => new HighlightController({
      stage: document.createElement('canvas'), camera: document.createElement('canvas'),
      fx: document.createElement('canvas'), getState: () => ({}), fxIsIdle: () => true,
    });
    const fresh = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 108; canvas.height = 192;
      return { canvas, a: { canvas, detached: true, started: performance.now() - 5000, firstChunkAt: null, pushWorked: false } };
    };
    const out = {};
    // 1) 有失败证据 + 无数据 → 必须挂回文档
    {
      const { canvas, a } = fresh();
      make().ensureRecordingOutput(a, { pushFailed: true });
      out.pushFailedNoData = { detached: a.detached, inDocument: canvas.isConnected };
      canvas.remove();
    }
    // 2) 没有失败证据 → 不能动它(首次分片晚到不等于失败)
    {
      const { canvas, a } = fresh();
      make().ensureRecordingOutput(a);
      out.noEvidence = { detached: a.detached, inDocument: canvas.isConnected };
      canvas.remove();
    }
    // 3) 已经有数据产出 → 不能把它从快路径踢下来
    {
      const { canvas, a } = fresh();
      a.firstChunkAt = performance.now() - 1000;
      make().ensureRecordingOutput(a, { pushFailed: true });
      out.healthy = { detached: a.detached, inDocument: canvas.isConnected };
      canvas.remove();
    }
    // 4) 才开始不到 1.2 秒 → 再等等,别急着回退
    {
      const { canvas, a } = fresh();
      a.started = performance.now() - 300;
      make().ensureRecordingOutput(a, { pushFailed: true });
      out.tooEarly = { detached: a.detached, inDocument: canvas.isConnected };
      canvas.remove();
    }
    return out;
  });

  console.log('[看门狗判据]', JSON.stringify(cases, null, 2));
  expect(cases.pushFailedNoData).toEqual({ detached: false, inDocument: true });
  expect(cases.noEvidence).toEqual({ detached: true, inDocument: false });
  expect(cases.healthy).toEqual({ detached: true, inDocument: false });
  expect(cases.tooEarly).toEqual({ detached: true, inDocument: false });
});
