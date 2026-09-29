// 游戏设置:设备密钥、文案风格、摄像头切换,全部写入 localStorage,与游戏页/视频管理页(同源)共享。
const $ = (id) => document.getElementById(id);

$("device-token").value = localStorage.getItem("dance-device-token") || "";
$("copy-style").value = localStorage.getItem("dance-highlight-copy") || "challenge";
$("device-token").addEventListener("change", () => localStorage.setItem("dance-device-token", $("device-token").value.trim()));
$("copy-style").addEventListener("change", () => localStorage.setItem("dance-highlight-copy", $("copy-style").value));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---------------------------------------------------------------------------
// 摄像头扫描 / 切换:选择的 deviceId 写入 localStorage,游戏页 startCamera 读取后使用。
// ---------------------------------------------------------------------------
const CAMERA_KEY = "dance-camera-device-id";
let cameraPreviewStream = null;

function cameraStatus(msg) { $("camera-status").textContent = msg; }

async function requestCameraPermission() {
  // 先申请一次权限并立即释放,浏览器才会在 enumerateDevices 里返回设备标签。
  const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  probe.getTracks().forEach((t) => t.stop());
}

async function refreshCameraList(probe) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    cameraStatus("当前浏览器不支持摄像头枚举");
    return;
  }
  if (probe) {
    try { await requestCameraPermission(); }
    catch (e) { cameraStatus("无法访问摄像头(请允许权限): " + e.message); return; }
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const sel = $("camera-select");
  sel.innerHTML = "";
  const def = el("option", "", "默认（前置）");
  def.value = "";
  sel.appendChild(def);
  cameras.forEach((c, i) => {
    const o = el("option", "", c.label || `摄像头 ${i + 1}`);
    o.value = c.deviceId;
    sel.appendChild(o);
  });
  sel.value = localStorage.getItem(CAMERA_KEY) || "";
  cameraStatus(cameras.length ? `找到 ${cameras.length} 个摄像头` : "未找到摄像头");
}

function stopCameraPreview() {
  if (cameraPreviewStream) {
    cameraPreviewStream.getTracks().forEach((t) => t.stop());
    cameraPreviewStream = null;
  }
  $("camera-preview").srcObject = null;
  $("camera-preview-wrap").classList.add("hidden");
  $("camera-preview-toggle").textContent = "预览";
  $("camera-params").classList.add("hidden");
  $("camera-params-controls").innerHTML = "";
}

async function startCameraPreview() {
  stopCameraPreview();
  const deviceId = $("camera-select").value;
  try {
    const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = "user";
    cameraPreviewStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    const elv = $("camera-preview");
    elv.srcObject = cameraPreviewStream;
    await elv.play();
    $("camera-preview-wrap").classList.remove("hidden");
    $("camera-preview-toggle").textContent = "关闭预览";
    cameraStatus("预览中");
    // 读取当前设备能力,应用已保存参数并渲染调节控件
    const track = cameraPreviewStream.getVideoTracks()[0];
    await applyParamsToTrack(track, loadCameraParams());
    renderCameraParams(track);
  } catch (e) {
    cameraStatus("预览失败: " + e.message);
  }
}

$("scan-cameras").addEventListener("click", () => refreshCameraList(true));
$("camera-select").addEventListener("change", () => {
  localStorage.setItem(CAMERA_KEY, $("camera-select").value);
  if (cameraPreviewStream) startCameraPreview();
});
$("camera-preview-toggle").addEventListener("click", () => {
  if (cameraPreviewStream) stopCameraPreview();
  else startCameraPreview();
});

// 初次加载:不主动弹权限,先列出已授权的设备;点「扫描摄像头」再申请权限。
refreshCameraList(false);

