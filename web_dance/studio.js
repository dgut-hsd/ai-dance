// 作品工坊:草稿列表 + 6 步工作台壳(剪映 Studio 风)。
// 设备密钥在「游戏设置」页配置,同源共享。
const $ = (id) => document.getElementById(id);
const deviceHeaders = () => {
  const t = localStorage.getItem("dance-device-token") || "";
  return t ? { "X-Device-Token": t } : {};
};

const STEPS = [
  { id: "source", name: "素材" },
  { id: "audio", name: "音频" },
  { id: "sequence", name: "动作序列" },
  { id: "chart", name: "谱面" },
  { id: "lane", name: "判定轨道白影" },
  { id: "publish", name: "出炉" },
];

let works = [];         // 全部作品(草稿 / 已上架 / 回收站)
let modeFilter = "";    // "" | "3d" | "video"
let songsCatalog = [];  // 歌曲库(绑定音乐用)
let videosCatalog = []; // 视频库(绑定视频用)
let current = null;     // 当前打开的作品
let stepIdx = 0;       // 当前步骤下标
let uploading = false;
let generating = false;
let chartMount = null; // { draftId, element } 内嵌谱面编辑器实例(跨步骤复用,避免重导入)

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `请求失败 (${res.status})`); e.status = res.status; throw e; }
  return body;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showToast(msg) {
  let t = document.getElementById("studio-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "studio-toast";
    t.className = "toast";
    t.innerHTML = '<span class="t-icon">✓</span><span class="t-text"></span><span class="t-bar"></span>';
    document.body.appendChild(t);
  }
  t.querySelector(".t-text").textContent = msg;
  // 重放底部消退进度条
  const bar = t.querySelector(".t-bar");
  bar.style.animation = "none";
  void bar.offsetWidth;
  bar.style.animation = "";
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 4000);
}

/** 列表/工作区空态:图标徽章 + 一行说明 */
function emptyBlock(icon, text) {
  const d = el("div", "placeholder");
  d.appendChild(el("div", "p-icon", icon));
  d.appendChild(el("p", null, text));
  return d;
}

function modeName(m) { return m === "video" ? "视频模式" : "3D 角色模式"; }

function stepStatus(d) {
  const f = d.files || {};
  const states = [!!f.source, !!f.audio, !!f.sequence, !!f.chart, !!f.lane, false];
  return states;
}

// ---------------------------------------------------------------------------
// 列表视图
// ---------------------------------------------------------------------------
function renderSkeletons() {
  const area = $("works-area");
  area.innerHTML = "";
  const grid = el("div", "draft-grid");
  for (let i = 0; i < 6; i++) {
    const card = el("article", "draft-card skeleton-card");
    card.innerHTML = '<div class="cover"></div><div class="body"><div class="sk-line w60"></div><div class="sk-line w40"></div></div>';
    grid.appendChild(card);
  }
  area.appendChild(grid);
}

/** 三种状态(字段)就是首页的分区。 */
const STATUS_META = {
  published: { title: "正式作品", icon: "✅", empty: "还没有正式作品，把草稿做到「出炉」就能上架。" },
  draft: { title: "草稿", icon: "✏️", empty: "没有草稿。点右上角「+ 新建作品」开始。" },
  trashed: { title: "回收站", icon: "🗑️", empty: "回收站是空的。" },
};

async function loadList() {
  $("list-status").textContent = "";
  renderSkeletons();
  try {
    const [ws, idx, vids] = await Promise.all([
      api("/api/works", { headers: deviceHeaders() }),
      api("/songs/index.json").catch(() => ({ songs: [] })),
      api("/api/videos").catch(() => []),
    ]);
    works = Array.isArray(ws) ? ws : [];
    songsCatalog = (idx.songs || []).map((s) => ({ id: s.id, label: s.label, file: s.file }));
    videosCatalog = Array.isArray(vids) ? vids : [];
  } catch (e) {
    works = [];
    $("list-status").textContent = e.message;
  }
  renderWorks();
}

function renderWorks() {
  closeWorkMenu();
  const area = $("works-area");
  area.innerHTML = "";
  const list = modeFilter ? works.filter((w) => w.mode === modeFilter) : works;
  $("list-count").textContent = list.length ? `共 ${list.length} 个` : "";
  if (!list.length) {
    area.appendChild(emptyBlock("🎬", works.length
      ? "这个模式下还没有作品，换个标签看看。"
      : "还没有作品。点右上角「+ 新建作品」开始。"));
    return;
  }
  const justPublished = sessionStorage.getItem("studio-just-published");
  for (const s of Object.keys(STATUS_META)) {
    const meta = STATUS_META[s];
    const group = list.filter((w) => w.status === s);
    if (!group.length && s === "trashed") continue; // 回收站空着就不占地方
    const head = el("div", "list-head sub-head");
    head.append(el("h2", null, `${meta.icon} ${meta.title}`), el("span", "count", String(group.length)));
    area.appendChild(head);
    const grid = el("div", "draft-grid");
    if (!group.length) grid.appendChild(el("p", "placeholder", meta.empty));
    for (const w of group) grid.appendChild(workCard(w, w.id === justPublished));
    area.appendChild(grid);
  }
  if (justPublished) sessionStorage.removeItem("studio-just-published");
}

