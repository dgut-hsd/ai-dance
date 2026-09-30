/**
 * video-fit.spec.js — 视频模式右侧画面不再裁剪内容。
 *
 * 背景:容器以前是固定的 55vw × 100vh + object-fit: cover,比例由屏幕决定、与视频无关。
 * 1920×1080 上容器 1056×1080(≈0.98),而仓库里绝大多数训练视频是 720×1280(0.5625),
 * 于是视频被放大到 1920 宽、左右各裁掉约 41%,舞者的手脚经常在画面外。
 *
 * 现在容器宽度 = min(62vw, 100vh × 视频比例)、object-fit: contain:
 *   · 竖屏(9:16 / 3:4)→ 贴满 100vh,宽度自然收窄,零裁剪;
 *   · 横屏(4:3 的「闪身步」)→ 被 62vw 挡住 → 上下留黑。
 *
 * 用 ffmpeg 现造几支对应尺寸的小视频:比例必须同时来自"元数据"和"元素固有尺寸"两条路径,
 * 否则 <video> 的 loadedmetadata 会把桩数据校准回真实文件的比例,测试就测不到真实行为。
 */
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../../server/app.js';
import { runFFmpeg } from '../../server/media.js';

let service, server, base, data, videosDir, tmp;
/** "宽x高" → 文件名 */
const clips = {};

const CASES = [
  { key: '720x1280', w: 720, h: 1280 },   // 9:16,仓库里的主干
  { key: '832x1108', w: 832, h: 1108 },   // 3:4,videos/舞蹈1.mp4 的真实尺寸
  { key: '768x576', w: 768, h: 576 },     // 4:3,训练视频/闪身步.mp4
];

test.beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'dance-video-fit-'));
  videosDir = path.join(tmp, 'videos');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(videosDir, { recursive: true });
  for (const c of CASES) {
    const name = `v-${c.key}.mp4`;
    // 1 秒纯色即可:这里只需要容器几何,不需要播放内容
    await runFFmpeg(['-f', 'lavfi', '-i', `color=c=navy:s=${c.w}x${c.h}:r=10`, '-t', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(videosDir, name)], 60000);
    clips[c.key] = name;
  }
  server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  service = await createApp({ dataDir: path.join(tmp, '.jobs'), videosDir, storage: 'local', publicBase: base });
  server.on('request', service.app);
});

test.afterAll(async () => {
  await service?.close(); server?.closeAllConnections();
  if (server) await new Promise((r) => server.close(r));
  await rm(tmp, { recursive: true, force: true });
});

async function stubCamera(page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const stream = canvas.captureStream(5);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => stream });
  });
}

/**
 * 视频模式 + 绑定指定尺寸的那支小视频。
 * 用真实存在的舞曲 id 做绑定(dance1-video),免得还要造歌单。
 * @returns {Promise<string>} 该小视频的 URL(供 readGeom 手动触发加载)
 */
async function setup(page, key) {
  const name = clips[key];
  const c = CASES.find((x) => x.key === key);
  await page.addInitScript(() => {
    localStorage.setItem('dance-side-mode', 'video');
    sessionStorage.setItem('dance-record-highlight', '0');
  });
  await stubCamera(page);
  await page.route('**/api/videos-map', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ mapping: { 'dance1-video': name } }),
  }));
  await page.route('**/api/videos', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{
      name, url: `/videos/${name}`, poster: '', width: c.w, height: c.h,
      ratio: c.w / c.h,
      ratioClass: c.w / c.h < 0.7 ? 'portrait-9x16' : c.w / c.h < 1 ? 'portrait-3x4' : 'landscape',
      duration: 1,
    }]),
  }));
  await page.goto(base + '/web_dance/dance.html');
  await expect(page.locator('#ref-video')).toBeVisible({ timeout: 30000 });
  return base + `/videos/${encodeURIComponent(name)}`;
}

/**
 * 先确认"元数据那一路"已经把比例写进 DOM,再用项目自己的 VideoSource 真正加载一次视频,
 * 让 <video> 的 loadedmetadata 走一遍(那条路径会用固有尺寸重新校准),最后读几何。
 *
 * 之所以要手动加载:选曲态只有轮播到某张卡才会去 load 视频,等它太慢也太脆。
 * 这里用的是页面自己的 __danceVideo.source,不额外开测试专用的后门。
 */
async function readGeom(page, videoUrl) {
  // ① 元数据路径:改 src 之前就该把比例摆好(避免首帧先铺满再收窄的跳动)
  await expect.poll(() => page.evaluate(() => document.getElementById('ref-video')?.dataset.ratio || null), {
    timeout: 15000, message: '元数据比例应已写入容器',
  }).not.toBeNull();

  // ② 元素路径:真加载一次,等固有尺寸就位
  await page.evaluate(async (url) => {
    await window.__danceVideo.source.load(url);
    await window.__danceVideo.source.play().catch(() => {});
  }, videoUrl);
  await expect.poll(() => page.evaluate(() => document.getElementById('ref-video')?.videoWidth || 0), {
    timeout: 15000, message: '视频元数据应加载完成',
  }).toBeGreaterThan(0);

  return page.evaluate(() => {
    const el = document.getElementById('ref-video');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // 右缘留白:直接量出来(--ref-inset-right 是 2vw,getPropertyValue 只给原始字符串)
    const inset = innerWidth - r.right;
    // contain 下视频真正画出来的矩形:用它证明"内容没被裁",而不是只看元素尺寸
    let content = null;
    if (el.videoWidth && el.videoHeight) {
      const k = Math.min(r.width / el.videoWidth, r.height / el.videoHeight);
      const cw = el.videoWidth * k, ch = el.videoHeight * k;
      // object-position: right <inset> center → 内容贴元素右缘,再往左推一个 inset
      content = { w: cw, h: ch, ratio: cw / ch, right: r.right - inset };
    }
    return {
      boxW: r.width, boxH: r.height, boxLeft: r.left, boxRight: r.right,
      vpW: innerWidth,
      insetPx: inset,
      vw: el.videoWidth, vh: el.videoHeight,
      content,
      objectFit: cs.objectFit,
      ratio: el.dataset.ratio || null,
      ratioClass: el.dataset.ratioClass || null,
    };
  });
}

