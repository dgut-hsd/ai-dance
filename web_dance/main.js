/**
 * main.js — DANCE ARENA 入口:三渲二舞池 + 3D 舞者 + 实时动捕 + 舞蹈挑战评分。
 *
 * 复用 pose_capture/ 的整条动捕管线(MediaPipe -> 平滑 -> 契约帧),
 * 用 Retargeter 把契约帧映射到 FBX/GLB 人形骨架,再叠加游戏化 HUD 与评分。
 */

import * as THREE from "three";
import { startPoseStream } from "../pose_capture/mocap.js";
import { resolveMode } from "../pose_capture/contract.js";
import { reconstructJoints } from "../pose_capture/playback.js";
import { renderStickFigure } from "../pose_capture/stick-figure.js";
import { createScene } from "./scene.js";
import { createJuice } from "./ui-lab/juice.js";
import { loadAvatar, DEFAULT_MODEL, detectExt } from "./avatar.js";
import { DanceScorer } from "./score.js";
import { buildDemoSequence } from "./demo-sequence.js";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const state = {
  mode: "free",            // free | challenge
  danceType: "full-body",  // full-body | gesture
  mirror: true,
  flipFacing: false,
  running: false,
  avatar: null,            // { object, retargeter }
  stream: null,
  challenge: null,         // { seq, scorer, running, startMs }
  latestConf: 0,
};

const $ = (id) => document.getElementById(id);
const dom = {
  stage: $("stage"),
  fx: $("fx"),
  judge: $("judge"),
  status: $("status"),
  fps: $("fps"),
  delegate: $("delegate"),
  menu: $("menu"),
  menuStatus: $("menu-status"),
  modelHint: $("model-hint"),
  modelFile: $("model-file"),
  useDefault: $("use-default"),
  hud: $("hud"),
  cam: $("cam"),
  camStick: $("cam-stick"),
  confFill: $("conf-fill"),
  confLabel: $("conf-label"),
  refPanel: $("ref-panel"),
  refStick: $("ref-stick"),
  beats: $("beats"),
  scorePanel: $("score-panel"),
  grade: $("grade"),
  score: $("score"),
  combo: $("combo"),
  comboN: $("combo-n"),
  accCanvas: $("acc-canvas"),
  accPct: $("acc-pct"),
  progressFill: $("progress-fill"),
  btnStart: $("btn-start"),
  btnStop: $("btn-stop"),
  btnMirror: $("btn-mirror"),
  btnFlip: $("btn-flip"),
  danceType: $("dance-type"),
  danceTypeLabel: $("dance-type-label"),
  btnLoadRef: $("btn-load-ref"),
  refFile: $("ref-file"),
  btnReset: $("btn-reset"),
  centerMsg: $("center-msg"),
  centerMsgText: $("center-msg-text"),
  result: $("result"),
  resultGrade: $("result-grade"),
  resultScore: $("result-score"),
  resultAcc: $("result-acc"),
  resultCombo: $("result-combo"),
  resultAgain: $("result-again"),
};

const modeBtns = document.querySelectorAll(".mode-btn");

// ---------------------------------------------------------------------------
// 场景与渲染循环
// ---------------------------------------------------------------------------
const scene = createScene(dom.stage);
const clock = new THREE.Clock();

// ---------------------------------------------------------------------------
// 游戏手感层(juice):冲击波 / 火花 / 闪光 / 震屏 / 暗角 / hit-stop
// ---------------------------------------------------------------------------
const juice = createJuice({ canvas: dom.fx, shakeTarget: dom.stage });
let lastTier = "";
let lastMilestone = 0;
let lastBeatIdx = -1;

