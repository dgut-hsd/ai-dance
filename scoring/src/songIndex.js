/**
 * songIndex.js — songs/index.json 的**只增不改**合并(纯函数,可单测)。
 *
 * 为什么需要:index.json 里既有「生成器负责的内置曲」,也有「编辑器保存的曲目」和**人工改过的字段**
 * (例如把内置曲的 label 改成中文名、给 demo 换 id)。以前 `export-songs` 每次都按生成器的顺序整体
 * 重写,于是:
 *   · 人工改的 label 被覆盖回默认值;
 *   · demo 那条的 id 从 `demo-arena-loop` 变成 `demo` 并挪到数组最前 → PK 卡片顺序变化;
 *   · 编辑器保存的曲目虽然被保留,但顺序被挤到末尾。
 * 现在改成:以**已有 index 为骨架**,同一支舞(danceId 相同)原样保留(位置、id、label 都不动),
 * 只把生成器里有、index 里没有的**追加**到末尾。要回到「全量重写」用 `force: true`。
 */

const byDance = (d) => [d?.id, d?.danceId].filter(Boolean);

/**
 * @param {{dances?: Array, songs?: Array}|null} prev 现有 index(可为 null = 全新生成)
 * @param {{dances: Array, songs: Array}} built 本次生成器产出的条目
 * @param {{force?: boolean}} [opts] force=true → 生成器条目在前、按生成器顺序(index 之外的仍追加)
 * @returns {{index: {schema: string, dances: Array, songs: Array}, preserved: number, appended: number, replaced: number}}
 */
export function mergeSongIndex(prev, built, opts = {}) {
  const force = opts.force === true;
  const schema = "songs/index/v1";
  const prevDances = Array.isArray(prev?.dances) ? prev.dances.filter(Boolean) : [];
  const prevSongs = Array.isArray(prev?.songs) ? prev.songs.filter(Boolean) : [];

  if (force || !prev) {
    // 旧行为:生成器条目在前(按生成器顺序),index 里多出来的追加到后面
    const builtDanceKeys = new Set(built.dances.flatMap(byDance));
    const builtSongIds = new Set(built.songs.map((s) => s.id));
    const dances = [...built.dances, ...prevDances.filter((d) => !byDance(d).some((k) => builtDanceKeys.has(k)))];
    const songs = [...built.songs, ...prevSongs.filter((s) => !builtSongIds.has(s.id))];
    return { index: { schema, dances, songs }, preserved: dances.length - built.dances.length, appended: 0, replaced: built.dances.length };
  }

  // 只增不改:已有条目原样保留(含位置与人工改过的字段),缺的追加
  const knownDanceKeys = new Set(prevDances.flatMap(byDance));
  const knownSongIds = new Set(prevSongs.map((s) => s.id));
  const dances = [...prevDances];
  const songs = [...prevSongs];
  let appended = 0;
  for (const d of built.dances) {
    if (byDance(d).some((k) => knownDanceKeys.has(k))) continue; // 已存在(哪怕 id 不同)→ 不动
    dances.push(d);
    appended += 1;
  }
  for (const s of built.songs) {
    if (knownSongIds.has(s.id)) continue;
    songs.push(s);
    appended += 1;
  }
  return { index: { schema, dances, songs }, preserved: prevDances.length + prevSongs.length, appended, replaced: 0 };
}

/**
 * 已有谱面是否被**编辑器手改过**。生成器写出的谱面只有 `{schema, sequenceFile, audio, notes}`,
 * 而编辑器保存时会带 `judgeOffsetSec` / `audioOffsetSec`,判定点还会带 `refFrameIdx`(绑定到参考帧)。
 * 用这些标记判断,比"看目录里有没有文件"更准:能保护任何被手改过的曲目,而不只是 demo。
 */
export function chartLooksEdited(chart) {
  if (!chart || typeof chart !== "object") return false;
  if (chart.judgeOffsetSec != null || chart.audioOffsetSec != null) return true;
  return Array.isArray(chart.notes) && chart.notes.some((n) => n && n.refFrameIdx != null);
}

/**
 * 这支舞的产物是否已被人工/编辑器接管(存在就不覆盖,除非 --force)。
 * @param {string[]} dirFiles 该舞目录下已有的文件名
 * @param {{kind?:string, danceId:string}} dance
 * @param {(name:string)=>any} [readJson] 读同目录 JSON(用于识别编辑器改过的谱面)
 */
export function isEditorOwned(dirFiles, dance, readJson) {
  if (!dance?.danceId) return false;
  if (!dirFiles.includes(`${dance.danceId}.json`)) return false; // 没有序列 → 全新生成
  if (dance.kind === "demo") return true; // demo 的序列/谱面天生就是编辑器内容
  return chartLooksEdited(readJson?.(`${dance.danceId}.chart.json`));
}
