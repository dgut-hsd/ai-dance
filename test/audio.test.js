/**
 * test/audio.test.js — audio.js 的单元测试(TDD)。
 * 运行:npm test  或  node --test test/
 *
 * 纯逻辑模块(TimingMap / NoteChart / PlayerPoseBuffer / Scheduler /
 * LatencyModel / NoteJudge)直接在 Node 跑;AudioEngine / SongSession 通过
 * 注入的 fake AudioContext 验证时钟数学与调度,不依赖浏览器。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LatencyModel,
  TimingMap,
  NoteChart,
  PlayerPoseBuffer,
  Scheduler,
  AudioEngine,
  NoteJudge,
  SongSession,
} from "../web_dance/audio.js";

function assertClose(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${actual} to be close to ${expected} (eps ${eps})`
  );
}

// ---------------------------------------------------------------------------
// LatencyModel
// ---------------------------------------------------------------------------
test("LatencyModel: 三延迟求和 + judgeTimeAt", () => {
  const m = new LatencyModel({ outputLatencySec: 0.01, inputLatencySec: 0.08, userOffsetSec: -0.02 });
  assertClose(m.totalOffsetSec, 0.07);
  assertClose(m.judgeTimeAt(1.0), 1.07);
});

test("LatencyModel: autoCalibrate 用残差均值估计 inputLatencySec", () => {
  const m = new LatencyModel();
  const est = m.autoCalibrate([
    { expectedSec: 1.0, actualSec: 1.1 },
    { expectedSec: 2.0, actualSec: 2.1 },
    { expectedSec: 3.0, actualSec: 3.05 },
  ]);
  assertClose(est, 0.08333333333333333, 1e-6);
  assertClose(m.inputLatencySec, 0.08333333333333333, 1e-6);
});

// ---------------------------------------------------------------------------
// TimingMap
// ---------------------------------------------------------------------------
function constantTiming(bpm = 120, offsetSec = 0, timeSignatures) {
  const t = { version: "timing/v1", bpm, offsetSec, tempoMap: [{ t: 0, bpm }] };
  if (timeSignatures) t.timeSignatures = timeSignatures;
  return t;
}

test("TimingMap: 恒定 BPM 120 拍栅格 + 下拍 + 查询", () => {
  const tm = new TimingMap(constantTiming(120, 0), 4);
  assert.deepEqual(tm.beatTimesSec, [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]);
  assert.deepEqual(tm.downbeatsSec, [0, 2.0, 4.0]);
  assert.equal(tm.bpmAt(1.0), 120);
  assert.equal(tm.beatIndexAt(1.0), 2);
  assertClose(tm.beatIndexAt(1.25), 2.5);

  const nb = tm.nearestBeat(1.3);
  assert.equal(nb.index, 3);
  assertClose(nb.time, 1.5);
  assertClose(nb.deltaSec, -0.2);

  assert.equal(tm.nextBeatTime(1.3), 1.5);
  assert.equal(tm.prevBeatTime(1.3), 1.0);
  assert.equal(tm.isDownbeatTime(2.0), true);
  assert.equal(tm.isDownbeatTime(0.5), false);
  assert.equal(tm.barIndexAt(0.0), 0);
  assert.equal(tm.barIndexAt(2.0), 1);
  assert.equal(tm.barIndexAt(3.9), 1);
  assertClose(tm.timeAtBeat(2.5), 1.25);
});

test("TimingMap: 变速点 tempoMap", () => {
  const timing = { version: "timing/v1", bpm: 120, offsetSec: 0, tempoMap: [{ t: 0, bpm: 120 }, { t: 2, bpm: 60 }] };
  const tm = new TimingMap(timing, 4);
  assert.deepEqual(tm.beatTimesSec, [0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0]);
  assert.equal(tm.bpmAt(1.9), 120);
  assert.equal(tm.bpmAt(2.0), 60);
  assertClose(tm.beatIndexAt(2.5), 4.5);
  assert.deepEqual(tm.downbeatsSec, [0, 2.0]);
});

test("TimingMap: 弱起(负 offset)", () => {
  const tm = new TimingMap(constantTiming(120, -0.5), 2);
  assert.deepEqual(tm.beatTimesSec, [-0.5, 0, 0.5, 1.0, 1.5, 2.0]);
  assert.equal(tm.isDownbeatTime(-0.5), true);
  assert.equal(tm.beatIndexAt(0), 1);
});

test("TimingMap: 拍号变化重置小节", () => {
  const timing = constantTiming(120, 0, [{ t: 0, num: 4, den: 4 }, { t: 1.5, num: 3, den: 4 }]);
  const tm = new TimingMap(timing, 4);
  assert.deepEqual(tm.downbeatsSec, [0, 1.5, 3.0]);
});

test("TimingMap: 非法版本抛错", () => {
  assert.throws(() => new TimingMap({ version: "timing/v9", tempoMap: [{ t: 0, bpm: 120 }] }, 10), /timing\/v1/);
});

// ---------------------------------------------------------------------------
// NoteChart
// ---------------------------------------------------------------------------
test("NoteChart: 默认判定窗 + 时间窗查询", () => {
  const chart = { version: "chart/v1", notes: [
    { t: 1.0, type: "pose" },
    { t: 2.0, type: "hold", endT: 3.0 },
    { t: 4.0, type: "beat" },
  ] };
  const nc = new NoteChart(chart, 10);
  assert.deepEqual(nc.windowsMs, { perfect: 50, great: 100, good: 150 });
  assert.equal(nc.noteCount, 3);
  assert.deepEqual(nc.notesInWindow(0.5, 2.0).map((n) => n.t), [1.0]);
  assert.deepEqual(nc.notesInWindow(1.0, 4.5).map((n) => n.t), [1.0, 2.0, 4.0]);
  assert.equal(nc.nextNoteAfter(1.0).t, 2.0);
});

test("NoteChart: 自定义判定窗(秒→毫秒)", () => {
  const nc = new NoteChart({ version: "chart/v1", timingWindows: { perfect: 0.04, great: 0.08, good: 0.12 }, notes: [] });
  assert.deepEqual(nc.windowsMs, { perfect: 40, great: 80, good: 120 });
});

test("NoteChart: 非法输入抛错", () => {
  assert.throws(() => new NoteChart({ version: "chart/v9", notes: [] }), /chart\/v1/);
  assert.throws(() => new NoteChart({ version: "chart/v1", notes: [{ t: 2, type: "pose" }, { t: 1, type: "pose" }] }), /ascending/);
  assert.throws(() => new NoteChart({ version: "chart/v1", notes: [{ t: 1, type: "hold", endT: 1 }] }), /endT/);
});

// ---------------------------------------------------------------------------
// PlayerPoseBuffer
// ---------------------------------------------------------------------------
test("PlayerPoseBuffer: 最近邻采样 + 范围 + 过期 + sampleNearest", () => {
  const b = new PlayerPoseBuffer(8, 1.0);
  b.push({ id: "a" }, 1.0);
  b.push({ id: "b" }, 1.4);
  assert.equal(b.size, 2);
  assert.equal(b.sample(1.1).id, "a");
  assert.equal(b.sample(1.3).id, "b");
  assert.deepEqual(b.framesInRange(1.0, 1.5).map((e) => e.t), [1.0, 1.4]);
  assert.equal(b.sampleNearest(1.3, 0.05), null);
  const sn = b.sampleNearest(1.3, 0.2);
  assert.equal(sn.frame.id, "b");
  assertClose(sn.deltaSec, 0.1);
  assert.equal(b.sample(5.0), null); // 过期(5.0 - 1.4 > maxAge 1.0)
});

test("PlayerPoseBuffer: 环形容量淘汰最旧帧 + clear", () => {
  const b = new PlayerPoseBuffer(2, 10);
  b.push({ id: "a" }, 1.0);
  b.push({ id: "b" }, 1.1);
  b.push({ id: "c" }, 1.2);
  assert.equal(b.size, 2);
  assert.deepEqual(b.framesInRange(0, 2).map((e) => e.frame.id), ["b", "c"]);
  b.clear();
  assert.equal(b.size, 0);
  assert.equal(b.sample(1.0), null);
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
test("Scheduler: 单次事件按绝对时间触发", () => {
  const clock = { songTime: 0 };
  const s = new Scheduler(clock);
  const fired = [];
  s.schedule(0.5, (t) => fired.push(["a", t]));
  s.schedule(1.0, (t) => fired.push(["b", t]));
  s.tick(0.4); assert.deepEqual(fired, []);
  s.tick(0.5); assert.deepEqual(fired, [["a", 0.5]]);
  s.tick(0.9); assert.deepEqual(fired, [["a", 0.5]]);
  s.tick(1.0); assert.deepEqual(fired, [["a", 0.5], ["b", 1.0]]);
});

test("Scheduler: 周期事件 + 快进不堆积", () => {
  const clock = { songTime: 0 };
  const s = new Scheduler(clock);
  const fired = [];
  s.scheduleEvery(0, 1.0, (t) => fired.push(t));
  s.tick(0);    assert.deepEqual(fired, [0]);
  s.tick(1.0);  assert.deepEqual(fired, [0, 1.0]);
  s.tick(5.0);  assert.deepEqual(fired, [0, 1.0, 5.0]);
});

test("Scheduler: cancel 移除事件", () => {
  const clock = { songTime: 0 };
  const s = new Scheduler(clock);
  const fired = [];
  const id = s.schedule(1.0, () => fired.push("x"));
  s.cancel(id);
  s.tick(1.5);
  assert.deepEqual(fired, []);
});

// ---------------------------------------------------------------------------
// AudioEngine(fake AudioContext 注入)
// ---------------------------------------------------------------------------
function fakeAudioContext(clock = { t: 0 }) {
  const started = [];
  const ctx = {
    get currentTime() { return clock.t; },
    state: "running",
    baseLatency: 0.005,
    outputLatency: 0.010,
    destination: {},
    async resume() { ctx.state = "running"; },
    async close() { ctx.closed = true; },
    async decodeAudioData() { return { duration: 4.0 }; },
    createBufferSource() {
      const src = {
        buffer: null,
        connect() {},
        start(when, offset) { started.push({ src, when, offset }); },
        stop() {},
        onended: null,
      };
      return src;
    },
  };
  return { ctx, started };
}

test("AudioEngine: 无音频的静默时钟(songTime 随 ctx 走并 clamp)", async () => {
  const clock = { t: 10 };
  const { ctx } = fakeAudioContext(clock);
  const e = new AudioEngine({ audioContext: ctx });
  e.setDurationSec(2);
  await e.play(10);
  assert.equal(e.state, "playing");
  clock.t = 11;
  assert.equal(e.songTime, 1.0);
  clock.t = 13;
  assert.equal(e.songTime, 2.0);
});

test("AudioEngine: load 解码 + play 调度 source.start", async () => {
  const clock = { t: 0 };
  const { ctx, started } = fakeAudioContext(clock);
  const e = new AudioEngine({ audioContext: ctx });
  await e.load(new ArrayBuffer(8));
  assert.equal(e.durationSec, 4.0);
  await e.play(0);
  assert.equal(started.length, 1);
  assert.equal(started[0].when, 0);
  assert.equal(started[0].offset, 0);
});

test("AudioEngine: pause/resume 冻结并从暂停点续播", async () => {
  const clock = { t: 10 };
  const { ctx, started } = fakeAudioContext(clock);
  const e = new AudioEngine({ audioContext: ctx });
  await e.load(new ArrayBuffer(8));
  await e.play(10);
  clock.t = 11;
  assert.equal(e.songTime, 1.0);
  const pausedAt = e.pause();
  assert.equal(pausedAt, 1.0);
  clock.t = 12;
  assert.equal(e.songTime, 1.0);
  await e.resume();
  const last = started[started.length - 1];
  assert.equal(last.offset, 1.0);
  clock.t = 13;
  assertClose(e.songTime, 2.0);
});

test("AudioEngine: seek 重定位", async () => {
  const clock = { t: 10 };
  const { ctx, started } = fakeAudioContext(clock);
  const e = new AudioEngine({ audioContext: ctx });
  await e.load(new ArrayBuffer(8));
  await e.play(10);
  clock.t = 11;
  await e.seek(2.5);
  const last = started[started.length - 1];
  assert.equal(last.offset, 2.5);
  assertClose(e.songTime, 2.5);
});

test("AudioEngine: outputLatencySec + onEnded", async () => {
  const clock = { t: 0 };
  const { ctx, started } = fakeAudioContext(clock);
  let ended = 0;
  const e = new AudioEngine({ audioContext: ctx, onEnded: () => ended++ });
  assertClose(e.outputLatencySec, 0.015);
  await e.load(new ArrayBuffer(8));
  await e.play(0);
  assert.equal(e.state, "playing");
  started[0].src.onended();
  assert.equal(ended, 1);
  assert.equal(e.state, "ended");
});

test("AudioEngine: loop 开启后 source.loop 生效", async () => {
  const clock = { t: 0 };
  const { ctx, started } = fakeAudioContext(clock);
  const e = new AudioEngine({ audioContext: ctx });
  await e.load(new ArrayBuffer(8));
  e.loop = true;
  await e.play(0);
  assert.equal(started[0].src.loop, true);
  e.loop = false;
  await e.play(0);
  assert.equal(started[1].src.loop, false);
});

// ---------------------------------------------------------------------------
// NoteJudge
// ---------------------------------------------------------------------------
const REF = { marker: "A", bones: [[1, 0, 0], [0, 1, 0]], conf: [1, 1] };
const refAt = () => REF;
const mkFrame = (marker, bones) => ({ marker, bones: bones ?? REF.bones, conf: [1, 1] });
const markerSimilarity = (ref, player) => (ref && player && ref.marker === player.marker ? 1.0 : 0.0);
const poseChart = (notes) => ({ version: "chart/v1", notes });

test("NoteJudge: 命中窗口分级 PERFECT/GREAT/GOOD", () => {
  const mk = (delta) => {
    const j = new NoteJudge(poseChart([{ id: "n", t: 1.0, type: "pose" }]), markerSimilarity, { refAt, durationSec: 10 });
    j.feed(1.0 + delta, mkFrame("A"));
    return j.tick(1.15)[0];
  };
  assert.equal(mk(0.0).tier, "PERFECT");
  assert.equal(mk(0.07).tier, "GREAT");
  assert.equal(mk(0.12).tier, "GOOD");
});

test("NoteJudge: 超出窗口或动作不符 → MISS", () => {
  let j = new NoteJudge(poseChart([{ id: "n", t: 1.0, type: "pose" }]), markerSimilarity, { refAt, durationSec: 10 });
  j.feed(1.3, mkFrame("A"));
  assert.equal(j.tick(1.45)[0].tier, "MISS");

  j = new NoteJudge(poseChart([{ id: "n", t: 1.0, type: "pose" }]), markerSimilarity, { refAt, durationSec: 10 });
  j.feed(1.0, mkFrame("B"));
  assert.equal(j.tick(1.15)[0].tier, "MISS");
});

test("NoteJudge: note.threshold 覆盖默认阈值 + acc 层级", () => {
  const mid = () => 0.6;
  let j = new NoteJudge(poseChart([{ id: "n", t: 1.0, type: "pose", threshold: 0.8 }]), mid, { refAt, durationSec: 10 });
  j.feed(1.0, mkFrame("A"));
  assert.equal(j.tick(1.15)[0].tier, "MISS"); // 0.6 < 0.8

  j = new NoteJudge(poseChart([{ id: "n", t: 1.0, type: "pose", threshold: 0.5 }]), mid, { refAt, durationSec: 10 });
  j.feed(1.0, mkFrame("A"));
  assert.equal(j.tick(1.15)[0].tier, "GREAT"); // 0.6 >= 0.55 但 < 0.8
});

test("NoteJudge: bones 子集走内部余弦(绕过注入 similarity)", () => {
  const throwing = () => { throw new Error("should not be called"); };
  const chart = poseChart([{ id: "n", t: 1.0, type: "pose", bones: [0] }]);
  const j = new NoteJudge(chart, throwing, { refAt, durationSec: 10 });
  j.feed(1.0, { bones: [[1, 0, 0], [0, 0, 1]], conf: [1, 1] });
  const r = j.tick(1.15)[0];
  assert.equal(r.tier, "PERFECT");
  assertClose(r.acc, 1.0);
});

test("NoteJudge: 连击与 finalize", () => {
  const chart = poseChart([
    { id: "n1", t: 1.0, type: "pose" },
    { id: "n2", t: 2.0, type: "pose" },
    { id: "n3", t: 3.0, type: "pose" },
  ]);
  const j = new NoteJudge(chart, markerSimilarity, { refAt, durationSec: 10 });
  j.feed(1.0, mkFrame("A")); j.tick(1.15);
  j.feed(2.0, mkFrame("A")); j.tick(2.15);
  j.feed(3.3, mkFrame("A")); j.tick(3.45);
  const f = j.finalize();
  assert.equal(j.combo, 0);
  assert.equal(f.totalNotes, 3);
  assert.equal(f.notesHit, 2);
  assert.equal(f.perfect, 2);
  assert.equal(f.miss, 1);
  assert.equal(f.maxCombo, 2);
});

test("NoteJudge: hold 撑满 PERFECT / 中途跌破 GOOD / 起手失败 MISS", () => {
  const holdChart = () => poseChart([{ id: "h", t: 1.0, type: "hold", endT: 2.0 }]);

  // 撑满
  let j = new NoteJudge(holdChart(), markerSimilarity, { refAt, durationSec: 10 });
  j.feed(1.0, mkFrame("A"));
  j.feed(1.4, mkFrame("A"));
  j.feed(1.8, mkFrame("A"));
  j.feed(2.0, mkFrame("A"));
  const all = [];
  all.push(...j.tick(1.15));
  all.push(...j.tick(1.4));
  all.push(...j.tick(1.8));
  all.push(...j.tick(2.15));
  assert.equal(all.filter((r) => !r.ongoing).at(-1).tier, "PERFECT");
  assert.ok(all.some((r) => r.ongoing));

  // 中途跌破
  j = new NoteJudge(holdChart(), markerSimilarity, { refAt, durationSec: 10 });
  j.feed(1.0, mkFrame("A"));
  j.feed(1.5, mkFrame("B"));
  j.tick(1.15);
  j.tick(1.5);
  assert.equal(j.tick(2.15).filter((r) => !r.ongoing).at(-1).tier, "GOOD");

  // 起手失败
  j = new NoteJudge(holdChart(), markerSimilarity, { refAt, durationSec: 10 });
  j.feed(1.0, mkFrame("B"));
  assert.equal(j.tick(1.15).filter((r) => !r.ongoing).at(-1).tier, "MISS");
});

// ---------------------------------------------------------------------------
// SongSession(门面,静默时钟)
// ---------------------------------------------------------------------------
test("SongSession: prepare/start/update 驱动音符判定(静默时钟)", async () => {
  const clock = { t: 0 };
  const { ctx } = fakeAudioContext(clock);
  const N = 60;
  const frames = [];
  for (let i = 0; i < N; i++) {
    frames.push({ t: i / 30, marker: "A", bones: [[1, 0, 0], [0, 1, 0]], conf: [1, 1] });
  }
  const seq = {
    schema: "dance-sequence/v1",
    danceId: "smoke",
    meta: {
      fps: 30,
      durationSec: 2,
      numFrames: N,
      boneCount: 2,
      danceType: "full-body",
      timing: { version: "timing/v1", bpm: 120, offsetSec: 0, tempoMap: [{ t: 0, bpm: 120 }] },
    },
    bones: [{ name: "a", parent: "p", child: "c" }],
    frames,
    chart: { version: "chart/v1", notes: [{ id: "n", t: 1.0, type: "pose" }] },
  };
  const judged = [];
  const session = new SongSession({
    sequence: seq,
    similarity: markerSimilarity,
    audioContext: ctx,
    onJudge: (r) => judged.push(r),
  });
  await session.prepare();
  assert.ok(session.timing);
  assert.ok(session.chart);
  assert.ok(session.judge);

  await session.start(0);
  clock.t = 1.0;
  session.feed(1.0, mkFrame("A"));
  clock.t = 1.2;
  session.update();
  session.stop();

  const settled = judged.filter((r) => !r.ongoing);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].tier, "PERFECT");
});

test("AudioEngine: audioOffsetSec 跳过前导并缩短时长", async () => {
  const clock = { t: 0 };
  const { ctx, started } = fakeAudioContext(clock);
  const e = new AudioEngine({ audioContext: ctx });
  await e.load(new ArrayBuffer(8), 2); // decode 返回 duration 4.0
  assert.equal(e.durationSec, 2);
  await e.play(0);
  assert.equal(started[0].offset, 2); // 起播即跳 2s 前导
});

test("NoteJudge: chart.judgeOffsetSec 平移判定时刻", () => {
  const withOffset = new NoteJudge(
    { version: "chart/v1", judgeOffsetSec: 0.1, notes: [{ id: "n", t: 1.0, type: "pose" }] },
    markerSimilarity, { refAt, durationSec: 10 }
  );
  withOffset.feed(1.1, mkFrame("A"));
  assert.equal(withOffset.tick(1.25)[0].tier, "PERFECT"); // judgeTime = 1.1

  const without = new NoteJudge(
    { version: "chart/v1", notes: [{ id: "n", t: 1.0, type: "pose" }] },
    markerSimilarity, { refAt, durationSec: 10 }
  );
  without.feed(1.1, mkFrame("A"));
  assert.equal(without.tick(1.15)[0].tier, "GREAT"); // 无 offset:1.1 处 = 100ms → GREAT
});

test("SongSession: 静默时钟到点触发 onSongEnd(幂等)", async () => {
  const clock = { t: 0 };
  const { ctx } = fakeAudioContext(clock);
  const seq = {
    schema: "dance-sequence/v1", danceId: "x",
    meta: { fps: 30, durationSec: 2, numFrames: 60, boneCount: 2, danceType: "full-body" },
    bones: [], frames: [{ t: 0, bones: [[1, 0, 0]], conf: [1] }],
  };
  let ended = 0;
  const session = new SongSession({ sequence: seq, similarity: () => 1, audioContext: ctx, onSongEnd: () => ended++ });
  await session.prepare();
  await session.start(0);
  clock.t = 1.9; session.update(); assert.equal(ended, 0);
  clock.t = 2.0; session.update(); assert.equal(ended, 1);
  clock.t = 2.5; session.update(); assert.equal(ended, 1);
  session.stop();
});

test("SongSession: 音频自然结束触发 onSongEnd", async () => {
  const clock = { t: 0 };
  const { ctx, started } = fakeAudioContext(clock);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  try {
    let ended = 0;
    const seq = {
      schema: "dance-sequence/v1", danceId: "y",
      meta: { fps: 30, durationSec: 4, numFrames: 120, boneCount: 2, danceType: "full-body", audio: "song.wav" },
      bones: [], frames: [],
    };
    const session = new SongSession({ sequence: seq, similarity: () => 1, audioContext: ctx, onSongEnd: () => ended++ });
    await session.prepare();
    await session.start(0);
    assert.equal(started.length, 1);
    started[0].src.onended(); // 模拟音频自然结束
    assert.equal(ended, 1);
    session.stop();
  } finally {
    globalThis.fetch = origFetch;
  }
});