// 把舞者胸口投影到屏幕坐标,作为命中特效的爆发点
function avatarScreen() {
  if (!state.avatar) return { x: window.innerWidth / 2, y: window.innerHeight * 0.38 };
  const v = new THREE.Vector3();
  state.avatar.retargeter.hips.getWorldPosition(v);
  v.y += 0.35;
  v.project(scene.camera);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

function showJudge(text, color) {
  dom.judge.textContent = text;
  dom.judge.style.color = color;
  dom.judge.classList.remove("hidden");
  dom.judge.classList.remove("pop");
  void dom.judge.offsetWidth; // 重启动画
  dom.judge.classList.add("pop");
}

function judgeFeedback(acc, combo) {
  const p = avatarScreen();
  const tier = acc >= 0.8 ? "PERFECT" : acc >= 0.55 ? "GREAT" : "MISS";
  if (tier !== lastTier) {
    lastTier = tier;
    if (tier === "PERFECT") {
      showJudge("PERFECT", "#39ffcf");
      juice.ring(p.x, p.y, { size: 130, color: "57,255,207", width: 3.5, duration: 300 });
      juice.sparks(p.x, p.y, { count: 14, rays: 8, speed: 300 });
    } else if (tier === "GREAT") {
      showJudge("GREAT", "#4d7cff");
      juice.ring(p.x, p.y, { size: 100, color: "77,124,255", width: 3, duration: 260 });
      juice.sparks(p.x, p.y, { count: 8, rays: 5, speed: 220 });
    } else {
      showJudge("MISS", "#ff5f6d");
      juice.vignette(0.16);
      juice.shake(3);
    }
  }
  // 连击里程碑(每 10 连)
  if (combo > 0 && combo % 10 === 0 && combo !== lastMilestone) {
    lastMilestone = combo;
    juice.burst(p.x, p.y, { count: 50, speed: 460, ttl: 0.9 });
    juice.ring(p.x, p.y, { size: 220, color: "255,213,74", width: 4, duration: 420 });
    juice.flash("255,255,255", 0.22, 0.14);
    juice.shake(9);
    showJudge("COMBO x" + combo, "#ffd54a");
  }
}

function beatPulse(t, ch) {
  const beats = ch.seq.meta.beatTimesSec;
  if (!beats || beats.length < 2) return;
  const beat = beats[1] - beats[0] || 0.5;
  const idx = Math.floor(t / beat);
  if (idx !== lastBeatIdx) {
    lastBeatIdx = idx;
    const p = avatarScreen();
    juice.ring(p.x, p.y, { size: 70, color: "255,213,74", width: 2, duration: 220, alpha: 0.7 });
  }
}

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = clock.getDelta();
  scene.update(dt);
  // 改了骨骼后必须手动刷新 Skeleton,否则蒙皮不更新
  state.skeletons?.forEach((s) => s.update());
  scene.renderer.render(scene.scene, scene.camera);
}
renderLoop();

// ---------------------------------------------------------------------------
// 模型加载
// ---------------------------------------------------------------------------
async function loadModel(url, type) {
  setStatus("正在加载舞者…");
  dom.menuStatus.textContent = "正在加载 3D 模型…";
  try {
    const avatar = await loadAvatar(url, type);
    if (state.avatar) scene.scene.remove(state.avatar.object);
    scene.scene.add(avatar.object);
    avatar.retargeter.reset();
    state.avatar = avatar;
    state.skeletons = avatar.skeletons;
    dom.menu.classList.add("hidden");
    dom.hud.classList.remove("hidden");
    dom.btnStart.disabled = false;
    setStatus("舞者已就绪");
  } catch (e) {
    console.error(e);
    dom.menuStatus.textContent = "加载失败: " + e.message;
    setStatus("模型加载失败");
  }
}

dom.useDefault.addEventListener("click", () => loadModel(DEFAULT_MODEL));

dom.modelFile.addEventListener("change", () => {
  const file = dom.modelFile.files[0];
  if (!file) return;
  const ext = detectExt(file.name);
  if (ext === "gltf") {
    dom.menuStatus.textContent = "提示:.gltf 若含外部 .bin/.jpg 资源,本地加载可能失败,建议用 .glb 或 .fbx";
  }
  const url = URL.createObjectURL(file);
  loadModel(url, ext).finally(() => setTimeout(() => URL.revokeObjectURL(url), 60000));
});

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------
function setMode(mode) {
  if (state.running) stopStream();
  state.mode = mode;
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const isChallenge = mode === "challenge";
  dom.scorePanel.classList.toggle("hidden", !isChallenge);
  dom.refPanel.classList.toggle("hidden", !isChallenge);
  dom.btnLoadRef.classList.toggle("hidden", !isChallenge);
  if (isChallenge && !state.challenge) {
    state.challenge = {
      seq: buildDemoSequence(),
      scorer: new DanceScorer(buildDemoSequence()),
      running: false,
      startMs: 0,
    };
  }
}
modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

dom.danceType.addEventListener("change", () => {
  state.danceType = dom.danceType.value;
  dom.danceTypeLabel.textContent = dom.danceType.value === "gesture" ? "手势" : "全身";
  if (state.running) stopStream();
});

dom.btnMirror.addEventListener("click", () => {
  state.mirror = !state.mirror;
  dom.btnMirror.textContent = "镜像:" + (state.mirror ? "开" : "关");
});

