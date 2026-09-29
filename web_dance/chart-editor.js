import { loadSongIndex, dances, songs, danceById, loadSequence, reloadSongIndex } from "./song-library.js";
import { importFbx } from "./fbx-import.js";
import { reconstructJoints } from "../pose_capture/playback.js";
import { renderPoseSilhouette } from "../pose_capture/stick-figure.js";
import { parseChart, serializeChart } from "../scoring/src/chartCodec.js";
import { DEFAULT_BONE_WEIGHTS, BONE_DEFS } from "../scoring/src/schema.js";

const $ = (id) => document.getElementById(id);
const DRAFT_KEY = "chart-editor.draft";
const SCRUB_H = 18;
const NOTE_H = 60;
const NOTE_Y = SCRUB_H + (NOTE_H - 26) / 2;
const PX_PER_SEC = 210;

const state = {
  seq: null, baseNotes: [], notes: [], sel: -1,
  playhead: 0, bpm: 120, offset: 0,
  playing: false, drag: null, sourceKey: null, rafId: 0,
  folder: { fbx: null, audio: null }, danceId: null, label: "",
};

function slugify(s) {
  return (
    String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_")
      .replace(/^[^a-z0-9]+/, "").slice(0, 64) || "dance"
  );
}

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

function snapTime(t) {
  if (!$("snap").checked) return Math.max(0, Math.min(duration(), +t.toFixed(3)));
  const beats = beatTimes();
  let best = beats[0] ?? 0, dist = Math.abs(t - best);
  for (const b of beats) { const d = Math.abs(t - b); if (d < dist) { dist = d; best = b; } }
  return Math.max(0, Math.min(duration(), +best.toFixed(3)));
}

function copyNotes(notes) { return JSON.parse(JSON.stringify(notes || [])); }

function setSeq(seq, key, notesOverride) {
  state.seq = seq;
  state.sourceKey = key;
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
  resizeCanvas();
  redraw();
  renderNoteList();
  renderProps();
  drawPose();
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
  $("info").textContent = `${seq.danceId} · ${state.playhead.toFixed(2)}s / ${duration().toFixed(2)}s · ${(seq.frames || []).length}帧 · ${state.notes.length}个判定点`;
}

// ---- 时间轴渲染与交互 --------------------------------------------------------

function resizeCanvas() {
  const cvs = $("timeline"), wrap = cvs.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(320, Math.ceil(duration() * PX_PER_SEC) + 40);
  cvs.style.width = w + "px";
  cvs.width = Math.round(w * dpr);
  cvs.height = Math.round((SCRUB_H + NOTE_H) * dpr);
  cvs.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

function noteWindow(n) { return n.window || { early: -0.25, late: 0.25 }; }
function noteXCss(n) { return (n.t + noteWindow(n).early) * PX_PER_SEC; }
function noteWCss(n) { const w = noteWindow(n); return Math.max(5, (w.late - w.early) * PX_PER_SEC); }
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

  const beats = beatTimes();
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const x = b * PX_PER_SEC;
    ctx.fillStyle = i % 4 === 0 ? "rgba(120,150,255,.45)" : "rgba(120,150,255,.18)";
    ctx.fillRect(x, SCRUB_H, 1, NOTE_H);
    if (i % 4 === 0) {
      ctx.fillStyle = "rgba(130,160,255,.75)";
      ctx.fillText(String(i / 4 + 1), x + 3, SCRUB_H - 4);
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
    ctx.fillText((n.t).toFixed(2), x + 3, NOTE_Y + 16);
  }

  const px = state.playhead * PX_PER_SEC;
  ctx.strokeStyle = "#6fe3a1";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, SCRUB_H + NOTE_H);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function tFromEvent(e) {
  const rect = $("timeline").getBoundingClientRect();
  return Math.max(0, Math.min(duration(), (e.clientX - rect.left) / PX_PER_SEC));
}

