/**
 * test/audio-file.test.js — 验证项目内两个真实音频文件存在且 WAV 合法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildDemoSequence } from "../web_dance/demo-sequence.js";

const AUDIO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../web_dance/audio");

function assertValidWav(file, expectedDur) {
  const buf = readFileSync(resolve(AUDIO_DIR, file));
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt16LE(22), 2, `${file} 应为立体声`);
  assert.equal(buf.readUInt32LE(24), 44100, `${file} 采样率`);
  assert.equal(buf.readUInt16LE(34), 16, `${file} 位深`);
  const dataSize = buf.readUInt32LE(40);
  const duration = dataSize / (44100 * 2 * (16 / 8));
  assert.ok(Math.abs(duration - expectedDur) < 0.05, `${file} duration=${duration}`);
}

test("挑战 demo 引用 pop-demo.wav 且文件合法(120BPM 流行)", () => {
  const seq = buildDemoSequence();
  assert.equal(seq.chart.audio, "audio/pop-demo.wav");
  assertValidWav("pop-demo.wav", 24);
});

test("三轨内置音频都存在且合法", () => {
  assertValidWav("demo-beat.wav", 24); // 120BPM 鼓组(备用)
  assertValidWav("samba-demo.wav", 24); // 100BPM 桑巴(备用)
  assertValidWav("pop-demo.wav", 24); // 120BPM 流行(当前使用)
});
