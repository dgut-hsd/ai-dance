import { loadSongIndex, dances, songs, danceById, loadSequence, reloadSongIndex } from "./song-library.js";
import { importFbx } from "./fbx-import.js";
import { reconstructJoints } from "../pose_capture/playback.js";
import { renderPoseSilhouette } from "../pose_capture/stick-figure.js";
import { parseChart, serializeChart } from "../scoring/src/chartCodec.js";
import { DEFAULT_BONE_WEIGHTS, BONE_DEFS } from "../scoring/src/schema.js";
import { wavPeaks } from "./wav-peaks.js";
// 判定轨道预览:与游戏页共用同一套"计划 → DOM"实现,保证所见即所得
import { beatDurFor, planPoseLaneFrame } from "./pose-lane.js";
import { createLaneView } from "./lane-view.js";
import { buildLaneFigure } from "./lane-figure.js";
import { laneAssetFor, loadLaneManifest } from "./lane-assets.js";

// 挂载根:独立页面 = document;内嵌进工作台 = 传入的容器元素。
let ROOT = document;
let BODY = document.body;
const $ = (id) => ROOT.querySelector("#" + id);
const DRAFT_KEY = "chart-editor.draft";
// 草稿模式:工作台内嵌时传 draftId,编辑器把谱面保存回草稿而不是 songs/。
let DRAFT_ID = new URLSearchParams(location.search).get("draft");
let onSaved = null; // 内嵌模式的保存回调
const deviceHeaders = () => {
  const t = localStorage.getItem("dance-device-token") || "";
  return t ? { "X-Device-Token": t } : {};
};
const SCRUB_H = 18;
const NOTE_H = 60;
const NOTE_Y = SCRUB_H + (NOTE_H - 26) / 2;
let PX_PER_SEC = 210;
const GU = 64;
const sx = (t) => GU + t * PX_PER_SEC;
const tx = (x) => Math.max(0, Math.min(duration(), (x - GU) / PX_PER_SEC));
const WAVE_VER = "v5";
const BUILD = "9E";
let waveDirty = true;
function setWaveStatus(msg) {
  try { console.log("[wave] " + msg); } catch { /* noop */ }
}

const state = {
  seq: null, baseNotes: [], notes: [], sel: -1,
  playhead: 0, bpm: 120, offset: 0,
  lpb: 4, clickSound: true, clicked: new Set(), clickAccent: null,
  playing: false, drag: null, sourceKey: null, rafId: 0,
  folder: { fbx: null, audio: null }, danceId: null, label: "",
  draftId: DRAFT_ID, draftAudioUrl: null, draftAudioName: null,
  audio: null, audioUrl: null, audioBuf: null, audioPromise: null, peaks: null, decode: "waiting", decodeErr: "", autoFit: null,
  laneManifest: null,   // 逐判定点 3D 白影清单(见 lane-assets.js);加载失败也不影响编辑
};

function slugify(s) {
  return (
    String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_")
      .replace(/^[^a-z0-9]+/, "").slice(0, 64) || "dance"
  );
}

function showErr(msg) {
  const el = $("err");
  if (!el) return alert(msg);
  el.textContent = msg;
  el.style.display = "inline";
}
function clearErr() {
  const el = $("err");
  if (el) el.style.display = "none";
}
window.addEventListener("error", (e) => { if (e.message) showErr("页面错误：" + e.message); });
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  showErr("异步错误：" + (r?.message || String(r)));
});

async function apiJson(url, method, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["X-Owner-Token"] = token;
  const r = await fetch(url, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return r.json();
}

async function putRaw(url, blob, token) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream", "X-Owner-Token": token },
    body: blob,
  });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
}

function frameAt(t) {
  const frames = state.seq?.frames || [];
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid].t < t) lo = mid + 1; else hi = mid; }
  if (!lo) return frames[0] ?? null;
  if (lo === frames.length) return frames[lo - 1];
  return t - frames[lo - 1].t <= frames[lo].t - t ? frames[lo - 1] : frames[lo];
}

function duration() { return state.seq?.meta?.durationSec ?? 0; }

function beatTimes() {
  const beat = 60 / Math.max(1, state.bpm);
  const out = [];
  let t = state.offset;
  while (t <= duration() + 1e-6) { out.push(+t.toFixed(4)); t += beat; }
  return out;
}

// LPB(Lines Per Beat):每拍的细分网格数(1=整拍,2=二分,4=16分,8=32分…)。
// 网格线时间=偏移 + k·(拍长/lpb),吸附与绘制都走它。
let lpbCacheKey = "", lpbCache = [];
function gridTimes() {
  const beat = 60 / Math.max(1, state.bpm);
  const step = beat / Math.max(1, state.lpb);
  const key = `${state.bpm}:${state.offset}:${state.lpb}:${duration()}`;
  if (key === lpbCacheKey) return lpbCache;
  const out = [];
  let t = state.offset;
  while (t <= duration() + 1e-6) { out.push(+t.toFixed(4)); t += step; }
  lpbCacheKey = key;
  lpbCache = out;
  return out;
}

function snapTime(t) {
  if (!$("snap").checked) return Math.max(0, Math.min(duration(), +t.toFixed(3)));
  const grid = gridTimes();
  let best = grid[0] ?? 0, dist = Math.abs(t - best);
  for (const g of grid) { const d = Math.abs(t - g); if (d < dist) { dist = d; best = g; } }
  return Math.max(0, Math.min(duration(), +best.toFixed(3)));
}

function copyNotes(notes) { return JSON.parse(JSON.stringify(notes || [])); }

function setSeq(seq, key, notesOverride) {
  clearErr();
  clearAudio();
  state.autoFit = "window";
  state.seq = seq;
  state.sourceKey = key;
  BODY.classList.remove("no-seq");
  state.notes = notesOverride ?? copyNotes(seq.chart?.notes || []);
  state.baseNotes = copyNotes(state.notes);
  state.sel = -1;
  state.playhead = 0;
  state.bpm = seq.meta?.timing?.bpm ?? seq.meta?.bpm ?? 120;
  state.offset = seq.meta?.timing?.offsetSec ?? 0;
  $("bpm").value = state.bpm;
  $("offset").value = state.offset;
  const draft = loadDraft();
  if (draft && draft.key === key && draft.notes) {
    state.notes = draft.notes;
    $("info").textContent = "已恢复草稿（点「放弃草稿」回到音符起点）";
  }
  fitWindow();
  redraw();
  renderNoteList();
  renderProps();
  drawPose();
  drawWave();
  laneView.reset();
  renderLanePreview();
  setWaveStatus("读取音频…（前端 fetch 字节）");
  ensureAudio().then(() => drawWave()).catch((e) => { showErr("音频：" + e.message); setWaveStatus("启动预载失败：" + e.message); });
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
}
function saveDraft() {
  if (!state.sourceKey) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ key: state.sourceKey, notes: state.notes })); } catch { /* noop */ }
}

