import 'dotenv/config';
import express from 'express';
import OSS from 'ali-oss';
import QRCode from 'qrcode';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVideo, makeFullVideo, validPng, runFFmpeg, ffmpegPath, thumbArgs } from './media.js';
import { buildHighlightStory, validateMetadata } from './highlight.js';
import { createSongStore } from './songstore.js';
import { createDraftStore } from './draftstore.js';
import { videoFileMeta } from './videoMeta.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = () => randomBytes(24).toString('base64url');
const hash = s => createHash('sha256').update(String(s || '')).digest();
const equal = (a, b) => timingSafeEqual(hash(a), hash(b));
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_BYTES = 512 * 1024 * 1024;
const DAY = 86400000;
const mimeTypes = new Set(['video/webm', 'video/mp4']);

export async function createApp(options = {}) {
  const data = path.resolve(options.dataDir || process.env.HIGHLIGHT_DATA_DIR || path.join(root, '.highlight-data'));
  const publicBase = (options.publicBase || process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8000}`).replace(/\/$/, '');
  const deviceToken = options.deviceToken ?? process.env.DEVICE_TOKEN ?? '';
  const mode = options.storage || process.env.STORAGE_MODE || 'local';
  if (!['local', 'oss'].includes(mode)) throw new Error('STORAGE_MODE must be local or oss');
  const songsDir = path.resolve(options.songsDir || process.env.SONGS_DIR || path.join(root, 'songs'));
  const songStore = createSongStore({ songsDir });
  const draftsDir = path.resolve(options.draftsDir || process.env.DRAFTS_DIR || path.join(root, '.drafts'));
  await mkdir(draftsDir, { recursive: true });
  const draftStore = createDraftStore({ draftsDir });
  const videosDir = path.resolve(options.videosDir || process.env.VIDEOS_DIR || path.join(root, 'videos'));
  const highlightIntro = path.resolve(options.highlightIntro || process.env.HIGHLIGHT_INTRO ||
    path.join(videosDir, 'rokoko导入视频', '开场.mp4'));
  const highlightIntroDuration = Number(options.highlightIntroDuration || process.env.HIGHLIGHT_INTRO_DURATION) || 3.6;
  const videoMapFile = path.join(videosDir, 'index.json');
  const readVideoMap = async () => {
    try {
      const parsed = JSON.parse(await readFile(videoMapFile, 'utf8'));
      return parsed && typeof parsed.mapping === 'object' && !Array.isArray(parsed.mapping) ? parsed.mapping : {};
    } catch { return {}; }
  };
  const writeVideoMap = async (mapping) => {
    const tmp = `${videoMapFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ schema: 'videos/index/v1', mapping }, null, 2));
    await rename(tmp, videoMapFile);
  };
  const readMp4Names = async () => {
    try {
      return (await readdir(videosDir)).filter((f) => /\.mp4$/i.test(f));
    } catch { return []; }
  };
  const readDanceIds = async () => {
    try {
      const idx = JSON.parse(await readFile(path.join(songsDir, 'index.json'), 'utf8'));
      return (idx.dances || []).map((d) => d.id).filter((id) => typeof id === 'string' && id);
    } catch { return []; }
  };

  // ---- 作品(工坊) ↔ 已上架歌单 的桥梁 ---------------------------------------
  const songsIndexFile = path.join(songsDir, 'index.json');
  const readSongsIndex = async () => {
    try {
      const idx = JSON.parse(await readFile(songsIndexFile, 'utf8'));
      return { schema: idx.schema || 'songs/index/v1', dances: idx.dances || [], songs: idx.songs || [] };
    } catch { return { schema: 'songs/index/v1', dances: [], songs: [] }; }
  };
  const writeSongsIndex = async (idx) => {
    const tmp = `${songsIndexFile}.tmp`;
    await writeFile(tmp, JSON.stringify(idx, null, 2));
    await rename(tmp, songsIndexFile);
  };
  const fileExists = async (p) => { if (!p) return false; try { await stat(p); return true; } catch { return false; } };
  /** 作品的文件目录:普通作品在自己的 .drafts/<id>/;external 老作品在 songs/<danceId>/。 */
  const workDirOf = (draft) => (draft.external && draft.danceId)
    ? path.join(songsDir, draft.danceId)
    : draftStore.dirOf(draft.id);
  /** 作品里某个文件的绝对路径(真实文件名存在 files 里,两种目录布局通用)。 */
  const workFileOf = (draft, kind) => {
    const name = draft.files?.[kind];
    return name ? path.join(workDirOf(draft), name) : null;
  };

  /** 把 songs/index.json 里已有的舞曲补成「已上架」作品记录(只补元数据,不动文件)。 */
  const syncLegacyWorks = async () => {
    const [idx, drafts, mapping] = await Promise.all([readSongsIndex(), draftStore.list(), readVideoMap()]);
    const known = new Set(drafts.map((d) => d.danceId).filter(Boolean));
    let added = 0;
    for (const d of idx.dances) {
      if (!d?.danceId || known.has(d.danceId)) continue;
      const song = idx.songs.find((s) => s.id === (d.defaultSongId || d.id));
      const videoName = mapping[d.danceId] || '';
      // 老歌单没有 mode,按素材来源推断:有 FBX 动作的一律算 3D 作品
      // (copydance1 这种「3D 动作 + 另外绑了参考视频」的,两个列表都该进,不能判成视频作品);
      // 只有「没有 FBX、完全靠视频撑起来」的才算视频作品。
      const legacyMode = d.fbxFile ? '3d' : (videoName ? 'video' : '3d');
      await draftStore.create({
        mode: legacyMode,
        label: d.label || d.danceId,
        status: 'published',
        external: true,                 // 文件在 songs/<danceId>/
        danceId: d.danceId,
        bpm: song?.bpm ?? 120,
        videoName,
        songId: d.defaultSongId || '',
        files: {
          // 素材:3D 作品是 FBX,视频作品才是视频。两者都有时以 FBX 为准
          // (copydance1 = FBX 动作 + 另外绑了参考视频,它的素材是 FBX,不是那个视频)
          source: d.fbxFile || videoName || null,
          audio: d.musicFile || null,
          sequence: `${d.danceId}.json`,
          chart: d.chartFile || null,
          lane: null,
        },
      });
      added++;
    }
    return added;
  };

  /** 从已上架歌单里摘掉一支舞曲(打回草稿 / 删除时用),并清掉视频绑定。 */
  const unpublishFromIndex = async (danceId) => {
    if (!danceId) return;
    const idx = await readSongsIndex();
    idx.dances = idx.dances.filter((d) => d.danceId !== danceId && d.id !== danceId);
    idx.songs = idx.songs.filter((s) => s.id !== danceId);
    await writeSongsIndex(idx);
    const mapping = await readVideoMap();
    if (danceId in mapping) { mapping[danceId] = ''; await writeVideoMap(mapping); }
  };

  /**
   * 把已上架作品的改动同步回 songs/index.json。
   *
   * 工坊里有两条改名路径,以前只有「绑定音乐/视频」那条会同步,「打开编辑」里的标题框直接写草稿文件,
   * 于是同一个作品在工坊显示新名字、在游戏里还是旧名字。两条路径现在都走这里。
   *
   * 两条硬规则(都是踩过的坑):
   *   · songId 只认非空值 —— 面板的下拉在没有匹配项时值为 "",以前会照单写入,把
   *     dance.defaultSongId 清成一个不存在的 id,绑定从此静默丢失。
   *   · songs[] 里查不到那条歌曲时**按草稿补一条**,而不是只警告 —— 见下面「悬空引用」。
   */
  const syncDraftToIndex = async (draft) => {
    if (draft.status !== 'published' || !draft.danceId) return false;
    const idx = await readSongsIndex();
    const dance = idx.dances.find((d) => d.danceId === draft.danceId || d.id === draft.danceId);
    if (!dance) return false;
    let changed = false;
    if (draft.label && dance.label !== draft.label) { dance.label = draft.label; changed = true; }
    // 悬空引用:defaultSongId 指向的歌曲条目不在 songs[] 里(歌单被重新导出刷掉过、或手工删过条目)。
    // 后果是**静默没声音**:选曲试听走 performanceMusicUrl() = dance.defaultSongId → songById → song.file,
    // 查不到就返回 null,于是「其他视频点卡片没音频,只有个别有」。以前这里只 warn 就跳过,
    // 坏状态会一直留在歌单里。现在按草稿自己的音频文件补回一条(口径与 publish 里新建条目一致)。
    if (!idx.songs.some((s) => s.id === dance.defaultSongId)) {
      const audioFile = String(draft.files?.audio || dance.musicFile || '');
      idx.songs.push({
        id: dance.defaultSongId || draft.danceId,
        label: draft.label || dance.label || draft.danceId,
        file: audioFile,
        bpm: draft.bpm || 120,
      });
      if (audioFile) dance.musicFile = audioFile;
      changed = true;
      console.warn(`[works] ${draft.danceId} 的歌曲条目(${dance.defaultSongId})不在歌单里,已按草稿补回:${audioFile}`);
    }
    if (draft.songId) {
      const song = idx.songs.find((s) => s.id === draft.songId);
      if (!song) console.warn(`[works] ${draft.danceId} 绑定的歌曲 ${draft.songId} 不在歌单里,跳过歌曲同步`);
      else {
        if (dance.defaultSongId !== song.id) { dance.defaultSongId = song.id; changed = true; }
        if (dance.musicFile !== song.file) { dance.musicFile = song.file; changed = true; }
      }
    }
    if (changed) await writeSongsIndex(idx);
    return changed;
  };

  /** 把 external(老)作品的文件拷回自己的作品目录,之后它就是普通草稿。 */
  const materializeWork = async (draft) => {
    if (!draft.external) return draft;
    const dir = draftStore.dirOf(draft.id);
    await mkdir(dir, { recursive: true });
    const songDir = draft.danceId ? path.join(songsDir, draft.danceId) : '';
    const copyIn = async (src, dstName) => {
      if (!src || !dstName || !(await fileExists(src))) return null;
      await copyFile(src, path.join(dir, dstName));
      return dstName;
    };
    const files = { source: null, audio: null, sequence: null, chart: null, lane: null };
    // 序列/谱面落成规范文件名,后续步骤才能照常读写
    files.sequence = await copyIn(draft.files.sequence ? path.join(songDir, draft.files.sequence) : null, 'sequence.json');
    files.chart = await copyIn(draft.files.chart ? path.join(songDir, draft.files.chart) : null, 'chart.json');
    files.audio = await copyIn(draft.files.audio ? path.join(songDir, draft.files.audio) : null, draft.files.audio);
    if (draft.files.source) {
      // 3D:FBX 在 songs/ 里,拷回作品目录;视频:本来就在 videos/,只留名字,不重复拷一份
      files.source = draft.mode === '3d'
        ? await copyIn(path.join(songDir, draft.files.source), draft.files.source)
        : draft.files.source;
    }
    // 判定轨道白影在 assets/lane/<danceId>/
    const laneSrc = draft.danceId ? path.join(root, 'web_dance', 'assets', 'lane', draft.danceId) : '';
    if (laneSrc && (await fileExists(path.join(laneSrc, 'manifest.json')))) {
      const dstLane = path.join(dir, 'lane');
      await mkdir(dstLane, { recursive: true });
      for (const f of await readdir(laneSrc)) {
        if (f === 'manifest.json' || /\.png$/i.test(f)) await copyFile(path.join(laneSrc, f), path.join(dstLane, f));
      }
      files.lane = 'lane/manifest.json';
    }
    draft.files = files;
    draft.external = false;
    return draftStore.put(draft);
  };

  /** 写操作前先确保作品有自己的本地目录(external 老作品会被拷回来)。 */
  const ensureLocal = async (id) => {
    const draft = await draftStore.get(id);
    return draft.external ? materializeWork(draft) : draft;
  };
  // 舞曲视频:缩略图(懒生成) + 元数据(ffmpeg 探测,进程内缓存)。
  const postersDir = path.join(videosDir, '.posters');
  await mkdir(postersDir, { recursive: true });
  const posterFile = (name) => path.join(postersDir, `${name}.jpg`);
  const ensurePoster = async (name) => {
    const dst = posterFile(name);
    try { await stat(dst); return dst; } catch { /* 生成 */ }
    const src = path.join(videosDir, name);
    for (const ss of ['1', '0']) {
      try {
        await runFFmpeg(['-ss', ss, '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', dst], 30000);
        return dst;
      } catch { /* 换 0s 再试 */ }
    }
    return null;
  };
  const videoMeta = new Map();
  const probeVideo = (file) => new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-12000); });
    child.on('error', () => resolve({ duration: null, width: null, height: null }));
    child.on('close', () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const vid = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
      const seconds = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : null;
      resolve({
        duration: Number.isFinite(seconds) ? Math.round(seconds) : null,
        width: vid ? +vid[1] : null,
        height: vid ? +vid[2] : null,
      });
    });
  });
  const getVideoMeta = async (name) => {
    if (videoMeta.has(name)) return videoMeta.get(name);
    const meta = await probeVideo(path.join(videosDir, name));
    videoMeta.set(name, meta);
    return meta;
  };
  // ---- 视频素材的比例元数据(videos/index.json 的 files 段) --------------------
  // 页面靠它决定右侧画面容器摆多宽,不再固定 55vw + object-fit: cover
  // (后者会把 9:16 的视频左右各裁掉约 41%,舞者的手脚直接出画)。
  // files 与 mapping 互不干扰:写这里绝不能动 mapping,否则玩家绑好的视频会全部失效。
  const readVideoFiles = async () => {
    try {
      const parsed = JSON.parse(await readFile(videoMapFile, 'utf8'));
      return parsed && typeof parsed.files === 'object' && !Array.isArray(parsed.files) ? parsed.files : {};
    } catch { return {}; }
  };
  /** 合并写回:始终带上 mapping,免得只更新 files 时把绑定清空。 */
  const applyVideoFiles = async (entries) => {
    const [mapping, files] = await Promise.all([readVideoMap(), readVideoFiles()]);
    const next = { ...files };
    for (const [name, meta] of Object.entries(entries)) next[name] = meta;
    const tmp = `${videoMapFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ schema: 'videos/index/v1', mapping, files: next }, null, 2));
    await rename(tmp, videoMapFile);
    for (const name of Object.keys(entries)) videoMeta.delete(name);
    return next;
  };
  /** 比例表:已有元数据直接用,没有的现探一次(探测失败给全 null,不阻塞页面)。 */
  const getVideoFiles = async (names) => {
    const known = await readVideoFiles();
    const out = {};
    const fresh = {};
    for (const name of names) {
      if (known[name]) { out[name] = known[name]; continue; }
      const meta = videoFileMeta(await getVideoMeta(name).catch(() => null));
      out[name] = meta;
      fresh[name] = meta;
    }
    if (Object.keys(fresh).length) await applyVideoFiles(fresh).catch(() => {});
    return out;
  };
  // 启动时补齐:以前部署的 videos/index.json 没有 files 段,页面首次加载就得能用上比例。
  // 放到空闲时段做,而且只补 videos/ 里真实存在的文件 —— 不阻塞 listen,也不给测试期
  // 没装 ffmpeg 的环境添麻烦(探测失败会被 catch 成"比例未知",不是错误)。
  void (async () => {
    try {
      const present = (await readdir(videosDir)).filter((f) => /\.mp4$/i.test(f));
      const known = await readVideoFiles();
      const missing = present.filter((f) => !known[f]);
      if (missing.length) await getVideoFiles(missing);
    } catch { /* 元数据是增强信息,补不上也不能影响启动 */ }
  })();
  const baseURL = new URL(publicBase);
  if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.pathname !== '/' || baseURL.search || baseURL.hash)
    throw new Error('PUBLIC_BASE_URL must be an HTTP(S) origin');
  if (!deviceToken && !['localhost', '127.0.0.1', '[::1]'].includes(baseURL.hostname))
    throw new Error('对外访问必须设置 DEVICE_TOKEN');
  const oss = mode === 'oss' ? new OSS({
    region: process.env.OSS_REGION, bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    stsToken: process.env.OSS_STS_TOKEN || undefined, secure: true,
  }) : null;
  const delivery = oss && process.env.OSS_PUBLIC_DOMAIN ? new OSS({
    region: process.env.OSS_REGION, bucket: process.env.OSS_BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    stsToken: process.env.OSS_STS_TOKEN || undefined,
    endpoint: process.env.OSS_PUBLIC_DOMAIN, cname: true, secure: true,
  }) : oss;
  await mkdir(data, { recursive: true });
  const jobs = new Map();
  const SHORT_VIDEO = 'short.mp4';
  const LONG_VIDEO = 'long.mp4';
  const workDir = j => path.join(data, j.id);
  const object = (j, name) => `highlights/${j.id}/${name}`;
  const save = async j => {
    await mkdir(workDir(j), { recursive: true });
    await writeFile(path.join(workDir(j), 'job.tmp'), JSON.stringify(j));
    await rename(path.join(workDir(j), 'job.tmp'), path.join(workDir(j), 'job.json'));
  };
  for (const name of await readdir(data)) {
    if (!/^[\w-]{32}$/.test(name)) continue;
    try {
      const j = JSON.parse(await readFile(path.join(data, name, 'job.json'), 'utf8'));
      if (j.id !== name) continue;
      if (j.status === 'processing') j.status = 'queued';
      if (j.fullStatus === 'processing') {
        j.fullStatus = 'failed';
        j.fullError = '服务重启中断了完整纪念版生成，高光成片仍可正常领取';
      }
      jobs.set(j.id, j);
    } catch { /* Ignore incomplete metadata, never serve it. */ }
  }
  let busy = false, closed = false;
  const locked = new Set();
  async function exclusive(id, fn) {
    if (locked.has(id)) throw fail(409, '本局正在操作，请稍后重试');
    locked.add(id);
    try { return await fn(); } finally { locked.delete(id); }
  }
  async function downloadSource(j) {
    if (!oss) return;
    const response = await fetch(oss.signatureUrl(object(j, 'source'), { expires: 300 }), { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('原始录像读取失败');
    await boundedWrite(Readable.fromWeb(response.body), path.join(workDir(j), 'source'), MAX_BYTES);
  }
  async function pump() {
    if (busy || closed) return;
    const j = [...jobs.values()].find(x => x.status === 'queued' && x.expiresAt > Date.now() && !locked.has(x.id));
    if (!j) return;
    busy = true;
    await exclusive(j.id, async () => {
      try {
        j.status = 'processing'; await save(j);
        await downloadSource(j);
        const clip = { ...buildHighlightStory(j.metadata), introDuration: highlightIntroDuration,
          sourceDuration: j.metadata.duration };
        const dir = workDir(j);
        await (options.makeVideo || makeVideo)(path.join(dir, 'source'), path.join(dir, SHORT_VIDEO),
          path.join(dir, 'poster.jpg'), path.join(dir, 'card.png'), clip, highlightIntro, path.join(dir, 'thumb.jpg'));
        if (oss) {
          await oss.put(object(j, SHORT_VIDEO), path.join(dir, SHORT_VIDEO), { headers: { 'Content-Type': 'video/mp4' } });
          await oss.put(object(j, 'poster.jpg'), path.join(dir, 'poster.jpg'), { headers: { 'Content-Type': 'image/jpeg' } });
          // 缩略图是给取片台认人用的,不能因为它上传失败就让整条成片失败。
          try { await oss.put(object(j, 'thumb.jpg'), path.join(dir, 'thumb.jpg'), { headers: { 'Content-Type': 'image/jpeg' } }); }
          catch (e) { console.error('Thumbnail upload failed', j.id, e.message); }
        }
        j.clip = clip; j.artifactVersion = 'short-long-v1'; j.status = 'ready'; j.error = null; j.readyAt = Date.now();
        await save(j);
        try {
          j.fullStatus = 'processing'; j.fullError = null; await save(j);
          await (options.makeFullVideo || makeFullVideo)(path.join(dir, 'source'), path.join(dir, LONG_VIDEO),
            path.join(dir, 'card.png'), clip, highlightIntro);
          if (oss) await oss.put(object(j, LONG_VIDEO), path.join(dir, LONG_VIDEO), { headers: { 'Content-Type': 'video/mp4' } });
          j.fullStatus = 'ready'; j.fullReadyAt = Date.now();
        } catch (e) {
          console.error('Full video processing failed', j.id, e.message);
          j.fullStatus = 'failed'; j.fullError = '完整纪念版生成失败，高光成片仍可正常领取';
        }
        await save(j);
      } catch (e) {
        console.error('Highlight processing failed', j.id, e.message);
        j.status = 'failed'; j.error = '视频生成失败，可在游戏设备上重试'; await save(j);
      }
    }).catch(e => console.error(e.message));
    busy = false;
    if (!closed) setImmediate(pump);
  }
  async function cleanup() {
    for (const j of jobs.values()) {
      if (locked.has(j.id)) continue;
      try {
        await exclusive(j.id, async () => {
          if (j.expiresAt <= Date.now() || j.status === 'deleted') {
            j.status = j.status === 'deleted' ? 'deleted' : 'expired'; await save(j);
            if (oss) await oss.deleteMulti(['source', SHORT_VIDEO, LONG_VIDEO, 'highlight.mp4', 'full.mp4', 'poster.jpg', 'thumb.jpg'].map(n => object(j, n)));
            await rm(workDir(j), { recursive: true, force: true });
            jobs.delete(j.id);
          } else if (j.createdAt + DAY < Date.now() && j.status === 'ready') {
            await rm(path.join(workDir(j), 'source'), { force: true });
            if (oss && !j.sourceDeleted) { await oss.delete(object(j, 'source')); j.sourceDeleted = true; await save(j); }
          }
        });
      } catch (e) { console.error('Cleanup will retry', e.message); }
    }
  }
  const timer = setInterval(() => { void cleanup(); void pump(); }, 60000);
  timer.unref();
  setImmediate(pump);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) {
      res.set('Cache-Control', 'no-store');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== baseURL.origin)
        return res.status(403).json({ error: '请求来源不允许，请使用配置的访问地址' });
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  const device = (req, res, next) => {
    const ip = req.socket.remoteAddress;
    if (deviceToken ? !equal(req.headers['x-device-token'], deviceToken) : !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip))
      return res.status(401).json({ error: '请在高光设置中填写设备密钥' });
    next();
  };
  const find = req => {
    const j = jobs.get(req.params.id);
    if (!j) throw fail(404, '视频不存在或已过期');
    if (j.expiresAt <= Date.now() || ['expired', 'deleted'].includes(j.status)) throw fail(410, '视频已过期或已删除');
    return j;
  };
  const owner = req => {
    const j = find(req);
    if (!equal(req.headers['x-owner-token'], j.ownerToken)) throw fail(403, '无权操作此视频');
    return j;
  };
  app.get('/api/highlights/config', device, (req, res) => res.json({ storage: mode, maxBytes: MAX_BYTES, maxDuration: 600, publicBase }));
  // Staff console: list all sessions. Requires the device token (or localhost); ownerToken is
  // returned so staff can retry/delete any session from the backend page.
  app.get('/api/highlights', device, (req, res) => {
    res.json([...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(j => ({
      id: j.id, ownerToken: j.ownerToken, status: j.status, mime: j.mime,
      createdAt: j.createdAt, expiresAt: j.expiresAt, readyAt: j.readyAt, retries: j.retries || 0,
      error: j.error, duration: j.clip ? j.clip.duration + (j.clip.cardDuration || 2) + (j.clip.introDuration || 0) : null, result: j.metadata?.result || null,
      fullStatus: j.fullStatus || (j.status === 'ready' ? 'unavailable' : 'waiting'),
      fullError: j.fullError || null,
      fullDuration: j.clip?.sourceDuration ? j.clip.sourceDuration + (j.clip.cardDuration || 2) + (j.clip.introDuration || 0) : null,
      highlightTitle: j.metadata?.highlightTitle || '', highlightCount: j.metadata?.highlights?.length || 0,
      shareUrl: `${publicBase}/v/${j.id}`,
      ...(j.status === 'ready' ? { videoUrl: `/api/highlights/${j.id}/media`, posterUrl: `/api/highlights/${j.id}/poster`, thumbUrl: `/api/highlights/${j.id}/thumb` } : {}),
      ...(j.fullStatus === 'ready' ? { fullVideoUrl: `/api/highlights/${j.id}/full-media` } : {}),
    })));
  });
  app.post('/api/highlights', device, async (req, res) => {
    if (!mimeTypes.has(req.body?.mime)) throw fail(400, '不支持的录像格式');
    // Only the work the single transcode worker must drain belongs in this limit.
    // An `uploading` job consumes no transcode capacity: it is created when the round
    // starts and only becomes `queued` after the client finishes uploading. Counting it
    // here let abandoned tabs (closed page, dropped network) pile up until every new
    // round got 429 - while the player saw nothing, because the client swallows the error.
    if ([...jobs.values()].filter(j => ['queued', 'processing'].includes(j.status)).length >= 20)
      throw fail(429, '待处理视频较多，请稍后重试');
    const j = { id: token(), ownerToken: token(), status: 'uploading', mime: req.body.mime,
      createdAt: Date.now(), expiresAt: Date.now() + 7 * DAY };
    await save(j); jobs.set(j.id, j);
    res.status(201).json({ id: j.id, ownerToken: j.ownerToken, shareUrl: `${publicBase}/v/${j.id}`, expiresAt: j.expiresAt });
  });
  app.post('/api/highlights/:id/upload-url', async (req, res) => {
    const j = owner(req);
    if (j.status !== 'uploading') throw fail(409, '录像已提交');
    res.json({ url: oss ? oss.signatureUrl(object(j, 'source'), { method: 'PUT', expires: 600, 'Content-Type': j.mime }) : `/api/highlights/${j.id}/source`,
      headers: oss ? { 'Content-Type': j.mime } : { 'Content-Type': j.mime, 'X-Owner-Token': j.ownerToken } });
  });
  app.put('/api/highlights/:id/source', async (req, res) => {
    const j = owner(req);
    if (oss) throw fail(404, '请使用直传地址');
    await exclusive(j.id, async () => {
      if (j.status !== 'uploading') throw fail(409, '录像已提交');
      await boundedWrite(req, path.join(workDir(j), 'source'), MAX_BYTES);
    });
    res.json({ ok: true });
  });
  app.put('/api/highlights/:id/card', async (req, res) => {
    const j = owner(req);
    await exclusive(j.id, async () => {
      if (j.status !== 'uploading') throw fail(409, '录像已提交');
      const card = path.join(workDir(j), 'card.png');
      await boundedWrite(req, card, 2 * 1024 * 1024);
      if (!await validPng(card)) { await rm(card, { force: true }); throw fail(400, '成绩卡格式错误'); }
    });
    res.json({ ok: true });
  });
  app.post('/api/highlights/:id/complete', async (req, res) => {
    const j = owner(req);
    await exclusive(j.id, async () => {
      if (['ready', 'queued', 'processing'].includes(j.status)) return;
      if (j.status !== 'uploading') throw fail(409, '请使用重试操作');
      let metadata;
      try { metadata = validateMetadata(req.body); } catch (e) { throw fail(400, e.message); }
      const bytes = oss ? Number((await oss.head(object(j, 'source'))).res.headers['content-length']) : (await stat(path.join(workDir(j), 'source'))).size;
      if (!(bytes > 0 && bytes <= MAX_BYTES)) throw fail(400, '录像为空或超过 200 MB');
      if (!await validPng(path.join(workDir(j), 'card.png'))) throw fail(400, '缺少成绩卡');
      j.metadata = metadata; j.status = 'queued'; await save(j);
    });
    res.json({ status: j.status }); void pump();
  });
  app.post('/api/highlights/:id/retry', async (req, res) => {
    const j = owner(req);
    await exclusive(j.id, async () => {
      if (j.status !== 'failed') throw fail(409, '当前无需重试');
      if ((j.retries || 0) >= 3) throw fail(429, '重试次数已用完，请联系工作人员');
      j.retries = (j.retries || 0) + 1; j.status = 'queued'; j.error = null; await save(j);
    });
    res.json({ status: j.status }); void pump();
  });
  app.delete('/api/highlights/:id', async (req, res) => {
    const j = owner(req);
    await exclusive(j.id, async () => { j.status = 'deleted'; await save(j); });
    res.json({ ok: true }); void cleanup();
  });
  // 服务端 3D 动捕(MeTRAbs):收视频 → 调 tools/pose3d.py → 返回 dance-sequence/v1 序列。
  // 供 lab.html 的「服务端 3D 模型」通路使用,替代浏览器端 MediaPipe 单目深度(膝盖反向根因)。
  app.post('/api/pose3d', device, async (req, res) => {
    const dir = path.join(root, '.pose3d-tmp');
    await mkdir(dir, { recursive: true });
    const input = path.join(dir, `${token()}.mp4`);
    try {
      await boundedWrite(req, input, MAX_BYTES);
      await streamPose3d(input, res);
    } catch (e) {
      if (!res.headersSent) res.status(e.status || 502).json({ error: e.message || '3D 动捕失败' });
      else res.end();
    } finally {
      await rm(input, { force: true });
    }
  });
  app.get('/api/highlights/:id', (req, res) => {
    const j = find(req);
    res.json({ status: j.status, expiresAt: j.expiresAt, error: j.error,
      result: j.metadata?.result, duration: j.clip ? j.clip.duration + (j.clip.cardDuration || 2) + (j.clip.introDuration || 0) : null,
      fullStatus: j.fullStatus || (j.status === 'ready' ? 'unavailable' : 'waiting'),
      fullError: j.fullError || null,
      fullDuration: j.clip?.sourceDuration ? j.clip.sourceDuration + (j.clip.cardDuration || 2) + (j.clip.introDuration || 0) : null,
      highlightTitle: j.metadata?.highlightTitle || '', highlightCount: j.metadata?.highlights?.length || 0,
      ...(j.status === 'ready' ? { videoUrl: `/api/highlights/${j.id}/media`, posterUrl: `/api/highlights/${j.id}/poster`, thumbUrl: `/api/highlights/${j.id}/thumb` } : {}),
      ...(j.fullStatus === 'ready' ? { fullVideoUrl: `/api/highlights/${j.id}/full-media` } : {}) });
  });
  app.get('/api/highlights/:id/qr', async (req, res) => {
    const j = find(req);
    res.type('svg').send(await QRCode.toString(`${publicBase}/v/${j.id}`, { type: 'svg', margin: 2, width: 240 }));
  });
  // 直链签名 URL:OSS 模式走自定义域名签名(24 小时),本地模式走本机媒体地址。
  // 缓存一段时间,避免 /staff 自动刷新时二维码因签名每次不同而闪烁。
  const signedUrlCache = new Map();
  const storedVideoName = (j, version) => j.artifactVersion === 'short-long-v1'
    ? (version === 'long' ? LONG_VIDEO : SHORT_VIDEO)
    : (version === 'long' ? 'full.mp4' : 'highlight.mp4');
  const directVideoUrl = (j, version, download) => {
    const now = Date.now();
    const cacheKey = `${j.id}:${version}:${download ? 'download' : 'play'}`;
    const cached = signedUrlCache.get(cacheKey);
    if (cached && cached.until > now + 3600000) return cached.url;
    const expires = Math.max(1, Math.min(86400, Math.floor((j.expiresAt - now) / 1000)));
    const route = version === 'long' ? 'full-media' : 'media';
    const filename = version === 'long' ? 'dance-long.mp4' : 'dance-short.mp4';
    const url = delivery
      ? delivery.signatureUrl(object(j, storedVideoName(j, version)), { expires,
        ...(download ? { response: { 'content-disposition': `attachment; filename="${filename}"` } } : {}) })
      : `${publicBase}/api/highlights/${j.id}/${route}${download ? '?download=1' : ''}`;
    signedUrlCache.set(cacheKey, { url, until: now + expires * 1000 });
    return url;
  };
  app.get('/api/highlights/:id/qr-play', async (req, res) => {
    const j = find(req);
    if (j.status !== 'ready') throw fail(409, '视频尚未生成');
    res.type('svg').send(await QRCode.toString(directVideoUrl(j, 'short', false), { type: 'svg', margin: 2, width: 240 }));
  });
  const sendDownloadQr = async (res, j, version) => {
    if (version === 'long' && j.fullStatus !== 'ready') throw fail(409, '完整视频尚未生成');
    res.type('svg').send(await QRCode.toString(directVideoUrl(j, version, true), { type: 'svg', margin: 2, width: 240 }));
  };
  app.get('/api/highlights/:id/qr-short', async (req, res) => {
    const j = find(req);
    if (j.status !== 'ready') throw fail(409, '高光视频尚未生成');
    await sendDownloadQr(res, j, 'short');
  });
  app.get('/api/highlights/:id/qr-long', async (req, res) => {
    const j = find(req);
    await sendDownloadQr(res, j, 'long');
  });
  app.get('/api/highlights/:id/qr-download', async (req, res) => {
    const j = find(req);
    if (j.status !== 'ready') throw fail(409, '视频尚未生成');
    // 兼容旧后台：旧的“下载码”仍明确对应 short 高光版。
    await sendDownloadQr(res, j, 'short');
  });
  // 取片台认人用的缩略图。本次改动之前生成的任务没有这张图,所以这里按需补一张并同步到 OSS:
  // 否则线上已有的成片在取片台上全是没有图的卡片,等于白做。
  // 抽帧实现可注入,便于测试串行行为(与 options.makeVideo 同一套路)。
  const extractThumb = options.extractThumb || ((src, dst, clip) => runFFmpeg(thumbArgs(src, dst, clip), 60000));
  const backfillThumb = async (j) => {
    const dst = path.join(workDir(j), 'thumb.jpg');
    try { await stat(dst); return true; } catch { /* 需要生成 */ }
    const src = path.join(workDir(j), storedVideoName(j, 'short'));
    try { await stat(src); } catch { return false; }
    try {
      await extractThumb(src, dst, j.clip || {});
    } catch (e) {
      console.error('Thumbnail extraction failed', j.id, e.message);
      await rm(dst, { force: true });
      return false;
    }
    if (oss) {
      try { await oss.put(object(j, 'thumb.jpg'), dst, { headers: { 'Content-Type': 'image/jpeg' } }); }
      catch (e) { console.error('Thumbnail upload failed', j.id, e.message); }
    }
    return true;
  };
  // 取片台一打开会同时请求所有卡片的缩略图,历史任务还要在这次请求里现场抽帧。
  // 不能并发:9 条老任务会在同一瞬间拉起 9 个 ffmpeg,去和正在给顾客转码的那个 worker 抢 CPU,
  // 直接把「等视频」的时间拉长。串行排队。
  let thumbQueue = Promise.resolve();
  const ensureThumb = (j) => {
    const next = thumbQueue.then(() => backfillThumb(j), () => backfillThumb(j));
    thumbQueue = next.catch(() => {});
    return next;
  };
  app.get('/api/highlights/:id/thumb', async (req, res) => {
    const j = find(req);
    if (j.status !== 'ready') throw fail(409, '视频尚未生成');
    const local = await ensureThumb(j);
    if (delivery) return res.redirect(delivery.signatureUrl(object(j, 'thumb.jpg'), {
      expires: Math.max(1, Math.min(300, Math.floor((j.expiresAt - Date.now()) / 1000))),
    }));
    if (!local) throw fail(404, '缩略图不可用');
    res.sendFile(path.join(workDir(j), 'thumb.jpg'), { dotfiles: 'allow' });
  });
  app.get('/api/highlights/:id/full-media', (req, res) => {
    const j = find(req);
    if (j.fullStatus !== 'ready') throw fail(409, j.fullStatus === 'failed' ? (j.fullError || '完整纪念版生成失败') : '完整纪念版尚未生成');
    const name = storedVideoName(j, 'long');
    if (delivery) return res.redirect(delivery.signatureUrl(object(j, name), {
      expires: Math.max(1, Math.min(300, Math.floor((j.expiresAt - Date.now()) / 1000))),
      response: { 'content-disposition': `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="dance-long.mp4"` },
    }));
    if (req.query.download === '1') res.attachment('dance-long.mp4');
    res.sendFile(path.join(workDir(j), name), { dotfiles: 'allow' });
  });
  for (const [route, fixedName] of [['media', null], ['poster', 'poster.jpg']]) {
    app.get(`/api/highlights/:id/${route}`, (req, res) => {
      const j = find(req);
      if (j.status !== 'ready') throw fail(409, '视频尚未生成');
      const name = fixedName || storedVideoName(j, 'short');
      const download = route === 'media' && req.query.download === '1';
      if (delivery) return res.redirect(delivery.signatureUrl(object(j, name), {
        expires: Math.max(1, Math.min(300, Math.floor((j.expiresAt - Date.now()) / 1000))),
        // 对象上传时已带正确 Content-Type,不要再覆盖它(OSS 会拒绝 response-content-type)。
        response: { 'content-disposition': `${download ? 'attachment' : 'inline'}; filename="dance-${route === 'media' ? 'short.mp4' : 'highlight.jpg'}"` },
      }));
      if (download) res.attachment('dance-short.mp4');
      // Data lives under .highlight-data; allow its dot-prefixed path segment
      // (send otherwise ignores dot-directories and returns 404 "Not Found").
      res.sendFile(path.join(workDir(j), name), { dotfiles: 'allow' });
    });
  }
  // 谱面编辑器:上传舞曲文件夹(fbx+音频)并保存谱面 → 落盘 songs/ + 更新 index.json
  const ownerHeader = req => req.headers['x-owner-token'];
  app.post('/api/songs', device, async (req, res) => {
    const out = await songStore.create({
      danceId: req.body?.danceId, label: req.body?.label, bpm: req.body?.bpm,
      fbxName: req.body?.fbxName, audioName: req.body?.audioName, overwrite: req.body?.overwrite,
    });
    res.status(201).json(out);
  });
  for (const [route, kind] of [['fbx', 'fbx'], ['audio', 'audio']]) {
    app.put(`/api/songs/:danceId/${route}`, async (req, res) => {
      await songStore.putFile(req.params.danceId, kind, ownerHeader(req), req);
      res.json({ ok: true });
    });
  }
  app.put('/api/songs/:danceId/chart', async (req, res) => {
    let text = '';
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw fail(413, '谱面超过大小限制');
      text += chunk;
    }
    await songStore.putSequence(req.params.danceId, ownerHeader(req), text);
    res.json({ ok: true });
  });
  app.post('/api/songs/:danceId/complete', async (req, res) => {
    res.json(await songStore.complete(req.params.danceId, ownerHeader(req)));
  });
  /**
   * 改歌曲名(songs[] 的 label)。
   *
   * 歌曲条目以前只在「创建」时定名:上架作品用作品名、谱面编辑器用导入时的名字,之后没有任何入口能改。
   * 于是工坊里能看到「Copy Dance 1」这种名字却改不掉。这里只动 label —— 不动 file / bpm / id,
   * 所以不影响音频解析与已绑定的舞曲。
   *
   * 注意 id 允许带 `:danceId` 形式的路由不会冲突:/api/songs/:danceId/{fbx,audio,chart,complete}
   * 都是更深的两段路径。
   */
  app.put('/api/songs/:id', device, async (req, res) => {
    const id = String(req.params.id);
    const label = String(req.body?.label ?? '').trim();
    if (!label) throw fail(400, '歌曲名不能为空');
    const index = await readSongsIndex();
    const song = (index.songs || []).find((s) => s.id === id);
    if (!song) throw fail(404, '歌曲不存在');
    song.label = label.slice(0, 120);
    await writeSongsIndex(index);
    res.json({ ok: true, song });
  });

  // 可用舞者模型列表(供 /settings 的模型切换面板)。递归列出 models/ 下所有 .glb/.gltf/.fbx。
  app.get('/api/models', async (req, res) => {
    try {
      const files = (await readdir(path.join(root, 'models'), { recursive: true }))
        .filter((f) => /\.(glb|gltf|fbx)$/i.test(f))
        .map((f) => {
          const rel = f.split(/[\\/]/).join('/');
          return { name: rel.split('/').pop(), url: `/models/${rel}` };
        })
        .sort((a, b) => a.url.localeCompare(b.url));
      res.json(files);
    } catch (e) {
      res.json([]);
    }
  });

  // 舞曲视频库(videos/*.mp4):列表带缩略图/时长/分辨率,支持上传/删除。
  app.get('/api/videos', async (req, res) => {
    try {
      const names = (await readdir(videosDir)).filter((f) => /\.mp4$/i.test(f)).sort((a, b) => a.localeCompare(b));
      // 比例元数据(宽高/档位)由 files 段提供,页面据此摆容器;探测失败为 null,页面走兜底。
      const files = await getVideoFiles(names);
      const out = [];
      for (const name of names) {
        const meta = await getVideoMeta(name);
        out.push({
          name, url: `/videos/${encodeURIComponent(name)}`, poster: `/api/videos/${encodeURIComponent(name)}/poster`,
          ...meta,
          ...(files[name] || {}),
        });
      }
      res.json(out);
    } catch (e) {
      res.json([]);
    }
  });
  // 上传视频(原始流,文件名走 URL,白名单 .mp4)。
  app.put('/api/videos/:name', device, async (req, res) => {
    const name = path.basename(String(req.params.name));
    if (!/\.mp4$/i.test(name) || name.startsWith('.')) throw fail(400, '文件名需为 .mp4');
    await boundedWrite(req, path.join(videosDir, name), MAX_BYTES);
    videoMeta.delete(name);
    await rm(posterFile(name), { force: true });
    // 换过文件就必须重探比例:旧的比例如今是错的,页面会照它摆错容器。
    const meta = videoFileMeta(await probeVideo(path.join(videosDir, name)));
    await applyVideoFiles({ [name]: meta }).catch(() => {});
    res.json({ ok: true, name, ...meta });
  });
  // 删除视频 + 封面,并清理绑定映射。
  app.delete('/api/videos/:name', device, async (req, res) => {
    const name = path.basename(String(req.params.name));
    if (!/\.mp4$/i.test(name)) throw fail(400, '文件名非法');
    await rm(path.join(videosDir, name), { force: true });
    await rm(posterFile(name), { force: true });
    videoMeta.delete(name);
    const mapping = await readVideoMap();
    let changed = false;
    for (const [danceId, v] of Object.entries(mapping)) if (v === name) { mapping[danceId] = ''; changed = true; }
    if (changed) await writeVideoMap(mapping);
    res.json({ ok: true });
  });
  // 封面图(懒生成)。
  app.get('/api/videos/:name/poster', async (req, res) => {
    const name = path.basename(String(req.params.name));
    if (!/\.mp4$/i.test(name)) throw fail(400, '文件名非法');
    const poster = await ensurePoster(name);
    if (!poster) return res.status(404).json({ error: '封面生成失败' });
    res.sendFile(poster, { dotfiles: 'allow' });
  });
  // 每首舞曲 → 绑定的参考视频(评分与歌曲音频仍由舞曲自身提供)。游戏页只读,后台 /settings 可写。
  app.get('/api/videos-map', async (req, res) => {
    res.json({ mapping: await readVideoMap() });
  });
  app.put('/api/videos-map', device, async (req, res) => {
    const mapping = req.body?.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
      throw fail(400, 'mapping 需为对象');
    // 白名单校验:键必须是 songs/index.json 里的舞曲 id,值必须是 videos/ 里真实存在的 mp4(可为空)。
    const [videoFiles, validDanceIds] = await Promise.all([readMp4Names(), readDanceIds()]);
    const videoSet = new Set(videoFiles);
    const danceSet = new Set(validDanceIds);
    const clean = {};
    for (const [k, v] of Object.entries(mapping)) {
      if (!danceSet.has(k)) continue;
      const name = path.basename(String(v || ''));
      clean[k] = /\.mp4$/i.test(name) && videoSet.has(name) ? name : '';
    }
    await writeVideoMap(clean);
    res.json({ ok: true, mapping: clean });
  });

  // 编辑舞曲元数据(名字 + 歌曲),写回 songs/index.json。歌曲改动会同步 musicFile。
  app.put('/api/dances/:id', device, async (req, res) => {
    const id = String(req.params.id);
    const { label, songId } = req.body || {};
    const indexPath = path.join(songsDir, 'index.json');
    let index;
    try { index = JSON.parse(await readFile(indexPath, 'utf8')); }
    catch { throw fail(404, '歌单不存在'); }
    const dance = (index.dances || []).find((d) => d.id === id);
    if (!dance) throw fail(404, '舞曲不存在');
    if (typeof label === 'string' && label.trim()) dance.label = label.trim().slice(0, 120);
    if (songId !== undefined) {
      const song = (index.songs || []).find((s) => s.id === songId);
      if (!song) throw fail(400, '歌曲不存在');
      dance.defaultSongId = song.id;
      dance.musicFile = song.file;
    }
    const tmp = `${indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(index, null, 2));
    await rename(tmp, indexPath);
    res.json({ ok: true, dance });
  });

  // ---- 作品工坊:统一「作品」列表 + 生命周期(全部只改 status 字段,软逻辑) ----
  /** 给作品补上列表要用的派生信息(歌曲名/视频名/是否已上架)。 */
  const enrichWorks = async (list) => {
    const [idx, mapping] = await Promise.all([readSongsIndex(), readVideoMap()]);
    const songs = idx.songs || [];
    return list.map((d) => {
      // 早于 drafts/v2 的记录没有 status/external 字段,按「草稿」处理
      const status = ['draft', 'published', 'trashed'].includes(d.status) ? d.status : 'draft';
      const song = songs.find((s) => s.id === (d.songId || d.danceId || d.id));
      return {
        ...d,
        status,
        external: Boolean(d.external),
        videoName: d.videoName || mapping[d.danceId] || '',
        published: status === 'published',
        songLabel: song?.label || '',
        songFile: song?.file || d.files?.audio || '',
      };
    });
  };

  app.get('/api/works', device, async (req, res) => {
    await syncLegacyWorks();
    const list = await draftStore.list();
    const status = req.query.status;
    const mode = req.query.mode;
    let works = await enrichWorks(list);
    if (status) works = works.filter((w) => w.status === status);
    if (mode) works = works.filter((w) => w.mode === mode);
    res.json(works);
  });

  app.get('/api/works/:id', device, async (req, res) => {
    const draft = await draftStore.get(req.params.id);
    res.json((await enrichWorks([draft]))[0]);
  });

  /** 编辑作品:名字 / BPM / danceId / 绑定歌曲 / 绑定视频。已上架的会同步到歌单与视频映射。 */
  app.put('/api/works/:id', device, async (req, res) => {
    let draft = await draftStore.get(req.params.id);
    const { label, bpm, danceId, songId, videoName } = req.body || {};
    if (danceId !== undefined && draft.external && String(danceId) !== draft.danceId) {
      throw fail(400, '已上架的老作品不能改目录名，请先「打回草稿」');
    }
    draft = await draftStore.updateMeta(req.params.id, { label, bpm, danceId, songId, videoName });
    if (draft.status === 'published' && draft.danceId) {
      await syncDraftToIndex(draft);
      const mapping = await readVideoMap();
      const next = String(videoName ?? draft.videoName ?? '');
      if ((mapping[draft.danceId] || '') !== next) { mapping[draft.danceId] = next; await writeVideoMap(mapping); }
    }
    res.json((await enrichWorks([draft]))[0]);
  });

  /** 打回草稿:external 老作品先把文件拷回来,再改状态 + 从歌单摘掉(文件不删)。 */
  app.post('/api/works/:id/unpublish', device, async (req, res) => {
    let draft = await draftStore.get(req.params.id);
    if (draft.status !== 'published') throw fail(400, '只有已上架的作品才能打回草稿');
    if (draft.external) draft = await materializeWork(draft);
    await unpublishFromIndex(draft.danceId);
    draft = await draftStore.setStatus(req.params.id, 'draft');
    res.json({ ok: true, work: (await enrichWorks([draft]))[0] });
  });

  /** 删除 = 软删除,进回收站(文件都留着)。 */
  app.post('/api/works/:id/trash', device, async (req, res) => {
    let draft = await draftStore.get(req.params.id);
    if (draft.status === 'published') await unpublishFromIndex(draft.danceId);
    draft = await draftStore.setStatus(req.params.id, 'trashed');
    res.json({ ok: true, work: (await enrichWorks([draft]))[0] });
  });

  /** 从回收站找回(回到草稿)。 */
  app.post('/api/works/:id/restore', device, async (req, res) => {
    const draft = await draftStore.setStatus(req.params.id, 'draft');
    res.json({ ok: true, work: (await enrichWorks([draft]))[0] });
  });

  /** 彻底删除:删作品目录 + 已上架的 songs/<danceId>/ + 歌单条目 + 白影。 */
  app.delete('/api/works/:id', device, async (req, res) => {
    const draft = await draftStore.get(req.params.id);
    await unpublishFromIndex(draft.danceId);
    if (draft.danceId) {
      await rm(path.join(songsDir, draft.danceId), { recursive: true, force: true });
      await rm(path.join(root, 'web_dance', 'assets', 'lane', draft.danceId), { recursive: true, force: true });
    }
    await draftStore.remove(req.params.id);
    res.json({ ok: true });
  });

  // 作品工坊:草稿 CRUD(鉴权同后台,本地免密)。
  app.get('/api/drafts', device, async (req, res) => {
    await syncLegacyWorks();
    res.json(await enrichWorks(await draftStore.list()));
  });
  app.post('/api/drafts', device, async (req, res) => {
    res.status(201).json(await draftStore.create({ mode: req.body?.mode, label: req.body?.label }));
  });
  app.get('/api/drafts/:id', device, async (req, res) => {
    res.json(await draftStore.get(req.params.id));
  });
  // 写文件前先把 external(老)作品拷成普通草稿,避免读写落在两个目录。
  app.put('/api/drafts/:id/source', device, async (req, res) => {
    await ensureLocal(req.params.id);
    res.json(await draftStore.putFile(req.params.id, 'source', String(req.query.name || ''), req));
  });
  app.put('/api/drafts/:id/audio', device, async (req, res) => {
    await ensureLocal(req.params.id);
    res.json(await draftStore.putFile(req.params.id, 'audio', String(req.query.name || ''), req));
  });
  // 序列/谱面为较大的 JSON,走 text/plain 原始流(避免 express.json 256kb 上限)。
  app.put('/api/drafts/:id/sequence', device, async (req, res) => {
    await ensureLocal(req.params.id);
    let text = '';
    for await (const chunk of req) text += chunk;
    res.json(await draftStore.putText(req.params.id, 'sequence', text));
  });
  app.put('/api/drafts/:id/chart', device, async (req, res) => {
    await ensureLocal(req.params.id);
    let text = '';
    for await (const chunk of req) text += chunk;
    res.json(await draftStore.putText(req.params.id, 'chart', text));
  });
  // 读作品的序列/谱面文本(external 老作品从 songs/<danceId>/ 读)。
  app.get('/api/drafts/:id/text/:kind', device, async (req, res) => {
    const kind = req.params.kind === 'sequence' || req.params.kind === 'chart' ? req.params.kind : null;
    if (!kind) throw fail(400, 'kind 非法');
    const draft = await draftStore.get(req.params.id);
    const file = workFileOf(draft, kind);
    let text = '';
    if (file && (await fileExists(file))) text = await readFile(file, 'utf8');
    res.type('text/plain').send(text);
  });
  app.put('/api/drafts/:id/meta', device, async (req, res) => {
    const draft = await draftStore.updateMeta(req.params.id, req.body || {});
    // 已上架作品的改动要同步回歌单:工坊「打开编辑」里的标题框走的就是这条路径。
    await syncDraftToIndex(draft);
    res.json(draft);
  });
  // 从已上传的视频素材抽取音频(ffmpeg → wav)。
  app.post('/api/drafts/:id/extract-audio', device, async (req, res) => {
    const draft = await ensureLocal(req.params.id);
    const source = draft.files?.source;
    if (!source) throw fail(400, '请先上传视频素材');
    if (!/\.(mp4|mov|webm|mkv)$/i.test(source)) throw fail(400, '素材不是视频，无法抽音频');
    const audioName = source.replace(/\.[^.]+$/, '') + '.wav';
    const dir = draftStore.dirOf(req.params.id);
    await runFFmpeg(['-i', path.join(dir, source), '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', path.join(dir, audioName)], 120000);
    res.json(await draftStore.setFile(req.params.id, 'audio', audioName));
  });
  // 预览作品里的素材/音频文件(external 老作品指向 songs/ 或 videos/)。
  app.get('/api/drafts/:id/raw/:kind', device, async (req, res) => {
    const kind = req.params.kind === 'source' || req.params.kind === 'audio' ? req.params.kind : null;
    if (!kind) throw fail(400, 'kind 非法');
    const draft = await draftStore.get(req.params.id);
    const name = draft.files?.[kind];
    if (!name) throw fail(404, '文件不存在');
    let file = path.join(workDirOf(draft), name);
    // 视频模式的素材是 videos/ 里的 mp4,作品目录里通常没有
    if (draft.mode === 'video' && kind === 'source' && !(await fileExists(file))) file = path.join(videosDir, name);
    if (!(await fileExists(file))) throw fail(404, '文件不存在');
    res.sendFile(file, { dotfiles: 'allow' });
  });
  // 保存判定轨道白影(前端在页面内渲染出 PNG,这里解码落盘 + 写 manifest)。
  app.put('/api/drafts/:id/lane', device, async (req, res) => {
    await ensureLocal(req.params.id);
    let text = '';
    for await (const chunk of req) text += chunk;
    let body;
    try { body = JSON.parse(text); } catch { throw fail(400, '请求体需为 JSON'); }
    const notes = body.notes;
    if (!Array.isArray(notes)) throw fail(400, 'notes 需为数组');
    const draft = await draftStore.get(req.params.id);
    const danceId = draft.danceId || draft.id;
    const laneDir = path.join(draftStore.dirOf(req.params.id), 'lane');
    await mkdir(laneDir, { recursive: true });
    // 重铺判定点后,旧 PNG 会留在目录里(文件名 = 时刻,新谱面覆盖不到的那些就成了孤儿)。
    // 它们不进 manifest、也就不会被消费端引用,但会让「这作品到底有多少张白影」永远说不清。
    // 只清当前清单之外的多余 PNG,manifest 等别的文件不动。
    const keepFiles = new Set(notes.map((n) => `${String(n.key ?? Number(n.t).toFixed(3))}.png`));
    try {
      for (const f of await readdir(laneDir)) {
        if (/\.png$/i.test(f) && !keepFiles.has(f)) await rm(path.join(laneDir, f), { force: true });
      }
    } catch { /* 清理失败不该挡住保存 */ }
    const manifestNotes = [];
    for (const n of notes) {
      const key = String(n.key ?? Number(n.t).toFixed(3));
      const dataUrl = n.dataUrl;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) continue;
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      const name = `${key}.png`;
      await writeFile(path.join(laneDir, name), buf);
      // file 必须写成「<danceId>/<key>.png」——和 CLI 生成器 tools/lane-silhouettes.mjs 同一份契约。
      // 消费端 laneAssetUrl() 是直接拼 assets/lane/<file> 的,少一层目录就会 404 静默退回 2D 剪影。
      manifestNotes.push({ t: n.t, key, moveId: n.moveId ?? null, file: `${danceId}/${name}`, w: n.w, h: n.h, joints: n.joints || {} });
    }
    manifestNotes.sort((a, b) => a.t - b.t);
    const manifest = {
      schema: 'lane-silhouettes/v1',
      generatedAt: new Date().toISOString(),
      model: body.model || '', size: body.size || 256, color: body.color || '#ffffff',
      dances: { [danceId]: { danceId, notes: manifestNotes } },
    };
    await writeFile(path.join(laneDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await draftStore.setFile(req.params.id, 'lane', 'lane/manifest.json');
    res.json({ ok: true, notes: manifestNotes.length });
  });
  // 预览草稿里的判定轨道白影 PNG。
  app.get('/api/drafts/:id/lane/:file', device, async (req, res) => {
    const file = path.basename(String(req.params.file || ''));
    if (!/^[\d.]+\.png$/.test(file)) throw fail(400, '文件名非法');
    // 换模型重新生成后文件名不变,必须禁缓存,否则浏览器显示旧模型的白影
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(draftStore.dirOf(req.params.id), 'lane', file), { dotfiles: 'allow' });
  });
  // 出炉上架:把作品产物搬进 songs/ + videos/ + assets/lane/ 并写索引,然后把 status 改成 published。
  // 注意:不再删草稿目录 —— 文件留着,「打回草稿」才能只改一个字段就继续改。
  app.post('/api/drafts/:id/publish', device, async (req, res) => {
    let draft = await draftStore.get(req.params.id);
    const f = draft.files || {};
    if (!f.sequence || !f.chart || !f.audio) throw fail(400, '作品缺少 序列/谱面/音频，无法上架');
    const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "dance";
    const danceId = draft.danceId || slug(draft.label) || draft.id;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(danceId)) throw fail(400, 'danceId 非法(需小写字母/数字/_-，字母或数字开头)');
    const dir = workDirOf(draft);
    const songDir = path.join(songsDir, danceId);
    // 就是它自己(重新上架)时不必再要求「覆盖」
    const sameDance = draft.danceId === danceId;
    if ((await fileExists(songDir)) && !req.body?.overwrite && !sameDance) {
      throw fail(409, `songs/${danceId}/ 已存在，请勾选「覆盖」后重试`);
    }
    const copy = async (src, dst) => {
      if (!(await fileExists(src))) return false;
      if (path.resolve(src) === path.resolve(dst)) return true; // external 重上架:源和目标是同一个文件
      await mkdir(path.dirname(dst), { recursive: true });
      await copyFile(src, dst);
      return true;
    };

    await mkdir(songDir, { recursive: true });
    // 1) 序列 + 谱面 + 音频
    await copy(path.join(dir, f.sequence), path.join(songDir, `${danceId}.json`));
    await copy(path.join(dir, f.chart), path.join(songDir, `${danceId}.chart.json`));
    await copy(path.join(dir, f.audio), path.join(songDir, f.audio));

    // 1b) 把序列/谱面里记的 danceId 改成最终 danceId。
    //     生成阶段的 danceId 是占位名(FBX 采样默认 "dance"、视频动捕用视频文件名),
    //     而判定轨道白影是按 seq.danceId 去 assets/lane 清单里找图的 —— 不改就永远取不到,
    //     而且会静默退回 2D 剪影(界面上看不出报错)。已经对了的文件不重写。
    for (const file of [`${danceId}.json`, `${danceId}.chart.json`]) {
      const p = path.join(songDir, file);
      try {
        const o = JSON.parse(await readFile(p, 'utf8'));
        if (o.danceId === danceId) continue;
        o.danceId = danceId;
        await writeFile(p, JSON.stringify(o));
      } catch { /* 缺文件/坏 JSON 不该挡住上架 */ }
    }

    // 2) FBX(3D 模式) 或 视频(视频模式)
    let fbxName = null, videoName = draft.videoName || null;
    if (draft.mode === '3d' && f.source && /\.fbx$/i.test(f.source)) {
      fbxName = f.source;
      await copy(path.join(dir, f.source), path.join(songDir, fbxName));
    } else if (draft.mode === 'video' && f.source) {
      videoName = f.source;
      const dstVideo = path.join(videosDir, videoName);
      // 素材本来就在 videos/(绑定的库视频)时不用再拷一遍
      if (!(await fileExists(dstVideo)) && await copy(path.join(dir, f.source), dstVideo)) {
        await rm(posterFile(videoName), { force: true });
        videoMeta.delete(videoName);
      }
    }

    // 3) 判定轨道白影 → web_dance/assets/lane/<danceId>/
    const laneDir = path.join(root, 'web_dance', 'assets', 'lane', danceId);
    const laneSrcDir = draft.external ? laneDir : path.join(dir, 'lane');
    const laneManifest = path.join(laneSrcDir, 'manifest.json');
    if (await fileExists(laneManifest)) {
      const manifest = JSON.parse(await readFile(laneManifest, 'utf8'));
      const oldDance = Object.values(manifest.dances || {})[0];
      const notes = [];
      for (const n of oldDance?.notes || []) {
        const name = path.basename(n.file);                                  // 兼容两种写法,只认文件名
        await copy(path.join(laneSrcDir, name), path.join(laneDir, name));
        notes.push({ ...n, file: `${danceId}/${name}` });                    // 统一规范成 <danceId>/<key>.png
      }
      if (oldDance) manifest.dances = { [danceId]: { ...oldDance, danceId, notes } };
      // 同上:这次上架产生的 PNG 是权威清单,目录里不在清单内的旧图直接清掉
      const keepLane = new Set(notes.map((n) => path.basename(n.file)));
      try {
        for (const f of await readdir(laneDir)) {
          if (/\.png$/i.test(f) && !keepLane.has(f)) await rm(path.join(laneDir, f), { force: true });
        }
      } catch { /* 清理失败不该挡住上架 */ }
      const laneIndexPath = path.join(root, 'web_dance', 'assets', 'lane', 'index.json');
      let prev = {};
      try { prev = JSON.parse(await readFile(laneIndexPath, 'utf8')); } catch { /* 首次生成 */ }
      const merged = {
        schema: 'lane-silhouettes/v1', generatedAt: new Date().toISOString(),
        model: manifest.model, size: manifest.size, color: manifest.color,
        dances: { ...(prev.dances || {}), ...(manifest.dances || {}) },
      };
      const laneTmp = `${laneIndexPath}.tmp`;
      await writeFile(laneTmp, JSON.stringify(merged, null, 2));
      await rename(laneTmp, laneIndexPath);
    }

    // 4) 更新 songs/index.json
    //    反复上架不该把 songs[] 越滚越多,也不该改掉用户给歌曲起的名字:
    //    音频没变就继续复用这支舞原本绑定的那条歌曲记录(id/名字/条目统统不动)。
    //    不变量:dance.defaultSongId 必须能在 songs[] 里查到 ——
    //    运行时(选曲试听 / 游戏背景音乐)是 defaultSongId → songById → song.file 这条链,
    //    悬空就等于**静默没声音**(现场表现:"别的视频点卡片有声音,这几支没有")。
    const index = await readSongsIndex();
    const prevDance = index.dances.find((d) => d.id === danceId || d.danceId === danceId);
    const prevSong = index.songs.find((s) => s.id === (prevDance?.defaultSongId ?? danceId));
    // 兜底:defaultSongId 可能已经失效(歌曲条目被删过),这时按音频文件回认那张歌曲卡,
    // 否则下面会删掉旧条目再按作品名重建 —— 用户改过的歌曲名就这样被冲掉了。
    const sameAudioSong = index.songs.find((s) => s.id === danceId && s.file === f.audio) || null;
    const keepSong = (prevSong && prevSong.file === f.audio ? prevSong : null) || sameAudioSong;
    const oldSongEntry = index.songs.find((s) => s.id === danceId);

    index.dances = index.dances.filter((d) => d.id !== danceId && d.danceId !== danceId);
    index.songs = index.songs.filter((s) => s.id !== danceId);
    index.dances.push({
      id: danceId, label: draft.label || danceId, danceId,
      defaultSongId: keepSong ? keepSong.id : danceId,
      chartFile: `${danceId}.chart.json`, musicFile: f.audio, fbxFile: fbxName,
      // 作品的「出身模式」:游戏用它决定这支舞进 3D 列表还是视频列表。
      // 3D 作品(哪怕是绑了视频的 copydance1)两个列表都能进;视频作品只进视频列表。
      mode: draft.mode,
    });
    if (!keepSong) {
      index.songs.push({
        id: danceId,
        label: oldSongEntry?.label || draft.label || danceId,
        file: f.audio,
        bpm: draft.bpm || 120,
      });
    }
    // 上架完成后自检并修好悬空引用(keepSong 复用的那条也可能本身就是悬空的)
    const published = index.dances.find((d) => d.danceId === danceId);
    if (published && !index.songs.some((s) => s.id === published.defaultSongId)) {
      index.songs.push({
        id: published.defaultSongId || danceId,
        label: oldSongEntry?.label || draft.label || danceId,
        file: f.audio,
        bpm: draft.bpm || 120,
      });
      published.musicFile = f.audio;
      console.warn(`[publish] ${danceId} 的歌曲条目悬空,已补回:${f.audio}`);
    }
    await writeSongsIndex(index);

    // 5) 视频绑定(视频模式)
    if (draft.mode === 'video') {
      const mapping = await readVideoMap();
      mapping[danceId] = videoName || '';
      await writeVideoMap(mapping);
    }

    // 6) 状态改成「已上架」(文件都留着,便于打回草稿继续改)
    await draftStore.updateMeta(req.params.id, { danceId, videoName: videoName || '', songId: danceId });
    draft = await draftStore.setStatus(req.params.id, 'published');
    res.json({ ok: true, danceId, videoName, fbxName, work: (await enrichWorks([draft]))[0] });
  });
  app.delete('/api/drafts/:id', device, async (req, res) => {
    await draftStore.remove(req.params.id);
    res.json({ ok: true });
  });

  app.get('/v/:id', (req, res) => res.sendFile(path.join(root, 'web_dance', 'highlight.html')));
  app.get('/staff', (req, res) => res.sendFile(path.join(root, 'web_dance', 'staff.html')));
  app.get('/settings', (req, res) => res.sendFile(path.join(root, 'web_dance', 'settings.html')));
  // 舞曲视频已并入作品工坊(绑定音乐/视频、改名字、软删除都在那边),老入口直接跳过去。
  app.get('/dance-videos', (req, res) => res.redirect('/studio'));
  app.get('/studio', (req, res) => res.sendFile(path.join(root, 'web_dance', 'studio.html')));
  // 谱面编辑器:跳转到 /web_dance/ 下,保证 ./chart-editor.js 等相对路径正确解析。
  app.get('/editor', (req, res) => res.redirect('/web_dance/chart-editor.html'));
  // Explicit asset mounts: never expose credentials, recordings, .git, or backend sources.
  // Cache-Control: no-cache = 每次都回源校验(命中就回 304,很便宜)。
  // 不设的话 express.static 不发 Cache-Control,浏览器会按 Last-Modified 走启发式缓存
  // (文件年龄的 10%)—— 刚改完的前端模块会被静默命中旧文件,表现为"我改了但行为没变",
  // 比没有缓存更难查。之前只能靠手改 import 上的 ?v= 兜,已经漏过两次。
  const staticOpts = {
    dotfiles: 'deny',
    setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); },
  };
  for (const dir of ['web_dance', 'pose_capture', 'scoring/src', 'models', 'fbx', 'songs'])
    app.use(`/${dir}`, express.static(path.join(root, dir), staticOpts));
  // videos 必须挂 videosDir 解析出来的目录,不能拼 root/videos:
  // 传了 videosDir 选项 / 设了 VIDEOS_DIR 时(测试、多素材库)拼 root 会让每个视频 404,
  // 而 /api/videos 又是从 videosDir 列文件的 —— 表现为"列表里有、点开播不了"。
  app.use('/videos', express.static(videosDir, staticOpts));
  for (const file of ['chart.json', 'timing.json']) app.get(`/${file}`, (req, res) => res.sendFile(path.join(root, file)));
  app.get('/', (req, res) => res.redirect('/web_dance/'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (!err.status || err.status >= 500) console.error(err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : '服务暂时不可用，请稍后重试' });
  });
  return { app, jobs, cleanup, async close() {
    closed = true; clearInterval(timer);
    while (busy || locked.size) await new Promise(resolve => setTimeout(resolve, 20));
  }, data };
}

