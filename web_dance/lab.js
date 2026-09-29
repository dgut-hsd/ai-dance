/**
 * lab.js — 动作学习实验台:上传本地舞蹈视频 → MediaPipe 逐帧动捕 →
 * 3D 模型学习复现 → 与原视频/骨架并排对比。
 *
 * 完全复用项目已有管线,保证与实时端(DANCE ARENA)数据契约一致:
 *   - export.js        : exportVideoToSequence 视频 → dance-sequence/v1 契约序列
 *   - playback.js      : reconstructJoints / sampleFrame 关节重建与插值回放
 *   - retarget.js      : Retargeter.applyFrame 契约帧 → 人形骨架
 *   - stick-figure.js  : renderPoseSilhouette 剪影对比
 *   - scene.js         : createScene 舞台(与主页面同一套灯光/地面/控制器)
 */

import * as THREE from "three";
import { createScene } from "./scene.js";
import { loadAvatar, DEFAULT_MODEL } from "./avatar.js";
import { exportVideoToSequence, downloadJSON } from "../pose_capture/export.js";
import { reconstructJoints, sampleFrame } from "../pose_capture/playback.js";
import { renderPoseSilhouette } from "../pose_capture/stick-figure.js";

const $ = (id) => document.getElementById(id);

const dom = {
  stage: $("stage"),
  upload: $("upload-file"),
  fileName: $("file-name"),
  mode: $("dance-mode"),
  mirror: $("opt-mirror"),
  server3d: $("opt-server3d"),
  learn: $("btn-learn"),
  download: $("btn-download"),
  status: $("status"),
  progFill: $("prog-fill"),
  progLabel: $("prog-label"),
  metrics: $("metrics"),
  mFrames: $("m-frames"),
  mDur: $("m-dur"),
  mFps: $("m-fps"),
  mConf: $("m-conf"),
  video: $("src-video"),
  poseCanvas: $("pose-canvas"),
};

// 分析状态 → 中文提示映射(与 export.js 的 onStatus 回调对齐)
const STATUS_TEXT = {
  "loading-model": "正在加载姿态模型…",
  processing: "逐帧动捕分析中…",
};

const state = {
  stage: null,
  avatar: null,
  sequence: null,
  boneDefs: null,
  dims: null,
  file: null,
  fileUrl: null,
  running: false,
  learning: false,
  mirror: true,
  mode: "full-body",
  server3d: false,
};

const clock = new THREE.Clock();

function setStatus(text, isError = false) {
  dom.status.textContent = text;
  dom.status.classList.toggle("err", isError);
}

function setProgress(v) {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  dom.progFill.style.width = pct + "%";
  dom.progLabel.textContent = pct + "%";
}

// 平均置信度:所有帧、所有骨骼 conf 的均值 → 百分比
function avgConfidence(frames) {
  let sum = 0, n = 0;
  for (const f of frames) {
    const c = f.conf || [];
    for (const v of c) { sum += v; n++; }
  }
  return n ? sum / n : 0;
}

function renderMetrics(seq) {
  const m = seq.meta || {};
  dom.mFrames.textContent = (seq.frames || []).length;
  dom.mDur.textContent = Number.isFinite(m.durationSec) ? m.durationSec.toFixed(2) + "s" : "—";
  dom.mFps.textContent = m.fps || "—";
  dom.mConf.textContent = Math.round(avgConfidence(seq.frames || []) * 100) + "%";
  dom.metrics.classList.remove("empty");
}

// 右上对比区的骨架剪影:用模型尺寸重建关节,忠实反映 3D 模型当前姿态
function drawSilhouette(frame) {
  if (!frame) return;
  const dims = state.avatar?.retargeter?.dims || state.dims || {};
  const joints = reconstructJoints(frame, dims, state.boneDefs);
  renderPoseSilhouette(dom.poseCanvas, joints, state.boneDefs, {
    color: "#39ffcf",
  });
}

// ---------------------------------------------------------------------------
// 主渲染循环:阶段更新 + (可选)模型复现 + 骨架剪影
// ---------------------------------------------------------------------------
function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = clock.getDelta();
  state.stage.update(dt);

  if (state.running && state.avatar && state.sequence && !dom.video.paused && !dom.video.ended) {
    const t = dom.video.currentTime;
    const frame = sampleFrame(state.sequence.frames, t);
    state.avatar.retargeter.applyFrame(frame, {
      boneDefs: state.boneDefs,
      mirror: state.mirror,
      rootMotion: false, // 离线序列无 rootVel,回退「脚贴地」运动学
    });
    state.avatar.skeletons.forEach((s) => s.update());
    drawSilhouette(frame);
  }

  state.stage.render();
}