// ---- 姿态预览 ---------------------------------------------------------------

function drawPose() {
  const cvs = $("pose"), ctx = cvs.getContext("2d");
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  const seq = state.seq;
  if (!seq) return;
  const frame = frameAt(state.playhead);
  const dims = seq.meta?.dimensions || {};
  if (frame) {
    renderPoseSilhouette(cvs, reconstructJoints(frame, dims, seq.bones), seq.bones);
  }
  const wf = state.peaks ? "已显示" : (state.decode === "fail" ? "失败" + (state.decodeErr ? "(" + state.decodeErr + ")" : "") : (state.audioUrl ? "解码中" : "无音频"));
  $("info").textContent = `${seq.danceId} · ${state.playhead.toFixed(2)}s / ${duration().toFixed(2)}s · ${(seq.frames || []).length}帧 · ${state.notes.length}个判定点 · 波形:${wf}`;
}

// ---- 判定轨道预览(玩家右下角看到的卡片,所见即所得) --------------------------

let laneView = null;
function createLaneViewNow() {
  laneView = createLaneView({
    root: $("pose-hint"), track: $("judge-track"), stage: $("judge-stage"),
    buildFigure: buildLaneFigure,   // 进度条/文字都不挂载(见 lane.css)
  });
}

// 编辑器里的"谱面"就是 state.notes(未保存的草稿),直接当判定事件喂给同一套计划逻辑
function previewEvents() {
  return state.notes
    .map((n, i) => ({ t: n.t, moveId: n.id ?? `pose-${i}`, targetT: n.t }))
    .sort((a, b) => a.t - b.t);
}

function renderLanePreview() {
  if (!state.seq) return;
  const plan = planPoseLaneFrame({
    events: previewEvents(),
    t: state.playhead,
    trackW: $("judge-track")?.clientWidth || 0,
    beatDur: beatDurFor(state.seq),
    trackedKeys: laneView.trackedKeys(),
    arrivedKeys: laneView.arrivedKeys(),
    hasSource: true,
    hasTrack: true,
  });
  laneView.update(plan, {
    seq: state.seq,
    dpr: window.devicePixelRatio || 1,
    entryFor: (ev) => laneAssetFor(state.laneManifest, state.seq?.danceId, ev.t),
  });
}

// ---- 时间轴渲染与交互 --------------------------------------------------------

function resizeCanvas() {
  const cvs = $("timeline"), wrap = cvs.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const scroll = $("timelineScroll");
  const vw = Math.max(40, (scroll && scroll.clientWidth) || window.innerWidth);
  const w = Math.max(320, Math.ceil(duration() * PX_PER_SEC) + vw);
  cvs.style.width = w + "px";
  cvs.style.height = (SCRUB_H + NOTE_H) + "px";
  cvs.width = Math.round(w * dpr);
  cvs.height = Math.round((SCRUB_H + NOTE_H) * dpr);
  cvs.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  const wv = $("waveform");
  const HV = 90;
  wv.style.width = w + "px";
  wv.style.height = HV + "px";
  wv.width = Math.round(w * dpr);
  wv.height = Math.round(HV * dpr);
  wv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  const ph = $("playhead");
  if (ph) ph.style.height = (SCRUB_H + NOTE_H + 6 + HV) + "px";
  waveDirty = true;
}

function clearAudio() {
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audio = null;
  state.audioUrl = null;
  state.audioBuf = null;
  state.audioPromise = null;
  state.peaks = null;
  state.decode = "waiting";
  state.decodeErr = "";
  waveDirty = true;
}

function fitTimeline() {
  const wrap = $("timelineWrap");
  const avail = Math.max(320, (wrap.clientWidth || window.innerWidth - 282) - 20);
  PX_PER_SEC = Math.max(1, Math.round((avail - 40) / Math.max(1, duration())));
  updateZoomUI();
  resizeCanvas();
}

function fitWindow() {
  const wrap = $("timelineWrap");
  const avail = Math.max(320, (wrap.clientWidth || window.innerWidth - 282) - 20);
  const windowSec = Math.min(Math.max(1, duration()), 30);
  PX_PER_SEC = Math.max(1, Math.round((avail - 40) / windowSec));
  updateZoomUI();
  resizeCanvas();
}

function minZoomPxps() {
  const wrap = $("timelineWrap");
  const avail = Math.max(320, ((wrap && wrap.clientWidth) || window.innerWidth - 282) - 20);
  return Math.max(1, Math.round((avail - 40) / Math.max(1, duration())));
}

function updateZoomUI() {
  const z = $("zoom");
  if (!z) return;
  z.min = String(minZoomPxps());
  z.max = "300";
  z.value = PX_PER_SEC;
}