function setPlayhead(t) {
  state.playhead = Math.max(0, Math.min(duration(), t));
  const wrap = $("timeline").parentElement;
  wrap.scrollLeft = Math.max(0, state.playhead * PX_PER_SEC - wrap.clientWidth * 0.5);
  redraw();
  drawPose();
}

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
window.addEventListener("pointermove", (e) => {
  if (!state.drag) return;
  if (state.drag.mode === "scrub") setPlayhead(tFromEvent(e));
  else if (state.drag.mode === "note") {
    const n = state.notes[state.drag.idx];
    if (!n) return;
    n.t = snapTime(tFromEvent(e));
    state.drag.moved = true;
    redraw();
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
  const n = { id: `m-${Date.now()}`, t: +t.toFixed(3), type: "pose",
    difficulty: state.seq?.meta?.difficulty ?? 2, window: null, bones: null };
  state.notes.push(n);
  selectNote(state.notes.length - 1);
  saveDraft();
  redraw();
  renderNoteList();
  renderProps();
}

function selectNote(i) {
  state.sel = i;
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
}

function fillEveryN(step) {
  const out = [];
  const beats = beatTimes();
  for (let i = 0; i < beats.length; i += step) {
    out.push({ id: `auto-${i}`, t: beats[i], type: "pose",
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

function renderNoteList() {
  const ul = $("noteList");
  ul.innerHTML = "";
  state.notes.forEach((n, i) => {
    const li = document.createElement("li");
    li.className = i === state.sel ? "sel" : "";
    li.innerHTML = `<b>${n.t.toFixed(2)}s</b><span class="tag">${n.type}${n.bones ? "·局部" : ""}${n.window ? "·自定义窗" : ""}${n.difficulty ? "·难度" + n.difficulty : ""}</span>`;
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
  $("pTime").onchange = (ev) => { n.t = +ev.target.value || n.t; saveDraft(); redraw(); renderNoteList(); drawPose(); };
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

// ---- 播放 -------------------------------------------------------------------

function startPlay() {
  state.playing = true;
  $("btnPlay").textContent = "暂停 ⏸";
  let last = performance.now();
  const tick = (now) => {
    if (!state.playing) return;
    const dt = (now - last) / 1000; last = now;
    setPlayhead(state.playhead + dt);
    if (state.playhead >= duration()) { stopPlay(); return; }
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}
function stopPlay() {
  state.playing = false;
  cancelAnimationFrame(state.rafId);
  $("btnPlay").textContent = "播放 ▶";
}
$("btnPlay").onclick = () => { if (!state.seq) return; state.playing ? stopPlay() : startPlay(); };

// ---- 导入 / 导出 --------------------------------------------------------------

function audioFileName() {
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
  } finally {
    btn.disabled = false;
    btn.textContent = "保存到歌单";
  }
};

$("btnFill1").onclick = () => fillEveryN(1);
$("btnFill2").onclick = () => fillEveryN(2);
$("btnFill4").onclick = () => fillEveryN(4);
$("btnClear").onclick = () => { state.notes = []; state.sel = -1; saveDraft(); redraw(); renderNoteList(); renderProps(); };

$("btnReset").onclick = () => {
  localStorage.removeItem(DRAFT_KEY);
  state.notes = copyNotes(state.baseNotes);
  state.sel = -1;
  redraw();
  renderNoteList();
  renderProps();
  drawPose();
};

["bpm", "offset"].forEach((id) => $(id).addEventListener("change", () => {
  state.bpm = Math.max(20, Number($("bpm").value) || 120);
  state.offset = Number($("offset").value) || 0;
  redraw();
  drawPose();
}));

$("folderFile").addEventListener("change", async (e) => {
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
  }
});

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
  sel.value = selectValue ?? dances()[0]?.id ?? "";
}

async function init() {
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
    }
  };
  if (dances().length) await sel.onchange();
}

init();