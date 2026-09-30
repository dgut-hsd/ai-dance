/**
 * video-mode.spec.js — 视频模式的真机可测部分:首屏性能 + 参考视频健康度。
 *
 * 覆盖两类现场问题:
 *   1. 「视频突然播不了了」:开局后视频必须真的在播;人为把它按停(模拟最恶劣的中途打断),
 *      看门狗要在 ~1 秒内把它救回来,并且留下可读的失败原因。
 *   2. 「LCP 3.77s / INP 240ms」:把 Web Vitals 量出来,超过阈值直接失败。
 *
 * 摄像头/MediaPipe 用路由桩挡掉:现场故障与性能瓶颈都在页面自身的调度上,
 * 不依赖真实摄像头也能稳定复现与度量(并让测试在 CI 上跑得动)。
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
  data = await mkdtemp(path.join(tmpdir(), 'dance-video-mode-'));
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

/** 摄像头桩:返回一个永远不产生坐标的流(测试不依赖真实摄像头与手势识别) */
async function stubCamera(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const stream = canvas.captureStream(5);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => stream,
    });
  });
}

/** 视频模式:与 /settings 页选择「右侧画面 = 视频」等价 */
async function useVideoMode(page) {
  await page.addInitScript(() => {
    localStorage.setItem('dance-side-mode', 'video');
    sessionStorage.setItem('dance-record-highlight', '0'); // 不涉录制,聚焦播放链路
  });
}

/** 装 Web Vitals 探针:必须在页面脚本之前注入 */
async function installVitals(page) {
  await page.addInitScript(() => {
    window.__vitals = { lcp: null, cls: 0, longTasks: [], lcpElement: '', interactions: [] };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__vitals.lcp = entry.startTime;
        window.__vitals.lcpElement = entry.element
          ? `${entry.element.tagName?.toLowerCase()}${entry.element.id ? '#' + entry.element.id : ''}`
          : (entry.url || '');
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        window.__vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__vitals.longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__vitals.interactions.push({ name: entry.name, dur: Math.round(entry.duration) });
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  });
}

/** 打开游戏页并等选曲 UI 出现 */
async function openSelect(page) {
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#song-pick')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#song-pick-title')).toBeVisible();
}

test('视频模式选曲首屏:LCP 与长任务在预算内,视频已预热', async ({ page }) => {
  await useVideoMode(page);
  await installVitals(page);
  await stubCamera(page);

  const t0 = Date.now();
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#song-pick')).toBeVisible({ timeout: 30000 });
  const selectUiMs = Date.now() - t0;
  const firstPaintAt = await page.evaluate(() => performance.now());
  await page.waitForTimeout(2500); // 让 LCP 定稿、长任务都记下来

  const vitals = await page.evaluate(async (uiAt) => {
    // 交互延迟:真实点一次抽屉箭头,量"点击→下一帧"的耗时
    const arrow = document.querySelector('#song-pick-next');
    const before = performance.now();
    arrow.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const clickToPaint = performance.now() - before;
    return {
      ...window.__vitals,
      clickToPaint: Math.round(clickToPaint),
      // 选曲 UI 出来之后的长任务才是"玩家能感觉到卡"的那些
      interactiveLongTasks: window.__vitals.longTasks.filter((t) => t.start >= uiAt),
    };
  }, firstPaintAt);

  const worstLongTask = vitals.longTasks.reduce((m, t) => Math.max(m, t.dur), 0);
  const worstInteractive = vitals.interactiveLongTasks.reduce((m, t) => Math.max(m, t.dur), 0);
  console.log('[视频模式选曲首屏]', JSON.stringify({
    selectUiMs, lcp: Math.round(vitals.lcp), lcpElement: vitals.lcpElement,
    cls: Number(vitals.cls.toFixed(4)), worstLongTask, worstInteractive,
    clickToPaint: vitals.clickToPaint, longTaskCount: vitals.longTasks.length,
    longTasks: vitals.longTasks,
  }, null, 2));

  expect(vitals.lcp, 'LCP 应远低于 3.77s 这个现场值').toBeLessThan(2500);
  expect(vitals.cls, 'CLS 应保持在良好区间').toBeLessThan(0.1);
  expect(worstInteractive, '选曲 UI 出来后的最长任务应低于 200ms(否则就是点不动的原因)').toBeLessThan(200);
  expect(vitals.clickToPaint, '点击到画面更新应低于 200ms').toBeLessThan(200);

  // 参考视频应在选曲阶段就开始缓冲(preload=auto),而不是等到开局才下载
  const video = await page.evaluate(() => {
    const el = document.getElementById('ref-video');
    return { preload: el.preload, src: el.currentSrc || el.src, networkState: el.networkState, readyState: el.readyState };
  });
  expect(video.preload).toBe('auto');
  expect(video.src).toBeTruthy();
  console.log('[参考视频预热]', JSON.stringify(video));
});