function buildPeaks(ch, sampleRate, durationSec) {
  const targetBuckets = Math.max(2, Math.min(40000, Math.ceil(durationSec * 200)));
  const per = Math.max(1, Math.floor(ch.length / targetBuckets));
  const n = Math.max(2, Math.ceil(ch.length / per));
  const mn = new Float32Array(n), mx = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * per, e = Math.min(ch.length, (i + 1) * per);
    let lo = 1, hi = -1;
    for (let j = s; j < e; j++) { const v = ch[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    mn[i] = lo; mx[i] = hi;
  }
  state.peaks = { min: mn, max: mx, rate: n / Math.max(1, durationSec) };
  waveDirty = true;
}

function waveSelfReport() {
  const cvs = $("waveform");
  if (!cvs) return "找不到 #waveform canvas";
  try {
    const dpr = window.devicePixelRatio || 1;
    const cssW = parseFloat(cvs.style.width) || 0;
    const cssH = parseFloat(cvs.style.height) || 0;
    const r = cvs.getBoundingClientRect();
    const ctx = cvs.getContext("2d");
    const hDev = Math.max(1, Math.round(cssH * dpr));
    const cx = Math.max(0, Math.min(cvs.width - 1, Math.round((GU + 24) * dpr)));
    const img = ctx.getImageData(cx, 0, 1, hDev);
    let painted = 0, sample = "";
    for (let y = 0; y < hDev; y++) {
      const o = y * 4;
      if (img.data[o + 3] > 20) {
        painted++;
        if (sample === "") sample = `rgba(${img.data[o]},${img.data[o + 1]},${img.data[o + 2]},${img.data[o + 3]})`;
      }
    }
    return `styleW=${cssW}px rect=${Math.round(r.width)}x${Math.round(r.height)} 后端=${cvs.width}x${cvs.height} 采样x=${GU + 24} 非透明=${painted}/${hDev}行 首色=${sample}`;
  } catch (e) {
    return "自检异常:" + ((e && e.message) || e);
  }
}

function drawWave() {
  const cvs = $("waveform");
  if (!cvs) return;
  waveDirty = false;
  const ctx = cvs.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, parseFloat(cvs.style.width) || (cvs.clientWidth || cvs.width / dpr) || 320);
  const cssH = parseFloat(cvs.style.height) || cvs.clientHeight || 90;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, cssH);
  const peaks = state.peaks;
  if (!peaks || !peaks.min || !peaks.min.length) {
    ctx.font = "12px system-ui";
    if (state.decode === "fail") {
      ctx.fillStyle = "rgba(255,107,107,.95)";
      ctx.fillText("波形解码失败：" + (state.decodeErr || "未知") + "（右键波形图重试）", GU + 8, 16);
    } else {
      ctx.fillStyle = "rgba(255,255,255,.6)";
      ctx.fillText("音频载入/解码中，波形待显示…", GU + 8, 16);
    }
    return;
  }
  const mid = cssH / 2, amp = mid * 1.7;
  const rate = peaks.rate;
  for (let x = GU; x < w; x++) {
    const t0 = (x - GU) / PX_PER_SEC;
    const t1 = t0 + 1 / PX_PER_SEC;
    const b0 = Math.floor(t0 * rate), b1 = Math.min(peaks.min.length - 1, Math.ceil(t1 * rate));
    let lo = 1, hi = -1;
    if (b1 >= b0) {
      for (let b = b0; b <= b1; b++) { if (peaks.min[b] < lo) lo = peaks.min[b]; if (peaks.max[b] > hi) hi = peaks.max[b]; }
    }
    ctx.fillStyle = "rgba(76,194,255,.8)";
    ctx.fillRect(x, mid - Math.min(1, hi) * amp, 1, Math.max(1, (hi - lo) * amp));
  }
  try {
    const rpt = "自检:" + waveSelfReport();
    ctx.fillStyle = "rgba(255,255,255,.85)";
    ctx.font = "11px system-ui";
    ctx.fillText("引擎" + WAVE_VER + "/BUILD-" + BUILD + " " + rpt, 8, Math.max(12, cssH - 6));
  } catch (e) {
    try { ctx.fillStyle = "#ffb0c0"; ctx.fillText(String((e && e.message) || e), 8, Math.max(12, cssH - 6)); } catch { /* noop */ }
  }
}

function noteWindow(n) { return n.window || { early: -0.25, late: 0.25 }; }
function noteXCss(n) { return sx(n.t) - noteWCss(n) / 2; }
function noteWCss(n) {
  const w = noteWindow(n);
  const c = $("timeline").getContext("2d");
  c.font = "10px system-ui";
  const lw = Math.ceil(c.measureText(n.t.toFixed(2)).width) + 8;
  return Math.min(Math.max(5, (w.late - w.early) * PX_PER_SEC), lw);
}
function noteAtCss(x) {
  let hit = -1, best = Infinity;
  for (let i = 0; i < state.notes.length; i++) {
    const n = state.notes[i];
    const cx = noteXCss(n) + noteWCss(n) / 2;
    if (x >= noteXCss(n) && x <= noteXCss(n) + noteWCss(n)) {
      const d = Math.abs(x - cx);
      if (d < best) { best = d; hit = i; }
    }
  }
  return hit;
}

function redraw() {
  const cvs = $("timeline");
  if (!cvs.width) return;
  const ctx = cvs.getContext("2d");
  const w = cvs.style.width.replace("px", "");
  ctx.clearRect(0, 0, w, SCRUB_H + NOTE_H);
  ctx.font = "10px system-ui";

  ctx.fillStyle = "rgba(255,255,255,.04)";
  ctx.fillRect(0, 0, GU, SCRUB_H + NOTE_H);
  ctx.strokeStyle = "rgba(111,227,161,.3)";
  ctx.beginPath();
  ctx.moveTo(GU + 0.5, 0);
  ctx.lineTo(GU + 0.5, SCRUB_H + NOTE_H);
  ctx.stroke();

  const grid = gridTimes();
  const lpb = Math.max(1, state.lpb);
  const beat = 60 / Math.max(1, state.bpm);
  const linePx = (beat / lpb) * PX_PER_SEC;
  // 网格线太密(<2px)就不画细分线,只画拍线,免得播放时每帧重绘卡顿
  const drawSub = linePx >= 2 && lpb > 1;
  for (let i = 0; i < grid.length; i++) {
    const b = grid[i];
    const x = sx(b);
    if (i % lpb === 0) {
      const bi = i / lpb;
      ctx.fillStyle = bi % 4 === 0 ? "rgba(120,150,255,.45)" : "rgba(120,150,255,.18)";
      ctx.fillRect(x, SCRUB_H, 1, NOTE_H);
      if (bi % 4 === 0) {
        ctx.fillStyle = "rgba(130,160,255,.75)";
        ctx.fillText(String(bi / 4 + 1), x + 3, SCRUB_H - 4);
      }
    } else if (drawSub) {
      ctx.fillStyle = "rgba(255,255,255,.07)";
      ctx.fillRect(x, SCRUB_H, 1, NOTE_H);
    }
  }
  ctx.strokeStyle = "rgba(60,70,110,.6)";
  ctx.strokeRect(0, 0, w, NOTE_H + SCRUB_H);

  for (let i = 0; i < state.notes.length; i++) {
    const n = state.notes[i];
    const x = noteXCss(n);
    const cw = noteWCss(n);
    ctx.fillStyle = i === state.sel ? "#ff5c8a" : "#4cc2ff";
    ctx.globalAlpha = i === state.sel ? 1 : 0.85;
    ctx.fillRect(x, NOTE_Y, cw, 24);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(12,14,20,.9)";
    const txt = (n.t).toFixed(2);
    ctx.fillText(txt, x + (cw - ctx.measureText(txt).width) / 2, NOTE_Y + 16);
  }

  if (waveDirty) { waveDirty = false; drawWave(); }
}

