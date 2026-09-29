/**
 * songstore.js — 谱面保存:把编辑器上传的「舞曲文件夹」(fbx + 音频 + 谱面)落盘到 songs/ 并更新 index.json。
 *
 * 与 server/app.js 解耦(只用 node 内置 fs/stream 与 scoring 的 codec/校验),
 * 便于在无 express/dotenv 的环境下单测注册表行为。
 *
 * 目标目录布局(与 export-songs-cli 一致):
 *   songs/<danceId>/<danceId>.json        内嵌谱面的 dance-sequence/v1
 *   songs/<danceId>/<danceId>.chart.json  chart/v2 独立谱面
 *   songs/<danceId>/<audioName>           音频(原文件名)
 *   songs/<danceId>/<fbxName>             FBX(原文件名,可选)
 *   songs/index.json                      歌曲索引(追加/替换对应条目)
 *
 * 约定:
 *   - danceId: ^[a-z0-9][a-z0-9_-]{0,63}$(一律小写,保证跨平台安全)
 *   - audio/fbx 用 basename 白名单;新建但目录已存在时 409,除非 overwrite
 *   - 所有写 index.json 都用 tmp+rename 原子替换
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";
import { toStandaloneChart } from "../scoring/src/chartCodec.js";
import { assertValidSequence } from "../scoring/src/contractValidate.js";

const DANCE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|flac)$/i;
const FBX_EXT = /\.fbx$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });

function safeName(name, kind) {
  if (typeof name !== "string" || !name) return null;
  const base = path.basename(name);
  if (!base || base !== name || base.startsWith(".")) return null;
  if (kind === "fbx" && !FBX_EXT.test(base)) return null;
  if (kind === "audio" && !AUDIO_EXT.test(base)) return null;
  return base;
}

function parseSequence(text) {
  let seq;
  try {
    seq = JSON.parse(text);
  } catch {
    throw fail(400, "谱面 JSON 无法解析");
  }
  if (!seq?.chart || !Array.isArray(seq.chart.notes)) throw fail(400, "谱面缺少内嵌 chart.notes");
  try {
    assertValidSequence(seq);
  } catch (e) {
    throw fail(400, `谱面校验失败: ${e.message}`);
  }
  return seq;
}

async function fileExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function createSongStore({ songsDir }) {
  const pending = new Map();
  const locked = new Set();
  const exclusive = async (id, fn) => {
    if (locked.has(id)) throw fail(409, "该曲子正在保存，请稍后重试");
    locked.add(id);
    try {
      return await fn();
    } finally {
      locked.delete(id);
    }
  };
  const dirOf = (danceId) => path.join(songsDir, danceId);
  const pendingOf = (danceId, token) => {
    const p = pending.get(danceId);
    if (!p) throw fail(404, "先创建保存任务(POST /api/songs)");
    if (p.ownerToken !== token) throw fail(403, "无权操作该保存任务");
    return p;
  };
  const writeStream = async (stream, destination, limit, label) => {
    let size = 0;
    const temp = `${destination}.upload`;
    try {
      await pipeline(stream, new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        done(size > limit ? fail(413, `${label} 超过大小限制`) : null, chunk);
      } }), createWriteStream(temp));
      if (!size) throw fail(400, `${label} 文件为空`);
      await rename(temp, destination);
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
  };
  const updateIndex = async (danceId, entry) => {
    const indexPath = path.join(songsDir, "index.json");
    let index;
    try {
      index = JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
      index = { schema: "songs/index/v1", dances: [], songs: [] };
    }
    index.dances = (index.dances ?? []).filter((d) => d.id !== danceId);
    index.songs = (index.songs ?? []).filter((s) => s.id !== danceId);
    index.dances.push({
      id: danceId,
      label: entry.label,
      danceId,
      defaultSongId: danceId,
      chartFile: `${danceId}.chart.json`,
      musicFile: entry.audioName,
      fbxFile: entry.fbxName ?? null,
    });
    index.songs.push({ id: danceId, label: entry.label, file: entry.audioName, bpm: entry.bpm });
    const tmp = `${indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(index, null, 2));
    await rename(tmp, indexPath);
  };
  return {
    /** 创建保存任务;目录已存在且未 overwrite 时 409。ownerToken 用于后续 PUT/complete 鉴权。 */
    async create({ danceId, label, bpm, fbxName, audioName, overwrite = false }) {
      danceId = String(danceId || "").toLowerCase();
      if (!DANCE_ID.test(danceId)) throw fail(400, "danceId 需为小写字母/数字/_-，长度 ≤64，且以字母或数字开头");
      label = String(label ?? danceId).trim().slice(0, 120) || danceId;
      if (!(Number.isFinite(bpm) && bpm >= 40 && bpm <= 300)) throw fail(400, "BPM 需在 40–300 之间");
      const fbx = fbxName ? safeName(fbxName, "fbx") : null;
      if (fbxName && !fbx) throw fail(400, `非法的 FBX 文件名: ${fbxName}`);
      const audio = audioName ? safeName(audioName, "audio") : null;
      if (audioName && !audio) throw fail(400, `非法的音频文件名: ${audioName}`);
      await exclusive(danceId, async () => {
        if (await fileExists(dirOf(danceId))) {
          if (!overwrite) throw fail(409, `songs/${danceId}/ 已存在，如需覆盖请带上 overwrite`);
        } else {
          await mkdir(dirOf(danceId), { recursive: true });
        }
      });
      const ownerToken = token();
      pending.set(danceId, { ownerToken, label, bpm, fbxName: fbx, audioName: audio, createdAt: Date.now() });
      return { danceId, ownerToken };
    },
    /** 流式写入 fbx / 音频(basename 白名单;无则 400)。 */
    async putFile(danceId, kind, token_, stream) {
      const p = pendingOf(danceId, token_);
      const name = kind === "fbx" ? p.fbxName : p.audioName;
      if (!name) throw fail(400, `本次保存没有 ${kind} 文件`);
      const limit = kind === "audio" ? 128 * 1024 * 1024 : 64 * 1024 * 1024;
      await exclusive(danceId, () => writeStream(stream, path.join(dirOf(danceId), name), limit, kind));
    },
    /** 接收内嵌谱面的序列 JSON(text/plain),落盘 <danceId>.json 并派生独立谱面。 */
    async putSequence(danceId, token_, bodyText) {
      const p = pendingOf(danceId, token_);
      const seq = parseSequence(bodyText);
      await exclusive(danceId, async () => {
        const dst = path.join(dirOf(danceId), `${danceId}.json`);
        await writeFile(dst, JSON.stringify(seq, null, 2));
        const standalone = toStandaloneChart(seq.chart ?? {}, { sequenceFile: `${danceId}.json` });
        await writeFile(path.join(dirOf(danceId), `${danceId}.chart.json`), JSON.stringify(standalone, null, 2));
      });
    },
    /** 写 index.json(替换或追加对应条目),随后清除保存任务。 */
    async complete(danceId, token_) {
      const p = pendingOf(danceId, token_);
      await exclusive(danceId, async () => {
        await updateIndex(danceId, p);
        pending.delete(danceId);
      });
      return { danceId };
    },
    pending,
  };
}

function token() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}