function workCard(w, highlight) {
  const card = el("article", "draft-card work-card");
  if (highlight) card.classList.add("just-published");

  const cover = el("div", "cover");
  cover.appendChild(el("span", null, w.mode === "video" ? "🎬" : "🧍"));
  cover.appendChild(el("span", `status-badge ${w.status}`, STATUS_META[w.status].title));
  // 右上角一个设置齿轮,所有操作都收进它的小菜单里
  const gear = el("button", "work-gear", "⚙");
  gear.title = "设置";
  gear.setAttribute("aria-label", "设置");
  gear.addEventListener("click", (e) => {
    e.stopPropagation();
    openWorkMenu(w, gear, card);
  });
  cover.appendChild(gear);
  card.appendChild(cover);

  const body = el("div", "body");
  body.appendChild(el("div", "name", w.label));
  // 第一行:模式 + 目录;第二行:绑定情况(拆两行才不会挤成一坨)
  const line1 = [modeName(w.mode)];
  if (w.danceId) line1.push(`songs/${w.danceId}`);
  body.appendChild(el("div", "meta", line1.join(" · ")));
  const tags = el("div", "meta tags");
  tags.appendChild(el("span", w.songLabel ? "tag on" : "tag", w.songLabel ? `🎵 ${w.songLabel}` : "🎵 未绑定音乐"));
  if (w.mode === "video") {
    tags.appendChild(el("span", w.videoName ? "tag on" : "tag", w.videoName ? `🎬 ${w.videoName}` : "🎬 未绑定视频"));
  }
  body.appendChild(tags);
  const states = stepStatus(w);
  const doneCount = states.filter(Boolean).length;
  if (w.status !== "published") {
    body.appendChild(el("div", "meta subtle", `已完成 ${doneCount}/${STEPS.length - 1} 步 · ${new Date(w.updatedAt).toLocaleString("zh-CN")}`));
    const bar = el("div", "steps-bar");
    for (let i = 0; i < STEPS.length - 1; i++) {
      const seg = document.createElement("i");
      seg.className = states[i] ? "done" : (states.slice(0, i).every(Boolean) ? "on" : "");
      bar.appendChild(seg);
    }
    body.appendChild(bar);
  }
  card.appendChild(body);
  // 点卡片直接进编辑器(回收站里的除外)
  if (w.status !== "trashed") {
    card.addEventListener("click", () => openDraft(w.id));
  }
  return card;
}

// ---------------------------------------------------------------------------
// 设置齿轮的小菜单(用 fixed 定位挂到 body,避免被卡片的 overflow:hidden 裁掉)
// ---------------------------------------------------------------------------
let openMenuEl = null;

function onMenuDocDown(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeWorkMenu();
}

function closeWorkMenu() {
  if (!openMenuEl) return;
  openMenuEl.remove();
  openMenuEl = null;
  document.removeEventListener("pointerdown", onMenuDocDown, true);
  window.removeEventListener("scroll", closeWorkMenu, true);
  window.removeEventListener("resize", closeWorkMenu, true);
}

function openWorkMenu(w, anchor, card) {
  const sameOne = openMenuEl?.dataset.workId === w.id;
  closeWorkMenu();
  if (sameOne) return; // 再点一次 = 收起

  const menu = el("div", "work-menu");
  menu.dataset.workId = w.id;
  const item = (icon, label, cls, fn) => {
    const b = el("button", `work-menu-item${cls ? " " + cls : ""}`);
    b.append(el("span", "mi-icon", icon), el("span", "mi-label", label));
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeWorkMenu();
      await fn();
    });
    menu.appendChild(b);
  };

  if (w.status === "trashed") {
    item("↩", "找回", "", () => act(`/api/works/${w.id}/restore`, "POST", `已找回「${w.label}」`));
    item("✕", "彻底删除", "danger", () => purgeOne(w));
  } else {
    item("✎", "打开编辑", "strong", () => openDraft(w.id));
    item("♪", "绑定音乐 / 视频", "", () => toggleBind(w, card));
    if (w.status === "published") {
      item("↩", "打回草稿", "", () => act(`/api/works/${w.id}/unpublish`, "POST", `「${w.label}」已打回草稿`));
    }
    item("🗑", "删除", "danger", () => trashOne(w));
  }

  document.body.appendChild(menu);
  // 贴着齿轮摆;下面的空间不够就翻到上面
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.max(12, Math.min(r.right - mw, window.innerWidth - mw - 12));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  requestAnimationFrame(() => menu.classList.add("show"));
  openMenuEl = menu;
  // 下一帧再挂全局监听,免得这次点击立刻把菜单关掉
  setTimeout(() => {
    document.addEventListener("pointerdown", onMenuDocDown, true);
    window.addEventListener("scroll", closeWorkMenu, true);
    window.addEventListener("resize", closeWorkMenu, true);
  }, 0);
}