function tFromEvent(e) {
  const rect = $("timeline").getBoundingClientRect();
  return tx(e.clientX - rect.left);
}

function setPlayhead(t) {
  state.playhead = Math.max(0, Math.min(duration(), t));
  const scroll = $("timelineScroll");
  scroll.scrollLeft = Math.max(0, Math.min(state.playhead * PX_PER_SEC, scroll.scrollWidth - scroll.clientWidth));
  redraw();
  drawPose();
  renderLanePreview();   // 卡片预览跟着播放头走
}

function bindTimeline() {
  const TIMELINE = $("timeline");
  TIMELINE.addEventListener("pointerdown", (e) => {
    if (!state.seq) return;
    const rect = TIMELINE.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const t = tFromEvent(e);
    if (state.playing) stopPlay();
    if (y <= SCRUB_H) {
      state.drag = { mode: "scrub" };
      setPlayhead(t);
      return;
    }
    const hit = noteAtCss(e.clientX - rect.left);
    if (hit >= 0) {
      state.drag = { mode: "note", idx: hit, moved: false };
    } else {
      addNote(snapTime(t));
      state.drag = { mode: "none" };
    }
  });
  const SCROLL = $("timelineScroll");
  SCROLL.addEventListener("scroll", () => {
    if (state.playing) return;
    const t = SCROLL.scrollLeft / PX_PER_SEC;
    const pt = Math.max(0, Math.min(duration(), t));
    if (Math.abs(pt - state.playhead) > 0.01) {
      state.playhead = pt;
      redraw();
      drawPose();
    }
  });
  TIMELINE.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!state.seq) return;
    const rect = TIMELINE.getBoundingClientRect();
    const hit = noteAtCss(e.clientX - rect.left);
    const i = hit >= 0 ? hit : state.sel;
    if (i >= 0 && i < state.notes.length) deleteNote(i);
  });
  const WAVEFORM = $("waveform");
  WAVEFORM.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!state.seq || !state.audioBuf) return;
    state.decode = "decoding";
    state.decodeErr = "";
    drawWave();
    decodePeaks(state.audioBuf).catch((err) => {
      state.decode = "fail";
      state.decodeErr = err?.message || String(err);
      drawWave();
      showErr("音频解码失败：" + state.decodeErr);
    });
  });
}

window.addEventListener("pointermove", (e) => {
  if (!state.drag) return;
  if (state.drag.mode === "scrub") setPlayhead(tFromEvent(e));
  else if (state.drag.mode === "note") {
    const n = state.notes[state.drag.idx];
    if (!n) return;
    n.t = snapTime(tFromEvent(e));
    state.drag.moved = true;
    redraw();
    renderLanePreview();
  }
});
window.addEventListener("pointerup", () => {
  if (state.drag?.mode === "note" && !state.drag.moved) {
    selectNote(state.drag.idx);
  }
  state.drag = null;
});

// ---- 音符操作 ----------------------------------------------------------------

function addNote(t) {
  const n = { id: `动作 ${state.notes.length + 1}`, t: +t.toFixed(3), type: "pose",
    difficulty: state.seq?.meta?.difficulty ?? 2, window: null, bones: null };
  state.notes.push(n);
  selectNote(state.notes.length - 1);   // 选中 → 播放头跳过去 → 卡片预览立刻展示它
  saveDraft();
  redraw();
  renderNoteList();
  renderProps();
}

function selectNote(i) {
  state.sel = i;
  const n = state.notes[i];
  if (n) setPlayhead(n.t);   // 点判定点就跳到它的时刻,姿势/卡片预览跟着它
  renderNoteList();
  renderProps();
  redraw();
}

function deleteNote(i) {
  state.notes.splice(i, 1);
  if (state.sel >= state.notes.length) state.sel = state.notes.length - 1;
  if (state.sel === i) state.sel = -1;
  saveDraft();
  redraw();
  renderNoteList();
  renderProps();
  renderLanePreview();
}

function fillEveryN(step) {
  const out = [];
  const beats = beatTimes();
  for (let i = 0; i < beats.length; i += step) {
    out.push({ id: `动作 ${i + 1}`, t: beats[i], type: "pose",
      difficulty: state.seq?.meta?.difficulty ?? 2, window: null, bones: null });
  }
  state.notes = out;
  state.sel = -1;
  saveDraft();
  redraw();
  renderNoteList();
  renderProps();
}

// ---- 列表与属性 --------------------------------------------------------------

