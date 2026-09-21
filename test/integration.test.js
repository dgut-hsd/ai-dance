/**
 * test/integration.test.js — 集成冒烟:demo 序列 → timing/chart → SongSession 音符判定。
 * 验证 web_dance/main.js 集成的数据链路(纯逻辑,无浏览器 / three.js / MediaPipe)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDemoSequence } from "../web_dance/demo-sequence.js";
import { SongSession } from "../web_dance/audio.js";

function fakeAudioContext(clock = { t: 0 }) {
  const started = [];
  const ctx = {
    get currentTime() { return clock.t; },
    state: "running",
    baseLatency: 0,
    outputLatency: 0,
    destination: {},
    async resume() { ctx.state = "running"; },
    async close() {},
    async decodeAudioData() { return { duration: 0 }; },
    createBufferSource() {
      const src = { buffer: null, connect() {}, start(when, offset) { started.push({ when, offset }); }, stop() {}, onended: null };
      return src;
    },
  };
  return { ctx, started };
}

test("demo 序列 + SongSession 端到端:节拍栅格 + 12 个下拍音符全部命中", async () => {
  const seq = buildDemoSequence();
  assert.equal(seq.schema, "dance-sequence/v1");
  assert.equal(seq.meta.timing.version, "timing/v1");
  assert.equal(seq.chart.version, "chart/v1");

  const clock = { t: 0 };
  const { ctx } = fakeAudioContext(clock);
  const judged = [];
  const session = new SongSession({
    sequence: seq,
    similarity: () => 1.0, // 玩家始终完美匹配
    audioContext: ctx,
    onJudge: (r) => judged.push(r),
  });
  await session.prepare();

  // 节拍栅格:24s @120bpm → 49 拍;每 2s 一个下拍 → 13 个下拍
  assert.equal(session.timing.beatTimesSec.length, 49);
  assert.equal(session.timing.downbeatsSec.length, 13);
  assert.equal(session.chart.noteCount, 12);

  await session.start(0);

  const dummyFrame = { bones: [[0, 1, 0], [0, 1, 0]], conf: [1, 1] };
  for (const n of session.chart.notes) {
    session.feed(n.t, dummyFrame);
    clock.t = n.t + 0.3;
    session.update();
  }
  clock.t = 24;
  session.update();
  session.stop();

  const settled = judged.filter((r) => !r.ongoing);
  assert.equal(settled.length, 12);
  assert.ok(settled.every((r) => r.tier === "PERFECT"));
});
