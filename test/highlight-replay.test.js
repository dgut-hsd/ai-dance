import test from "node:test";
import assert from "node:assert/strict";
import { HighlightReplayController } from "../web_dance/highlight-replay.js";

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.src = "";
    this.paused = true;
    this.controls = true;
  }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  loadMetadata() { this.dispatchEvent(new Event("loadedmetadata")); }
  tick(time) { this.currentTime = time; this.dispatchEvent(new Event("timeupdate")); }
}

test("元数据已就绪时不会因 loadedmetadata 再次启动同一片段", async () => {
  const video = new FakeVideo();
  video.readyState = 1;
  let changes = 0;
  const replay = new HighlightReplayController({ video, onSegmentChange: () => changes++ });
  await replay.start("blob:ready", [{ start: 1, peak: 2, end: 3 }]);
  video.loadMetadata();
  assert.equal(changes, 1);
});

test("分段回放依次跳转三个高光并结束", async () => {
  const video = new FakeVideo();
  const seen = [];
  let completed = 0;
  const replay = new HighlightReplayController({
    video,
    onSegmentChange: (segment, index) => seen.push([segment.peak, index]),
    onComplete: () => completed++,
  });

  const started = replay.start("blob:test", [
    { start: 1, peak: 2, end: 3 },
    { start: 6, peak: 7, end: 8 },
    { start: 11, peak: 12, end: 13 },
  ]);
  video.loadMetadata();
  await started;
  assert.equal(video.currentTime, 1);
  assert.equal(video.controls, false);

  video.tick(3.01);
  assert.equal(video.currentTime, 6);
  video.tick(8.01);
  assert.equal(video.currentTime, 11);
  video.tick(13.01);

  assert.equal(video.paused, true);
  assert.equal(completed, 1);
  assert.deepEqual(seen, [[2, 0], [7, 1], [12, 2]]);
});

test("stop 清理回放且不会触发完成回调", async () => {
  const video = new FakeVideo();
  let completed = 0;
  const replay = new HighlightReplayController({ video, onComplete: () => completed++ });
  const started = replay.start("blob:test", [{ start: 2, peak: 3, end: 4 }]);
  video.loadMetadata();
  await started;
  replay.stop();
  video.tick(5);
  assert.equal(video.paused, true);
  assert.equal(completed, 0);
});