/** 属性面板/列表用的是 innerHTML,名字是用户输入 → 转义一下 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderNoteList() {
  const ul = $("noteList");
  ul.innerHTML = "";
  state.notes.forEach((n, i) => {
    const li = document.createElement("li");
    li.className = i === state.sel ? "sel" : "";
    const name = n.id ? `${esc(n.id)} · ` : "";
    li.innerHTML = `<b>${n.t.toFixed(2)}s</b><span class="tag">${name}${n.type}${n.bones ? "·局部" : ""}${n.window ? "·自定义窗" : ""}${n.difficulty ? "·难度" + n.difficulty : ""}</span>`;
    li.onclick = () => selectNote(i);
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.onclick = (e) => { e.stopPropagation(); deleteNote(i); };
    li.appendChild(del);
    ul.appendChild(li);
  });
}

function renderProps() {
  const box = $("props");
  const n = state.sel >= 0 ? state.notes[state.sel] : null;
  if (!n) { box.innerHTML = "<h3>未选中音符</h3>"; return; }
  const names = (state.seq?.bones || BONE_DEFS).map((b) => b.name);
  box.innerHTML = `
    <h3>判定点 #${state.sel + 1}</h3>
    <div class="grid">
      <label>时刻(s)</label><input type="number" id="pTime" step="0.01" value="${n.t.toFixed(3)}">
      <label>动作名</label><input type="text" id="pName" maxlength="40" placeholder="卡片上显示的字" value="${esc(n.id ?? "")}">
      <label>类型</label><select id="pType">
        <option value="pose"${n.type === "pose" ? " selected" : ""}>pose</option>
        <option value="gesture"${n.type === "gesture" ? " selected" : ""}>gesture</option>
      </select>
      <label>难度</label><input type="number" id="pDiff" step="1" min="1" max="10" value="${n.difficulty ?? 2}">
      <label>判定窗</label><select id="pWin">
        <option value=""${!n.window ? " selected" : ""}>默认 ±0.25s</option>
        <option value="tight"${n.window && n.window.late <= 0.16 ? " selected" : ""}>严酷 ±0.15s</option>
        <option value="wide"${n.window && n.window.late >= 0.35 ? " selected" : ""}>宽松 ±0.35s</option>
        <option value="custom"${n.window && n.window.late > 0.16 && n.window.late < 0.35 ? " selected" : ""}>自定义(改下面的值)</option>
      </select>
      ${n.window ? `<label>early</label><input type="number" id="pEarly" step="0.01" value="${n.window.early}">
      <label>late</label><input type="number" id="pLate" step="0.01" value="${n.window.late}">` : ""}
    </div>
    <div class="bones" id="pBones"></div>`;
  const bonesBox = $("pBones");
  for (let i = 0; i < names.length; i++) {
    const btn = document.createElement("button");
    btn.textContent = names[i];
    btn.className = n.bones ? (n.bones.includes(i) ? "on" : "") : "on";
    btn.onclick = () => {
      if (!n.bones) n.bones = Array.from({ length: names.length }, (_, k) => k);
      if (n.bones.includes(i)) n.bones = n.bones.filter((k) => k !== i);
      else n.bones.push(i);
      if (n.bones.length === names.length) n.bones = null;
      saveDraft(); renderProps(); renderNoteList(); redraw();
    };
    bonesBox.appendChild(btn);
  }
  const del = document.createElement("button");
  del.textContent = "删除此判定点";
  del.style.marginTop = "8px";
  del.onclick = () => deleteNote(state.sel);
  box.appendChild(del);
  // 动作名 → note.id(卡片上显示的字);清空则回退成 pose-N
  $("pName").onchange = (ev) => {
    const v = String(ev.target.value || "").trim();
    if (v) n.id = v; else delete n.id;
    saveDraft();
    renderNoteList();
    renderProps();
    renderLanePreview();
  };
  $("pTime").onchange = (ev) => { n.t = +ev.target.value || n.t; saveDraft(); redraw(); renderNoteList(); drawPose(); renderLanePreview(); };
  $("pType").onchange = (ev) => { n.type = ev.target.value; saveDraft(); renderNoteList(); redraw(); };
  $("pDiff").onchange = (ev) => { n.difficulty = Math.min(10, Math.max(1, +ev.target.value || 2)); saveDraft(); renderNoteList(); };
  $("pWin").onchange = (ev) => {
    const v = ev.target.value;
    n.window = v === "" ? null : v === "tight" ? { early: -0.15, late: 0.15 } : v === "wide" ? { early: -0.35, late: 0.35 } : { early: -0.2, late: 0.2 };
    saveDraft(); renderProps();
  };
  if ($("pEarly")) $("pEarly").onchange = (ev) => { n.window.early = +ev.target.value || -0.2; saveDraft(); redraw(); };
  if ($("pLate")) $("pLate").onchange = (ev) => { n.window.late = +ev.target.value || 0.2; saveDraft(); redraw(); };
}

// ---- 判定点音效 ----------------------------------------------------------------
// 播放经过判定点就"嗒"一声,方便对音;统一用一种音效,不做强弱拍区分。
// 用 WebAudio 实时合成:高频噪声爆点,无需音频文件。
let clickCtx = null, clickMaster = null;
function clickCtxInit() {
  if (!clickCtx) {
    clickCtx = new (window.AudioContext || window.webkitAudioContext)();
    clickMaster = clickCtx.createGain();
    clickMaster.gain.value = 1.2;
    clickMaster.connect(clickCtx.destination);
  }
  if (clickCtx.state === "suspended") clickCtx.resume();
  return clickCtx;
}
function clickBeep() {
  try {
    clickCtxInit();           // 确保在用户手势/播放中 Resume
    const ctx = clickCtx, t0 = ctx.currentTime + 0.001;
    const dur = 0.045;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.5);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = 4800; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t0);
    g.gain.exponentialRampToValueAtTime(1.0, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(bp).connect(g).connect(clickMaster);
    src.start(t0);
  } catch { /* 忽略音频异常(未授权等) */ }
}
function traverseNotes(prevT, curT) {
  if (!state.clickSound) return;
  for (let i = 0; i < state.notes.length; i++) {
    const n = state.notes[i];
    if (n.t > prevT + 1e-6 && n.t <= curT + 1e-6 && !state.clicked.has(n)) {
      state.clicked.add(n);
      clickBeep();
    }
  }
}

// ---- 播放 -------------------------------------------------------------------

function ensureAudio() {
  if (!state.audioPromise) {
    state.audioPromise = loadAudio().catch((e) => { state.audioPromise = null; throw e; });
  }
  return state.audioPromise;
}

async function loadAudio() {
  if (state.audioUrl) return state.audio;
  const u = state.draftAudioUrl || state.seq?.chart?.audio || state.seq?.meta?.audio || "";
  let ab = null, src = null;
  if (state.folder.audio) {
    ab = await state.folder.audio.arrayBuffer();
    src = URL.createObjectURL(new Blob([ab], { type: state.folder.audio.type || "audio/wav" }));
  } else if (u) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`获取音频失败：${u} → ${r.status}`);
    ab = await r.arrayBuffer();
    src = URL.createObjectURL(new Blob([ab]));
  }
  if (!src) {
    state.decode = "fail";
    state.decodeErr = "未找到音频";
    setWaveStatus("未找到音频（无 audio 字段 / 无文件夹音频）");
    drawWave();
    showErr("未找到音频，无法显示波形");
    return null;
  }
  setWaveStatus(`已读到 ${(ab.byteLength / (1024 * 1024)).toFixed(1)}MB 音频字节，纯JS解析峰值（引擎${WAVE_VER}）…`);
  const audio = new Audio(src);
  audio.addEventListener("ended", () => { if (state.playing) stopPlay(); });
  state.audio = audio;
  state.audioUrl = src;
  state.audioBuf = ab;
  if (!state.peaks) {
    try {
      await decodePeaks(ab);
    } catch (e) {
      state.decode = "fail";
      state.decodeErr = e?.message || String(e);
      setWaveStatus("失败：" + state.decodeErr);
      drawWave();
      showErr("音频解码失败，波形图无法显示：" + state.decodeErr);
    }
  }
  return audio;
}