dom.btnFlip.addEventListener("click", () => {
  state.flipFacing = !state.flipFacing;
  dom.btnFlip.textContent = "朝向:" + (state.flipFacing ? "反" : "正");
});

dom.btnReset.addEventListener("click", () => scene.resetCamera());

// ---------------------------------------------------------------------------
// 参考序列加载(挑战模式)
// ---------------------------------------------------------------------------
dom.btnLoadRef.addEventListener("click", () => dom.refFile.click());
dom.refFile.addEventListener("change", async () => {
  const file = dom.refFile.files[0];
  if (!file) return;
  try {
    const seq = JSON.parse(await file.text());
    if (seq.schema !== "dance-sequence/v1" || !Array.isArray(seq.frames)) {
      throw new Error("不是合法的 dance-sequence/v1 文件");
    }
    state.challenge = { seq, scorer: new DanceScorer(seq), running: false, startMs: 0 };
    setStatus(`已加载参考:${seq.danceId} (${seq.meta.numFrames} 帧)`);
  } catch (e) {
    setStatus("参考加载失败: " + e.message);
  }
});

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------
async function startFree() {
  await startCamera();
}

async function startChallenge() {
  const ch = state.challenge;
  if (!ch) return;
  ch.scorer.reset();
  resetScoreHUD();
  lastTier = "";
  lastMilestone = 0;
  lastBeatIdx = -1;
  await startCamera();
  if (!state.running) return;
  // 倒计时
  await countdown();
  ch.running = true;
  ch.startMs = performance.now();
}

function startCamera() {
  const boneDefs = resolveMode(state.danceType).bones;
  setStatus("加载 MediaPipe 模型…");
  return startPoseStream({
    video: dom.cam,
    canvas: dom.camStick,
    mode: state.danceType,
    // 舞蹈优先跟手:beta 调大(默认 0.5 → 0.8),快动作不拖尾
    smoothing: { minCutoff: 1.5, beta: 0.8, dCutoff: 1.0 },
    onFrame: (frame) => onFrame(frame, boneDefs),
    onStatus: (s) => setStatus(mapStatus(s)),
    onError: (e) => {
      setStatus("错误: " + e.message);
      dom.btnStop.disabled = true;
      dom.btnStart.disabled = false;
      state.running = false;
    },
    onPerf: (snap) => {
      dom.fps.textContent = snap.fps + " FPS";
      dom.delegate.textContent = snap.delegate;
    },
  }).then((handle) => {
    state.stream = handle;
    state.running = true;
    dom.btnStart.disabled = true;
    dom.btnStop.disabled = false;
  });
}

function mapStatus(s) {
  const map = {
    "loading-model": "加载模型中…",
    "model-ready": "模型就绪",
    "camera-on": "摄像头已开启",
    "video-playing": "播放中",
  };
  return map[s] || s;
}

function onFrame(frame, boneDefs) {
  if (state.avatar) {
    state.avatar.retargeter.applyFrame(frame, {
      boneDefs,
      mirror: state.mirror,
      flipFacing: state.flipFacing,
    });
  }
  // 置信度
  const conf = frame.conf;
  const avg = conf && conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 0;
  state.latestConf = avg;
  dom.confFill.style.width = Math.round(avg * 100) + "%";
  dom.confLabel.textContent = "置信度 " + Math.round(avg * 100) + "%";

  // 挑战判定
  const ch = state.challenge;
  if (state.mode === "challenge" && ch && ch.running) {
    const t = (performance.now() - ch.startMs) / 1000;
    const res = ch.scorer.judge(t, frame, boneDefs);
    if (res) {
      updateScoreHUD(res);
      judgeFeedback(res.acc, res.combo);
    }
    updateChallengeProgress(t, ch);
    beatPulse(t, ch);
    if (t >= ch.seq.meta.durationSec) finishChallenge();
  }
}

function stopStream() {
  if (state.stream) {
    state.stream.stop();
    state.stream = null;
  }
  state.running = false;
  if (state.challenge) state.challenge.running = false;
  if (state.avatar) state.avatar.retargeter.reset();
  dom.btnStart.disabled = !state.avatar;
  dom.btnStop.disabled = true;
  dom.confFill.style.width = "0%";
  dom.confLabel.textContent = "置信度 --";
  setStatus("已停止");
}

dom.btnStart.addEventListener("click", async () => {
  if (!state.avatar) return;
  dom.btnStart.disabled = true;
  try {
    if (state.mode === "challenge") await startChallenge();
    else await startFree();
  } catch (e) {
    setStatus("启动失败: " + e.message);
    dom.btnStart.disabled = false;
  }
});