/** 展开/收起绑定面板(名字 + 音乐 + 视频)—— 从原「舞曲视频」页并过来的能力。 */
function toggleBind(w, card) {
  const open = card.querySelector(".bind-panel");
  if (open) { open.remove(); return; }
  const panel = el("div", "bind-panel");
  // 面板里的点击不要冒泡到卡片(否则一点输入框就跳去编辑器了)
  panel.addEventListener("click", (e) => e.stopPropagation());

  const mkField = (label, node) => {
    const f = el("div", "field");
    f.append(el("label", null, label), node);
    return f;
  };
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = w.label || "";
  nameInput.placeholder = "作品名";
  panel.appendChild(mkField("作品名", nameInput));

  const songSel = document.createElement("select");
  songSel.appendChild(new Option("（不绑定）", ""));
  for (const s of songsCatalog) songSel.appendChild(new Option(s.label, s.id));
  songSel.value = w.songId || "";
  panel.appendChild(mkField("音乐", songSel));

  let videoSel = null;
  if (w.mode === "video") {
    videoSel = document.createElement("select");
    videoSel.appendChild(new Option("（不绑定）", ""));
    for (const v of videosCatalog) videoSel.appendChild(new Option(v.name, v.name));
    videoSel.value = w.videoName || "";
    panel.appendChild(mkField("视频", videoSel));
  }

  const save = el("button", "btn primary sm", "保存绑定");
  save.addEventListener("click", async (e) => {
    e.stopPropagation();
    save.disabled = true;
    save.textContent = "保存中…";
    try {
      const body = { label: nameInput.value.trim(), songId: songSel.value };
      if (videoSel) body.videoName = videoSel.value;
      await api(`/api/works/${w.id}`, {
        method: "PUT",
        headers: { ...deviceHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      showToast("已保存绑定");
      await loadList();
    } catch (err) {
      showToast("保存失败：" + err.message);
      save.disabled = false;
      save.textContent = "保存绑定";
    }
  });
  panel.appendChild(save);
  card.appendChild(panel);
}

async function act(url, method, okMsg) {
  try {
    await api(url, {
      method,
      headers: { ...deviceHeaders(), "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    if (okMsg) showToast(okMsg);
    await loadList();
  } catch (e) {
    showToast("操作失败：" + e.message);
  }
}

async function trashOne(w) {
  if (!confirm(`把「${w.label}」移入回收站？\n\n文件都会保留，随时可以在回收站里找回。`)) return;
  await act(`/api/works/${w.id}/trash`, "POST", `「${w.label}」已移入回收站`);
}

async function purgeOne(w) {
  const extra = w.danceId ? `\n· 已上架目录 songs/${w.danceId}/` : "";
  if (!confirm(`彻底删除「${w.label}」？\n\n会一并删掉：\n· 作品目录${extra}\n· 判定轨道白影\n\n此操作不可恢复！`)) return;
  await act(`/api/works/${w.id}`, "DELETE", `「${w.label}」已彻底删除`);
}

// 上传视频到素材库(原来在「舞曲视频」页,现在并到工坊)
$("btn-upload-video").addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/mp4,video/*";
  input.multiple = true;
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    $("list-status").textContent = "上传中…";
    let ok = 0;
    for (const f of files) {
      try {
        const res = await fetch(`/api/videos/${encodeURIComponent(f.name)}`, {
          method: "PUT", headers: { ...deviceHeaders(), "Content-Type": "application/octet-stream" }, body: f,
        });
        if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || res.status); }
        ok++;
      } catch (e) {
        $("list-status").textContent = `「${f.name}」上传失败：${e.message}`;
      }
    }
    if (ok) showToast(`已上传 ${ok} 个视频到素材库`);
    await loadList();
  };
  input.click();
});

// 模式切换
document.querySelectorAll("#mode-tabs .seg-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mode-tabs .seg-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    modeFilter = btn.dataset.mode || "";
    renderWorks();
  });
});

// ---------------------------------------------------------------------------
// 新建作品
// ---------------------------------------------------------------------------
function openNewModal() { $("new-modal").classList.remove("hidden"); }
function closeNewModal() { $("new-modal").classList.add("hidden"); }

$("btn-new").addEventListener("click", openNewModal);
$("btn-cancel-new").addEventListener("click", closeNewModal);
$("new-modal").addEventListener("click", (e) => { if (e.target === $("new-modal")) closeNewModal(); });
document.querySelectorAll(".mode-option").forEach((opt) => {
  opt.addEventListener("click", async () => {
    closeNewModal();
    try {
      const draft = await api("/api/drafts", { method: "POST", headers: { ...deviceHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ mode: opt.dataset.mode }) });
      await openDraft(draft.id);
    } catch (e) { $("list-status").textContent = e.message; }
  });
});

// ---------------------------------------------------------------------------
// 编辑视图
// ---------------------------------------------------------------------------
async function openDraft(id) {
  try {
    current = await api(`/api/drafts/${id}`, { headers: deviceHeaders() });
  } catch (e) { alert(e.message); return; }
  stepIdx = 0;
  chartMount = null; // 打开新草稿:重置内嵌谱面编辑器
  $("list-view").classList.add("hidden");
  $("editor-view").classList.remove("hidden");
  $("btn-back").classList.remove("hidden");
  $("draft-title").classList.remove("hidden");
  $("mode-badge").classList.remove("hidden");
  $("step-progress").classList.remove("hidden");
  $("save-state").classList.remove("hidden");
  $("btn-publish").classList.remove("hidden");
  $("btn-new").classList.add("hidden");
  $("draft-title").value = current.label || "";
  $("mode-badge").textContent = modeName(current.mode);
  $("btn-publish").disabled = !(current.files?.chart && current.files?.sequence);
  renderSteps();
  renderAssets();
  renderStep();
}

function backToList() {
  current = null;
  chartMount = null; // 回到列表:释放内嵌谱面编辑器
  $("list-view").classList.remove("hidden");
  $("editor-view").classList.add("hidden");
  $("btn-back").classList.add("hidden");
  $("draft-title").classList.add("hidden");
  $("mode-badge").classList.add("hidden");
  $("step-progress").classList.add("hidden");
  $("save-state").classList.add("hidden");
  $("btn-publish").classList.add("hidden");
  $("btn-new").classList.remove("hidden");
  $("bottom-bar").className = "bottom";
  loadList();
}
$("btn-back").addEventListener("click", backToList);

// 作品名:失焦即保存
$("draft-title").addEventListener("change", async () => {
  if (!current) return;
  try {
    current = await api(`/api/drafts/${current.id}/meta`, { method: "PUT", headers: { ...deviceHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ label: $("draft-title").value }) });
    $("save-state").textContent = "已保存";
  } catch (e) { $("save-state").textContent = e.message; }
});

function renderSteps() {
  const box = $("steps");
  box.innerHTML = "";
  const states = stepStatus(current);
  STEPS.forEach((s, i) => {
    const item = el("div", "step-item");
    const done = i < STEPS.length - 1 && states[i];
    if (i === stepIdx) item.classList.add("active");
    if (done) item.classList.add("done");
    const dot = el("span", "step-dot", done ? "✓" : String(i + 1));
    item.append(dot, el("span", "step-name", s.name));
    item.addEventListener("click", () => { stepIdx = i; renderSteps(); renderStep(); });
    box.appendChild(item);
  });
  $("step-progress").textContent = `${stepIdx + 1}/${STEPS.length}`;
}

function renderAssets() {
  const box = $("assets");
  box.innerHTML = "";
  const f = current.files || {};
  const items = [
    { key: "source", label: "素材", file: f.source, icon: current.mode === "video" ? "🎬" : "🧍" },
    { key: "audio", label: "音频", file: f.audio, icon: "🎵" },
    { key: "sequence", label: "序列", file: f.sequence, icon: "📊" },
    { key: "chart", label: "谱面", file: f.chart, icon: "🎼" },
  ];
  for (const it of items) {
    if (!it.file) continue;
    const card = el("div", "asset-card");
    card.append(el("span", "thumb", it.icon), elMeta(it.label, it.file));
    box.appendChild(card);
  }
}

function elMeta(title, sub) {
  const d = document.createElement("div");
  d.className = "meta";
  d.append(el("div", "name", title), el("div", "info", sub));
  return d;
}

// ---------------------------------------------------------------------------
// 步骤内容(中央 stage + 右栏 props)
// ---------------------------------------------------------------------------
function renderStep() {
  const stage = $("stage");
  const props = $("props");
  const bottom = $("bottom-bar");
  stage.innerHTML = "";
  stage.style.padding = "";
  props.innerHTML = "";
  bottom.className = "bottom";
  bottom.innerHTML = "";

  const s = STEPS[stepIdx];
  const f = current.files || {};

  if (s.id === "source") return renderSourceStep(stage, props);
  if (s.id === "audio") return renderAudioStep(stage, props);
  if (s.id === "sequence") return renderSequenceStep(stage, props);
  if (s.id === "chart") return renderChartStep(stage, props);
  if (s.id === "lane") return renderLaneStep(stage, props);
  return renderPublishStep(stage, props);
}

function placeholder(stage, title, desc, actions = [], icon = "") {
  const p = el("div", "placeholder");
  if (icon) p.appendChild(el("div", "p-icon", icon));
  p.appendChild(el("h3", null, title));
  for (const d of desc) if (d) p.appendChild(el("p", null, d));
  for (const a of actions) p.appendChild(a);
  stage.appendChild(p);
}

// ① 素材
function renderSourceStep(stage, props) {
  const isVideo = current.mode === "video";
  if (current.files?.source) {
    // 视频模式预览视频,3D 模式显示文件名
    if (isVideo) {
      const wrap = el("div", "audio-panel");
      const video = document.createElement("video");
      video.className = "preview-video";
      video.controls = true;
      video.src = `/api/drafts/${current.id}/raw/source`;
      wrap.appendChild(video);
      stage.appendChild(wrap);
    } else {
      placeholder(stage, "素材已上传", [`已上传：${current.files.source}`], [], "✅");
    }
    const p = el("div", "placeholder");
    p.style.marginTop = "14px";
    const b = uploadButton("重新上传素材", "source", isVideo ? "video/*" : ".fbx");
    b.classList.remove("primary");
    b.classList.add("ghost");
    p.appendChild(b);
    stage.appendChild(p);
  } else {
    const dz = el("div", "dropzone");
    dz.append(el("div", "big", isVideo ? "🎬" : "🧍"), el("p", "t", isVideo ? "上传舞蹈视频（MP4/MOV）" : "上传 Rokoko 导出的 FBX 动作"), el("p", "s", "点击选择文件"));
    dz.addEventListener("click", () => uploadFile("source", isVideo ? "video/*" : ".fbx"));
    stage.appendChild(dz);
  }
  props.append(
    prop("模式", current.mode === "video" ? "视频模式" : "3D 角色模式"),
    prop("说明", isVideo ? "从视频抽音频并动捕成动作序列" : "FBX 采样成动作序列，音频单独上传"),
  );
}

function uploadButton(label, kind, accept) {
  const b = el("button", "btn primary", label);
  b.addEventListener("click", () => uploadFile(kind, accept));
  return b;
}

function uploadFile(kind, accept) {
  const input = $("file-input");
  input.accept = accept;
  input.value = "";
  input.onchange = async () => {
    const file = input.files[0];
    if (!file || !current) return;
    if (uploading) return;
    uploading = true;
    $("save-state").textContent = "上传中…";
    try {
      const res = await fetch(`/api/drafts/${current.id}/${kind}?name=${encodeURIComponent(file.name)}`, {
        method: "PUT", headers: { ...deviceHeaders(), "Content-Type": "application/octet-stream" }, body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `上传失败 (${res.status})`);
      current = await api(`/api/drafts/${current.id}`, { headers: deviceHeaders() });
      $("save-state").textContent = "已保存";
      renderSteps(); renderAssets(); renderStep();
    } catch (e) {
      $("save-state").textContent = e.message;
    } finally { uploading = false; }
  };
  input.click();
}

// ② 音频
function renderAudioStep(stage, props) {
  const has = !!current.files?.audio;
  if (has) {
    const panel = el("div", "audio-panel");
    const wave = el("div", "wave");
    const canvas = document.createElement("canvas");
    wave.appendChild(canvas);
    panel.appendChild(wave);

    const controls = el("div", "controls");
    const playBtn = el("button", "play-btn", "▶");
    const time = el("span", "time", "0:00 / 0:00");
    controls.append(playBtn, time);
    panel.appendChild(controls);
    stage.appendChild(panel);

    const audio = new Audio(`/api/drafts/${current.id}/raw/audio`);
    let playing = false;
    playBtn.addEventListener("click", () => {
      if (playing) { audio.pause(); playBtn.textContent = "▶"; playing = false; }
      else { audio.play().catch(() => {}); playBtn.textContent = "⏸"; playing = true; }
    });
    audio.addEventListener("timeupdate", () => { time.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration || 0)}`; });
    audio.addEventListener("ended", () => { playBtn.textContent = "▶"; playing = false; });
    audio.addEventListener("loadedmetadata", () => drawWave(canvas, audio.src));

    const p = el("div", "placeholder");
    p.style.marginTop = "12px";
    const re = uploadButton("重新上传音频", "audio", "audio/*");
    re.classList.remove("primary"); re.classList.add("ghost");
    p.appendChild(re);
    stage.appendChild(p);
  } else {
    const actions = [];
    if (current.mode === "video") {
      const b = el("button", "btn primary", "从视频提取音频");
      b.addEventListener("click", extractAudio);
      actions.push(b);
    }
    actions.push(uploadButton("上传音频文件", "audio", "audio/*"));
    placeholder(stage, "还没有音频",
      current.mode === "video" ? ["可从上传的视频里提取音频", "也可以直接上传自己的音频"] : ["上传这首舞曲的音频（WAV/MP3）"],
      actions, "🎵");
  }

  props.append(
    el("div", "props-title", "音频属性"),
    prop("BPM", String(current.bpm || 120), "number"),
    el("div", "hint", "BPM 决定谱面节拍栅格，可在「谱面」步继续调整。"),
  );
  const bpmInput = props.querySelector("input");
  if (bpmInput) bpmInput.addEventListener("change", async () => {
    const v = +bpmInput.value;
    if (!Number.isFinite(v)) return;
    current = await api(`/api/drafts/${current.id}/meta`, { method: "PUT", headers: { ...deviceHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ bpm: v }) });
    $("save-state").textContent = "已保存";
  });
  // 「测定」按钮:听音频自动估 BPM 并填回输入框(测完即保存)
  if (has && bpmInput) {
    const btn = el("button", "btn sm ghost", "测定 BPM");
    btn.style.marginTop = "6px";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "测定中…";
      try {
        const ab = await (await fetch(`/api/drafts/${current.id}/raw/audio`)).arrayBuffer();
        const { detectBpm } = await import("./bpm.js");
        const bpm = await detectBpm(ab);
        if (bpm == null) {
          showToast("没测出来：音频太短或没有明显节拍");
        } else {
          bpmInput.value = String(bpm);
          bpmInput.dispatchEvent(new Event("change"));
          showToast(`测定结果 ${bpm} BPM`);
        }
      } catch (e) {
        showToast("测定失败: " + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "测定 BPM";
      }
    });
    bpmInput.parentElement.appendChild(btn);
  }
}

async function extractAudio() {
  if (!current) return;
  $("save-state").textContent = "抽取音频中…";
  try {
    await api(`/api/drafts/${current.id}/extract-audio`, { method: "POST", headers: deviceHeaders() });
    current = await api(`/api/drafts/${current.id}`, { headers: deviceHeaders() });
    $("save-state").textContent = "已保存";
    renderSteps(); renderAssets(); renderStep();
  } catch (e) {
    $("save-state").textContent = e.message;
  }
}

function fmt(s) {
  s = Math.max(0, Math.floor(+s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function drawWave(canvas, url) {
  try {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const data = buf.getChannelData(0);
    const dpr = globalThis.devicePixelRatio || 1;
    const w = canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const g = canvas.getContext("2d");
    g.fillStyle = "#1c1d22"; g.fillRect(0, 0, w, h);
    const step = Math.max(1, Math.floor(data.length / (w * 2)));
    const mid = h / 2;
    g.strokeStyle = "#4cc2ff"; g.lineWidth = 1; g.beginPath();
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      const start = Math.floor(x * step);
      const end = Math.min(data.length, start + step);
      for (let i = start; i < end; i++) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
      g.moveTo(x + 0.5, mid + min * mid * 0.9);
      g.lineTo(x + 0.5, mid + max * mid * 0.9);
    }
    g.stroke();
    ctx.close();
  } catch { /* 波形绘制失败忽略 */ }
}

// ③ 动作序列
function renderSequenceStep(stage, props) {
  if (generating) return; // 生成中由 generateSequence 接管 stage
  if (current.files?.sequence) {
    placeholder(stage, "动作序列已生成", [
      `${current.files.sequence}`,
      current.mode === "video" ? "由视频动捕生成" : "由 FBX 骨骼采样生成",
      "下一步去「谱面」制作判定点",
    ], [genButton("重新生成")], "✅");
  } else {
    placeholder(stage, "还没有动作序列", [
      current.mode === "video" ? "将对视频逐帧动捕（MediaPipe）" : "将采样 FBX 骨骼动画为 30fps 参考序列",
      current.mode === "video" ? "约需几分钟，期间请勿关闭本页" : "几秒即可完成",
    ], [genButton("生成动作序列")], current.mode === "video" ? "🎬" : "🦴");
  }
  props.append(
    el("div", "props-title", "序列"),
    el("div", "hint", current.mode === "video"
      ? "把真人舞蹈视频逐帧识别成参考动作序列，供评分比对。"
      : "把 Rokoko FBX 骨骼动画采样成参考序列，并自动铺「每 2 拍」一个判定点。"),
  );
}

function genButton(label) {
  const b = el("button", "btn primary", label);
  b.addEventListener("click", generateSequence);
  return b;
}

async function generateSequence() {
  if (!current || generating) return;
  const f = current.files || {};
  if (!f.source) { alert("请先在「① 素材」上传素材"); return; }
  if (current.mode === "3d" && !f.audio) { alert("3D 模式请先在「② 音频」上传音频"); return; }

  generating = true;
  $("save-state").textContent = "生成中…";
  const stage = $("stage");
  stage.innerHTML = "";
  const box = el("div", "audio-panel");
  const title = el("h3", null, "正在生成动作序列…");
  title.style.cssText = "text-align:center;color:var(--text);font-size:16px;margin:0;";
  const track = el("div", "progress-track");
  const fill = el("div", "progress-fill");
  const label = el("div", "progress-label", "准备中…");
  track.appendChild(fill);
  box.append(title, track, label);
  stage.appendChild(box);
  const setProg = (p, txt) => {
    fill.style.width = `${Math.min(100, Math.round(p * 1000) / 10)}%`;
    label.textContent = txt || `${Math.round(p * 100)}%`;
  };

  try {
    const res = await fetch(`/api/drafts/${current.id}/raw/source`);
    if (!res.ok) throw new Error("读取素材失败");
    const blob = await res.blob();
    const file = new File([blob], f.source, { type: current.mode === "video" ? "video/mp4" : "application/octet-stream" });

    let seq;
    if (current.mode === "video") {
      const { exportVideoToSequence } = await import("../pose_capture/export.js");
      const statusMap = { "loading-model": "加载动捕模型…", "processing": "逐帧识别中…" };
      seq = await exportVideoToSequence({
        file,
        mode: "full-body",
        onProgress: (p) => setProg(p),
        onStatus: (s) => setProg(0, statusMap[s] || s),
      });
    } else {
      const { importFbx } = await import("./fbx-import.js");
      setProg(0, "解析 FBX…");
      // importFbx 是 async:漏 await 会把 Promise 序列化成 {}
      seq = await importFbx(file, { bpm: current.bpm || 120, audio: f.audio, danceId: current.danceId || "dance", loopTo: 24 });
      if (!seq?.frames?.length) throw new Error("FBX 里没有采到任何帧(检查动画片段/骨架命名)");
      setProg(1, "完成");
    }

    const save = await fetch(`/api/drafts/${current.id}/sequence`, {
      method: "PUT",
      headers: { ...deviceHeaders(), "Content-Type": "text/plain" },
      body: JSON.stringify(seq),
    });
    if (!save.ok) { const b = await save.json().catch(() => ({})); throw new Error(b.error || "保存失败"); }

    current = await api(`/api/drafts/${current.id}`, { headers: deviceHeaders() });
    $("save-state").textContent = "已保存";
  } catch (e) {
    $("save-state").textContent = "生成失败";
    alert("动作序列生成失败：" + (e.message || e));
  } finally {
    // 必须先清 generating:否则 renderSequenceStep 会因「生成中」直接 return,界面卡在进度页
    generating = false;
  }
  renderSteps(); renderAssets(); renderStep();
}

// ④ 谱面
function renderChartStep(stage, props) {
  if (!current.files?.sequence) {
    placeholder(stage, "还没有动作序列", ["请先在「③ 动作序列」生成参考序列"], [], "🎼");
    props.append(el("div", "hint", "谱面编辑器需要参考序列才能打判定点。"));
    return;
  }
  stage.style.padding = "0";
  // 复用已挂载的编辑器(同草稿):直接放回 stage,保留事件与画布
  if (chartMount && chartMount.draftId === current.id) {
    stage.appendChild(chartMount.element);
  } else {
    const container = document.createElement("div");
    chartMount = { draftId: current.id, element: container };
    stage.appendChild(container);
    (async () => {
      const { mountChartEditorEmbed } = await import("./chart-editor-embed.js");
      await mountChartEditorEmbed(container, {
        draftId: current.id,
        onSaved: () => {
          api(`/api/drafts/${current.id}`, { headers: deviceHeaders() }).then((d) => {
            current = d; renderSteps(); renderAssets(); $("save-state").textContent = "已保存";
          }).catch(() => {});
        },
      });
    })().catch((e) => { placeholder(stage, "谱面编辑器加载失败", [e.message], [], "⚠️"); });
  }
  props.append(
    el("div", "props-title", "谱面"),
    el("div", "hint", "在时间轴上打判定点（点空白=加、拖动=改、右键/列表✕=删）。编辑完点顶栏「保存到草稿」写回。"),
  );
}

// ⑤ 判定轨道白影
async function renderLaneStep(stage, props) {
  if (generating) return;
  if (!current.files?.sequence) {
    placeholder(stage, "还没有动作序列", ["请先在「③ 动作序列」生成参考序列"], [], "👤");
    props.append(el("div", "hint", "判定轨道白影需要参考序列 + 谱面判定点。"));
    return;
  }
  if (!current.files?.chart) {
    placeholder(stage, "还没有谱面", ["请先在「④ 谱面」打判定点"], [], "🎼");
    props.append(el("div", "hint", "白影按谱面的判定点逐点生成。"));
    return;
  }
  placeholder(stage, "加载判定点…", [], [], "⏳");

  try {
    const { laneNoteTimes } = await import("./lane-assets.js");
    const [seqText, models] = await Promise.all([
      fetch(`/api/drafts/${current.id}/text/sequence`, { headers: deviceHeaders() }).then((r) => r.text()),
      api("/api/models"),
    ]);
    const seq = JSON.parse(seqText || "{}");
    const noteTimes = laneNoteTimes(seq);
    if (!noteTimes.length) {
      placeholder(stage, "谱面没有判定点", ["请先在「④ 谱面」打判定点"], [], "🎼");
      return;
    }

    const generated = !!current.files?.lane;
    stage.innerHTML = "";
    const box = el("div", "lane-panel");

    // 模型选择
    const modelField = el("div", "field");
    modelField.appendChild(el("label", "", "白影模型（可换模板）"));
    const modelSel = document.createElement("select");
    if (!models.length) modelSel.appendChild(el("option", "", "（无可用模型）"));
    for (const m of models) {
      const o = el("option", "", m.name);
      o.value = m.url;
      modelSel.appendChild(o);
    }
    if (models[0]) modelSel.value = models[0].url;
    modelField.appendChild(modelSel);
    box.appendChild(modelField);

    // 判定点列表(默认全选 = 当前时机)
    const head = el("div", "lane-head");
    const allCb = document.createElement("input");
    allCb.type = "checkbox";
    allCb.checked = true;
    head.append(allCb, el("span", "", `判定点（${noteTimes.length} 个，默认全部）`));
    box.appendChild(head);

    const noteList = el("div", "lane-note-list");
    const rows = [];
    for (const nt of noteTimes) {
      const row = el("label", "lane-note-row");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      const info = el("span", "lane-note-info", `${nt.t.toFixed(2)}s${nt.moveId ? " · " + nt.moveId : ""}`);
      row.append(cb, info);
      noteList.appendChild(row);
      rows.push({ cb, nt });
    }
    allCb.addEventListener("change", () => { rows.forEach((r) => { r.cb.checked = allCb.checked; }); });
    box.appendChild(noteList);

    // 操作
    const actions = el("div", "p-actions");
    const genBtn = el("button", "btn primary", generated ? "重新生成白影" : "生成白影");
    genBtn.addEventListener("click", () => {
      const picked = rows.filter((r) => r.cb.checked).map((r) => r.nt);
      if (!picked.length) { alert("请至少勾选一个判定点"); return; }
      generateLane(seq, picked, modelSel.value);
    });
    actions.appendChild(genBtn);
    box.appendChild(actions);

    // 已生成:直接预览缩略图
    if (generated) {
      const tHead = el("div", "lane-head");
      tHead.append(el("span", "", "已生成白影预览"));
      box.appendChild(tHead);
      const thumbs = el("div", "lane-thumbs");
      for (const nt of noteTimes) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = `/api/drafts/${current.id}/lane/${nt.key}.png`;
        img.alt = `${nt.t.toFixed(2)}s`;
        img.title = `${nt.t.toFixed(2)}s`;
        img.onerror = () => img.remove();
        thumbs.appendChild(img);
      }
      box.appendChild(thumbs);
    }

    stage.appendChild(box);
  } catch (e) {
    placeholder(stage, "加载失败", [e.message], [], "⚠️");
  }
  props.append(
    el("div", "props-title", "判定轨道白影"),
    el("div", "hint", "把判定点的姿势渲染成 3D 白影（可换模型）。默认按当前所有判定点生成，取消勾选可自定义节点。"),
  );
}

async function generateLane(seq, noteTimes, modelUrl) {
  if (!noteTimes.length || !modelUrl) return;
  generating = true;
  $("save-state").textContent = "生成白影中…";
  try {
    const THREE = await import("three");
    const { loadAvatar } = await import("./avatar.js");
    const { resolveMode } = await import("../pose_capture/contract.js");
    const { createSilhouetteRenderer, alphaCropBox, unionCropBox, renderSilhouetteShot, canvasToPng, applySequenceFrame } = await import("./silhouette.js");

    const model = await loadAvatar(modelUrl);
    const size = 256;
    const sil = createSilhouetteRenderer({ size });
    sil.attach(model.object);
    sil.whiten(model.object);
    const bones = resolveMode(seq.meta?.danceType || "full-body").bones;

    const ARROW_BONES = {
      left_wrist: ["LeftHand"], right_wrist: ["RightHand"],
      left_elbow: ["LeftForeArm"], right_elbow: ["RightForeArm"],
      left_ankle: ["LeftFoot"], right_ankle: ["RightFoot"],
      left_knee: ["LeftLeg"], right_knee: ["RightLeg"],
      hips_center: ["Hips"], nose: ["Head"],
    };
    const jointPointsOf = ({ retargeter }) => {
      const out = {};
      if (!retargeter?.findBone) return out;
      for (const [name, cands] of Object.entries(ARROW_BONES)) {
        const bone = retargeter.findBone(cands);
        if (!bone) continue;
        const p = bone.getWorldPosition(new THREE.Vector3());
        out[name] = [p.x, p.y, p.z];
      }
      return out;
    };

    // 两遍渲染:第一遍求所有动作 alpha 包围盒的并集,第二遍按共用裁剪框出图
    const boxes = [];
    for (const nt of noteTimes) {
      applySequenceFrame(seq, nt.t, model.retargeter, bones, { mirror: false, rootMotion: false });
      model.skeletons?.forEach((s) => s.update());
      model.object.updateMatrixWorld(true);
      boxes.push(alphaCropBox(sil.renderRaw(), { alphaThreshold: sil.opts.alphaThreshold }));
    }
    const crop = unionCropBox(boxes, { size, padFrac: sil.opts.padFrac });

    const notes = [];
    for (const nt of noteTimes) {
      const shot = renderSilhouetteShot({
        sil, object3D: model.object, skeletons: model.skeletons, retargeter: model.retargeter,
        seq, t: nt.t, boneDefs: bones, crop, jointPoints: jointPointsOf,
      });
      notes.push({ t: nt.t, key: nt.key, moveId: nt.moveId ?? null, dataUrl: canvasToPng(shot.canvas), w: shot.width, h: shot.height, joints: shot.joints });
    }
    sil.dispose();

    const res = await fetch(`/api/drafts/${current.id}/lane`, {
      method: "PUT",
      headers: { ...deviceHeaders(), "Content-Type": "text/plain" },
      body: JSON.stringify({ model: modelUrl, size, color: "#ffffff", notes }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || "保存失败"); }

    current = await api(`/api/drafts/${current.id}`, { headers: deviceHeaders() });
    $("save-state").textContent = "已保存";
  } catch (e) {
    $("save-state").textContent = "生成失败";
    alert("白影生成失败：" + (e.message || e));
  } finally {
    // 同 generateSequence:先清 generating 再重绘,否则 renderLaneStep 直接 return
    generating = false;
  }
  renderSteps(); renderAssets(); renderStep();
}

// ⑥ 出炉
function renderPublishStep(stage, props) {
  const f = current.files || {};
  const ready = !!(f.sequence && f.chart && f.audio);
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "dance";
  const danceId = current.danceId || slug(current.label);

  const panel = el("div", "lane-panel");
  const head = el("h3", null, "出炉上架");
  head.style.cssText = "margin:0;font-size:16px;";
  panel.appendChild(head);

  if (!ready) {
    panel.appendChild(el("p", "hint", "还缺少素材/音频/序列/谱面，请先完成前面步骤。"));
    stage.appendChild(panel);
    props.append(el("div", "hint", "上架前需要：素材、音频、动作序列、谱面。"));
    return;
  }

  const summary = el("div", "hint");
  summary.innerHTML = "";
  summary.textContent = [
    `模式：${modeName(current.mode)}`,
    `音频：${f.audio}`,
    current.mode === "video" ? `视频：${f.source}` : `FBX：${f.source}`,
    f.lane ? "白影：已生成" : "白影：未生成（可选）",
  ].join(" · ");
  panel.appendChild(summary);
  stage.appendChild(panel);

  // 右栏:上架表单
  const danceIdInput = document.createElement("input");
  danceIdInput.type = "text";
  danceIdInput.value = danceId;
  const danceIdProp = el("div", "prop");
  danceIdProp.append(el("label", null, "目录名 danceId"), danceIdInput);
  props.appendChild(danceIdProp);

  const bpmInput = document.createElement("input");
  bpmInput.type = "number";
  bpmInput.value = String(current.bpm || 120);
  const bpmProp = el("div", "prop");
  bpmProp.append(el("label", null, "BPM"), bpmInput);
  props.appendChild(bpmProp);

  const overwriteLabel = el("label", "lane-note-row", null);
  const overwriteCb = document.createElement("input");
  overwriteCb.type = "checkbox";
  overwriteLabel.append(overwriteCb, el("span", "", "覆盖已存在的同名舞曲"));
  props.appendChild(overwriteLabel);

  const publishBtn = el("button", "btn primary", "上架到歌单");
  publishBtn.style.marginTop = "6px";
  publishBtn.addEventListener("click", async () => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(danceIdInput.value.trim())) { alert("danceId 需为小写字母/数字/_-，字母或数字开头"); return; }
    if (!confirm(`确认把「${current.label}」上架为 ${danceIdInput.value.trim()}？`)) return;
    publishBtn.disabled = true;
    publishBtn.textContent = "上架中…";
    try {
      const body = JSON.stringify({ overwrite: overwriteCb.checked });
      const res = await fetch(`/api/drafts/${current.id}/publish`, {
        method: "POST", headers: { ...deviceHeaders(), "Content-Type": "application/json" }, body,
      });
      const rb = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(rb.error || `上架失败 (${res.status})`);
      const publishedId = rb.danceId;
      const workId = rb.work?.id || current.id;
      const publishedLabel = current.label; // 先取出来:backToList() 会把 current 置空
      backToList();
      showToast(`已上架「${publishedLabel}」→ songs/${publishedId}/`);
      // 高亮新上架的那张卡(作品记录保留,不再删草稿)
      sessionStorage.setItem("studio-just-published", workId);
    } catch (e) {
      alert("上架失败：" + e.message);
      publishBtn.disabled = false;
      publishBtn.textContent = "上架到歌单";
    }
  });
  props.appendChild(publishBtn);

  // 保存 danceId 到草稿(失焦时)
  danceIdInput.addEventListener("change", async () => {
    current = await api(`/api/drafts/${current.id}/meta`, { method: "PUT", headers: { ...deviceHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ danceId: danceIdInput.value.trim() }) });
    $("save-state").textContent = "已保存";
  });
}

function prop(label, value, type = "text") {
  const wrap = el("div", "prop");
  const lab = el("label", null, label);
  const input = document.createElement(type === "number" ? "input" : "input");
  input.type = type;
  input.value = value ?? "";
  if (type !== "number") input.readOnly = true;
  wrap.append(lab, input);
  return wrap;
}

// ---------------------------------------------------------------------------
// 顶栏「上架」按钮 → 跳到出炉步(让用户先核对再上架)
// ---------------------------------------------------------------------------
$("btn-publish").addEventListener("click", () => {
  stepIdx = STEPS.length - 1;
  renderSteps();
  renderStep();
});

// ---------------------------------------------------------------------------
loadList();