test('开局后视频确实在播;被按停时看门狗自动救回并给出原因', async ({ page }) => {
  await useVideoMode(page);
  await stubCamera(page);
  await openSelect(page);

  // 开始按钮在抽屉里,先按现场的操作顺序打开抽屉
  await page.locator('#song-pick-open').click();
  await expect(page.locator('#song-pick-drawer')).toBeVisible();
  await page.locator('#song-pick-start').click();
  // 倒计时 3.2s + 音频准备,给足时间
  await expect.poll(async () => page.evaluate(() => {
    const el = document.getElementById('ref-video');
    return { paused: el.paused, readyState: el.readyState, t: el.currentTime };
  }), { timeout: 30000, message: '开局后参考视频应进入播放' }).toMatchObject({ paused: false });

  const playing = await page.evaluate(() => {
    const el = document.getElementById('ref-video');
    return { paused: el.paused, currentTime: el.currentTime, readyState: el.readyState, duration: el.duration };
  });
  expect(playing.readyState).toBeGreaterThanOrEqual(2);
  expect(playing.duration).toBeGreaterThan(1);
  console.log('[开局播放中]', JSON.stringify(playing));

  // 现场故障模拟:外部因素把视频按停(切标签页回来、解码器被抢占、切歌竞态都会长这样)
  await page.evaluate(() => document.getElementById('ref-video').pause());
  expect(await page.evaluate(() => document.getElementById('ref-video').paused)).toBe(true);

  // 看门狗应在 ~1 秒内补一次 play,并且留下可读日志
  await expect.poll(async () => page.evaluate(() => document.getElementById('ref-video').paused), {
    timeout: 8000, message: '看门狗应把被按停的视频救回来',
  }).toBe(false);

  const report = await page.evaluate(() => window.__danceVideo.export());
  const parsed = JSON.parse(report);
  console.log('[视频自检]', JSON.stringify({ health: parsed.health, errors: parsed.errors }, null, 2));
  expect(parsed.health.ok).toBe(true);
  // 诊断链路本身要能工作:日志里必须有 play/pause 事件记录
  expect(parsed.log.some((l) => l.text.startsWith('playing') || l.text.startsWith('play()'))).toBe(true);
  expect(parsed.log.some((l) => l.text.startsWith('pause'))).toBe(true);
});

