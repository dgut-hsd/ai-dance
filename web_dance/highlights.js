// Recording and uploads belong to individual sessions, independently of the next game.
const MAX_BYTES = 200 * 1024 * 1024;
const labels = { uploading: '等待上传', queued: '等待生成', processing: '正在生成高光', ready: '高光已就绪', failed: '生成失败' };
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
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`上传失败 (${xhr.status})`));
    xhr.onerror = () => reject(new Error('网络中断，录像已保留，请重试'));
    xhr.ontimeout = () => reject(new Error('上传超时，录像已保留，请重试'));
    xhr.send(blob);
  });
}
function drawContained(ctx, source, x, y, w, h, mirror = false) {
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  if (!sw || !sh) return;
  const scale = Math.min(w / sw, h / sh), dw = sw * scale, dh = sh * scale;
  ctx.save(); ctx.translate(x + w / 2, y + h / 2); if (mirror) ctx.scale(-1, 1);
  ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh); ctx.restore();
}
function cardBlob(result) {
  const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a1025'; ctx.fillRect(0, 0, 1280, 720);
  ctx.textAlign = 'center'; ctx.fillStyle = '#52ffd0'; ctx.font = 'bold 40px sans-serif';
  ctx.fillText('DANCE ARENA · 我的高光', 640, 135);
  ctx.font = 'bold 150px sans-serif'; ctx.fillText(result.grade, 640, 335);
  ctx.fillStyle = '#ffffff'; ctx.font = '44px sans-serif';
  ctx.fillText(`得分 ${result.score}   ·   最大连击 ${result.maxCombo}`, 640, 445);
  ctx.font = '28px sans-serif'; ctx.fillText('这一刻，为自己喝彩', 640, 560);
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('成绩卡生成失败')), 'image/png'));
}

