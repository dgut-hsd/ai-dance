import 'dotenv/config';
import express from 'express';
import OSS from 'ali-oss';
import QRCode from 'qrcode';
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
const MAX_BYTES = 200 * 1024 * 1024;
const DAY = 86400000;
const mimeTypes = new Set(['video/webm', 'video/mp4']);

export async function createApp(options = {}) {
  const data = path.resolve(options.dataDir || process.env.HIGHLIGHT_DATA_DIR || path.join(root, '.highlight-data'));
  const publicBase = (options.publicBase || process.env.PUBLIC_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
  const deviceToken = options.deviceToken ?? process.env.DEVICE_TOKEN ?? '';
  const mode = options.storage || process.env.STORAGE_MODE || 'local';
  if (!['local', 'oss'].includes(mode)) throw new Error('STORAGE_MODE must be local or oss');
  const songsDir = path.resolve(options.songsDir || process.env.SONGS_DIR || path.join(root, 'songs'));
  const songStore = createSongStore({ songsDir });
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
  for (const [route, name] of [['media', 'highlight.mp4'], ['poster', 'poster.jpg']]) {
    app.get(`/api/highlights/:id/${route}`, (req, res) => {
      const j = find(req);
      if (j.status !== 'ready') throw fail(409, '视频尚未生成');
      const download = route === 'media' && req.query.download === '1';
      if (delivery) return res.redirect(delivery.signatureUrl(object(j, name), {
        expires: Math.max(1, Math.min(300, Math.floor((j.expiresAt - Date.now()) / 1000))),
        response: { 'content-type': route === 'media' ? 'video/mp4' : 'image/jpeg',
          'content-disposition': `${download ? 'attachment' : 'inline'}; filename="dance-highlight.${route === 'media' ? 'mp4' : 'jpg'}"` },
      }));
      if (download) res.attachment('dance-highlight.mp4');
      res.sendFile(path.join(workDir(j), name));
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

  app.get('/v/:id', (req, res) => res.sendFile(path.join(root, 'web_dance', 'highlight.html')));
  // Explicit asset mounts: never expose credentials, recordings, .git, or backend sources.
  for (const dir of ['web_dance', 'pose_capture', 'scoring/src', 'models', 'fbx'])
    app.use(`/${dir}`, express.static(path.join(root, dir), { dotfiles: 'deny' }));
  app.use('/songs', express.static(songsDir, { dotfiles: 'deny' }));
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
