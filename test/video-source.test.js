/**
 * video-source.test.js — 参考视频加载时序/诊断的单测。
 *
 * 用替身 <video> 精确复现三种现场故障:
 *   1. 改 src 之后立刻 pause → 加载被 abort;
 *   2. play() 返回的 Promise 被拒(AbortError / NotSupportedError);
 *   3. 未 ready 就写 currentTime → pending seek,画面停住。
 * 这里断言的是"不会再出现这些状态",而不只是"函数被调用了"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VideoSource, videoHealth, mediaErrorText, describeError, videoErrorSummary,
} from '../web_dance/video-source.js';

/** 替身 <video>:只实现 VideoSource 用到的那部分接口 */
class FakeVideo {
  constructor({ metadataDelayMs = 0, playError = null, readyState = 0, failLoad = false, duration = 30, seeks = 0 } = {}) {
    this.listeners = new Map();
    this.paused = true;
    this.ended = false;
    this.muted = false;
    this.loop = false;
    this.playsInline = false;
    this.preload = '';
    this.attributes = {};
    this.error = null;
    this.duration = duration;
    this.readyState = readyState;
    this.networkState = 1;
    this.loads = 0;
    this.seeks = 0;
    this.plays = 0;
    this.pauses = 0;
    this.removedSrc = 0;
    this._metadataDelayMs = metadataDelayMs;
    this._playError = playError;
    this._failLoad = failLoad;
    this._src = '';
    this._time = 0;
    this._timers = [];
    this.seeks = seeks;
  }

  get currentTime() { return this._time; }
  set currentTime(value) { this._time = value; this.seeks++; }

  get src() { return this._src; }
  // 真实浏览器里 currentSrc 是"最终选中并开始加载的那个地址"
  get currentSrc() { return this._src; }
  set src(value) {
    this._src = value;
    // 真实浏览器:改 src 会让元素回到 HAVE_NOTHING
    this.readyState = 0;
    this.error = null;
  }

  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'src') { this._src = ''; this.readyState = 0; this.removedSrc++; }
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type });
  }

  load() {
    this.loads++;
    const run = () => {
      if (this._failLoad) {
        this.error = { code: 4, message: 'demuxer: could not open' };
        this.readyState = 0;
        this.emit('error');
        return;
      }
      this.readyState = 1;
      this.emit('loadedmetadata');
    };
    if (this._metadataDelayMs > 0) this._timers.push(setTimeout(run, this._metadataDelayMs));
    else run();
  }

  play() {
    this.plays++;
    if (this._playError) return Promise.reject(this._playError);
    this.paused = false;
    this.readyState = Math.max(this.readyState, 3);
    this.emit('playing');
    return Promise.resolve();
  }

  pause() { this.pauses++; this.paused = true; this.emit('pause'); }
}

const silent = { log: () => {}, warn: () => {} };
const makeSource = (video, options = {}) => new VideoSource(video, { ...silent, ...options });
// VideoSource 在 Node 里没有 location,回退基址就是 http://localhost/
const ABS_A = 'http://localhost/videos/a.mp4';
const ABS_B = 'http://localhost/videos/b.mp4';

/**
 * 造一个"src 已设好、元数据已到"的替身。
 * 必须先赋 src 再恢复 readyState —— 真实浏览器的 src 赋值会把元素打回 HAVE_NOTHING,
 * 替身照抄这个语义,免得测出一个线上不存在的状态。
 */
function readyVideo({ src = ABS_A, readyState = 3, paused = true, ...options } = {}) {
  const video = new FakeVideo({ readyState: 0, ...options });
  video.src = src;
  video.readyState = readyState;
  video.paused = paused;
  return video;
}