async function decodePeaks(ab) {
  const wav = wavPeaks(ab);
  if (wav) {
    state.decode = "ok";
    state.peaks = wav;
    waveDirty = true;
    setWaveStatus(`波形已显示：${state.seq ? duration().toFixed(1) : "?"}s · ${wav.min.length}桶 · 引擎${WAVE_VER}/BUILD-${BUILD}`);
    drawWave();
    return;
  }
  setWaveStatus("未识别为 PCM WAV，改走浏览器 WebAudio 解码…");
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC) {
    state.decode = "fail";
    state.decodeErr = "非 WAV 且浏览器不支持 OfflineAudioContext";
    setWaveStatus("失败：非 WAV 且浏览器不支持 OfflineAudioContext");
    throw new Error(state.decodeErr);
  }
  state.decode = "decoding";
  const ac = new AC(1, 1, 44100);
  const buf = await Promise.race([
    ac.decodeAudioData(ab.slice(0)),
    new Promise((_, rej) => setTimeout(() => rej(new Error("音频解码超时(10s)")), 10000)),
  ]);
  state.decode = "ok";
  buildPeaks(buf.getChannelData(0), buf.sampleRate, buf.duration);
  setWaveStatus(`波形已显示：${duration().toFixed(1)}s · WebAudio解码（引擎${WAVE_VER}）`);
  drawWave();
}

async function startPlay() {
  if (state.playhead >= duration()) setPlayhead(0);
  clickCtxInit();            // 用户手势内创建/恢复 AudioContext,否则会被策略挂起
  setPlayhead(state.playhead);
  state.playing = true;
  state.clicked = new Set();
  $("btnPlay").textContent = "暂停 ⏸";
  const startT = state.playhead;
  const startWall = performance.now();
  let audioReady = false;
  try {
    const audio = await ensureAudio();
    if (audio) {
      if (!state.peaks && state.audioBuf) {
        try { await decodePeaks(state.audioBuf); } catch (e) {
          state.decode = "fail";
          state.decodeErr = e?.message || String(e);
          drawWave();
          showErr("音频解码失败，波形图无法显示：" + state.decodeErr);
        }
      }
      audio.currentTime = Math.max(0, Math.min(state.playhead, audio.duration || state.playhead));
      await audio.play().catch(() => {});
      audioReady = true;
    }
  } catch (e) {
    showErr("音频：" + e.message);
  }
  const tick = () => {
    if (!state.playing) return;
    const prevT = state.playhead;
    let t;
    if (audioReady && state.audio && !state.audio.paused) {
      // 完全跟随音频时钟:判定音与音乐严格对齐,不受 rAF 丢帧/标签页节流/墙钟漂移影响。
      t = state.audio.currentTime;
    } else if (audioReady) {
      // 音频已就绪但还没真正起播(等待缓冲/起播),播放头锁在起点,避免先乱跑再回跳
      t = startT;
    } else {
      // 没有音频(纯 rAF 预览),退回墙钟推进
      t = startT + (performance.now() - startWall) / 1000;
    }
    setPlayhead(t);
    traverseNotes(prevT, t);
    if (state.playhead >= duration()) { stopPlay(); drawWave(); return; }
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}
function stopPlay() {
  state.playing = false;
  state.clicked = new Set();
  cancelAnimationFrame(state.rafId);
  $("btnPlay").textContent = "播放 ▶";
  if (state.audio) { try { state.audio.pause(); } catch { /* noop */ } }
}
function bindPlayControls() {
  $("btnPlay").onclick = () => { if (!state.seq) return; state.playing ? stopPlay() : startPlay(); };
  $("btnFit").onclick = () => {
    state.autoFit = "full";
    state.playhead = 0;
    fitTimeline();
    setPlayhead(0);
    drawWave();
  };
  $("zoom").addEventListener("input", () => {
    state.autoFit = null;
    const minPx = minZoomPxps();
    PX_PER_SEC = Math.max(minPx, +$("zoom").value || PX_PER_SEC);
    $("zoom").value = String(PX_PER_SEC);
    resizeCanvas();
    redraw();
    drawWave();
  });
}
window.addEventListener("resize", () => {
  if (state.autoFit === "window") {
    fitWindow();
  } else if (state.autoFit === "full") {
    fitTimeline();
  } else {
    const z = $("zoom");
    const minPx = minZoomPxps();
    if (z) z.min = String(minPx);
    if (PX_PER_SEC < minPx) {
      PX_PER_SEC = minPx;
      if (z) z.value = String(minPx);
    }
  }
  if (state.autoFit === "window" || state.autoFit === "full") state.playhead = 0;
  resizeCanvas();
  redraw();
  drawWave();
  renderLanePreview();   // 轨道宽度变了 → 剪影流速/位置跟着重算
});

// ---- 导入 / 导出 --------------------------------------------------------------

function audioFileName() {
  if (state.draftAudioName) return state.draftAudioName;
  const seq = state.seq;
  const base = seq.danceId ? `../songs/${seq.danceId}/` : "";
  const audio = seq.chart?.audio || seq.meta?.audio || "";
  return audio.startsWith(base) ? audio.slice(base.length) : audio;
}

function chartContent() {
  const seq = state.seq;
  const events = state.notes.map((n) => ({
    moveId: n.id,
    t: n.t,
    noteType: n.type || "pose",
    targetT: n.t,
    difficulty: n.difficulty,
    window: n.window ? { early: n.window.early, late: n.window.late } : undefined,
    weights: n.bones ? DEFAULT_BONE_WEIGHTS.map((w, i) => (n.bones.includes(i) ? w : 0)) : undefined,
  }));
  const opts = { seq, source: "manual", audio: audioFileName(), judgeOffsetSec: seq.chart?.judgeOffsetSec };
  const content = serializeChart(events, opts);
  if (!seq.chart?.timingWindows && content.timingWindows) delete content.timingWindows;
  return content;
}

function validateContent(content) {
  try {
    const count = parseChart(state.seq, content).length;
    return count;
  } catch (e) {
    alert("谱面校验失败：" + e.message);
    return -1;
  }
}

function readDanceId(silent) {
  const v = String($("danceId").value || "").trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v)) return v;
  if (!silent) alert("目录名(ID)需为小写字母/数字/_-，长度≤64，字母或数字开头");
  return null;
}

