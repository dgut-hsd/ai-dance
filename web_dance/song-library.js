/**
 * song-library.js — 歌单(songs/index.json)与舞曲序列(songs/<danceId>/<danceId>.json)的文件读取层。
 */
const INDEX_URL = "../songs/index.json";

let index = null;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

/** 启动时导入歌单;幂等 */
export async function loadSongIndex() {
  if (index) return index;
  index = await fetchJson(INDEX_URL);
  return index;
}

export function songIndex() {
  return index;
}

export function dances() {
  return index?.dances ?? [];
}

export function songs() {
  return index?.songs ?? [];
}

export function danceById(id) {
  return dances().find((d) => d.id === id) ?? null;
}

export function songById(id) {
  return songs().find((s) => s.id === id) ?? null;
}

/**
 * 按 danceId 读入一首舞曲序列(songs/<danceId>/<danceId>.json)。
 * 文件内的 chart.audio / meta.audio 为相对本曲目录的相对路径 → 重基成页面可 fetch 的 URL。
 */
export async function loadSequence(danceId) {
  const fileUrl = `../songs/${danceId}/${danceId}.json`;
  const seq = await fetchJson(fileUrl);
  const base = `../songs/${danceId}/`;
  for (const key of ["chart", "meta"]) {
    const block = seq[key];
    const audio = block?.audio;
    if (audio && typeof audio === "string" && !/^(data:|blob:|https?:|file:|\/)/.test(audio)) {
      block.audio = base + audio;
    }
  }
  return seq;
}