export class HighlightController {
  constructor({ stage, camera, fx, panel, consent, deviceInput, getState }) {
    Object.assign(this, { stage, camera, fx, panel, consent, deviceInput, getState });
    this.jobs = new Map(); this.active = null; this.pending = 0;
    deviceInput.value = sessionStorage.getItem('dance-device-token') || '';
    deviceInput.addEventListener('change', () => sessionStorage.setItem('dance-device-token', deviceInput.value.trim()));
    window.addEventListener('beforeunload', e => {
      if (this.active || this.pending || [...this.jobs.values()].some(j => j.blob)) { e.preventDefault(); e.returnValue = ''; }
    });
    this.restore();
  }
  message(text) { document.getElementById('highlight-message').textContent = text; }
  async restore() {
    try {
      for (const job of await storage('getAll')) {
        if (job.expiresAt < Date.now()) { await storage('delete', job.id); continue; }
        this.jobs.set(job.id, job); this.renderJob(job); this.poll(job);
      }
    } catch { this.message('浏览器无法持久保存录像；上传期间请勿关闭页面。'); }
  }
  async prepare(engine, cancelled = () => false) {
    if (!this.consent.checked) return null;
    if (this.active || [...this.jobs.values()].filter(j => j.blob).length >= 3)
      throw new Error('请先上传或删除待处理的录像');
    if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('此浏览器不支持高光录制，请使用新版 Chrome 或 Edge');
    const mime = ['video/webm;codecs=vp8,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm', 'video/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mime) throw new Error('此浏览器没有可用的录像编码器');
    const job = await api('/api/highlights', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': this.deviceInput.value.trim() },
      body: JSON.stringify({ mime: mime.split(';')[0] }) });
    if (cancelled()) {
      await api(`/api/highlights/${job.id}`, { method: 'DELETE', headers: ownerHeaders(job) }).catch(() => {});
      return null;
    }
    job.status = 'uploading'; this.jobs.set(job.id, job); this.renderJob(job);
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const stream = canvas.captureStream(30);
    let audio;
    try {
      audio = engine.createRecordingTap();
      for (const track of audio.stream.getAudioTracks()) stream.addTrack(track);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
      const active = { job, canvas, ctx: canvas.getContext('2d'), recorder, stream, audio,
        chunks: [], samples: [], bytes: 0, lastDraw: -Infinity, lastSample: -1, started: null, error: null };
      recorder.ondataavailable = e => {
        if (e.data.size) { active.chunks.push(e.data); active.bytes += e.data.size; }
        if (active.bytes > MAX_BYTES) this.abort('录像超过 200 MB，已停止录制');
      };
      recorder.onerror = () => this.abort('录制失败，本局无法生成高光');
      this.active = active;
      return active;
    } catch (e) {
      audio?.disconnect(); stream.getTracks().forEach(t => t.stop());
      await api(`/api/highlights/${job.id}`, { method: 'DELETE', headers: ownerHeaders(job) }).catch(() => {});
      throw e;
    }
  }
  start() {
    const a = this.active; if (!a) return;
    a.started = performance.now(); a.recorder.start(1000);
    this.message('正在记录本局高光 · 请保持此页面在前台');
  }
  draw() {
    const a = this.active; if (!a || a.started == null) return;
    const now = performance.now(), t = (now - a.started) / 1000;
    if (t > 600) { this.abort('录像已达到 10 分钟上限'); return; }
    if (now - a.lastDraw < 1000 / 30) return;
    a.lastDraw = now;
    try {
      const ctx = a.ctx, s = this.getState();
      ctx.fillStyle = '#090c1b'; ctx.fillRect(0, 0, 1280, 720);
      ctx.drawImage(this.stage, 0, 0, 1280, 720);
      ctx.fillStyle = '#0a1025'; ctx.fillRect(18, 110, 596, 500);
      drawContained(ctx, this.camera, 24, 116, 584, 488, true);
      ctx.drawImage(this.fx, 0, 0, 1280, 720);
      ctx.fillStyle = '#0a1025'; ctx.fillRect(0, 0, 1280, 88); ctx.fillRect(0, 632, 1280, 88);
      ctx.fillStyle = '#52ffd0'; ctx.font = 'bold 32px sans-serif';
      ctx.fillText('DANCE ARENA · 真人 PK', 30, 55);
      ctx.fillStyle = '#fff'; ctx.font = '26px sans-serif';
      ctx.fillText(`得分 ${Math.round(s.score)}    连击 ${s.combo}`, 790, 55);
      ctx.fillText('我的舞台', 42, 683); ctx.fillText(s.tier || '让热爱发光', 850, 683);
      if (Math.floor(t) !== a.lastSample) {
        a.lastSample = Math.floor(t);
        a.samples.push({ t, conf: s.conf, acc: s.acc, combo: s.combo, tier: s.tier || '' });
      }
    } catch { this.abort('画面无法录制，请检查素材跨域配置'); }
  }
  release(a) { a.audio.disconnect(); a.stream.getTracks().forEach(t => t.stop()); }
  abort(message = '') {
    const a = this.active; if (!a) return;
    this.active = null;
    a.recorder.ondataavailable = null; a.recorder.onerror = null;
    if (a.recorder.state !== 'inactive') a.recorder.stop();
    this.release(a); a.chunks.length = 0;
    api(`/api/highlights/${a.job.id}`, { method: 'DELETE', headers: ownerHeaders(a.job) }).catch(() => {});
    this.jobs.delete(a.job.id); a.job.element?.remove();
    if (message) this.message(message);
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
      if (duration < 1 || a.bytes > MAX_BYTES) throw new Error('录像太短或文件过大，无法生成高光');
      const job = a.job;
      job.blob = new Blob(a.chunks, { type: a.recorder.mimeType });
      job.card = await cardBlob(result);
      job.metadata = { duration, samples: a.samples, result };
      try { await this.persist(job); } catch { this.message('本地空间不足，正在直接上传，请勿关闭页面。'); }
      await this.upload(job);
    } catch (e) { this.message(e.message); }
    finally { this.release(a); a.chunks.length = 0; this.pending--; }
  }
  persist(job) {
    const { element, running, polling, statusText, ...record } = job;
    return storage('put', record);
  }
  renderJob(job) {
    if (!job.element) {
      const article = document.createElement('article'); article.className = 'highlight-job';
      const img = document.createElement('img'); img.src = `/api/highlights/${job.id}/qr`; img.alt = '扫码领取本局高光';
      const link = document.createElement('a'); link.href = job.shareUrl; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '打开领取页';
      const status = document.createElement('p'); status.className = 'highlight-job-status'; status.setAttribute('aria-live', 'polite');
      const retry = document.createElement('button'); retry.textContent = '重试'; retry.className = 'btn';
      retry.onclick = () => job.blob ? this.upload(job) : this.retry(job);
      const remove = document.createElement('button'); remove.textContent = '删除本局视频'; remove.className = 'btn';
      remove.onclick = async () => {
        if (job.running) return;
        try {
          await api(`/api/highlights/${job.id}`, { method: 'DELETE', headers: ownerHeaders(job) });
          this.jobs.delete(job.id); await storage('delete', job.id).catch(() => {}); article.remove();
        } catch (e) { status.textContent = e.message; }
      };
      article.append(img, status, link, retry, remove); this.panel.prepend(article); job.element = article;
    }
    job.element.querySelector('p').textContent = job.statusText || labels[job.status] || job.status;
    job.element.querySelectorAll('button')[0].hidden = !(job.blob || job.status === 'failed');
    job.element.querySelectorAll('button').forEach(b => { b.disabled = !!job.running || ['queued', 'processing'].includes(job.status); });
  }
  async upload(job) {
    if (job.running || !job.blob) return;
    job.running = true; this.renderJob(job);
    try {
      // Recover after a lost completion response without uploading a second copy.
      const current = await api(`/api/highlights/${job.id}`);
      if (current.status === 'uploading') {
        const destination = await api(`/api/highlights/${job.id}/upload-url`, { method: 'POST', headers: ownerHeaders(job) });
        await put(destination.url, job.blob, destination.headers, p => { job.statusText = `正在上传 ${p}% · 请勿关闭页面`; this.renderJob(job); });
        await put(`/api/highlights/${job.id}/card`, job.card, { ...ownerHeaders(job), 'Content-Type': 'image/png' }, () => {});
        await api(`/api/highlights/${job.id}/complete`, { method: 'POST', headers: jsonHeaders(job), body: JSON.stringify(job.metadata) });
        job.status = 'queued';
      } else job.status = current.status;
      delete job.blob; delete job.card; delete job.metadata; job.statusText = '';
      await this.persist(job).catch(() => {}); this.poll(job);
    } catch (e) { job.statusText = `${e.message} · 可点击重试`; }
    finally { job.running = false; this.renderJob(job); }
  }
  async retry(job) {
    if (job.running) return;
    try {
      await api(`/api/highlights/${job.id}/retry`, { method: 'POST', headers: ownerHeaders(job) });
      job.status = 'queued'; job.statusText = ''; this.poll(job);
    } catch (e) { job.statusText = e.message; }
    this.renderJob(job);
  }
  async poll(job) {
    if (job.polling) return;
    job.polling = true;
    try {
      while (this.jobs.has(job.id)) {
        try {
          const state = await api(`/api/highlights/${job.id}`);
          job.status = state.status;
          if (!job.running) { job.statusText = state.error || ''; this.renderJob(job); }
          if (['ready', 'failed'].includes(state.status)) break;
        } catch (e) {
          if ([404, 410].includes(e.status)) {
            job.statusText = '视频已过期或已删除'; this.renderJob(job); await storage('delete', job.id).catch(() => {}); break;
          }
          job.statusText = '连接暂时中断，正在重连'; this.renderJob(job);
        }
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
    } finally { job.polling = false; }
  }
}