// ---------------------------------------------------------------------------
// USB 相机参数:读取活动 track 的 getCapabilities(),渲染可调控件;
// 修改即时 applyConstraints 到预览,并写入 localStorage 供游戏页 startCamera 使用。
// ---------------------------------------------------------------------------
const CAMERA_PARAMS_KEY = "dance-camera-params";
const PARAM_META = [
  { key: "exposureMode", label: "曝光模式", kind: "enum" },
  { key: "exposureTime", label: "曝光时间", kind: "range" },
  { key: "whiteBalanceMode", label: "白平衡模式", kind: "enum" },
  { key: "colorTemperature", label: "色温", kind: "range" },
  { key: "focusMode", label: "对焦模式", kind: "enum" },
  { key: "focusDistance", label: "对焦距离", kind: "range" },
  { key: "brightness", label: "亮度", kind: "range" },
  { key: "contrast", label: "对比度", kind: "range" },
  { key: "saturation", label: "饱和度", kind: "range" },
  { key: "sharpness", label: "锐度", kind: "range" },
  { key: "zoom", label: "变焦", kind: "range" },
  { key: "torch", label: "补光灯", kind: "bool" },
  { key: "iso", label: "感光度 ISO", kind: "range" },
  { key: "pan", label: "水平 Pan", kind: "range" },
  { key: "tilt", label: "垂直 Tilt", kind: "range" },
];

function loadCameraParams() {
  try { return JSON.parse(localStorage.getItem(CAMERA_PARAMS_KEY) || "{}"); } catch { return {}; }
}
function saveCameraParams(params) {
  localStorage.setItem(CAMERA_PARAMS_KEY, JSON.stringify(params));
}

// 先设模式(*Mode),再设数值,保证 exposureTime 等在手动模式下生效。
async function applyParamsToTrack(track, params) {
  if (!track || !params) return;
  const keys = Object.keys(params).sort((a, b) => {
    const am = a.endsWith("Mode") ? 0 : 1;
    const bm = b.endsWith("Mode") ? 0 : 1;
    return am - bm;
  });
  for (const key of keys) {
    const v = params[key];
    if (v === null || v === undefined || v === "") continue;
    try { await track.applyConstraints({ [key]: v }); } catch { /* 设备不支持,跳过 */ }
  }
}

function formatParam(v) {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1000 || abs < 0.01)) return v.toExponential(2);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function renderCameraParams(track) {
  const wrap = $("camera-params");
  const box = $("camera-params-controls");
  const status = $("camera-params-status");
  box.innerHTML = "";
  if (!track?.getCapabilities) {
    status.textContent = "当前浏览器不支持读取相机参数";
    wrap.classList.remove("hidden");
    return;
  }
  const caps = track.getCapabilities();
  const settings = track.getSettings();
  const saved = loadCameraParams();
  let count = 0;

  for (const meta of PARAM_META) {
    const cap = caps[meta.key];
    if (cap === undefined || cap === null) continue;

    if (meta.kind === "bool") {
      count++;
      const label = el("label", "param", null);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!(saved[meta.key] ?? settings[meta.key]);
      cb.addEventListener("change", () => {
        const params = loadCameraParams();
        params[meta.key] = cb.checked;
        saveCameraParams(params);
        track.applyConstraints({ [meta.key]: cb.checked }).catch(() => {});
      });
      label.append(cb, document.createTextNode(meta.label));
      box.appendChild(label);
      continue;
    }

    if (meta.kind === "enum") {
      const opts = Array.isArray(cap) ? cap : [];
      if (!opts.length) continue;
      count++;
      const label = el("label", "param", null);
      label.appendChild(document.createTextNode(meta.label));
      const sel = document.createElement("select");
      for (const o of opts) {
        const opt = el("option", "", o);
        opt.value = o;
        sel.appendChild(opt);
      }
      const current = saved[meta.key] ?? settings[meta.key] ?? opts[0];
      sel.value = opts.includes(current) ? current : opts[0];
      sel.addEventListener("change", () => {
        const params = loadCameraParams();
        params[meta.key] = sel.value;
        saveCameraParams(params);
        track.applyConstraints({ [meta.key]: sel.value }).catch(() => {});
      });
      label.appendChild(sel);
      box.appendChild(label);
      continue;
    }

    // range
    const r = (typeof cap === "object") ? cap : {};
    const min = Number(r.min);
    const max = Number(r.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    count++;
    const step = Number.isFinite(Number(r.step)) ? Number(r.step) : (max - min) / 100;
    const label = el("label", "param", null);
    label.appendChild(document.createTextNode(meta.label));
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    let cur = Number(saved[meta.key] ?? settings[meta.key]);
    if (!Number.isFinite(cur)) cur = min + (max - min) / 2;
    input.value = String(cur);
    const val = el("span", "param-val", formatParam(cur));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      val.textContent = formatParam(v);
      const params = loadCameraParams();
      params[meta.key] = v;
      saveCameraParams(params);
      track.applyConstraints({ [meta.key]: v }).catch(() => {});
    });
    label.append(input, val);
    box.appendChild(label);
  }

  wrap.classList.toggle("hidden", count === 0);
  status.textContent = count
    ? `该摄像头支持 ${count} 项可调参数`
    : "该摄像头未暴露可调参数(设备不支持或浏览器限制)";
}

