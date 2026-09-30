/**
 * test/song-index.test.js — songs/index.json 的「只增不改」合并 + demo 目录保护。
 *
 * 背景(踩过的坑):export-songs 以前整体重写 index.json,把 demo 那条的 id 从
 * `demo-arena-loop` 改成 `demo` 并挪到数组最前 → PK 选曲页卡片顺序变化;人工改过的 label 也被覆盖。
 * 这里把语义钉死:已有条目(位置/id/label)一律保留,只追加新条目。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSongIndex, isEditorOwned, chartLooksEdited } from "../scoring/src/songIndex.js";

const built = {
  dances: [
    { id: "demo", label: "合成示例舞", danceId: "demo-arena-loop", defaultSongId: "demo-beat", chartFile: "demo-arena-loop.chart.json", musicFile: "demo-beat.wav", fbxFile: null },
    { id: "hiphop", label: "Hip Hop Dancing", danceId: "hiphop", defaultSongId: "pop-demo", chartFile: "hiphop.chart.json", musicFile: "pop-demo.wav", fbxFile: "hiphop.fbx" },
  ],
  songs: [
    { id: "demo-beat", label: "示例节拍", file: "demo-beat.wav", bpm: 120 },
    { id: "pop-demo", label: "Pop Demo", file: "pop-demo.wav", bpm: 120 },
  ],
};

test("T-IDX-1 已有条目原样保留:位置、id、人工改过的 label 都不动", () => {
  const prev = {
    schema: "songs/index/v1",
    dances: [
      { id: "hiphop", label: "Hip Hop Dancing", danceId: "hiphop", musicFile: "pop-demo.wav" },
      { id: "demo-arena-loop", label: "合成示例舞(我改的名字)", danceId: "demo-arena-loop", musicFile: "demo-beat.wav" },
      { id: "copydance1", label: "风萧萧雨萧萧", danceId: "copydance1", musicFile: "copyDance1_30s.wav" },
    ],
    songs: [{ id: "pop-demo", label: "Pop Demo", file: "pop-demo.wav", bpm: 120 }],
  };
  const { index, appended, preserved } = mergeSongIndex(prev, built);
  assert.deepEqual(index.dances.map((d) => d.id), ["hiphop", "demo-arena-loop", "copydance1"],
    "顺序与 id 必须原样保留(demo 那条不能变成 demo 也不能挪到最前)");
  assert.equal(index.dances[1].label, "合成示例舞(我改的名字)", "人工改过的 label 不能被覆盖");
  assert.equal(appended, 1, "两支舞都已存在;只有生成器多出来的歌曲 demo-beat 被追加");
  assert.equal(preserved, 4, "3 支舞 + 1 首歌都被保留");
  assert.deepEqual(index.songs.map((s) => s.id), ["pop-demo", "demo-beat"], "已有歌曲在前,新歌曲追加在后");
});

test("T-IDX-2 生成器里有、index 里没有 → 追加到末尾(不插队)", () => {
  const prev = { schema: "songs/index/v1", dances: [{ id: "copydance1", label: "风萧萧雨萧萧", danceId: "copydance1" }], songs: [] };
  const { index, appended } = mergeSongIndex(prev, built);
  assert.deepEqual(index.dances.map((d) => d.id), ["copydance1", "demo", "hiphop"]);
  assert.deepEqual(index.songs.map((s) => s.id), ["demo-beat", "pop-demo"]);
  assert.equal(appended, 4);
});

test("T-IDX-3 全新生成(没有旧 index)时按生成器顺序", () => {
  const { index } = mergeSongIndex(null, built);
  assert.deepEqual(index.dances.map((d) => d.id), ["demo", "hiphop"]);
  assert.equal(index.schema, "songs/index/v1");
});

test("T-IDX-4 --force 回到全量重写:生成器条目在前、index 里多出来的追加", () => {
  const prev = {
    schema: "songs/index/v1",
    dances: [{ id: "copydance1", danceId: "copydance1" }, { id: "demo-arena-loop", danceId: "demo-arena-loop" }],
    songs: [{ id: "copy-song", file: "x.wav" }],
  };
  const { index } = mergeSongIndex(prev, built, { force: true });
  // demo 用生成器的 id(=demo)出现,旧的 demo-arena-loop 条目因 danceId 相同被去掉;copydance1 追加在后
  assert.deepEqual(index.dances.map((d) => d.id), ["demo", "hiphop", "copydance1"]);
  assert.deepEqual(index.songs.map((s) => s.id), ["demo-beat", "pop-demo", "copy-song"]);
});

test("T-IDX-5 demo 目录保护:存在 demo 序列就当编辑器内容,不覆盖", () => {
  const demo = { kind: "demo", danceId: "demo-arena-loop" };
  assert.equal(isEditorOwned(["demo-arena-loop.json", "demo-arena-loop.chart.json"], demo), true);
  assert.equal(isEditorOwned([], demo), false, "目录里没有序列 → 可以生成");
  assert.equal(isEditorOwned(["demo-arena-loop.chart.json"], demo), false, "只有谱面、没有序列 → 当成全新生成");
});

test("T-IDX-6 编辑器改过的谱面(任意曲目)同样不覆盖", () => {
  const hiphop = { kind: "fbx", danceId: "hiphop" };
  const files = ["hiphop.json", "hiphop.chart.json"];
  const generated = { schema: "chart/v2", sequenceFile: "hiphop.json", audio: "pop-demo.wav", notes: [{ id: "a", t: 0, type: "pose", lane: 0 }] };
  assert.equal(isEditorOwned(files, hiphop, () => generated), false, "生成器写的谱面没有编辑器标记 → 照常重生成");
  assert.equal(chartLooksEdited({ ...generated, judgeOffsetSec: 0.12 }), true);
  assert.equal(chartLooksEdited({ ...generated, audioOffsetSec: -0.2 }), true);
  assert.equal(chartLooksEdited({ ...generated, notes: [{ id: "m-1", t: 1, refFrameIdx: 30 }] }), true);
  assert.equal(chartLooksEdited(null), false);
});

// ---------------------------------------------------------------------------
// 悬空歌曲引用:defaultSongId 必须能在 songs[] 里查到
// ---------------------------------------------------------------------------
/**
 * 现场症状:选曲页点某些卡片没有试听音乐、游戏里那支舞也没背景音乐,但 wav 明明在
 * `songs/<danceId>/` 里。根因是 songs/index.json 里 `dances[].defaultSongId` 指向的条目
 * 不在 `songs[]` 里 —— 运行时那条链(defaultSongId → songById() → song.file)直接返回 null,
 * 全链路静默。歌单被重新导出/外部同步刷过之后就容易留下这种半截状态。
 *
 * 这里直接拿仓库里真实的 songs/index.json 当断言对象:只要出现悬空引用就红。
 * 修复入口:server/app.js 的 publish / syncDraftToIndex 会自动补回;
 * 批量修历史遗留用 `node tmp/fix-dangling-songs.mjs`。
 */
test("T-IDX-7 歌单里不能有悬空的 defaultSongId(否则选曲试听静默没声音)", async () => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL("../songs/index.json", import.meta.url);
  const index = JSON.parse(await readFile(url, "utf8"));
  const songIds = new Set((index.songs || []).map((s) => s.id));
  const dangling = (index.dances || [])
    .filter((d) => d.defaultSongId && !songIds.has(d.defaultSongId))
    .map((d) => `${d.danceId}(→${d.defaultSongId})`);
  assert.deepEqual(dangling, [],
    `这些舞曲的 defaultSongId 在 songs[] 里查不到,选曲试听与游戏音乐都会静默失效:${dangling.join(", ")}`);
});
