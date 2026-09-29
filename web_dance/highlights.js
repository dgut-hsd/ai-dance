// 高光录制与上传。玩家端只负责:录制 → 本地即时回放 → 静默后台上传。
// 任务列表 / 二维码 / 下载 / 重试 / 删除等工作人员 UI 已移到 /staff 视频管理页(经 /api/highlights 管理)。
import { copyFor, renderScoreLine, DEFAULT_COPY } from './highlight-copy.js';
const MAX_BYTES = 512 * 1024 * 1024;
// 9:16 竖屏短视频; 布局坐标按 720×1280 设计空间编写, 再等比放大到 1080×1920。
const REC_W = 1080, REC_H = 1920, DESIGN_W = 720, DESIGN_H = 1280;
let dbPromise;
function database() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('dance-highlights', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storage(method, value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('jobs', method === 'getAll' ? 'readonly' : 'readwrite');
    const req = tx.objectStore('jobs')[method](...(value === undefined ? [] : [value]));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('本地保存失败'));
  });
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `请求失败 (${response.status})`);
    error.status = response.status; throw error;
  }
  return response.json();
}
const ownerHeaders = job => ({ 'X-Owner-Token': job.ownerToken });
const jsonHeaders = job => ({ ...ownerHeaders(job), 'Content-Type': 'application/json' });
function put(url, blob, headers, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('PUT', url); xhr.timeout = 180000;
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `上传失败 (${xhr.status})`;
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* OSS may return XML. */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('网络中断，录像已保留，请重试'));
    xhr.ontimeout = () => reject(new Error('上传超时，录像已保留，请重试'));
    xhr.send(blob);
  });
}
function drawContained(ctx, source, x, y, w, h, mirror = false, hShift = 0) {
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  if (!sw || !sh) return;
  const scale = Math.min(w / sw, h / sh), dw = sw * scale, dh = sh * scale;
  // hShift 按绘制宽度 dw 的比例水平平移(正右负左),用于回正分屏造成的舞者偏移。
  ctx.save(); ctx.translate(x + w / 2 + hShift * dw, y + h / 2); if (mirror) ctx.scale(-1, 1);
  ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh); ctx.restore();
}
function cardBlob(result, copy) {
  const canvas = document.createElement('canvas'); canvas.width = REC_W; canvas.height = REC_H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(REC_W / DESIGN_W, 0, 0, REC_H / DESIGN_H, 0, 0);
  ctx.fillStyle = '#0a1025'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#52ffd0'; ctx.font = 'bold 34px sans-serif';
  ctx.fillText(copy.card.eyebrow, 360, 150);
  ctx.font = 'bold 200px sans-serif'; ctx.fillText(result.grade, 360, 420);
  ctx.fillStyle = '#ffd54a'; ctx.font = 'bold 60px sans-serif';
  ctx.fillText(copy.card.gradeTitles[result.grade] || result.grade, 360, 540);
  ctx.fillStyle = '#ffffff'; ctx.font = '42px sans-serif';
  ctx.fillText(renderScoreLine(copy.card.scoreLine, result.score, result.maxCombo), 360, 660);
  ctx.fillStyle = '#52ffd0'; ctx.font = '30px sans-serif';
  ctx.fillText(copy.card.tagline, 360, 760);
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('成绩卡生成失败')), 'image/png'));
}

