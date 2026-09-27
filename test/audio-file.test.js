/**
 * test/audio-file.test.js — 验证 songs/<danceId>/ 下真实音频文件存在且 WAV 合法。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// demo 参考序列取自 songs/ 落盘产物(不再依赖 web_dance/demo-sequence.js)
const SEQ = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../songs/demo-arena-loop/demo-arena-loop.json"), "utf8"),
);

// 音频统一放 songs/<danceId>/ 下(每曲平铺)
const SONGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../songs");

function assertValidWav(danceId, file, expectedDur) {
  const buf = readFileSync(resolve(SONGS_DIR, danceId, file));
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt16LE(22), 2, `${file} 应为立体声`);
  assert.equal(buf.readUInt32LE(24), 44100, `${file} 采样率`);
  assert.equal(buf.readUInt16LE(34), 16, `${file} 位深`);
  const dataSize = buf.readUInt32LE(40);
  const duration = dataSize / (44100 * 2 * (16 / 8));
  assert.ok(Math.abs(duration - expectedDur) < 0.05, `${file} duration=${duration}`);
}

test("挑战 demo 引用 demo-beat.wav 且文件合法(120BPM 鼓组)", () => {
  assert.equal(SEQ.chart.audio, "demo-beat.wav");
  assertValidWav("demo-arena-loop", "demo-beat.wav", 24);
});

test("三轨内置音频都在 songs/<danceId>/ 下且合法", () => {
  assertValidWav("demo-arena-loop", "demo-beat.wav", 24); // 120BPM 鼓组(备用)
  assertValidWav("salsa", "samba-demo.wav", 24); // 100BPM 桑巴(备用)
  assertValidWav("hiphop", "pop-demo.wav", 24); // 120BPM 流行(当前使用)
});