test('收起选曲抽屉后,参考视频继续循环播(回到吸引态)', async ({ page }) => {
  await useVideoMode(page);
  await stubCamera(page);
  await openSelect(page);

  // ① 首屏(吸引态)本来就在循环播
  await expect.poll(() => page.evaluate(() => {
    const el = document.getElementById('ref-video');
    return { src: el.currentSrc || el.src, paused: el.paused, t: el.currentTime };
  }), { timeout: 30000, message: '进选曲页后参考视频应在吸引态播放' })
    .toMatchObject({ paused: false });

  // ② 打开抽屉 → 预览(从头播)
  await page.locator('#song-pick-open').click();
  await expect(page.locator('#song-pick-drawer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getElementById('ref-video').paused), {
    timeout: 20000, message: '打开抽屉应触发参考视频试看',
  }).toBe(false);
  const srcWhileOpen = await page.evaluate(() => document.getElementById('ref-video').currentSrc);

  // ③ 关掉抽屉 → 必须继续循环播,而不是停住
  //    这是现场问题:关抽屉走的是"停预览"这条路(只 pause + 清掉回退定时器),
  //    而看门狗只管本局、不管选曲态,于是画面停在原地再也不动。
  await page.locator('#song-pick-close').click();
  await expect(page.locator('#song-pick')).not.toHaveClass(/picker-open/);

  const resumedFrom = await page.evaluate(() => document.getElementById('ref-video').currentTime);
  await expect.poll(() => page.evaluate(() => {
    const el = document.getElementById('ref-video');
    return { paused: el.paused, readyState: el.readyState };
  }), { timeout: 10000, message: '收起抽屉后参考视频应仍在播放' })
    .toMatchObject({ paused: false });

  // 「继续播」而不是「重新播」:关抽屉不该把画面拽回 0(那和点卡片预览是两回事)
  const after = await page.evaluate(() => {
    const el = document.getElementById('ref-video');
    return { src: el.currentSrc, t: el.currentTime, loop: el.loop };
  });
  expect(after.src).toBe(srcWhileOpen);
  expect(after.loop, '吸引态的参考视频必须循环').toBe(true);
  expect(after.t, '关抽屉应续播,不能跳回片头').toBeGreaterThan(resumedFrom - 0.5);

  // ④ 再等过 5 秒回退定时器那一刻,仍然稳在播(回退定时器跳的就是同一条吸引态路径)
  await page.waitForTimeout(5200);
  expect(await page.evaluate(() => document.getElementById('ref-video').paused)).toBe(false);
});

test('抽屉里换过卡片再收起:右侧切到刚选的那支舞并继续播', async ({ page }) => {
  await useVideoMode(page);
  await stubCamera(page);
  await openSelect(page);

  const videoName = () => page.evaluate(() => {
    const el = document.getElementById('ref-video');
    const src = el.currentSrc || el.src || '';
    return src ? decodeURIComponent(src).split('/').pop() : '';
  });
  await expect.poll(videoName, { timeout: 30000, message: '首屏应已载入某支舞的参考视频' }).not.toBe('');
  const first = await videoName();

  await page.locator('#song-pick-open').click();
  await expect(page.locator('#song-pick-drawer')).toBeVisible();
  // 点下一支舞的卡片(不用箭头:箭头在抽屉动画期间会点不动)
  const cardCount = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#song-pick-strip .song-card')];
    cards[1]?.click();
    return cards.length;
  });
  test.skip(cardCount < 2, '歌单里只有一支绑了视频的舞曲,测不了换卡');
  const selectedLabel = await page.evaluate(() => document.getElementById('song-pick-current')?.textContent?.trim() || '');
  await expect.poll(videoName, { timeout: 20000, message: '点卡片应把右侧切到那张卡的视频' }).not.toBe(first);

  await page.locator('#song-pick-close').click();
  await expect(page.locator('#song-pick')).not.toHaveClass(/picker-open/);

  // 收起抽屉后:右侧是「刚选中那张卡」的视频(不是跳回第一支),而且要继续播
  await expect.poll(() => page.evaluate(() => document.getElementById('ref-video').paused), {
    timeout: 10000, message: '换卡后收起抽屉,视频仍应继续播',
  }).toBe(false);
  const after = await page.evaluate(() => {
    const el = document.getElementById('ref-video');
    return { name: decodeURIComponent(el.currentSrc || '').split('/').pop(), paused: el.paused, t: el.currentTime };
  });
  console.log('[收起抽屉后]', JSON.stringify({ first, selectedLabel, after }));
  expect(after.name).not.toBe(first);
  expect(after.paused).toBe(false);
});

