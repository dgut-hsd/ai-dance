// 舞曲视频管理:视频库(上传/删除/缩略图) + 舞曲↔视频绑定 + 舞曲名字/歌曲编辑。
// 设备密钥在「游戏设置」页配置,同源共享。
const $ = (id) => document.getElementById(id);
const deviceHeaders = () => {
  const t = localStorage.getItem("dance-device-token") || "";
  return t ? { "X-Device-Token": t } : {};
};

let videos = [];   // [{ name, url, poster, duration, width, height }]
let mapping = {};  // danceId -> 视频文件名
let dances = [];   // [{ id, label, defaultSongId }]
let songs = [];    // [{ id, label, file, bpm }]

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(20000) });
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

// 往 thumb 容器里放封面图(带加载失败占位)。
function fillThumb(thumb, video) {
  thumb.innerHTML = "";
  if (video) {
    const img = document.createElement("img");
    img.alt = video.name;
    img.onerror = () => { thumb.innerHTML = ""; thumb.appendChild(el("div", "placeholder", "无封面")); };
    img.src = video.poster;
    thumb.appendChild(img);
  } else {
    thumb.appendChild(el("div", "placeholder", "未绑定"));
  }
}

function renderVideos() {
  const grid = $("video-grid");
  grid.innerHTML = "";
  $("video-count").textContent = `共 ${videos.length} 个`;
  if (!videos.length) { grid.appendChild(el("p", "empty", "暂无视频，点「上传视频」添加")); return; }
  const boundNames = new Set(Object.values(mapping).filter(Boolean));
  for (const v of videos) {
    const card = el("article", "video-card");
    const bound = boundNames.has(v.name);
    if (bound) card.classList.add("bound");

    const thumb = el("div", "thumb");
    thumb.title = "点击预览播放";
    thumb.addEventListener("click", () => window.open(v.url, "_blank", "noopener"));
    fillThumb(thumb, v);
    if (bound) thumb.appendChild(el("span", "badge", "已绑定"));
    card.appendChild(thumb);

    const meta = el("div", "meta");
    const info = `${v.duration != null ? v.duration + "s" : "—"} · ${v.width && v.height ? `${v.width}×${v.height}` : "—"}`;
    meta.append(el("span", "name", v.name), el("span", "info", info));
    card.appendChild(meta);

    const actions = el("div", "actions");
    const del = el("button", "btn danger", "删除");
    del.onclick = async () => {
      if (!confirm(`删除「${v.name}」？已绑定它的舞曲会被取消绑定。`)) return;
      try {
        await api(`/api/videos/${encodeURIComponent(v.name)}`, { method: "DELETE", headers: deviceHeaders() });
        await loadAll();
      } catch (e) { $("status").textContent = "删除失败: " + e.message; }
    };
    actions.appendChild(del);
    card.appendChild(actions);

    grid.appendChild(card);
  }
}

function renderDances() {
  const list = $("dance-list");
  list.innerHTML = "";
  $("dance-count").textContent = `共 ${dances.length} 支`;
  if (!dances.length) { list.appendChild(el("p", "empty", "未加载到歌单（需先导出/制谱）")); return; }
  for (const d of dances) {
    const row = el("div", "dance-row" + (mapping[d.id] ? "" : " unbound"));
    row.dataset.danceId = d.id;

    // 缩略图(当前绑定视频)
    const thumb = el("div", "thumb");
    fillThumb(thumb, videos.find((v) => v.name === mapping[d.id]));
    row.appendChild(thumb);

    // 舞曲名
    const nameField = el("div", "field");
    nameField.appendChild(el("label", "", "舞曲名"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = d.label || "";
    nameInput.placeholder = "舞曲名";
    nameField.appendChild(nameInput);
    row.appendChild(nameField);

    // 歌曲
    const songField = el("div", "field");
    songField.appendChild(el("label", "", "歌曲"));
    const songSel = document.createElement("select");
    for (const s of songs) {
      const o = el("option", "", s.label);
      o.value = s.id;
      songSel.appendChild(o);
    }
    songSel.value = d.defaultSongId || (songs[0] && songs[0].id) || "";
    songField.appendChild(songSel);
    row.appendChild(songField);

    // 视频
    const videoField = el("div", "field");
    videoField.appendChild(el("label", "", "视频"));
    const videoSel = document.createElement("select");
    const none = el("option", "", "（不绑定）");
    none.value = "";
    videoSel.appendChild(none);
    for (const v of videos) {
      const o = el("option", "", v.name);
      o.value = v.name;
      videoSel.appendChild(o);
    }
    videoSel.value = mapping[d.id] || "";
    videoSel.addEventListener("change", () => {
      mapping[d.id] = videoSel.value;
      row.classList.toggle("unbound", !videoSel.value);
      fillThumb(thumb, videos.find((v) => v.name === videoSel.value));
    });
    videoField.appendChild(videoSel);
    row.appendChild(videoField);

    list.appendChild(row);
  }
}

async function loadAll() {
  try {
    const [vids, map, songsIdx] = await Promise.all([
      api("/api/videos"),
      api("/api/videos-map"),
      fetch("/songs/index.json").then((r) => r.json()),
    ]);
    videos = vids || [];
    mapping = (map && map.mapping) || {};
    dances = (songsIdx && songsIdx.dances) || [];
    songs = (songsIdx && songsIdx.songs) || [];
    renderVideos();
    renderDances();
    $("status").textContent = `已载入 · ${new Date().toLocaleTimeString("zh-CN")}`;
  } catch (e) {
    $("status").textContent = e.message;
  }
}

$("refresh").onclick = loadAll;

$("upload").addEventListener("change", async () => {
  const files = [...$("upload").files];
  $("upload").value = "";
  if (!files.length) return;
  $("status").textContent = "上传中…";
  let ok = 0;
  for (const f of files) {
    try {
      const res = await fetch(`/api/videos/${encodeURIComponent(f.name)}`, {
        method: "PUT",
        headers: { ...deviceHeaders(), "Content-Type": "application/octet-stream" },
        body: f,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `上传失败 (${res.status})`);
      ok++;
    } catch (e) {
      $("status").textContent = `「${f.name}」上传失败: ${e.message}`;
    }
  }
  if (ok) { $("status").textContent = `已上传 ${ok} 个视频`; await loadAll(); }
});

$("save-all").onclick = async () => {
  try {
    // 1) 保存每支舞曲的名字 + 歌曲
    for (const row of document.querySelectorAll(".dance-row")) {
      const danceId = row.dataset.danceId;
      const nameInput = row.querySelector("input[type=text]");
      const selects = row.querySelectorAll("select");
      const songSel = selects[0];
      const videoSel = selects[1];
      await api(`/api/dances/${encodeURIComponent(danceId)}`, {
        method: "PUT",
        headers: { ...deviceHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ label: nameInput.value.trim(), songId: songSel.value }),
      });
      mapping[danceId] = videoSel.value;
    }
    // 2) 保存视频绑定
    await api("/api/videos-map", {
      method: "PUT",
      headers: { ...deviceHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ mapping }),
    });
    $("status").textContent = "已保存";
    await loadAll();
  } catch (e) {
    $("status").textContent = "保存失败: " + e.message;
  }
};

loadAll();
