// 高光录制与上传。玩家端只负责:录制 → 本地即时回放 → 静默后台上传。
// 任务列表 / 二维码 / 下载 / 重试 / 删除等工作人员 UI 已移到 /staff 视频管理页(经 /api/highlights 管理)。
import { selectHighlightSegments, positiveTitleFor } from './highlight-selector.js';
import { highlightLayout } from './highlight-layout.js';
import { resultCopyFor } from './result-copy.js';
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
function drawCovered(ctx, source, x, y, w, h, mirror = false, hShift = 0, zoom = 1) {
  const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
  if (!sw || !sh) return;
  const scale = Math.max(w / sw, h / sh) * zoom, dw = sw * scale, dh = sh * scale;
  ctx.save(); ctx.translate(x + w / 2 + hShift * dw, y + h / 2); if (mirror) ctx.scale(-1, 1);
  ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh); ctx.restore();
}
function cardBlob(result) {
  const canvas = document.createElement('canvas'); canvas.width = REC_W; canvas.height = REC_H;
  const ctx = canvas.getContext('2d');
  const resultCopy = resultCopyFor(result.grade);
  ctx.setTransform(REC_W / DESIGN_W, 0, 0, REC_H / DESIGN_H, 0, 0);
  const bg = ctx.createLinearGradient(0, 0, 0, DESIGN_H);
  bg.addColorStop(0, '#11100d'); bg.addColorStop(.55, '#070708'); bg.addColorStop(1, '#030407');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
  ctx.strokeStyle = 'rgba(231,193,98,.5)'; ctx.lineWidth = 2; ctx.strokeRect(28, 28, 664, 1224);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#d5b45f'; ctx.font = '700 17px sans-serif';
  ctx.fillText('DANCE ARENA  ·  HIGHLIGHT REPLAY', 360, 122);
  ctx.fillStyle = '#fff2c7'; ctx.font = 'italic 900 58px sans-serif';
  ctx.fillText('你的舞台时刻', 360, 230);
  ctx.fillStyle = '#ffd76d'; ctx.font = 'italic 900 224px sans-serif';
  ctx.fillText(result.grade, 360, 500);
  ctx.font = 'italic 900 62px sans-serif'; ctx.fillText(resultCopy.title, 360, 610);
  ctx.fillStyle = 'rgba(255,255,255,.82)'; ctx.font = '24px sans-serif';
  ctx.fillText(resultCopy.tagline, 360, 662);
  ctx.strokeStyle = 'rgba(231,193,98,.35)'; ctx.beginPath(); ctx.moveTo(110, 730); ctx.lineTo(610, 730); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '900 54px sans-serif'; ctx.fillText(String(Math.round(result.score || 0)), 360, 830);
  ctx.fillStyle = 'rgba(255,255,255,.58)'; ctx.font = '18px sans-serif'; ctx.fillText('SCORE  ·  得分', 360, 870);
  ctx.fillStyle = '#ffe39a'; ctx.font = '800 31px sans-serif';
  ctx.fillText(`MAX COMBO  ${Math.round(result.maxCombo || 0)}`, 360, 955);
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '17px sans-serif';
  ctx.fillText('这一刻，值得被看见', 360, 1140);
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
  getReplay() {
    return this.replayUrl ? {
      url: this.replayUrl,
      result: this.replayResult,
      segments: this.replayResult?.highlights || [],
    } : null;
  }
  async prepare(engine, cancelled = () => false) {
    // 每次读取最新勾选状态(复选框可能在页面加载后才被取消),并清掉上一次回放,避免「不录屏仍回放」。
    this.recordEnabled = sessionStorage.getItem('dance-record-highlight') !== '0';
    if (!this.recordEnabled) { this.clearReplay(); return null; }
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
    } catch (e) {
      // 不能静默:服务端拒绝(429/401/网络)与「浏览器不支持录制」是两种情况,后者本来就该静默。
      console.warn('[highlight] 本局未录制:', e.message);
      return null;
    }
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
        chunks: [], samples: [], markers: [], bytes: 0, lastDraw: -Infinity, lastSample: -1, started: null };
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
  markJudge(marker) {
    const a = this.active;
    if (!a || a.started == null || !Number.isFinite(marker?.time)) return;
    a.markers.push({
      time: Math.max(0, marker.time),
      tier: marker.tier || '',
      accuracy: Number(marker.accuracy) || 0,
      combo: Number(marker.combo) || 0,
      scoreGain: Number(marker.scoreGain) || 0,
      confidence: Number(marker.confidence) || 0,
      noteId: marker.noteId || '',
    });
  }
  draw() {
    const a = this.active; if (!a || a.started == null) return;
    const now = performance.now(), t = (now - a.started) / 1000;
    if (t > 600) { this.abort(); return; }
    if (now - a.lastDraw < 1000 / 60) return;
    a.lastDraw = now;
    try {
      const ctx = a.ctx, s = this.getState();
      const layout = highlightLayout(DESIGN_W, DESIGN_H);
      ctx.setTransform(REC_W / DESIGN_W, 0, 0, REC_H / DESIGN_H, 0, 0);
      // 真人是传播视频的绝对主角：铺满整幅竖屏，画面中心始终留给玩家。
      ctx.fillStyle = '#090c1b'; ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
      drawCovered(ctx, this.camera, layout.camera.x, layout.camera.y, layout.camera.w, layout.camera.h, true);
      // 3D 教练只作为动作对照缩在右上角，不再与真人争夺半屏。
      const p = layout.coach;
      ctx.save();
      ctx.beginPath(); ctx.roundRect(p.x, p.y, p.w, p.h, p.radius); ctx.clip();
      ctx.fillStyle = 'rgba(5,8,18,.88)'; ctx.fillRect(p.x, p.y, p.w, p.h);
      drawCovered(ctx, this.stage, p.x, p.y, p.w, p.h, false, -this.stageShift(), p.zoom);
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,215,109,.72)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(p.x, p.y, p.w, p.h, p.radius); ctx.stroke();
      // 特效叠加
      ctx.drawImage(this.fx, 0, 0, DESIGN_W, DESIGN_H);
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
      if (duration < 1 || a.bytes > MAX_BYTES) throw new Error('录像太短或文件过大');
      const job = a.job;
      job.blob = new Blob(a.chunks, { type: a.recorder.mimeType });
      const highlights = selectHighlightSegments(a.markers, { duration });
      const highlightTitle = positiveTitleFor({
        perfectCount: result.tallies?.perfect || 0,
        maxCombo: result.maxCombo || 0,
        completed: true,
      });
      const replayResult = { ...result, highlights, highlightTitle };
      // 本地即时回放:保留 blob 引用并生成 object URL;上传后仍可播放。
      this.replayBlob = job.blob;
      this.replayUrl = URL.createObjectURL(job.blob);
      this.replayResult = replayResult;
      job.card = await cardBlob(result);
      job.metadata = {
        duration,
        samples: a.samples,
        markers: a.markers,
        highlights,
        highlightTitle,
        result,
      };
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
