import test from "node:test";
import assert from "node:assert/strict";
import { SelectionPreviewAudio } from "../web_dance/selection-preview-audio.js";

class FakeAudioEngine {
  static instances = [];
  constructor() {
    this.ctx = { state: "running", resume: async () => {} };
    this.loads = [];
    this.plays = 0;
    this.stops = 0;
    this.loop = false;
    FakeAudioEngine.instances.push(this);
  }
  async load(url) { this.loads.push(url); }
  async play() { this.plays++; }
  stop() { this.stops++; }
  async dispose() {}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("SelectionPreviewAudio 快速切歌只播放最后一首且使用独立引擎", async () => {
  FakeAudioEngine.instances.length = 0;
  const preview = new SelectionPreviewAudio({ AudioEngine: FakeAudioEngine, debounceMs: 0 });
  preview.request("a.wav");
  preview.request("b.wav");
  await tick();

  assert.equal(FakeAudioEngine.instances.length, 1);
  assert.deepEqual(preview.engine.loads, ["b.wav"]);
  assert.equal(preview.engine.plays, 1);
  assert.equal(preview.engine.loop, true);
});

test("SelectionPreviewAudio stop 会取消等待中的试听", async () => {
  const preview = new SelectionPreviewAudio({ AudioEngine: FakeAudioEngine, debounceMs: 0 });
  preview.request("c.wav");
  preview.stop();
  await tick();

  assert.deepEqual(preview.engine.loads, []);
  assert.equal(preview.engine.plays, 0);
  assert.equal(preview.engine.stops, 1);
});