test('未绑定视频的舞曲给出可读提示,而不是静默黑屏', async ({ page }) => {
  // 只留一支没绑视频的舞:选曲列表会为空,应该给出明确提示
  await page.route('**/api/videos-map', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ mapping: { hiphop: '', salsa: '', 'demo-arena-loop': '' } }),
  }));
  await useVideoMode(page);
  await stubCamera(page);
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#status')).toContainText('没有已绑定视频的舞曲', { timeout: 30000 });
  await expect(page.locator('#status')).toContainText('后台');
  // 空列表时开始按钮必须禁用,避免工作人员点了没反应又找不到原因
  await expect(page.locator('#song-pick-start')).toBeDisabled();
});

test('视频模式摄像头预览开关:隐藏的是显示层,识别输入照常', async ({ page }) => {
  await useVideoMode(page);
  await stubCamera(page);

  // 默认显示
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#song-pick')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#cam-panel')).toBeVisible();
  expect(await page.evaluate(() => document.body.classList.contains('hide-cam-panel'))).toBe(false);

  // 后台设置页关掉
  await page.goto(base + '/settings');
  await expect(page.locator('#video-side-preview')).toBeChecked();
  await page.locator('#video-side-preview').uncheck();
  expect(await page.evaluate(() => localStorage.getItem('dance-video-side-camera'))).toBe('0');

  // 回到游戏页:面板不显示,但摄像头仍在解码(识别管线不能受影响)
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#song-pick')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#cam-panel')).toBeHidden();
  const state = await page.evaluate(() => ({
    visibility: getComputedStyle(document.getElementById('cam-panel')).visibility,
    // visibility:hidden 只是不绘制;元素仍在布局里,摄像头仍在跑
    camHasStream: !!document.getElementById('cam').srcObject,
  }));
  expect(state.visibility).toBe('hidden');
  await expect.poll(() => page.evaluate(() => !!document.getElementById('cam').srcObject), {
    timeout: 40000, message: '隐藏预览不能影响摄像头启动(识别输入)',
  }).toBe(true);

  // 设置页再打开:游戏页不刷新也应立刻跟上
  await page.evaluate(() => {
    localStorage.setItem('dance-video-side-camera', '1');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dance-video-side-camera', newValue: '1' }));
  });
  await expect(page.locator('#cam-panel')).toBeVisible();
});

test('火柴人骨架开关:默认显示,设为 0 后画布真正隐藏,识别管线照常启动', async ({ page }) => {
  await useVideoMode(page);
  await stubCamera(page);

  // --- 默认(未设置)= 显示 ---
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#song-pick')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#cam-stick')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('dance-camera-stick'))).toBeNull();

  // --- 后台设置页关掉开关 ---
  await page.goto(base + '/settings');
  await expect(page.locator('#camera-stick')).toBeChecked();
  await page.locator('#camera-stick').uncheck();
  expect(await page.evaluate(() => localStorage.getItem('dance-camera-stick'))).toBe('0');
  await expect(page.locator('#camera-status')).toContainText('已关闭火柴人骨架');

  // --- 回到游戏页:画布必须真的不渲染(不是只改了属性) ---
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#song-pick')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#cam-stick')).toBeHidden();
  const hidden = await page.evaluate(() => {
    const canvas = document.getElementById('cam-stick');
    return { hidden: canvas.hidden, display: getComputedStyle(canvas).display };
  });
  expect(hidden).toEqual({ hidden: true, display: 'none' });

  // 关掉骨架不影响摄像头/识别管线:预热后 stream 必须照常起来
  await expect.poll(() => page.evaluate(() => Boolean(window.__danceVideo)), { timeout: 10000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const status = document.getElementById('status').textContent || '';
    return /摄像头已开启|识别|播放中|选一支舞|模型就绪/.test(status);
  }), { timeout: 40000, message: '关掉骨架后摄像头仍应正常启动' }).toBe(true);

  // --- 设置页再打开:游戏页不刷新也应立刻跟上(storage 事件) ---
  await page.evaluate(() => {
    localStorage.setItem('dance-camera-stick', '1');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dance-camera-stick', newValue: '1' }));
  });
  await expect(page.locator('#cam-stick')).toBeVisible();
});