/**
 * 核心断言:画出来的视频必须与源比例一致 —— 比例一致就意味着没有被裁
 * (cover 会裁剪,于是内容比例 !== 源比例;contain 不会)。
 */
function expectNoCrop(g) {
  expect(g.content, '视频应有固有尺寸').not.toBeNull();
  expect(g.content.ratio, '画出来的内容比例必须等于源比例(否则就是被裁了)')
    .toBeCloseTo(g.vw / g.vh, 3);
  // 内容不得超出元素(超出就是被裁)
  expect(g.content.w).toBeLessThanOrEqual(g.boxW + 1);
  expect(g.content.h).toBeLessThanOrEqual(g.boxH + 1);
}

/**
 * 右缘位置按比例档分:
 *   9:16  → 往左收一点(--ref-right: 7.3vw,1920 下右缘落在 1780);
 *   3:4 / 横屏 → 贴边(right: 0)。
 */
function expectRightMargin(g) {
  const inset = g.insetPx;
  expect(g.boxRight, '元素右缘应落在离窗口边一个留白的位置').toBeCloseTo(g.vpW - inset, 0);
  if (g.ratioClass === 'portrait-9x16') {
    expect(inset, '9:16 应往左收一点').toBeGreaterThan(8);
    expect(g.vpW - g.content.right, '9:16 画面右缘离窗口边的余量').toBeGreaterThan(8);
  } else {
    expect(inset, `${g.ratioClass} 应贴边`).toBeLessThan(1.5);
  }
}

test('T-FIT-1 9:16 竖屏:贴满 100vh、宽度 = 100vh×比例,右缘往左收', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const url = await setup(page, '720x1280');
  const g = await readGeom(page, url);

  expect(g.objectFit).toBe('contain');
  expect(g.ratio).toBe('0.5625');
  expect(g.ratioClass).toBe('portrait-9x16');
  expect(g.boxH).toBeCloseTo(1080, 0);
  expect(g.boxW).toBeCloseTo(607.5, 0);            // 100vh × 0.5625(62vw=1190 更大,这个分支配)
  // 画面右缘落在 1780:离窗口右缘 140px → 7.3vw
  expect(g.vpW - g.boxRight).toBeCloseTo(1920 * 0.073, 0);
  expectNoCrop(g);
  expectRightMargin(g);
});

test('T-FIT-2 3:4 竖屏(videos/舞蹈1.mp4 的真实比例 832×1108)— 贴边', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const url = await setup(page, '832x1108');
  const g = await readGeom(page, url);

  expect(g.ratioClass).toBe('portrait-3x4');
  expect(g.boxH).toBeCloseTo(1080, 0);
  expect(g.boxW).toBeCloseTo(1080 * (832 / 1108), 0); // ≈ 811
  expect(g.boxW).toBeLessThan(1920 * 0.62);           // 没被 62vw 卡住
  expectNoCrop(g);
  expectRightMargin(g);                               // 这一档应贴边
});

test('T-FIT-3 4:3 横屏(闪身步 768×576)— 贴边 + 上下留黑,不裁内容', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const url = await setup(page, '768x576');
  const g = await readGeom(page, url);

  expect(g.objectFit).toBe('contain');
  expect(g.ratioClass).toBe('landscape');
  // 横屏的上限:62vw,以及「不压到左侧摄像头小窗 + 右缘留白」——取更严的那个。
  const camRight = await page.evaluate(() => {
    const el = document.querySelector('#cam-panel');
    return el ? el.getBoundingClientRect().right : 0;
  });
  const expected = Math.min(1920 * 0.62, 1920 - camRight - 12 - 0);
  expect(g.boxW).toBeCloseTo(expected, 0);
  expect(g.boxH).toBeCloseTo(1080, 0);
  // 容器比视频"更窄长" → contain 只在上下留黑,视频完整可见(改前这里是左右被裁)
  expect(g.boxW / g.boxH).toBeLessThan(g.vw / g.vh);
  // 不允许压到摄像头小窗(改前 62vw 会重叠 67px)
  if (camRight) expect(g.boxLeft).toBeGreaterThanOrEqual(camRight - 1);
  expectNoCrop(g);
  expectRightMargin(g);                               // 横屏贴边
});

test('T-FIT-4 不绑定视频时不留残留比例,且不回到 cover', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    localStorage.setItem('dance-side-mode', 'video');
    sessionStorage.setItem('dance-record-highlight', '0');
  });
  await stubCamera(page);
  await page.route('**/api/videos-map', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ mapping: { 'dance1-video': '' } }),
  }));
  await page.route('**/api/videos', (route) => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto(base + '/web_dance/dance.html');
  // 没有已绑定视频的舞曲 → 明确的提示(而不是黑屏),且元素仍是 contain
  await expect(page.locator('#status')).toContainText('没有已绑定视频的舞曲', { timeout: 30000 });
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('ref-video')).objectFit)).toBe('contain');
});