// 恢复默认:清空已保存参数,并重新取流让设备回到驱动默认值,再按默认值重渲染控件。
$("camera-params-reset").addEventListener("click", async () => {
  localStorage.removeItem(CAMERA_PARAMS_KEY);
  if (cameraPreviewStream) {
    await startCameraPreview();
    cameraStatus("已恢复默认");
  }
});

// ---------------------------------------------------------------------------
// 舞者模型切换:列出 /api/models 的可用模型,选择写入 localStorage,游戏页 loadModel 读取。
// ---------------------------------------------------------------------------
const MODEL_KEY = "dance-model";

function modelStatus(msg) { $("model-status").textContent = msg; }

function saveModel(url) {
  if (url) localStorage.setItem(MODEL_KEY, url);
  else localStorage.removeItem(MODEL_KEY);
  modelStatus(url ? "已选择：" + url : "使用默认模型（dancer_girl.fbx）");
}

function selectModelOption(url) {
  const sel = $("model-select");
  let hit = null;
  for (const o of sel.options) if (o.value === url) { hit = o; break; }
  if (!hit && url) {
    hit = el("option", "", "自定义：" + url);
    hit.value = url;
    sel.appendChild(hit);
  }
  if (hit) sel.value = url;
}

async function refreshModels() {
  const sel = $("model-select");
  const saved = localStorage.getItem(MODEL_KEY) || "";
  try {
    const r = await fetch("/api/models");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const models = await r.json();
    sel.innerHTML = "";
    const def = el("option", "", "默认（dancer_girl.fbx）");
    def.value = "";
    sel.appendChild(def);
    for (const m of models) {
      const o = el("option", "", m.name);
      o.value = m.url;
      sel.appendChild(o);
    }
    if (saved && !models.some((m) => m.url === saved)) {
      const o = el("option", "", "自定义：" + saved);
      o.value = saved;
      sel.appendChild(o);
      $("model-url").value = saved;
    }
    sel.value = saved;
    modelStatus(`共 ${models.length} 个模型` + (saved ? "，已选：" + saved : "，默认"));
  } catch (e) {
    modelStatus("模型列表加载失败：" + e.message);
  }
}

$("model-select").addEventListener("change", () => {
  const url = $("model-select").value;
  $("model-url").value = "";
  saveModel(url);
});
$("model-refresh").addEventListener("click", refreshModels);
$("model-url").addEventListener("change", () => {
  const url = $("model-url").value.trim();
  selectModelOption(url);
  saveModel(url);
});

