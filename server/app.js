import 'dotenv/config';
import express from 'express';
import OSS from 'ali-oss';
import QRCode from 'qrcode';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVideo, validPng } from './media.js';
import { selectHighlight, validateMetadata } from './highlight.js';
import { createSongStore } from './songstore.js';

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
  const videosDir = path.resolve(options.videosDir || process.env.VIDEOS_DIR || path.join(root, 'videos'));
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
        const clip = selectHighlight(j.metadata.samples, j.metadata.duration, 28);
        const dir = workDir(j);
        await (options.makeVideo || makeVideo)(path.join(dir, 'source'), path.join(dir, 'highlight.mp4'),
          path.join(dir, 'poster.jpg'), path.join(dir, 'card.png'), clip);
        if (oss) {
          await oss.put(object(j, 'highlight.mp4'), path.join(dir, 'highlight.mp4'), { headers: { 'Content-Type': 'video/mp4' } });
          await oss.put(object(j, 'poster.jpg'), path.join(dir, 'poster.jpg'), { headers: { 'Content-Type': 'image/jpeg' } });
        }
        j.clip = clip; j.status = 'ready'; j.error = null; j.readyAt = Date.now();
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
            if (oss) await oss.deleteMulti(['source', 'highlight.mp4', 'poster.jpg'].map(n => object(j, n)));
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
      error: j.error, duration: j.clip ? j.clip.duration + 2 : null, result: j.metadata?.result || null,
      shareUrl: `${publicBase}/v/${j.id}`,
      ...(j.status === 'ready' ? { videoUrl: `/api/highlights/${j.id}/media`, posterUrl: `/api/highlights/${j.id}/poster` } : {}),
    })));
  });
  app.post('/api/highlights', device, async (req, res) => {
    if (!mimeTypes.has(req.body?.mime)) throw fail(400, '不支持的录像格式');
    if ([...jobs.values()].filter(j => ['uploading', 'queued', 'processing'].includes(j.status)).length >= 20)
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
      result: j.metadata?.result, duration: j.clip ? j.clip.duration + 2 : null,
      ...(j.status === 'ready' ? { videoUrl: `/api/highlights/${j.id}/media`, posterUrl: `/api/highlights/${j.id}/poster` } : {}) });
  });
  app.get('/api/highlights/:id/qr', async (req, res) => {
    const j = find(req);
    res.type('svg').send(await QRCode.toString(`${publicBase}/v/${j.id}`, { type: 'svg', margin: 2, width: 240 }));
  });
  // 直链签名 URL:OSS 模式走自定义域名签名(24 小时),本地模式走本机媒体地址。
  // 缓存一段时间,避免 /staff 自动刷新时二维码因签名每次不同而闪烁。
  const signedUrlCache = new Map();
  const mediaUrl = (j, download) => {
    const now = Date.now();
    const cached = signedUrlCache.get(j.id);
    if (cached && cached.until > now + 3600000) return download ? cached.download : cached.play;
    const expires = Math.max(1, Math.min(86400, Math.floor((j.expiresAt - now) / 1000)));
    const entry = {
      play: delivery ? delivery.signatureUrl(object(j, 'highlight.mp4'), { expires }) : `${publicBase}/api/highlights/${j.id}/media`,
      download: delivery ? delivery.signatureUrl(object(j, 'highlight.mp4'), { expires, response: { 'content-disposition': 'attachment; filename="dance-highlight.mp4"' } }) : `${publicBase}/api/highlights/${j.id}/media?download=1`,
      until: now + expires * 1000,
    };
    signedUrlCache.set(j.id, entry);
    return download ? entry.download : entry.play;
  };
  app.get('/api/highlights/:id/qr-play', async (req, res) => {
    const j = find(req);
    if (j.status !== 'ready') throw fail(409, '视频尚未生成');
    res.type('svg').send(await QRCode.toString(mediaUrl(j, false), { type: 'svg', margin: 2, width: 240 }));
  });
  app.get('/api/highlights/:id/qr-download', async (req, res) => {
    const j = find(req);
    if (j.status !== 'ready') throw fail(409, '视频尚未生成');
    res.type('svg').send(await QRCode.toString(mediaUrl(j, true), { type: 'svg', margin: 2, width: 240 }));
  });
  for (const [route, name] of [['media', 'highlight.mp4'], ['poster', 'poster.jpg']]) {
    app.get(`/api/highlights/:id/${route}`, (req, res) => {
      const j = find(req);
      if (j.status !== 'ready') throw fail(409, '视频尚未生成');
      const download = route === 'media' && req.query.download === '1';
      if (delivery) return res.redirect(delivery.signatureUrl(object(j, name), {
        expires: Math.max(1, Math.min(300, Math.floor((j.expiresAt - Date.now()) / 1000))),
        // 对象上传时已带正确 Content-Type,不要再覆盖它(OSS 会拒绝 response-content-type)。
        response: { 'content-disposition': `${download ? 'attachment' : 'inline'}; filename="dance-highlight.${route === 'media' ? 'mp4' : 'jpg'}"` },
      }));
      if (download) res.attachment('dance-highlight.mp4');
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

  // 可用参考视频列表(videos/*.mp4,供 /settings 的「右侧画面」配置)。
  app.get('/api/videos', async (req, res) => {
    try {
      const files = (await readdir(videosDir))
        .filter((f) => /\.mp4$/i.test(f))
        .sort((a, b) => a.localeCompare(b))
        .map((f) => ({ name: f, url: `/videos/${encodeURIComponent(f)}` }));
      res.json(files);
    } catch (e) {
      res.json([]);
    }
  });
  // 每首舞曲 → 参考视频 的绑定映射(游戏页只读,后台 /settings 可写)。
  app.get('/api/videos-map', async (req, res) => {
    res.json({ mapping: await readVideoMap() });
  });
  app.put('/api/videos-map', device, async (req, res) => {
    const mapping = req.body?.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
      throw fail(400, 'mapping 需为对象');
    const clean = {};
    for (const [k, v] of Object.entries(mapping)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(k)) continue; // 舞曲 id 白名单
      const base = typeof v === 'string' ? path.basename(v) : '';
      clean[k] = /\.mp4$/i.test(base) ? base : '';
    }
    await writeVideoMap(clean);
    res.json({ ok: true, mapping: clean });
  });

  app.get('/v/:id', (req, res) => res.sendFile(path.join(root, 'web_dance', 'highlight.html')));
  app.get('/staff', (req, res) => res.sendFile(path.join(root, 'web_dance', 'staff.html')));
  app.get('/settings', (req, res) => res.sendFile(path.join(root, 'web_dance', 'settings.html')));
  // 谱面编辑器:跳转到 /web_dance/ 下,保证 ./chart-editor.js 等相对路径正确解析。
  app.get('/editor', (req, res) => res.redirect('/web_dance/chart-editor.html'));
  // Explicit asset mounts: never expose credentials, recordings, .git, or backend sources.
  for (const dir of ['web_dance', 'pose_capture', 'scoring/src', 'models', 'fbx', 'songs', 'videos'])
    app.use(`/${dir}`, express.static(path.join(root, dir), { dotfiles: 'deny' }));
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
