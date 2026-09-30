/**
 * draftstore.js — 「作品工坊」作品存储:一个作品 = 一个 .drafts/<id>/ 目录。
 *
 * 作品文件布局:
 *   .drafts/<id>/draft.json      状态 + 元数据 + 文件引用
 *   .drafts/<id>/<sourceName>    素材(视频或 fbx,原文件名)
 *   .drafts/<id>/<audioName>     音频(原文件名)
 *   .drafts/<id>/sequence.json   动作序列(dance-sequence/v1)
 *   .drafts/<id>/chart.json      谱面(chart/v2)
 *   .drafts/<id>/lane/           判定轨道白影
 *
 * 作品状态(status)就是「草稿 / 已上架 / 回收站」三者,所有生命周期操作都只改这个字段:
 *   draft      —— 在工坊里编辑中
 *   published  —— 已上架(songs/ 里有一份对外可玩的拷贝)
 *   trashed    —— 回收站(软删除,文件都还在)
 *
 * external=true 表示这是从 songs/index.json 同步过来的「老作品」:
 * 它的文件不在自己的目录里,而在 songs/<danceId>/(files 里存的是那边的真实文件名)。
 * 一旦被「打回草稿」,app.js 会把文件拷进作品目录并把 external 置回 false。
 *
 * 与 server/app.js 解耦(只用 node 内置 fs/stream),便于单测。
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import path from "node:path";

const fail = (status, message) => Object.assign(new Error(message), { status });
const META_EXT = {
  source: /\.(mp4|mov|webm|mkv|fbx)$/i,
  audio: /\.(wav|mp3|ogg|m4a|flac)$/i,
};

function token() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function createDraftStore({ draftsDir }) {
  const dirOf = (id) => path.join(draftsDir, id);
  const draftFile = (id) => path.join(dirOf(id), "draft.json");

  const read = async (id) => {
    try { return JSON.parse(await readFile(draftFile(id), "utf8")); }
    catch { return null; }
  };
  const persist = async (draft) => {
    await mkdir(dirOf(draft.id), { recursive: true });
    const tmp = `${draftFile(draft.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(draft, null, 2));
    await rename(tmp, draftFile(draft.id));
  };
  const save = persist;
  const touch = (draft) => { draft.updatedAt = Date.now(); };
  const statusOf = (draft) => {
    const f = draft.files || {};
    if (f.chart) return "chart";
    if (f.sequence) return "sequence";
    if (f.audio) return "audio";
    if (f.source) return "source";
    return "new";
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

  return {
    async list() {
      let names = [];
      try { names = await readdir(draftsDir); } catch { return []; }
      const out = [];
      for (const name of names) {
        if (!/^[\w-]{16,64}$/.test(name)) continue;
        const d = await read(name);
        if (d && d.id === name) out.push(d);
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async create({ mode, label, status = "draft", external = false, danceId = "", files = null, bpm = 120, videoName = "", songId = "" }) {
      if (!["video", "3d"].includes(mode)) throw fail(400, "mode 需为 video 或 3d");
      label = String(label || "").trim().slice(0, 120) || (mode === "video" ? "未命名视频作品" : "未命名3D作品");
      const id = token();
      await mkdir(dirOf(id), { recursive: true });
      const now = Date.now();
      const draft = {
        schema: "drafts/v2",
        id, mode, label,
        status,                       // draft | published | trashed
        external: Boolean(external),  // true = 文件在 songs/<danceId>/
        danceId,
        bpm,
        videoName,                    // 视频模式绑定的视频文件名
        songId,                       // 绑定的歌曲 id
        files: files || { source: null, audio: null, sequence: null, chart: null, lane: null },
        publishedAt: status === "published" ? now : null,
        trashedAt: status === "trashed" ? now : null,
        createdAt: now, updatedAt: now,
      };
      await save(draft);
      return draft;
    },

    async get(id) {
      const d = await read(id);
      if (!d) throw fail(404, "草稿不存在");
      return d;
    },

    /** 上传素材/音频(原文件名白名单)。kind: "source" | "audio" */
    async putFile(id, kind, name, stream) {
      const draft = await read(id);
      if (!draft) throw fail(404, "草稿不存在");
      const base = path.basename(String(name || ""));
      if (!base || base !== name || base.startsWith(".") || !META_EXT[kind].test(base)) {
        throw fail(400, `非法的 ${kind === "source" ? "素材" : "音频"} 文件名`);
      }
      const limit = kind === "source" ? 1024 * 1024 * 1024 : 512 * 1024 * 1024;
      // 同名旧文件先清掉,避免残留
      const old = draft.files?.[kind];
      if (old && old !== base) await rm(path.join(dirOf(id), old), { force: true });
      await writeStream(stream, path.join(dirOf(id), base), limit, kind);
      draft.files = draft.files || {};
      draft.files[kind] = base;
      touch(draft);
      await save(draft);
      return draft;
    },

    /** 仅记录文件引用(文件已由调用方写入,如 ffmpeg 抽音频)。kind: "source" | "audio" */
    async setFile(id, kind, name) {
      const draft = await read(id);
      if (!draft) throw fail(404, "草稿不存在");
      draft.files = draft.files || {};
      draft.files[kind] = name;
      touch(draft);
      await save(draft);
      return draft;
    },

    /** 保存文本文件。kind: "sequence" | "chart" */
    async putText(id, kind, text) {
      const draft = await read(id);
      if (!draft) throw fail(404, "草稿不存在");
      const name = kind === "sequence" ? "sequence.json" : "chart.json";
      await writeFile(path.join(dirOf(id), name), String(text ?? ""));
      draft.files = draft.files || {};
      draft.files[kind] = name;
      touch(draft);
      await save(draft);
      return draft;
    },

    /** 读草稿里某个文本文件。 */
    async getText(id, kind) {
      const draft = await read(id);
      if (!draft) throw fail(404, "草稿不存在");
      const name = kind === "sequence" ? "sequence.json" : "chart.json";
      try { return await readFile(path.join(dirOf(id), name), "utf8"); }
      catch { return null; }
    },

    async updateMeta(id, { label, danceId, bpm, videoName, songId }) {
      const draft = await read(id);
      if (!draft) throw fail(404, "作品不存在");
      if (typeof label === "string" && label.trim()) draft.label = label.trim().slice(0, 120);
      if (typeof danceId === "string") draft.danceId = String(danceId).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
      if (bpm !== undefined && Number.isFinite(+bpm) && +bpm >= 40 && +bpm <= 300) draft.bpm = +bpm;
      // 绑定的视频/歌曲:允许置空(取消绑定)
      if (videoName !== undefined) draft.videoName = String(videoName || "").slice(0, 200);
      if (songId !== undefined) draft.songId = String(songId || "").slice(0, 120);
      touch(draft);
      await save(draft);
      return draft;
    },

    /** 只改状态 + 记时间戳(上架 / 打回草稿 / 删除 / 找回都走这里)。 */
    async setStatus(id, status) {
      if (!["draft", "published", "trashed"].includes(status)) throw fail(400, "status 非法");
      const draft = await read(id);
      if (!draft) throw fail(404, "作品不存在");
      draft.status = status;
      if (status === "published") draft.publishedAt = Date.now();
      if (status === "trashed") draft.trashedAt = Date.now();
      if (status !== "trashed") draft.trashedAt = null;
      touch(draft);
      await save(draft);
      return draft;
    },

    /** 直接落盘一条记录(app.js 里改完字段后调用)。 */
    async put(draft) {
      if (!draft?.id) throw fail(400, "缺少 id");
      touch(draft);
      await persist(draft);
      return draft;
    },

    /** 是否有这个作品目录(用于「老作品同步」时判断)。 */
    async has(id) {
      return Boolean(await read(id));
    },

    async remove(id) {
      await rm(dirOf(id), { recursive: true, force: true });
    },

    dirOf,
    statusOf,
  };
}