// 模型亮度:写入 localStorage,游戏页 loadAvatar 读取后应用到材质。
const BRIGHTNESS_KEY = "dance-model-brightness";
{
  const bv = parseFloat(localStorage.getItem(BRIGHTNESS_KEY)) || 1;
  $("model-brightness").value = String(bv);
  $("model-brightness-val").textContent = bv.toFixed(2);
}
$("model-brightness").addEventListener("input", () => {
  const v = parseFloat($("model-brightness").value);
  $("model-brightness-val").textContent = v.toFixed(2);
  localStorage.setItem(BRIGHTNESS_KEY, String(v));
});

refreshModels();

// ---------------------------------------------------------------------------
// 右侧画面:3D 模型 / 视频(3:4 MP4)。模式写入 localStorage;每首舞曲的视频绑定存服务端 videos/index.json。
// ---------------------------------------------------------------------------
const SIDE_KEY = "dance-side-mode";
let sideVideos = [];   // { name, url }
let sideMapping = {};  // danceId -> 视频文件名
let sideDances = [];   // { id, label }

function sideStatus(msg) { $("side-status").textContent = msg; }

function deviceToken() { return localStorage.getItem("dance-device-token") || ""; }

function applySideModeUI() {
  const video = $("side-mode").value === "video";
  $("side-video-map").classList.toggle("hidden", !video);
  sideStatus(video ? "右侧将显示视频" : "右侧将显示 3D 模型");
}

$("side-mode").value = localStorage.getItem(SIDE_KEY) || "model";
$("side-mode").addEventListener("change", () => {
  localStorage.setItem(SIDE_KEY, $("side-mode").value);
  applySideModeUI();
});

function sideRow(dance) {
  const label = el("label", "side-video-row", dance.label);
  const sel = document.createElement("select");
  sel.dataset.danceId = dance.id;
  const none = el("option", "", "（不绑定 · 回退 3D 教练）");
  none.value = "";
  sel.appendChild(none);
  for (const v of sideVideos) {
    const o = el("option", "", v.name);
    o.value = v.name;
    sel.appendChild(o);
  }
  const saved = sideMapping[dance.id] || "";
  if (saved && !sideVideos.some((v) => v.name === saved)) {
    const o = el("option", "", "已保存：" + saved);
    o.value = saved;
    sel.appendChild(o);
  }
  sel.value = saved;
  label.appendChild(sel);
  return label;
}

async function refreshSideMap() {
  try {
    const [vids, map, songsIdx] = await Promise.all([
      fetch("/api/videos").then((r) => r.json()),
      fetch("/api/videos-map").then((r) => r.json()),
      fetch("/songs/index.json").then((r) => r.json()),
    ]);
    sideVideos = vids || [];
    sideMapping = (map && map.mapping) || {};
    sideDances = (songsIdx && songsIdx.dances) || [];
    const rows = $("side-video-rows");
    rows.innerHTML = "";
    for (const d of sideDances) rows.appendChild(sideRow(d));
    sideStatus(`共 ${sideDances.length} 首舞曲、${sideVideos.length} 个视频`);
    if (!sideDances.length) rows.textContent = "未加载到歌单（需先运行导出歌单）";
  } catch (e) {
    sideStatus("右侧画面配置加载失败：" + e.message);
  }
}

$("side-map-refresh").addEventListener("click", refreshSideMap);

$("side-map-save").addEventListener("click", async () => {
  const mapping = {};
  for (const sel of $("side-video-rows").querySelectorAll("select")) {
    mapping[sel.dataset.danceId] = sel.value;
  }
  try {
    const headers = { "Content-Type": "application/json" };
    if (deviceToken()) headers["X-Device-Token"] = deviceToken();
    const r = await fetch("/api/videos-map", { method: "PUT", headers, body: JSON.stringify({ mapping }) });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || ("HTTP " + r.status));
    }
    sideStatus("已保存视频绑定");
  } catch (e) {
    sideStatus("保存失败：" + e.message);
  }
});

applySideModeUI();
refreshSideMap();