function bindSave() {
  $("danceId").addEventListener("change", () => {
    const v = readDanceId(true);
    if (v) state.danceId = v;
  });
  $("btnSave").onclick = async () => {
  const btn = $("btnSave");
  if (!state.seq) return;
  const content = chartContent();
  const count = validateContent(content);
  if (count <= 0) { if (count === 0) alert("谱面没有任何判定点"); return; }
  if (state.draftId) {
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const headers = { ...deviceHeaders(), "Content-Type": "text/plain" };
      const merged = { ...state.seq, chart: content };
      const r1 = await fetch(`/api/drafts/${state.draftId}/sequence`, { method: "PUT", headers, body: JSON.stringify(merged) });
      if (!r1.ok) throw new Error(`保存序列失败 (${r1.status})`);
      const r2 = await fetch(`/api/drafts/${state.draftId}/chart`, { method: "PUT", headers, body: JSON.stringify(content) });
      if (!r2.ok) throw new Error(`保存谱面失败 (${r2.status})`);
      state.baseNotes = copyNotes(state.notes);
      saveDraft();
      alert("已保存到草稿");
      window.parent?.postMessage?.({ type: "draft-saved" }, "*");
      onSaved?.();
    } catch (err) {
      alert("保存失败：" + err.message);
      showErr("保存失败：" + err.message);
    } finally {
      btn.disabled = false; btn.textContent = "保存到草稿";
    }
    return;
  }
  const danceId = readDanceId();
  if (!danceId) return;
  const exist = dances().find((d) => d.danceId === danceId);
  if (exist && state.folder.fbx && !confirm(`songs/${danceId}/ 已存在，保存会覆盖它并更新歌单。继续？`)) return;
  const fbxName = state.folder.fbx ? state.folder.fbx.name : exist?.fbxFile ?? null;
  const audioName = state.folder.audio ? state.folder.audio.name : songs().find((s) => s.id === danceId)?.file ?? exist?.musicFile ?? null;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const created = await apiJson("/api/songs", "POST", {
      danceId, label: state.label || danceId, bpm: state.bpm,
      fbxName, audioName, overwrite: Boolean(exist),
    });
    const token = created.ownerToken;
    if (state.folder.fbx) await putRaw(`/api/songs/${danceId}/fbx`, state.folder.fbx, token);
    if (state.folder.audio) await putRaw(`/api/songs/${danceId}/audio`, state.folder.audio, token);
    const merged = { ...state.seq, chart: content, meta: { ...state.seq.meta, audio: audioFileName() } };
    await putRaw(`/api/songs/${danceId}/chart`, new Blob([JSON.stringify(merged, null, 2)], { type: "text/plain" }), token);
    await apiJson(`/api/songs/${danceId}/complete`, "POST", {}, token);
    await reloadSongIndex();
    populateDances(danceId);
    state.folder = { fbx: null, audio: null };
    state.baseNotes = copyNotes(state.notes);
    saveDraft();
    alert(`已保存到 songs/${danceId}/ 并更新歌单`);
  } catch (err) {
    alert("保存失败：" + err.message);
    showErr("保存失败：" + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存到歌单";
  }
  };
}

function bindNoteButtons() {
  $("btnFill1").onclick = () => fillEveryN(1);
$("btnFill2").onclick = () => fillEveryN(2);
$("btnFill4").onclick = () => fillEveryN(4);
$("btnClear").onclick = () => { state.notes = []; state.sel = -1; saveDraft(); redraw(); renderNoteList(); renderProps(); renderLanePreview(); };

$("btnReset").onclick = () => {
  localStorage.removeItem(DRAFT_KEY);
  state.notes = copyNotes(state.baseNotes);
  state.sel = -1;
  redraw();
  renderNoteList();
  renderProps();
  drawPose();
  renderLanePreview();
};

  ["bpm", "offset"].forEach((id) => $(id).addEventListener("change", () => {
    state.bpm = Math.max(20, Number($("bpm").value) || 120);
    state.offset = Number($("offset").value) || 0;
    redraw();
    drawPose();
    renderLanePreview();   // 拍长变了 → 平台律动也跟着变
  }));

  const lpbEl = $("lpb");
  if (lpbEl) lpbEl.addEventListener("change", () => {
    state.lpb = Math.max(1, Math.min(32, Math.round(Number(lpbEl.value) || 1)));
    lpbEl.value = state.lpb;
    redraw();
    renderNoteList();
    renderProps();
  });
  const csEl = $("clickSound");
  if (csEl) csEl.addEventListener("change", () => { state.clickSound = csEl.checked; });

  // 「测定」BPM:从载入的音频自动估 BPM,列出候选供挑选
  const detectBtn = $("btnDetectBpm");
  if (detectBtn) detectBtn.addEventListener("click", async () => {
    detectBtn.disabled = true;
    detectBtn.textContent = "测定中…";
    detectBtn.parentElement.querySelectorAll(".bpm-cands").forEach((n) => n.remove());
    const bpmInput = $("bpm");
    try {
      if (!state.audioBuf) await ensureAudio();
      const ab = state.audioBuf;
      if (!ab) { showErr("没有已载入的音频，无法测定 BPM"); return; }
      const { detectBpmCandidates } = await import("./bpm.js");
      const cands = await detectBpmCandidates(ab);
      if (!cands.length) { showErr("没测出来：音频太短或没有明显节拍"); return; }
      clearErr();
      cands.forEach((c, i) => {
        const b = document.createElement("button");
        b.className = "needs-seq bpm-cands" + (i === 0 ? " primary" : "");
        b.textContent = String(c.bpm);
        b.title = `候选 ${c.bpm} BPM（匹配分 ${c.score}）`;
        b.addEventListener("click", () => {
          if (bpmInput) { bpmInput.value = String(c.bpm); bpmInput.dispatchEvent(new Event("change")); }
          b.parentElement.querySelectorAll(".bpm-cands").forEach((n) => n.remove());
        });
        detectBtn.parentElement.insertBefore(b, detectBtn.nextSibling);
      });
      showErr("");
    } catch (e) {
      showErr("测定失败：" + e.message);
    } finally {
      detectBtn.disabled = false;
      detectBtn.textContent = "测定";
    }
  });
}