test('videoHealth 把各种状态说成人话', () => {
  assert.equal(videoHealth(null).ok, false);
  const noSrc = new FakeVideo();
  assert.match(videoHealth(noSrc).reason, /还没设置 src/);
  const broken = new FakeVideo({ failLoad: true });
  broken.error = { code: 3, message: '' };
  assert.match(videoHealth(broken).reason, /解码失败/);
  const pending = readyVideo({ readyState: 0 });
  assert.match(videoHealth(pending).reason, /元数据都没到/);
  const idle = readyVideo({ readyState: 3, paused: true });
  assert.match(videoHealth(idle).reason, /暂停态/);
  const playing = readyVideo({ readyState: 3, paused: false });
  assert.deepEqual([videoHealth(playing).ok, videoHealth(playing).reason], [true, '播放中']);
});

test('错误码与异常都转成可读文本', () => {
  assert.match(mediaErrorText(1), /MEDIA_ERR_ABORTED/);
  assert.match(mediaErrorText(99), /MEDIA_ERR_99/);
  const abort = new Error('The play() request was interrupted');
  abort.name = 'AbortError';
  assert.equal(describeError(abort), 'AbortError: The play() request was interrupted');
});

test('同一地址只加载一次:重复 preview 不再打断正在播的视频', async () => {
  const video = new FakeVideo({ metadataDelayMs: 5 });
  const source = makeSource(video);
  await source.load('/videos/a.mp4');
  await source.load('/videos/a.mp4');
  assert.equal(video.loads, 1, '第二次 setRefVideo 不该再触发 load()');
  assert.equal(source.loadedUrl, ABS_A);
});

test('改地址会重新加载,并且并发 load 复用同一个 promise', async () => {
  const video = new FakeVideo({ metadataDelayMs: 5 });
  const source = makeSource(video);
  const [a, b] = await Promise.all([source.load('/videos/a.mp4'), source.load('/videos/a.mp4')]);
  assert.equal(a, b);
  assert.equal(video.loads, 1);
  await source.load('/videos/b.mp4');
  assert.equal(video.loads, 2);
  assert.equal(video.src, ABS_B);
});

test('play():等元数据就绪再播,不再"改完 src 立刻 play"', async () => {
  const video = new FakeVideo({ metadataDelayMs: 5 });
  const source = makeSource(video);
  // 现场动作顺序:切源(异步开始加载)→ 立刻 play。这里必须先切源,才能测到那个竞态。
  source.load('/videos/a.mp4');
  assert.equal(video.readyState, 0, '刚改完 src 还是 HAVE_NOTHING');
  const result = await source.play({ restart: true });
  assert.deepEqual(result, { ok: true });
  assert.equal(video.paused, false);
  assert.equal(video.muted, true, '参考视频必须静音,避免被自动播放策略拦');
  assert.equal(video.loop, true);
});

test('play({restart:true}):已播到中途只 seek 一次并等 seeked', async () => {
  const video = readyVideo({ readyState: 3, paused: false });
  video.currentTime = 12;
  const source = makeSource(video);
  source.url = ABS_A;
  source.loadedUrl = ABS_A;
  video.seeks = 0; // 只统计 play() 自己触发的 seek
  const promise = source.play({ restart: true });
  // 替身不会自己发 seeked:先确认它确实在等
  let settled = false;
  void promise.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false, 'seek 未落定前不应该继续');
  assert.equal(video.currentTime, 0, '已经请求 seek 到 0');
  assert.equal(video.plays, 0, 'seek 落定前不该 play');
  video.emit('seeked');
  await promise;
  assert.equal(settled, true);
  assert.equal(video.currentTime, 0, 'restart 会把播放位置拉回 0');
  assert.equal(video.plays, 0, '已经在播的元素不重复调 play()');
  assert.equal(video.paused, false, 'seek 期间保持播放,不闪断');
});

test('play():已经在播就不重复调 play()', async () => {
  const video = readyVideo({ readyState: 3, paused: false });
  const source = makeSource(video);
  source.url = ABS_A;
  source.loadedUrl = ABS_A;
  const result = await source.play({ loop: true });
  assert.equal(result.alreadyPlaying, true);
  assert.equal(video.plays, 0);
});

