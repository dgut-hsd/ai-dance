import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { selectHighlightSegments, positiveTitleFor } from "../web_dance/highlight-selector.js";

const marker = (time, tier, accuracy, combo = 0, confidence = 1, scoreGain = 0) =>
  ({ time, tier, accuracy, combo, confidence, scoreGain, noteId: `n-${time}` });

test("高光选择优先 PERFECT / 高准确率 / 高连击", () => {
  const segments = selectHighlightSegments([
    marker(3, "GOOD", 0.7, 2),
    marker(8, "PERFECT", 0.92, 8, 0.95, 300),
    marker(14, "GREAT", 0.86, 18, 0.9, 240),
    marker(20, "PERFECT", 0.97, 25, 0.98, 350),
  ], { duration: 24, count: 3 });

  assert.deepEqual(segments.map((x) => x.peak), [8, 14, 20]);
  assert.equal(segments.at(-1).tier, "PERFECT");
  assert.ok(segments.every((x) => x.end - x.start === 5));
});

test("高光片段去除过近候选并限制在视频时长内", () => {
  const segments = selectHighlightSegments([
    marker(0.4, "PERFECT", 0.99, 3),
    marker(1.2, "PERFECT", 0.98, 4),
    marker(7, "GREAT", 0.8, 9),
    marker(12.7, "PERFECT", 0.95, 12),
  ], { duration: 13, minGap: 3, before: 1.2, after: 1.8 });

  assert.equal(segments.length, 3);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, 13);
  assert.ok(segments[1].peak - segments[0].peak >= 3);
});

test("没有合格判定时也提供三段五秒真人片段", () => {
  const segments = selectHighlightSegments([
    marker(3, "MISS", 0.1, 0),
    marker(5, "GOOD", 0.8, 1, 0.2),
  ], { duration: 20 });

  assert.equal(segments.length, 3);
  assert.ok(segments.every(segment => segment.fallback));
  assert.ok(segments.every(segment => segment.end - segment.start === 5));
  assert.deepEqual(segments.map(segment => segment.peak), [5, 10, 15]);
});

test("只有一个合格动作时补足另外两段，成片规格不缩水", () => {
  const segments = selectHighlightSegments([marker(10, "PERFECT", .96, 8)], { duration: 20 });
  assert.equal(segments.length, 3);
  assert.equal(segments.filter(segment => !segment.fallback).length, 1);
  assert.equal(segments.reduce((sum, segment) => sum + segment.end - segment.start, 0), 15);
});

test("正向称号始终可用且不依赖虚构排名", () => {
  assert.equal(positiveTitleFor({ perfectCount: 6, maxCombo: 8 }), "精准舞者");
  assert.equal(positiveTitleFor({ perfectCount: 1, maxCombo: 20 }), "连击达人");
  assert.equal(positiveTitleFor({ perfectCount: 0, maxCombo: 0 }), "舞台新星");
});

test("结算页保留称号位置但不再使用旧称号阶梯和升级提示", async () => {
  const [html, main, css] = await Promise.all([
    readFile(new URL("../web_dance/dance.html", import.meta.url), "utf8"),
    readFile(new URL("../web_dance/main.js", import.meta.url), "utf8"),
    readFile(new URL("../web_dance/style.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /result-title/);
  assert.match(html, /result-tagline/);
  for (const source of [html, main, css]) assert.doesNotMatch(source, /result-next|TITLE_LADDER|TITLE_TAGLINES/);
});