function bindFolder() {
  const folderInput = $("folderFile");
  if (!folderInput) return; // 内嵌工作台没有「舞曲文件夹」入口(素材由工作台管)
  folderInput.addEventListener("change", async (e) => {
  const input = e.target;
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;
  const folderName = (files[0].webkitRelativePath || files[0].name).split("/")[0] || "dance";
  const fbxFile = files.find((f) => /\.fbx$/i.test(f.name));
  const audioFile = files.find((f) => /\.(wav|mp3|ogg|m4a|flac)$/i.test(f.name));
  if (!fbxFile) return alert("文件夹里没有找到 .fbx 文件");
  if (!audioFile) return alert("文件夹里没有找到音频(wav/mp3/ogg/m4a/flac)");
  const danceId = slugify(folderName);
  $("danceId").value = danceId;
  try {
    const seq = await importFbx(fbxFile, { bpm: state.bpm || 120, danceId });
    seq.chart.audio = audioFile.name;
    state.folder = { fbx: fbxFile, audio: audioFile };
    state.danceId = danceId;
    state.label = folderName;
    setSeq(seq, "folder:" + folderName);
    $("info").textContent = `已载入文件夹「${folderName}」→ ${danceId}: ${seq.frames.length} 帧 / ${duration().toFixed(2)}s / 音频 ${audioFile.name}。编辑好点「保存到歌单」`;
  } catch (err) {
    alert("FBX 解析失败：" + err.message);
    showErr("FBX 解析失败：" + err.message);
  }
  });
}

// ---- 初始化 ------------------------------------------------------------------

function populateDances(selectValue) {
  const sel = $("songSel");
  sel.innerHTML = '<option value="">— 选择已有歌曲 —</option>';
  for (const d of dances()) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.label} (${d.danceId})`;
    sel.appendChild(opt);
  }
  sel.value = selectValue ?? "";
}

async function loadDraftMode() {
  BODY.classList.add("draft-mode");
  $("btnSave").textContent = "保存到草稿";
  // 草稿模式隐藏「舞曲文件夹 / 曲子」选择(素材来自草稿)
  for (const id of ["folderFile", "songSel"]) {
    const node = $(id);
    if (node?.closest("label")) node.closest("label").style.display = "none";
  }
  try {
    const r = await fetch(`/api/drafts/${DRAFT_ID}`, { headers: deviceHeaders() });
    if (!r.ok) throw new Error(`读取草稿失败 (${r.status})`);
    const draft = await r.json();
    const sr = await fetch(`/api/drafts/${DRAFT_ID}/text/sequence`, { headers: deviceHeaders() });
    if (!sr.ok) throw new Error(`读取序列失败 (${sr.status})`);
    const seq = JSON.parse(await sr.text());
    state.draftAudioUrl = `/api/drafts/${DRAFT_ID}/raw/audio`;
    state.draftAudioName = draft.files?.audio || "";
    state.danceId = draft.danceId || slugify(draft.label || "dance");
    state.label = draft.label || "";
    $("danceId").value = state.danceId;
    if (!seq.chart) seq.chart = {};
    if (!seq.chart.audio) seq.chart.audio = state.draftAudioName;
    setSeq(seq, "draft:" + DRAFT_ID);
    $("info").textContent = `草稿模式：${draft.label || "未命名"} · ${(seq.frames || []).length} 帧 / ${duration().toFixed(2)}s。编辑完点「保存到草稿」`;
  } catch (err) {
    showErr("草稿加载失败：" + err.message);
  }
}

async function init() {
  setWaveStatus(`波形引擎 ${WAVE_VER} 就绪（未载入音频）`);
  // 逐点 3D 白影清单(没有也照常编辑,预览用 2D 剪影)
  loadLaneManifest().then((m) => { state.laneManifest = m; renderLanePreview(); }).catch(() => {});
  if (DRAFT_ID) { await loadDraftMode(); return; }
  try {
    await loadSongIndex();
    const sel = $("songSel");
    populateDances();
    sel.onchange = async () => {
      const d = danceById(sel.value);
      if (!d) return;
      try {
        const seq = await loadSequence(d.danceId);
        state.folder = { fbx: null, audio: null };
        state.danceId = d.danceId;
        state.label = d.label;
        $("danceId").value = d.danceId;
        setSeq(seq, d.id);
      } catch (err) {
        alert("加载歌曲失败：" + err.message);
        showErr("加载歌曲失败：" + err.message);
      }
    };
    if ($("songSel").options.length <= 1) {
      showErr("歌单为空：请确认 songs/index.json 存在（或用 npm run export-songs 生成）。需配合「npm start」的 Node 服务打开本页。");
    }
  } catch (err) {
    showErr("歌单加载失败：" + err.message + " —— 请用 http 方式打开（npm start → http://localhost:8000/web_dance/chart-editor.html），python -m http.server 只能看不能保存，双击 file:// 无法运行。");
  }
}

/**
 * 挂载谱面编辑器。
 *  - 独立页面:chart-editor.html 的 <script type="module"> 里直接 import 后调用
 *    mountChartEditor(document.body, {})(此时 DRAFT_ID 已从 URL 读好)。
 *  - 内嵌工作台:const { mountChartEditor } = await import("./chart-editor.js");
 *    mountChartEditor(container, { draftId, onSaved })。
 */
export function mountChartEditor(container, { draftId = null, onSaved: cb = null } = {}) {
  ROOT = container;
  BODY = container;
  if (draftId) { DRAFT_ID = draftId; state.draftId = draftId; }
  if (cb) onSaved = cb;
  createLaneViewNow();
  bindTimeline();
  bindPlayControls();
  bindSave();
  bindNoteButtons();
  bindFolder();
  return init();
}