test('play() 被拒时把 DOMException.name 带回来,而不是静默', async () => {
  const abort = new Error('The play() request was interrupted by a call to pause()');
  abort.name = 'AbortError';
  const video = readyVideo({ readyState: 1, playError: abort });
  const warnings = [];
  const source = new VideoSource(video, { log: () => {}, warn: (l) => warnings.push(l) });
  source.url = ABS_A;
  source.loadedUrl = ABS_A;
  const result = await source.play({ restart: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /AbortError/);
  assert.ok(warnings.some((w) => w.includes('play() 被拒')), '必须留下告警日志');
});

test('加载失败:抛出带错误码的可读错误', async () => {
  const video = new FakeVideo({ failLoad: true });
  const source = makeSource(video, { loadTimeoutMs: 200 });
  await assert.rejects(() => source.load('/videos/broken.mp4'), /MEDIA_ERR_SRC_NOT_SUPPORTED/);
});

test('加载超时:给出超时结论与当时的 readyState', async () => {
  const video = new FakeVideo({ metadataDelayMs: 5000 });
  const source = makeSource(video, { loadTimeoutMs: 20 });
  await assert.rejects(() => source.load('/videos/slow.mp4'), /加载超时 20ms/);
});

test('ensurePlaying:本该在播却暂停时补一次 play 并留下告警', async () => {
  const video = readyVideo({ readyState: 3, paused: true });
  const warnings = [];
  const source = new VideoSource(video, { log: () => {}, warn: (l) => warnings.push(l) });
  source.url = ABS_A;
  source.loadedUrl = ABS_A;
  assert.equal(source.ensurePlaying(), false);
  assert.ok(warnings.some((w) => w.includes('本该在播却没有')));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(video.plays, 1, '应补一次 play()');
  assert.equal(source.ensurePlaying(), true, '补上之后自检通过');
});

test('ensurePlaying:正常播放时静默通过', () => {
  const video = readyVideo({ readyState: 3, paused: false });
  const source = makeSource(video);
  assert.equal(source.ensurePlaying(), true);
  assert.equal(video.plays, 0);
});

test('pause 幂等,clear 摘掉地址', () => {
  const video = readyVideo({ readyState: 3, paused: false });
  const source = makeSource(video);
  source.url = ABS_A;
  source.pause();
  source.pause();
  assert.equal(video.pauses, 1);
  source.clear('停止本局');
  assert.equal(video.removedSrc, 1);
  assert.equal(source.url, null);
});

test('report/exportText:能直接贴进问题单', async () => {
  const video = readyVideo({ readyState: 0 });
  const source = makeSource(video);
  source.url = ABS_A;
  const payload = JSON.parse(source.exportText('参考视频'));
  assert.equal(payload.label, '参考视频');
  assert.equal(payload.url, ABS_A);
  assert.equal(payload.health.ok, false);
  assert.equal(typeof payload.errors, 'string');
  assert.ok(Array.isArray(payload.log));
});

test('videoErrorSummary 区分"没绑定 / 被打断 / 等数据"', () => {
  assert.equal(videoErrorSummary({ health: { ok: true } }), '视频正常播放中');
  assert.match(videoErrorSummary({ health: { ok: false }, url: null }), /没有绑定视频地址/);
  assert.match(
    videoErrorSummary({ health: { ok: false }, url: 'x', log: [{ text: 'abort rs=0' }] }),
    /被中途打断/,
  );
  assert.match(
    videoErrorSummary({ health: { ok: false }, url: 'x', log: [{ text: 'waiting rs=2' }] }),
    /等待数据/,
  );
  assert.match(
    videoErrorSummary({ health: { ok: false, errorCode: 4, reason: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }, url: 'x', log: [] }),
    /SRC_NOT_SUPPORTED/,
  );
});