// ---------------------------------------------------------------------------
// 上传处理:预览原视频,解锁「开始学习」
// ---------------------------------------------------------------------------
function onUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  // 类型校验:非视频文件(如误选图片/文本)直接提示,避免后续无声失败
  if (!file.type.startsWith("video/")) {
    setStatus(`不支持的文件类型「${file.type || "未知"}」，请选择视频文件`, true);
    e.target.value = ""; // 清空选择,允许重选同一文件
    return;
  }
  if (file.size === 0) {
    setStatus("文件为空，请重新选择", true);
    e.target.value = "";
    return;
  }

  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.file = file;
  state.fileUrl = URL.createObjectURL(file);
  dom.fileName.textContent = file.name;
  dom.video.src = state.fileUrl;
  dom.video.load();

  state.sequence = null;
  state.running = false;
  dom.download.disabled = true;
  dom.metrics.classList.add("empty");
  setProgress(0);
  setStatus("已选择视频，点击「开始学习并复现」…");
  dom.learn.disabled = false;
}

// ---------------------------------------------------------------------------
// 学习并复现:导出契约序列 → 驱动模型 + 播放原视频
// ---------------------------------------------------------------------------
async function onLearn() {
  if (!state.file || state.learning) return;
  state.learning = true;
  dom.learn.disabled = true;
  dom.download.disabled = true;
  setProgress(0);

  try {
    state.mode = dom.mode.value;
    state.server3d = dom.server3d.checked;

    let seq;
    if (state.server3d) {
      // 服务端 3D 动捕(MeTRAbs):POST 原始视频 → /api/pose3d → 同构契约序列。
      // 消除浏览器端 MediaPipe 单目深度的 z 歧义(膝盖反向的根因)。
      setStatus("服务端 3D 动捕推理中…");
      const resp = await fetch("/api/pose3d", {
        method: "POST",
        headers: { "Content-Type": state.file.type || "application/octet-stream" },
        body: state.file,
        signal: AbortSignal.timeout(11 * 60 * 1000),
      });
      if (!resp.ok) {
        let msg = "";
        try { msg = (await resp.json()).error || ""; } catch { /* ignore */ }
        throw new Error(msg || `服务端返回 ${resp.status}，请确认依赖已安装并已重启服务`);
      }
      // 服务端按 NDJSON 流式回传:progress 行刷新进度,result 行返回序列,error 行抛错。
      seq = await readPose3dStream(resp.body, setProgress, setStatus);
      setProgress(1);
    } else {
      setStatus("正在加载姿态模型…");
      seq = await exportVideoToSequence({
        file: state.file,
        mode: state.mode,
        onProgress: setProgress,
        onStatus: (s) => setStatus(STATUS_TEXT[s] || s),
        onError: (err) => setStatus("分析失败：" + err.message, true),
      });
    }

    state.sequence = seq;
    state.boneDefs = seq.bones;
    state.dims = seq.meta?.dimensions || {};

    renderMetrics(seq);

    // 复位到休息姿态后,从 0 开始同步复现
    state.avatar.retargeter.reset();
    dom.video.currentTime = 0;
    dom.video.loop = true;
    dom.video.play().catch(() => {});
    state.running = true;

    dom.download.disabled = false;
    setStatus("复现中：3D 模型已学习该舞蹈，右侧为对比效果");
  } catch (err) {
    setStatus("处理出错：" + (err?.message || err), true);
  } finally {
    state.learning = false;
    dom.learn.disabled = !state.file;
  }
}

// 解析 /api/pose3d 的 NDJSON 流:progress 行推进进度条,result 行返回序列,error 行抛错。
async function readPose3dStream(body, onProgress, onStatus) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.progress) {
        const { current, total } = msg.progress;
        if (total > 0) onProgress(current / total);
        onStatus(`服务端 3D 动捕推理中 ${current}/${total} 帧…`);
      } else if (msg.result) {
        result = msg.result;
      } else if (msg.error) {
        throw new Error(msg.error);
      }
    }
  }
  if (!result) throw new Error("服务端未返回结果（处理可能超时或被中断）");
  return result;
}

function onDownload() {
  if (!state.sequence) return;
  const name = (state.file?.name || "dance").replace(/\.[^.]+$/, "") + ".json";
  downloadJSON(state.sequence, name);
  setStatus("已导出：" + name);
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  // 先注册所有事件监听(必须早于任何 await),否则模型加载期间选择文件会「无响应」
  dom.upload.addEventListener("change", onUpload);
  dom.learn.addEventListener("click", onLearn);
  dom.download.addEventListener("click", onDownload);
  dom.mode.addEventListener("change", () => (state.mode = dom.mode.value));
  dom.mirror.addEventListener("change", () => (state.mirror = dom.mirror.checked));
  dom.server3d.addEventListener("change", () => (state.server3d = dom.server3d.checked));

  state.stage = createScene(dom.stage);
  state.mirror = true;
  dom.mirror.checked = true;

  setStatus("正在加载 3D 模型…");
  try {
    state.avatar = await loadAvatar(DEFAULT_MODEL);
    state.stage.scene.add(state.avatar.object);
    setStatus("模型就绪，请上传一段舞蹈视频");
  } catch (err) {
    setStatus("模型加载失败：" + (err?.message || err), true);
  }

  renderLoop();
}

init();