dom.btnStop.addEventListener("click", stopStream);
dom.resultAgain.addEventListener("click", () => {
  dom.result.classList.add("hidden");
  startChallenge();
});

// ---------------------------------------------------------------------------
// 倒计时
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countdown() {
  dom.centerMsg.classList.remove("hidden");
  for (const n of ["3", "2", "1", "GO!"]) {
    dom.centerMsgText.textContent = n;
    dom.centerMsgText.style.animation = "none";
    void dom.centerMsgText.offsetWidth; // 重启动画
    dom.centerMsgText.style.animation = "";
    if (n === "GO!") {
      juice.flash("255,255,255", 0.25, 0.16);
      juice.shake(6);
    }
    await sleep(800);
  }
  dom.centerMsg.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// HUD 更新
// ---------------------------------------------------------------------------
function updateScoreHUD(res) {
  dom.score.textContent = Math.round(state.challenge.scorer.score);
  const combo = res.combo;
  dom.comboN.textContent = combo;
  dom.combo.classList.toggle("hot", combo > 0 && combo % 10 === 0);
  drawAccRing(res.acc);
  dom.accPct.textContent = Math.round(res.acc * 100) + "%";
  const avg = state.challenge.scorer.hits
    ? state.challenge.scorer.totalAcc / state.challenge.scorer.hits
    : 0;
  dom.grade.textContent = gradeFor(avg);
}

function drawAccRing(acc) {
  const ctx = dom.accCanvas.getContext("2d");
  const w = dom.accCanvas.width;
  const h = dom.accCanvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, r = w / 2 - 6;
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const color = acc >= 0.8 ? "#39ffcf" : acc >= 0.55 ? "#4d7cff" : "#ff3d81";
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * acc);
  ctx.stroke();
}

function gradeFor(avg) {
  if (avg >= 0.9) return "S";
  if (avg >= 0.8) return "A";
  if (avg >= 0.7) return "B";
  if (avg >= 0.6) return "C";
  return "D";
}

function resetScoreHUD() {
  dom.score.textContent = "0";
  dom.comboN.textContent = "0";
  dom.grade.textContent = "-";
  dom.accPct.textContent = "0%";
  dom.progressFill.style.width = "0%";
  drawAccRing(0);
}

function updateChallengeProgress(t, ch) {
  const dur = ch.seq.meta.durationSec || 1;
  dom.progressFill.style.width = Math.min(100, (t / dur) * 100) + "%";
  // 参考动作
  const refFrame = ch.scorer.frameAt(t);
  if (refFrame) {
    const joints = reconstructJoints(refFrame, ch.seq.meta.dimensions || {}, ch.seq.bones);
    renderStickFigure(dom.refStick, joints, ch.seq.bones, refFrame.hands);
  }
  // 节拍指示
  const beats = ch.seq.meta.beatTimesSec;
  if (beats && beats.length > 1) {
    const beat = beats[1] - beats[0] || 0.5;
    const idx = Math.floor(t / beat) % 4;
    [...dom.beats.children].forEach((el, i) => el.classList.toggle("on", i === idx));
  }
}

function finishChallenge() {
  const ch = state.challenge;
  if (!ch || !ch.running) return;
  ch.running = false;
  const r = ch.scorer.finalize();
  dom.resultGrade.textContent = r.grade;
  dom.resultGrade.className = "grade-" + r.grade.toLowerCase();
  dom.resultScore.textContent = "得分 " + r.score;
  dom.resultAcc.textContent = "平均匹配 " + Math.round(r.avgAcc * 100) + "%";
  dom.resultCombo.textContent = "最大连击 " + r.maxCombo;
  dom.result.classList.remove("hidden");
  // 结算庆祝
  juice.burst(window.innerWidth / 2, window.innerHeight * 0.5, { count: 80, speed: 550, ttl: 1.1 });
  juice.flash("255,255,255", 0.3, 0.2);
  juice.shake(12);
  stopStream();
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function setStatus(s) {
  dom.status.textContent = s;
}

// 键盘:空格 开始/停止,M 镜像
window.addEventListener("keydown", (e) => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (state.running) stopStream();
    else if (state.avatar) dom.btnStart.click();
  } else if (e.key === "m" || e.key === "M") {
    dom.btnMirror.click();
  }
});

setMode("free");
setStatus("就绪 — 请选择舞者");