async function boundedWrite(stream, destination, limit) {
  let size = 0;
  const temp = `${destination}.upload`;
  try {
    await pipeline(stream, new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      done(size > limit ? fail(413, '文件超过大小限制') : null, chunk);
    } }), createWriteStream(temp));
    if (!size) throw fail(400, '文件为空');
    await rename(temp, destination);
  } catch (e) { await rm(temp, { force: true }); throw e; }
}

// 调用 tools/pose3d(MeTRAbs)把视频转成契约序列。Python 可执行文件可用 POSE3D_PYTHON 覆盖。
// 流式版:CLI 以 NDJSON(stdout)逐行回传 {progress}/{result}/{error},这里逐行透传给前端,
// 前端 fetch+ReadableStream 逐行解析,实时刷新进度条。舞蹈动捕 5fps 足够,避免默认 30fps 帧数爆炸。
function streamPose3d(inputPath, res) {
  return new Promise((resolve, reject) => {
    const python = process.env.POSE3D_PYTHON || 'python';
    const toolsDir = path.join(root, 'tools');
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const child = spawn(python, ['-m', 'pose3d', '--input', inputPath, '--out', '-', '--fps', '5', '--progress'], { cwd: toolsDir });

    let stderr = '';
    let buffer = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) res.write(line + '\n');
      }
    });
    // 首次加载 TF + 逐帧推理,给足超时;超时强杀避免孤儿进程占内存。
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(fail(502, `无法启动 3D 动捕进程（请确认已安装 Python 与 MeTRAbs）：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) res.write(buffer.trim() + '\n'); // 冲刷未换行的残留行
      if (code !== 0) {
        // 已流式发过 progress 行,无法再改状态码;补一行 error 让前端能识别失败。
        if (!res.writableEnded) {
          const tail = (stderr || '').trim().split('\n').slice(-2).join(' ');
          res.write(JSON.stringify({ error: `3D 动捕执行失败（退出码 ${code}）：${tail || '未知错误'}` }) + '\n');
        }
      }
      res.end();
      resolve();
    });
  });
}