export class HighlightController {
  constructor({ stage, camera, fx, getState, stageShift }) {
    Object.assign(this, { stage, camera, fx, getState });
    // pk 分屏录制时舞台画面把舞者推到右侧;stageShift 返回需要回正的水平比例(0 表示无需回正)。
    this.stageShift = stageShift || (() => 0);
    this.jobs = new Map(); this.active = null; this.pending = 0;
    // 是否录制由选曲页的「是否录制高光时刻」提示写入 sessionStorage,默认开启。
    this.recordEnabled = sessionStorage.getItem('dance-record-highlight') !== '0';
    // 文案风格与设备密钥由工作人员在 /settings 页面配置,用 localStorage 跨标签页共享。
    this.copyId = localStorage.getItem('dance-highlight-copy') || DEFAULT_COPY;
    this.copy = copyFor(this.copyId);
    this.replayUrl = null; this.replayBlob = null; this.replayResult = null;
    window.addEventListener('beforeunload', e => {
      if (this.active || this.pending || [...this.jobs.values()].some(j => j.blob)) { e.preventDefault(); e.returnValue = ''; }
    });
    this.restored = this.restore();
  }
  deviceToken() { return localStorage.getItem('dance-device-token') || ''; }
  async restore() {
    // 刷新后恢复未上传完的录像,静默续传,不渲染任何 UI。
    try {
      for (const job of await storage('getAll')) {
        if (job.expiresAt < Date.now()) { await storage('delete', job.id); continue; }
        this.jobs.set(job.id, job);
        if (job.blob) void this.upload(job);
      }
    } catch { /* IndexedDB 不可用,忽略 */ }
  }
  clearReplay() {
    if (this.replayUrl) URL.revokeObjectURL(this.replayUrl);
    this.replayUrl = null; this.replayBlob = null; this.replayResult = null;
  }
  getReplay() { return this.replayUrl ? { url: this.replayUrl, result: this.replayResult } : null; }
  async prepare(engine, cancelled = () => false) {
    if (!this.recordEnabled) return null;
    await this.restored;
    this.clearReplay();
    if (this.active || this.pending + [...this.jobs.values()].filter(j => j.blob && !j.running).length >= 3) return null;
    if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
    const mime = ['video/webm;codecs=vp8,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm', 'video/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) return null;
    if (cancelled()) return null;
    let job;
    try {
      job = await api('/api/highlights', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': this.deviceToken() },
        body: JSON.stringify({ mime: mime.split(';')[0] }) });
    } catch { return null; /* 后台未就绪,静默跳过录制,玩家照常跳舞 */ }
    if (cancelled()) {
      await api(`/api/highlights/${job.id}`, { method: 'DELETE', headers: ownerHeaders(job) }).catch(() => {});
      return null;
    }
    job.status = 'uploading'; this.jobs.set(job.id, job);
    await this.persist(job).catch(() => {});
    const canvas = document.createElement('canvas'); canvas.width = REC_W; canvas.height = REC_H;
    // A detached canvas has no render surface, so captureStream emits no frames.
    // Keep it in the document but invisible (in-viewport + opacity:0) so the
    // compositor keeps painting it in both headed and headless Chrome.
    Object.assign(canvas.style, { position: 'fixed', left: '0', top: '0', width: `${REC_W}px`, height: `${REC_H}px`,
      opacity: '0', pointerEvents: 'none', zIndex: '-1' });
    document.body.appendChild(canvas);
    const stream = canvas.captureStream(60);
    let audio;
    try {
      audio = engine.createRecordingTap();
      for (const track of audio.stream.getAudioTracks()) stream.addTrack(track);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000, audioBitsPerSecond: 160000 });
      const active = { job, canvas, ctx: canvas.getContext('2d'), recorder, stream, audio,
        videoTrack: stream.getVideoTracks()[0],
        chunks: [], samples: [], bytes: 0, lastDraw: -Infinity, lastSample: -1, started: null };
      recorder.ondataavailable = e => {
        if (e.data.size) { active.chunks.push(e.data); active.bytes += e.data.size; }
        if (active.bytes > MAX_BYTES && this.active === active) this.abort();
      };
      recorder.onerror = () => this.abort();
      this.active = active;
      return active;
    } catch (e) {
      audio?.disconnect(); stream.getTracks().forEach(t => t.stop()); canvas.remove();
      await api(`/api/highlights/${job.id}`, { method: 'DELETE', headers: ownerHeaders(job) }).catch(() => {});
      this.jobs.delete(job.id); await storage('delete', job.id).catch(() => {});
      return null;
    }
  }
  start() {
    const a = this.active; if (!a) return;
    a.started = performance.now(); a.recorder.start(1000);
  }
  draw() {
    const a = this.active; if (!a || a.started == null) return;
    const now = performance.now(), t = (now - a.started) / 1000;
    if (t > 600) { this.abort(); return; }
    if (now - a.lastDraw < 1000 / 60) return;
    a.lastDraw = now;
    try {
      const ctx = a.ctx, s = this.getState();
      const overlay = this.copy.overlay;
      ctx.setTransform(REC_W / DESIGN_W, 0, 0, REC_H / DESIGN_H, 0, 0);
      // 背景
      ctx.fillStyle = '#090c1b'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
      // 上半:3D 教练(contain 完整入框;pk 分屏时回正,让舞者居中)
      drawContained(ctx, this.stage, 0, 84, DESIGN_W, 520, false, -this.stageShift());
      // 下半:真人(contain 完整入框,镜像;不再铺满遮挡)
      drawContained(ctx, this.camera, 0, 620, DESIGN_W, 560, true);
      // 特效叠加
      ctx.drawImage(this.fx, 0, 0, DESIGN_W, DESIGN_H);
      // 顶栏 + 底栏
      ctx.fillStyle = '#0a1025'; ctx.fillRect(0, 0, DESIGN_W, 80); ctx.fillRect(0, 1200, DESIGN_W, 80);
      // 顶栏:钩子 + 得分
      ctx.fillStyle = '#52ffd0'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(overlay.topTitle, 20, 53);
      ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(`得分 ${Math.round(s.score)}`, 700, 53);
      // 底栏:连击 + 判定短语
      ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`连击 ${s.combo}`, 20, 1253);
      ctx.fillStyle = '#52ffd0'; ctx.font = 'bold 28px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(overlay.tiers[s.tier] || overlay.emptyTier, 700, 1253);
      ctx.textAlign = 'left';
      if (Math.floor(t) !== a.lastSample) {
        a.lastSample = Math.floor(t);
        a.samples.push({ t, conf: s.conf, acc: s.acc, combo: s.combo, tier: s.tier || '' });
      }
      // Headless/compositor-less contexts never repaint the canvas, so captureStream
      // would otherwise emit no video frames and MediaRecorder no data at all.
      try { a.videoTrack?.requestFrame(); } catch { /* capture already stopped */ }
    } catch { this.abort(); }
  }
  release(a) { a.audio.disconnect(); a.stream.getTracks().forEach(t => t.stop()); a.canvas.remove(); }
  abort() {
    const a = this.active; if (!a) return;
    this.active = null;
    a.recorder.ondataavailable = null; a.recorder.onerror = null;
    if (a.recorder.state !== 'inactive') a.recorder.stop();
    this.release(a); a.chunks.length = 0;
    api(`/api/highlights/${a.job.id}`, { method: 'DELETE', headers: ownerHeaders(a.job) }).catch(() => {});
    this.jobs.delete(a.job.id);
    storage('delete', a.job.id).catch(() => {});
  }
  async finish(result) {
    const a = this.active; if (!a) return;
    this.active = null; this.pending++;
    const duration = (performance.now() - a.started) / 1000;
    try {
      await new Promise((resolve, reject) => {
        a.recorder.onstop = resolve;
        a.recorder.onerror = () => reject(new Error('录制未能完成'));
        a.recorder.stop();
      });
      this.release(a);
      if (duration < 1 || a.bytes > MAX_BYTES) throw new Error('录像太短或文件过大');
      const job = a.job;
      job.blob = new Blob(a.chunks, { type: a.recorder.mimeType });
      // 本地即时回放:保留 blob 引用并生成 object URL;上传后仍可播放。
      this.replayBlob = job.blob;
      this.replayUrl = URL.createObjectURL(job.blob);
      this.replayResult = result;
      job.card = await cardBlob(result, this.copy);
      job.metadata = { duration, samples: a.samples, result };
      try { await this.persist(job); } catch { /* 本地空间不足,直接上传 */ }
      // 上传放后台,不阻塞 finish 返回,让回放尽快可用。
      void this.upload(job);
    } catch { /* 录制异常;若已生成 blob,回放仍可用 */ }
    finally { this.release(a); a.chunks.length = 0; this.pending--; }
  }
  persist(job) {
    const { element, running, polling, statusText, ...record } = job;
    return storage('put', record);
  }
  async upload(job) {
    if (job.running || !job.blob) return;
    job.running = true;
    try {
      // 若 completion 响应丢失,重连时不会重复上传第二份。
      const current = await api(`/api/highlights/${job.id}`);
      if (current.status === 'uploading') {
        const destination = await api(`/api/highlights/${job.id}/upload-url`, { method: 'POST', headers: ownerHeaders(job) });
        await put(destination.url, job.blob, destination.headers, () => {});
        await put(`/api/highlights/${job.id}/card`, job.card, { ...ownerHeaders(job), 'Content-Type': 'image/png' }, () => {});
        await api(`/api/highlights/${job.id}/complete`, { method: 'POST', headers: jsonHeaders(job), body: JSON.stringify(job.metadata) });
        job.status = 'queued';
      } else job.status = current.status;
      delete job.blob; delete job.card; delete job.metadata;
      await this.persist(job).catch(() => {});
    } catch { /* 保留 blob,供刷新后静默重试 */ }
    finally { job.running = false; }
  }
}
