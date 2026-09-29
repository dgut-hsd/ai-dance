/**
 * main.js — DANCE ARENA 入口:三渲二舞池 + 3D 舞者 + 实时动捕 + 舞蹈挑战评分。
 *
 * 复用 pose_capture/ 的整条动捕管线(MediaPipe -> 平滑 -> 契约帧),
 * 用 Retargeter 把契约帧映射到 FBX/GLB 人形骨架,再叠加游戏化 HUD 与评分。
 */

import * as THREE from "three";
import { PerfMonitor } from "../pose_capture/perf.js";
import { startPoseStream } from "../pose_capture/mocap.js";
import { resolveMode } from "../pose_capture/contract.js";
import { reconstructJoints, sampleFrame } from "../pose_capture/playback.js";
import { renderPoseSilhouette } from "../pose_capture/stick-figure.js";
import { createScene } from "./scene.js";
import { createJuice } from "./ui-lab/juice.js";
import { animate, ease } from "./ui-lab/tween.js";
import { loadAvatar, DEFAULT_MODEL, detectExt } from "./avatar.js";
import { ScoringAdapter } from "./scoring-adapter.js";
import { SongSession, AudioEngine } from "./audio.js";
import { HighlightController } from "./highlights.js";
import { BUILTIN_DANCES, loadDanceClips, retargetClipToSkeleton, captureRestPose } from "./dance-library.js";
import { loadSongIndex, dances, songs, danceById, songById, loadSequence } from "./song-library.js";
import { parseChart } from "../scoring/src/chartCodec.js";
import {
  createSilhouetteRenderer, renderSilhouetteFrame, canvasToPng, pickSignatureTimes,
} from "./silhouette.js";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const state = {
  mode: "free",            // free | challenge | performance
  danceType: "full-body",  // full-body | gesture
  mirror: true,
  flipFacing: false,
  running: false,
  avatar: null,            // { object, retargeter, animations, ... }
  coach: null,             // 挑战模式里的 3D 教练(同模型第二实例)
  coachPlayer: null,       // { update(t) } 按歌曲时钟驱动教练
  mixer: null,             // 表演模式的 AnimationMixer
  modelSource: null,       // { url, type } 用于给教练加载同一模型
  stream: null,
  challenge: null,         // { seq, scorer, running, session, noteBonus }
  // 默认先展示真实 FBX 编排，参数化 demo 仅作为技术回退。
  challengeDanceId: "hiphop",
  challengeSongId: "pop-demo",
  performanceDanceId: null,
  latestConf: 0,
  phase: "idle",             // idle | select | playing
  select: { entries: [], selected: 0, player: null, clock: 0, revertTimer: null },
};

const $ = (id) => document.getElementById(id);
const dom = {
  stage: $("stage"),
  fx: $("fx"),
  judge: $("judge"),
  judgeTier: $("judge-tier"),
  judgeSub: $("judge-sub"),
  comboBadge: $("combo-badge"),
  comboBadgeN: $("combo-badge-n"),
  status: $("status"),
  statusbar: $("statusbar"),
  topbar: $("topbar"),
  staffPerf: $("staff-perf"),
  fps: $("fps"),
  delegate: $("delegate"),
  menu: $("menu"),
  menuStatus: $("menu-status"),
  hud: $("hud"),
  controls: $("controls"),
  btnHome: $("btn-home"),
  cam: $("cam"),
  camStick: $("cam-stick"),
  camWrap: $("cam-wrap"),
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
  dancePicker: $("dance-picker"),
  danceSelect: $("dance-select"),
  songPicker: $("song-picker"),
  songSelect: $("song-select"),
  animPicker: $("anim-picker"),
  animSelect: $("anim-select"),
  btnReset: $("btn-reset"),
  centerMsg: $("center-msg"),
  centerMsgText: $("center-msg-text"),
  songPick: $("song-pick"),
  songPickStrip: $("song-pick-strip"),
  poseHint: $("pose-hint"),
  judgeStage: $("judge-stage"),
  judgeTrack: $("judge-track"),
  poseHintFill: $("pose-hint-fill"),
  poseHintName: $("pose-hint-name"),
  ready: $("ready"),
  readyBackdrop: $("ready-backdrop"),
  readySong: $("ready-song"),
  readyGo: $("ready-go"),
  result: $("result"),
  resultGrade: $("result-grade"),
  resultTitle: $("result-title"),
  resultTagline: $("result-tagline"),
  resultSong: $("result-song"),
  resultNext: $("result-next"),
  statScore: $("stat-score"),
  statAcc: $("stat-acc"),
  statCombo: $("stat-combo"),
  statHit: $("stat-hit"),
  statAccBar: $("stat-acc-bar"),
  statComboBar: $("stat-combo-bar"),
  statHitBar: $("stat-hit-bar"),
  resultAgain: $("result-again"),
  resultExit: $("result-exit"),
};

const modeBtns = document.querySelectorAll(".mode-btn");

// 工作人员调试:默认隐藏调试信息/控制条,?debug=1 或按 D 显示
let debugMode = false;
function applyDebugUI() {
  dom.topbar.classList.toggle("hidden", !debugMode);
  if (dom.staffPerf) dom.staffPerf.hidden = !debugMode;
}

// ---------------------------------------------------------------------------
// 场景与渲染循环
// ---------------------------------------------------------------------------
const scene = createScene(dom.stage);
const clock = new THREE.Clock();
const renderPerf = new PerfMonitor();
let startGeneration = 0;
let challengeTimer = null;
let lastPoseAt = 0;
let lastCaptureToRender = null;
let lastPerf = null;
const highlights = new HighlightController({
  stage: dom.stage, camera: dom.cam, fx: dom.fx,
  getState: () => ({
    score: state.challenge?.scorer.score || 0, combo: state.challenge?.scorer.combo || 0,
    tier: state.challenge?.scorer.lastTier || '', acc: state.challenge?.previewAcc || 0,
    conf: performance.now() - lastPoseAt < 700 ? state.latestConf : 0,
  }),
});

// 是否录制高光时刻(选曲页小提示)→ sessionStorage,高光控制器据此决定是否录制
const recordConsent = $("highlight-record-consent");
if (recordConsent) {
  recordConsent.checked = sessionStorage.getItem("dance-record-highlight") !== "0";
  recordConsent.addEventListener("change", () =>
    sessionStorage.setItem("dance-record-highlight", recordConsent.checked ? "1" : "0"));
}
// 结算后悬停 5s:结算画面缩略到右上角,自动播放本地高光回放
const replayOverlay = $("replay"), replayVideo = $("replay-video"), replayClose = $("replay-close");
let replayTimer = null;
function scheduleReplay() {
  clearTimeout(replayTimer);
  replayTimer = setTimeout(() => {
    const replay = highlights.getReplay();
    if (!replay) return;
    $("result").classList.add("result-mini");
    replayVideo.src = replay.url;
    replayOverlay.classList.remove("hidden");
    replayVideo.play().catch(() => {});
  }, 5000);
}
if (replayClose) replayClose.addEventListener("click", () => {
  replayVideo.pause();
  replayOverlay.classList.add("hidden");
  $("result").classList.remove("result-mini");
});

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

// 判定层级配色:金 > 青 > 蓝 > 红,与结算评级 S/A/B/D 同族
const TIER_COLORS = { PERFECT: "#ffd54a", GREAT: "#39ffcf", GOOD: "#4d7cff", MISS: "#ff5f6d" };

function showJudge(tier, subText) {
  dom.judge.dataset.tier = tier;
  dom.judge.style.setProperty("--jtier", TIER_COLORS[tier] || "#ffffff");
  dom.judgeTier.textContent = tier;
  dom.judgeSub.textContent = subText || "";
  dom.judge.classList.remove("hidden");
  dom.judge.classList.remove("pop");
  void dom.judge.offsetWidth; // 重启动画
  dom.judge.classList.add("pop");
}

function judgeFeedback(tier, combo, scoreGain) {
  const p = avatarScreen();
  const gain = scoreGain > 0 ? "+" + Math.round(scoreGain) : "";
  if (tier !== lastTier) {
    lastTier = tier;
    flashCamFrame(tier);
    if (tier === "PERFECT") {
      showJudge("PERFECT", gain);
      juice.hitStop(70);            // 命中顿帧
      juice.punch(0.045);           // 镜头怼一下
      juice.shake(7);
      juice.flash("255,213,74", 0.16, 0.12);
      juice.ring(p.x, p.y, { size: 160, color: "255,213,74", width: 4, duration: 340 });
      juice.ring(p.x, p.y, { size: 92, color: "255,255,255", width: 2.5, duration: 220, delay: 40 });
      juice.sparks(p.x, p.y, { count: 28, rays: 14, speed: 420, colors: ["255,213,74", "255,255,255", "255,61,129"] });
    } else if (tier === "GREAT") {
      showJudge("GREAT", gain);
      juice.hitStop(30);
      juice.punch(0.025);
      juice.shake(3);
      juice.flash("57,255,207", 0.1, 0.09);
      juice.ring(p.x, p.y, { size: 120, color: "57,255,207", width: 3, duration: 280 });
      juice.sparks(p.x, p.y, { count: 14, rays: 8, speed: 300, colors: ["57,255,207", "255,255,255"] });
    } else if (tier === "GOOD") {
      showJudge("GOOD", gain);
      juice.punch(0.015);
      juice.shake(2);
      juice.ring(p.x, p.y, { size: 92, color: "77,124,255", width: 2.5, duration: 230 });
    } else {
      showJudge("MISS", "");
      juice.hitStop(50);
      juice.punch(0.05);
      juice.shake(11);
      juice.flash("255,95,109", 0.18, 0.14);
      juice.vignette(0.28);
      juice.sparks(p.x, p.y, { count: 10, rays: 6, speed: 220, colors: ["255,95,109", "255,61,129"] });
    }
  }
  updateComboBadge(combo, p);
}

// 连击徽章:>=2 常驻显示,每次命中脉动并喷火星,每 10 连大爆发,高连击升温
function updateComboBadge(combo, p) {
  if (combo >= 2) {
    dom.comboBadge.classList.remove("hidden");
    dom.comboBadgeN.textContent = combo;
    dom.comboBadge.classList.toggle("hot", combo >= 20);
    dom.comboBadge.classList.remove("pulse", "milestone");
    void dom.comboBadge.offsetWidth;
    const b = dom.comboBadge.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    if (combo % 10 === 0 && combo !== lastMilestone) {
      lastMilestone = combo;
      dom.comboBadge.classList.add("milestone");
      setTimeout(() => dom.comboBadge.classList.remove("milestone"), 700);
      juice.hitStop(40);
      juice.shake(9);
      juice.flash("255,213,74", 0.22, 0.15);
      juice.burst(bx, by, { count: 60, speed: 520, ttl: 1.0, colors: ["255,213,74", "255,61,129", "255,255,255"] });
      juice.ring(bx, by, { size: 240, color: "255,213,74", width: 4, duration: 440 });
      juice.ring(p.x, p.y, { size: 200, color: "255,61,129", width: 3, duration: 380 });
    } else {
      dom.comboBadge.classList.add("pulse");
      // 每次命中从徽章喷一点火星,连击越久越烫
      juice.sparks(bx, by, { count: 5, rays: 4, speed: 200, colors: ["255,213,74", "255,61,129"] });
    }
  } else {
    dom.comboBadge.classList.add("hidden");
  }
}

function beatPulse(t, ch) {
  let idx = null;
  const timing = ch.session?.timing;
  if (timing) {
    const b = timing.nearestBeat(t);
    if (!b) return;
    idx = b.index;
  } else {
    const beats = ch.seq.meta.beatTimesSec;
    if (!beats || beats.length < 2) return;
    const beat = beats[1] - beats[0] || 0.5;
    idx = Math.floor(t / beat);
  }
  if (idx !== lastBeatIdx) {
    lastBeatIdx = idx;
    const p = avatarScreen();
    juice.ring(p.x, p.y, { size: 70, color: "255,213,74", width: 2, duration: 220, alpha: 0.7 });
  }
}

function renderLoop() {
  requestAnimationFrame(renderLoop);
  try {
    const dt = clock.getDelta();
    renderPerf.record("renderFrame", dt * 1000);
    renderPerf.fpsTick();
    scene.update(dt);
    // 改了骨骼后必须手动刷新 Skeleton,否则蒙皮不更新
    state.skeletons?.forEach((s) => s.update());
    // 表演模式:FBX/GLB 内嵌动画
    if (state.mixer) state.mixer.update(dt);
    // 选曲态:教练循环试跳/吸引
    if (state.phase === "select" && state.select?.player) {
      state.select.clock += dt;
      state.select.player.update(state.select.clock);
    }
    // 跟跳挑战:教练按歌曲时钟跳参考舞
    if ((state.mode === "challenge" || state.mode === "pk") && state.challenge?.running && state.coachPlayer) {
      const t = state.challenge.session?.songTime ?? 0;
      state.coachPlayer.update(t);
    }
    // 右下判定轨道:剪影从右往左流入判定平台,抵达平台即消失
    updatePoseLane();
    if (lastCaptureToRender != null) {
      renderPerf.record("captureToRenderSubmit", performance.now() - lastCaptureToRender);
      lastCaptureToRender = null;
    }
    // 兼容两种 scene 版本:合成器版走 scene.render(),老版直接渲染
    if (scene.render) scene.render();
    else scene.renderer.render(scene.scene, scene.camera);
    highlights.draw(); // Copy WebGL immediately, before its drawing buffer can be cleared.
  } catch (e) {
    // 渲染异常绝不能再中断整页初始化(否则按钮都不会挂载)
    console.error("renderLoop error:", e);
  }
}
renderLoop();

// ---------------------------------------------------------------------------
// 模型加载
// ---------------------------------------------------------------------------
async function loadModel(url, type) {
  setStatus("准备中…");
  dom.menuStatus.textContent = "";
  try {
    const avatar = await loadAvatar(url, type);
    if (state.avatar) scene.scene.remove(state.avatar.object);
    // 换模型后旧教练作废(它是旧模型的实例)
    if (state.coach) {
      scene.scene.remove(state.coach.object);
      state.coach = null;
      state.coachPlayer = null;
    }
    scene.scene.add(avatar.object);
    avatar.retargeter.reset();
    captureRestPose(avatar.object); // 记录休息姿态,供内置舞曲重定向对齐
    state.avatar = avatar;
    state.modelSource = { url, type: type || detectExt(url) };
    state.skeletons = avatar.skeletons;
    layoutForMode();
    dom.menu.classList.add("hidden");
    dom.hud.classList.remove("hidden");
    dom.btnStart.disabled = false;
    setStatus(`舞者已就绪(${avatar.animations.length} 个内嵌动画)`);
    // 进入 PK/挑战页即进入选曲:教练吸引态 + 摄像头镜像 + 海报卡片
    if (state.mode === "pk" || state.mode === "challenge") {
      enterSelect().catch((e) => setStatus("选曲加载失败:" + e.message));
    }
  } catch (e) {
    console.error(e);
    dom.menuStatus.textContent = "加载失败: " + e.message;
    setStatus("模型加载失败");
  }
}

// ---------------------------------------------------------------------------
// 挑战舞曲选择(舞蹈 + 歌曲;歌单与序列都从 songs/ 目录按文件读取,与选歌主页共用)
// ---------------------------------------------------------------------------
function challengeDance() {
  return danceById(state.challengeDanceId);
}
function challengeSong() {
  return songById(state.challengeSongId);
}

async function rebuildChallenge() {
  const dance = challengeDance();
  const song = challengeSong();
  if (!dance || !song) return;
  if (state.running) stopAll();
  setStatus("正在加载舞曲:" + dance.label + "…");
  const seq = await loadSequence(dance.danceId);
  state.challenge = { seq, scorer: new ScoringAdapter(seq), running: false };
  state.coachPlayer = null;
  setStatus(`已选:${dance.label} / ${song.label}`);
}

function setupChallengePickers() {
  for (const d of dances()) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.label;
    dom.danceSelect.appendChild(o);
  }
  for (const s of songs()) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.label;
    dom.songSelect.appendChild(o);
  }
  dom.danceSelect.value = state.challengeDanceId;
  dom.songSelect.value = state.challengeSongId;

  dom.danceSelect.addEventListener("change", () => {
    state.challengeDanceId = dom.danceSelect.value;
    const dance = danceById(state.challengeDanceId);
    state.challengeSongId = dance?.defaultSongId ?? state.challengeSongId;
    dom.songSelect.value = state.challengeSongId;
    rebuildChallenge().catch((e) => setStatus("舞曲加载失败:" + e.message));
  });
  dom.songSelect.addEventListener("change", () => {
    state.challengeSongId = dom.songSelect.value;
    rebuildChallenge().catch((e) => setStatus("舞曲加载失败:" + e.message));
  });
}

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------
function setMode(mode) {
  if (state.running) stopAll();
  state.mode = mode;
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const isChallenge = mode === "challenge" || mode === "pk";
  const isPk = mode === "pk";
  const isPerformance = mode === "performance";
  dom.scorePanel.classList.toggle("hidden", !isChallenge);
  dom.btnLoadRef.classList.toggle("hidden", !isChallenge || isPk);
  dom.dancePicker.classList.toggle("hidden", !isChallenge);
  dom.songPicker.classList.toggle("hidden", !isChallenge);
  dom.animPicker.classList.toggle("hidden", !isPerformance);
  document.body.classList.toggle("pk-mode", isPk);
  scene.setSplitLayout(isPk);
  if (isChallenge && !state.challenge) {
    rebuildChallenge().catch((e) => setStatus("舞曲加载失败:" + e.message));
  }
  if (isPerformance) enterPerformance();
  layoutForMode();
}
modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

// ---------------------------------------------------------------------------
// 舞台布局(单人 / 教练 + 玩家)
// ---------------------------------------------------------------------------
function layoutForMode() {
  if (!state.avatar) return;
  if (state.mode === "challenge") {
    state.avatar.object.visible = true;
    state.avatar.object.position.x = 1.1;
    if (state.coach) {
      state.coach.object.visible = true;
      state.coach.object.position.x = -1.1;
    }
    scene.camera.position.set(0, 1.9, 6.6);
    scene.controls.target.set(0, 0.95, 0);
    scene.controls.update();
  } else if (state.mode === "pk") {
    state.avatar.object.visible = false;
    if (state.coach) {
      state.coach.object.visible = true;
      state.coach.object.position.x = 0;
    }
    scene.camera.position.set(0, 1.9, 6.6);
    scene.controls.target.set(0, 0.95, 0);
    scene.controls.update();
  } else {
    state.avatar.object.visible = true;
    state.avatar.object.position.x = 0;
    if (state.coach) state.coach.object.visible = false;
    scene.resetCamera();
  }
}

// ---------------------------------------------------------------------------
// 3D 教练(跟跳挑战):同模型的第二实例,按歌曲时钟跳参考舞(JSON 帧)
// ---------------------------------------------------------------------------
async function ensureCoach() {
  if (state.coach) return state.coach;
  if (!state.modelSource) return null;
  setStatus("正在加载教练…");
  try {
    const coach = await loadAvatar(state.modelSource.url, state.modelSource.type);
    coach.object.visible = false;
    scene.scene.add(coach.object);
    state.coach = coach;
    state.skeletons = [...(state.avatar?.skeletons || []), ...coach.skeletons];
    return coach;
  } catch (e) {
    setStatus("教练加载失败: " + e.message);
    return null;
  }
}

// 把参考序列按时间逐帧喂给教练的 Retargeter(IK/贴地/头全部复用)
function makeCoachPlayer(seq, retargeter, boneDefs) {
  const frames = seq.frames || [];
  return {
    update(t) {
      // 插值采样(而非 round(t*fps) 硬切),消除低帧率接缝抖动
      const frame = sampleFrame(frames, t);
      // 教练固定站位跟跳,不消费根运动(否则会跟着参考序列的位移满场跑)
      if (frame) retargeter.applyFrame(frame, { boneDefs, mirror: false, rootMotion: false });
    },
  };
}

// ---------------------------------------------------------------------------
// 选曲(整合进 PK 页):悬停试跳 5 秒,双击开始
// ---------------------------------------------------------------------------
const SELECT_SKIN = {
  demo:   { a: "#ff3d81", b: "#7c4dff", diff: 1 },
  hiphop: { a: "#ffb300", b: "#ff3d81", diff: 2 },
  salsa:  { a: "#00e5a0", b: "#4d7cff", diff: 3 },
};

// 每支舞的 3D 舞者白影剪影(离屏预渲染的招牌动作)
const SILHOUETTES = {
  demo: "assets/silhouettes/demo.png",
  hiphop: "assets/silhouettes/hiphop.png",
  salsa: "assets/silhouettes/salsa.png",
};

// ---------------------------------------------------------------------------
// 页面内剪影兜底:没有预生成 PNG(或加载失败)时,直接用当前舞者的 3D 模型
// 离屏渲染一张白影。核心逻辑来自 tools/gen-silhouettes.mjs,提取成 web_dance/silhouette.js。
// 只在真的需要时才建渲染器(会多占一个 WebGL 上下文),用完把模型放回主场景。
// ---------------------------------------------------------------------------
let silhouetteRenderer = null;

function ensureSilhouetteRenderer() {
  if (!silhouetteRenderer) silhouetteRenderer = createSilhouetteRenderer({ size: 512 });
  return silhouetteRenderer;
}

// 挑该序列最展开的「招牌动作」时刻,渲染成 PNG dataURL;失败返回 null
function inPageSilhouette(entry) {
  const avatar = state.avatar;
  if (!avatar || !entry?.seq || state.running) return null; // 正在跳的时候别动玩家的模型
  const seq = entry.seq;
  const bones = resolveMode(state.danceType).bones;
  const jointsAt = (frame) => reconstructJoints(frame, seq.meta?.dimensions, seq.bones);
  const sig = pickSignatureTimes(seq, jointsAt, { count: 1 })[0];
  const t = sig ? sig.t : (seq.meta?.durationSec || 1) * 0.3;

  const sil = ensureSilhouetteRenderer();
  const home = scene.scene;
  let dataUrl = null;
  try {
    sil.attach(avatar.object);       // 借到离屏场景
    sil.whiten(avatar.object);       // 纯白材质
    const canvas = renderSilhouetteFrame({
      sil, object3D: avatar.object, skeletons: avatar.skeletons,
      retargeter: avatar.retargeter, seq, t, boneDefs: bones,
    });
    dataUrl = canvasToPng(canvas);
  } catch (e) {
    console.warn("[silhouette] 页面内渲染失败:", e);
  } finally {
    sil.restoreMaterials();
    home.add(avatar.object);         // 放回主场景
    avatar.retargeter.reset();       // 还原休息姿态,别影响后续显示
    avatar.skeletons?.forEach((s) => s.update());
  }
  return dataUrl;
}

// 循环播放序列(吸引态 / 试跳),教练原地跟跳不消费根运动
function makeLoopCoachPlayer(seq, retargeter, boneDefs) {
  const frames = seq.frames || [];
  const dur = seq.meta?.durationSec || 1;
  return {
    update(t) {
      const tt = t % dur;
      const frame = sampleFrame(frames, tt);
      if (frame) retargeter.applyFrame(frame, { boneDefs, mirror: false, rootMotion: false });
    },
  };
}

let cardAnimTimer = null;

function drawCardFrame(canvas, seq, t) {
  if (!canvas) return;
  const fps = seq.meta?.fps || 30;
  const frames = seq.frames || [];
  const i = Math.min(frames.length - 1, Math.max(0, Math.round(t * fps)));
  const frame = frames[i];
  if (!frame) return;
  const joints = reconstructJoints(frame, seq.meta?.dimensions, seq.bones);
  renderPoseSilhouette(canvas, joints, seq.bones, { color: "#ffffff" });
}

function drawCardSilhouette(canvas, seq) {
  drawCardFrame(canvas, seq, (seq.meta?.durationSec || 1) * 0.3);
}

// ---------------------------------------------------------------------------
// 右下判定轨道(Just Dance 式):剪影从右往左流入判定平台,抵达平台的那一瞬间剪影消失。
// 数据与判定共用同一份谱面(chart/v1 → 判定事件):谱面上的动作点时刻 = 剪影抵达平台的时刻。
// ---------------------------------------------------------------------------
const LANE_LEAD_SEC = 2.4;   // 剪影从右侧入场、滑到判定平台所需的时长(= 提前量)
const LANE_ARRIVE_X = 46;    // 判定平台中心的横坐标(轨道内像素)
const LANE_FIG_W = 98;       // 单个剪影宽度
const LANE_FIG_H = 142;      // 单个剪影高度
const LANE_MOTION_LOOKBACK = 0.4; // 箭头方向:比较动作点与它前 0.4s 的姿势
const LANE_MOTION_MIN = 0.06;     // 关节位移小于此值视为"定住造型",不标箭头

const poseHintCache = new WeakMap(); // seq -> 动作事件数组
const laneFigs = new Map();          // "t" -> { el, arrived }
let laneLabel = "";                  // 上次写入的标签文本
let laneProgress = -1;               // 上次写入的进度条数值
let laneStageLift = -1;              // 上次写入的判定平台律动位移
// 排查性能用:?nohint=1 可整体关掉右下角判定轨道,便于对比帧率
const poseHintDisabled = new URLSearchParams(location.search).get("nohint") === "1";

function poseEventsFor(seq) {
  if (!seq) return [];
  if (poseHintCache.has(seq)) return poseHintCache.get(seq);
  let events = [];
  try {
    events = parseChart(seq, seq.chart);
  } catch {
    events = [];
  }
  // 没有谱面时回退:每 0.5s 采一帧当动作点
  if (!events.length && seq.frames?.length) {
    const fps = seq.meta?.fps || 30;
    const step = Math.max(1, Math.round(fps * 0.5));
    events = seq.frames.filter((_, i) => i % step === 0).map((f) => ({ t: f.t }));
  }
  poseHintCache.set(seq, events);
  return events;
}

// 参考序列里最接近 t 的一帧(导出可能缺帧,按时间戳二分而不是按 fps 下标)
function frameAtTime(seq, t) {
  const frames = seq?.frames || [];
  if (!frames.length) return null;
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].t < t) lo = mid + 1; else hi = mid; }
  if (!lo) return frames[0];
  if (lo >= frames.length) return frames[frames.length - 1];
  return t - frames[lo - 1].t <= frames[lo].t - t ? frames[lo - 1] : frames[lo];
}

// 当前在跳哪支舞、跳到第几秒(选曲试跳 / 正式挑战都算;表演模式不显示)
function activePoseSource() {
  if (state.phase === "select") {
    const e = state.select.entries[state.select.selected];
    if (!e?.seq) return null;
    // 吸引态/试跳是循环播放,时钟要对时长取模,否则播过一轮后提示会停在最后一个动作
    return { seq: e.seq, t: state.select.clock % (e.seq.meta?.durationSec || 1) };
  }
  if (state.mode === "challenge" || state.mode === "pk") {
    const ch = state.challenge;
    if (ch?.seq) return { seq: ch.seq, t: ch.running ? (ch.session?.songTime ?? 0) : 0 };
  }
  return null;
}

// 拍长(秒):优先序列拍栅格,其次 bpm,最后 0.5s
function beatDurFor(seq) {
  const beats = seq?.meta?.beatTimesSec;
  if (beats && beats.length > 1) {
    const d = beats[1] - beats[0];
    if (d > 0.05) return d;
  }
  const bpm = seq?.meta?.timing?.bpm || seq?.meta?.bpm;
  if (bpm > 0) return 60 / bpm;
  return 0.5;
}

function laneRemove(key) {
  const fig = laneFigs.get(key);
  if (!fig) return;
  fig.el.remove();
  laneFigs.delete(key);
}

function laneClear() {
  for (const key of [...laneFigs.keys()]) laneRemove(key);
}

// 造一张剪影:只画动作的真实姿势(不做镜像)——单手上举的动作就该只有那只手举着。
// 同时算出这个动作"哪个部位往哪动",在旁边标一支方向箭头(上举 → 向上箭头,下蹲 → 向下箭头)。
function laneMakeFig(key, ev, seq, dpr) {
  const el = document.createElement("div");
  el.className = "lane-fig";
  el.style.width = LANE_FIG_W + "px";
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(LANE_FIG_W * dpr);
  canvas.height = Math.round(LANE_FIG_H * dpr);
  el.appendChild(canvas);
  dom.judgeTrack.appendChild(el);
  const nodeT = ev.targetT ?? ev.t;
  const frame = frameAtTime(seq, nodeT);
  if (frame) {
    const joints = reconstructJoints(frame, seq.meta?.dimensions, seq.bones);
    renderPoseSilhouette(canvas, joints, seq.bones, { color: "#ffd7a6" });
    const arrow = laneMotionArrow(seq, nodeT, joints, dpr);
    if (arrow) el.appendChild(arrow);
  }
  const fig = { el, arrived: false };
  laneFigs.set(key, fig);
  return fig;
}

// 剪影渲染器内部的"姿势包围盒 → 画布像素"映射(与 stick-figure.js 的常量保持一致),
// 用它把"正在动的那个关节"换算到画布坐标,箭头才能贴在动作旁边而不是乱飘。
const ARROW_MAP_JOINTS = [
  "left_shoulder", "left_elbow", "left_wrist",
  "right_shoulder", "right_elbow", "right_wrist",
  "left_hip", "left_knee", "left_ankle",
  "right_hip", "right_knee", "right_ankle",
  "nose",
];
const ARROW_PAD_FRAC = 0.10;

function laneJointToPixel(joints, name, dpr) {
  const pts = ARROW_MAP_JOINTS.map((n) => joints[n]).filter(Boolean);
  if (!pts.length || !joints[name]) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const W = LANE_FIG_W * dpr;
  const H = LANE_FIG_H * dpr;
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const pad = Math.min(W, H) * ARROW_PAD_FRAC;
  const scale = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const p = joints[name];
  return {
    x: (W / 2 + (p[0] - cx) * scale) / dpr,
    y: (H / 2 - (p[1] - cy) * scale) / dpr,
  };
}

// 比较两个姿势,找位移最大的关节(候选都是看得出来的末端/根节点)
function laneBestMotion(jointsFrom, jointsTo) {
  const CANDIDATES = [
    "left_wrist", "right_wrist", "left_elbow", "right_elbow",
    "left_ankle", "right_ankle", "left_knee", "right_knee",
    "hips_center", "nose",
  ];
  let best = null;
  for (const name of CANDIDATES) {
    const a = jointsFrom[name];
    const b = jointsTo[name];
    if (!a || !b) continue;
    const mx = b[0] - a[0];
    const my = b[1] - a[1];
    const mag = Math.hypot(mx, my);
    if (!best || mag > best.mag) best = { name, mx, my, mag };
  }
  return best;
}

// 这个动作"哪个部位往哪动":比较动作点与它前面的姿势,取位移最大的关节。
// 慢舞(幅度小)自动拉长回溯窗口到 0.8s;整首的第一个动作没有更早的姿势,就用往后 0.4s 的起手方向。
function laneMotionArrow(seq, nodeT, jointsNow, dpr) {
  const dims = seq.meta?.dimensions;
  let best = null;
  for (const lb of [LANE_MOTION_LOOKBACK, LANE_MOTION_LOOKBACK * 2]) {
    const prevFrame = frameAtTime(seq, nodeT - lb);
    if (!prevFrame) continue;
    const cand = laneBestMotion(reconstructJoints(prevFrame, dims, seq.bones), jointsNow);
    if (cand && (!best || cand.mag > best.mag)) best = cand;
    if (best && best.mag >= LANE_MOTION_MIN) break;
  }
  const firstT = seq.frames?.[0]?.t ?? 0;
  if ((!best || best.mag < LANE_MOTION_MIN) && nodeT - LANE_MOTION_LOOKBACK <= firstT + 1e-6) {
    const nextFrame = frameAtTime(seq, nodeT + LANE_MOTION_LOOKBACK);
    if (nextFrame) {
      const cand = laneBestMotion(jointsNow, reconstructJoints(nextFrame, dims, seq.bones));
      if (cand && (!best || cand.mag > best.mag)) best = cand;
    }
  }
  if (!best || best.mag < LANE_MOTION_MIN) return null; // 几乎没动(定住造型)就不标箭头

  const ux = best.mx / best.mag;
  const uy = best.my / best.mag;
  const anchor = laneJointToPixel(jointsNow, best.name, dpr);
  const body = laneJointToPixel(jointsNow, "hips_center", dpr);
  if (!anchor) return null;

  // 出箭头的方向:运动方向 + 远离身体的方向(否则下蹲/手落下的动作箭头会压在身体上)
  let dx = ux;
  let dy = -uy; // 屏幕 y 向下
  if (body) {
    const ox = anchor.x - body.x;
    const oy = anchor.y - body.y;
    const olen = Math.hypot(ox, oy);
    if (olen > 1) {
      dx = dx * 0.55 + (ox / olen) * 0.85;
      dy = dy * 0.55 + (oy / olen) * 0.85;
    }
  }
  const dlen = Math.hypot(dx, dy) || 1;
  dx /= dlen;
  dy /= dlen;

  const arrow = document.createElement("i");
  arrow.className = "lane-arrow";
  // 箭头基准朝上(0°):屏幕顺时针角度 = atan2(dx, dy)
  const deg = Math.atan2(dx, dy) * 180 / Math.PI;
  const push = 36;
  // 限制在剪影框内,否则举手/下落类动作的箭头会被轨道边缘裁掉
  const x = Math.min(LANE_FIG_W - 6, Math.max(6, anchor.x + dx * push));
  const y = Math.min(LANE_FIG_H - 6, Math.max(10, anchor.y + dy * push));
  arrow.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${deg.toFixed(1)}deg)`;
  return arrow;
}

function updatePoseLane() {
  if (!dom.poseHint) return;
  if (poseHintDisabled || !dom.judgeTrack) { dom.poseHint.classList.add("hidden"); laneClear(); return; }
  const src = activePoseSource();
  if (!src) { dom.poseHint.classList.add("hidden"); laneClear(); return; }
  dom.poseHint.classList.remove("hidden");

  const { seq, t } = src;
  const events = poseEventsFor(seq);
  if (!events.length) return;

  // 轨道几何:右侧入场 → 左侧判定平台,走到平台正好花 LANE_LEAD_SEC 秒(这就是"提前量")
  const trackW = dom.judgeTrack.clientWidth || 396;
  const pxPerSec = Math.max(1, (trackW - LANE_ARRIVE_X) / LANE_LEAD_SEC);
  const dpr = globalThis.devicePixelRatio || 1;

  // 这一帧应该还在轨道上的剪影:还没到平台的(含刚到的正在淡出)
  const live = new Set();
  for (const ev of events) {
    const dt = ev.t - t;
    if (dt > LANE_LEAD_SEC) break;
    if (dt < -0.05 && !laneFigs.has(ev.t.toFixed(3))) continue; // 早过点的,直接跳过
    const key = ev.t.toFixed(3);
    live.add(key);
    let fig = laneFigs.get(key);
    if (!fig) fig = laneMakeFig(key, ev, seq, dpr);
    if (fig.arrived) continue; // 已抵达:停在平台上等淡出动画结束,不再更新位置

    // 位置:平台处 x = LANE_ARRIVE_X,越早的动作越靠左
    const x = LANE_ARRIVE_X + Math.max(0, dt) * pxPerSec;
    fig.el.style.transform = `translateX(${(x - LANE_FIG_W / 2).toFixed(1)}px)`;
    fig.el.classList.toggle("near", dt <= 0.45);

    // 抵达判定平台:剪影立刻消失(淡出 + 放大),平台同时弹一下
    if (dt <= 0) {
      fig.arrived = true;
      fig.el.classList.add("arrive");
      setTimeout(() => laneRemove(key), 300);
    }
  }
  // 清掉已经不在视野里的
  for (const key of [...laneFigs.keys()]) if (!live.has(key)) laneRemove(key);

  // 律动:判定平台跟着拍点上下浮一下(越接近拍点越高)
  const beat = beatDurFor(seq);
  const frac = ((t / beat) % 1 + 1) % 1;
  const lift = 6 * Math.exp(-frac * 6);
  if (dom.judgeStage && Math.abs(lift - laneStageLift) > 0.2) {
    laneStageLift = lift;
    dom.judgeStage.style.transform = `translateY(${(-lift).toFixed(2)}px)`;
  }

  // 标签:下一个动作名 + 还有几秒到它(0.1s 粒度,避免每帧写 DOM)
  let i = 0;
  for (let k = events.length - 1; k >= 0; k--) if (events[k].t <= t) { i = k; break; }
  const cur = events[i];
  const next = events[Math.min(events.length - 1, i + 1)];
  const up = next.t > t ? next : cur;
  const remain = Math.max(0, up.t - t);
  const text = (up.moveId || "") + (remain > 0.05 ? ` · ${remain.toFixed(1)}s` : " · 就是现在");
  if (text !== laneLabel && dom.poseHintName) {
    laneLabel = text;
    dom.poseHintName.textContent = text;
  }

  // 进度条:上一个节点 → 下一个节点,走满 = 现在就该做它
  const gap = Math.max(0.2, next.t - cur.t);
  const p = t < cur.t ? 0 : Math.min(1, (t - cur.t) / gap);
  if (p - laneProgress >= 0.005 || p < laneProgress) {
    laneProgress = p;
    if (dom.poseHintFill) dom.poseHintFill.style.width = (p * 100).toFixed(1) + "%";
  }
}

// 试跳时让海报上的剪影跟着循环(卡片也"活了")
function animateCardPose(i) {
  clearInterval(cardAnimTimer);
  const e = state.select.entries[i];
  if (!e) return;
  let t = 0;
  cardAnimTimer = setInterval(() => {
    if (state.phase !== "select") { clearInterval(cardAnimTimer); return; }
    t = (t + 0.1) % (e.seq.meta?.durationSec || 1);
    drawCardFrame(e._canvas, e.seq, t);
  }, 90);
}

// 扇形布局:从右下角向左展开,选中卡贴角放大,越远越缩越小/越后仰
function layoutCards() {
  const n = state.select.entries.length;
  state.select.entries.forEach((e, k) => {
    const el = e.el;
    if (!el) return;
    const w = el.offsetWidth || 210;
    const spread = Math.round(w * 0.66);
    let off = ((k - state.select.selected) % n + n) % n; // 0=选中(贴角), 1..=向左展开
    if (off === 0) {
      el.style.transform = `translateX(0px) translateY(-10px) rotateY(0deg) scale(1.12)`;
      el.style.zIndex = n;
      el.style.opacity = "";
    } else {
      const rot = 18 + (off - 1) * 14;
      const scale = Math.max(0.64, 0.88 - (off - 1) * 0.12);
      el.style.transform = `translateX(${-off * spread}px) translateY(${off * 4}px) rotateY(${-rot}deg) scale(${scale})`;
      el.style.zIndex = n - off;
      el.style.opacity = "";
    }
  });
}

async function seqFor(entry) {
  return loadSequence(entry.dance.danceId);
}

async function enterSelect() {
  state.phase = "select";
  state.mode = "pk";
  clearTimeout(state.select.revertTimer);
  clearInterval(cardAnimTimer);
  state.select.player = null;
  laneClear();
  laneProgress = -1;
  laneLabel = "";
  document.body.classList.add("pk-mode");
  scene.setSplitLayout(true);
  // 选曲态只留:摄像头 + 教练 + 卡片;其余 HUD 收起
  dom.result.classList.add("hidden");
  closeReady();
  dom.scorePanel.classList.add("hidden");
  dom.controls.classList.add("hidden");
  dom.dancePicker.classList.add("hidden");
  dom.songPicker.classList.add("hidden");
  dom.btnLoadRef.classList.add("hidden");
  dom.animPicker.classList.add("hidden");
  dom.centerMsg.classList.add("hidden");

  const coach = await ensureCoach();
  if (!coach) { setStatus("教练加载失败"); return; }
  coach.object.visible = true;
  coach.retargeter.reset();
  layoutForMode(); // pk 布局:隐藏玩家 3D,显示教练

  // 预载全部舞曲序列,试跳/开始都即时
  const entries = dances().map((dance) => {
    const song = songById(dance.defaultSongId) || songs()[0];
    return { dance, song, skin: SELECT_SKIN[dance.id] || SELECT_SKIN.demo, seq: null, el: null };
  });
  await Promise.all(entries.map(async (e) => { e.seq = await seqFor(e); }));

  state.select.entries = entries;
  state.select.selected = 0;
  buildSelectCards();
  dom.songPick.classList.remove("hidden");
  startAttract(0);
  await startCamera();
  setStatus("选一支舞 · 单击预览 · 双击准备开始");
}

function buildSelectCards() {
  dom.songPickStrip.innerHTML = "";
  state.select.entries.forEach((e, i) => {
    const card = document.createElement("div");
    card.className = "song-card";
    card.style.setProperty("--sc-a", e.skin.a);
    card.style.setProperty("--sc-b", e.skin.b);
    const heat = "●".repeat(e.skin.diff) + "○".repeat(Math.max(0, 3 - e.skin.diff));
    card.innerHTML = `
      <div class="sc-cover"></div>
      <img class="sc-sil" src="${SILHOUETTES[e.dance.id] || SILHOUETTES.demo}" alt="" draggable="false">
      <div class="sc-heat">${heat}</div>
      <div class="sc-info">
        <div class="sc-title">${e.dance.label}</div>
        <div class="sc-meta">♪ ${e.song.label} · BPM ${e.song.bpm}</div>
      </div>`;
    // 预生成 PNG 缺失/加载失败时,页面内用 3D 舞者实时渲染一张白影剪影
    const silImg = card.querySelector(".sc-sil");
    silImg.addEventListener("error", () => {
      const dataUrl = inPageSilhouette(e);
      if (dataUrl) silImg.src = dataUrl;
    }, { once: true });
    card.addEventListener("click", () => {
      selectCard(i);
      preview(i);
    });
    card.addEventListener("dblclick", () => openReady(i));
    dom.songPickStrip.appendChild(card);
    e.el = card;
  });
  selectCard(0);
}

function selectCard(i) {
  state.select.selected = i;
  state.select.entries.forEach((e, k) => e.el.classList.toggle("selected", k === i));
  layoutCards();
}

function openReady(i) {
  selectCard(i);
  const e = state.select.entries[i];
  if (e) {
    dom.readySong.textContent = `${e.dance.label} · ${e.song.label} · BPM ${e.song.bpm}`;
    dom.readyBackdrop.classList.remove("hidden");
    dom.ready.classList.remove("hidden");
    dom.readyGo.focus();
  }
}

function closeReady() {
  dom.ready.classList.add("hidden");
  dom.readyBackdrop.classList.add("hidden");
}

dom.readyBackdrop.addEventListener("click", closeReady);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !dom.ready.classList.contains("hidden")) closeReady();
});

function preview(i) {
  const e = state.select.entries[i];
  const coach = state.coach;
  if (!e?.seq || !coach) return;
  state.select.clock = 0;
  state.select.player = makeLoopCoachPlayer(e.seq, coach.retargeter, resolveMode(state.danceType).bones);
  animateCardPose(i);
  clearTimeout(state.select.revertTimer);
  state.select.revertTimer = setTimeout(() => startAttract(state.select.selected), 5000);
}

function startAttract(i) {
  const e = state.select.entries[i];
  const coach = state.coach;
  clearInterval(cardAnimTimer);
  if (!e?.seq || !coach) return;
  state.select.clock = 0;
  state.select.player = makeLoopCoachPlayer(e.seq, coach.retargeter, resolveMode(state.danceType).bones);
  if (e._canvas) drawCardSilhouette(e._canvas, e.seq);
}

function startSong(i) {
  const e = state.select.entries[i];
  if (!e) return;
  state.phase = "playing";
  state.select.player = null;
  laneClear();
  laneProgress = -1;
  laneLabel = "";
  clearTimeout(state.select.revertTimer);
  clearInterval(cardAnimTimer);
  dom.songPick.classList.add("hidden");
  closeReady();
  dom.controls.classList.toggle("hidden", !debugMode); // 只有工作人员模式才显示底部控制条
  state.challengeDanceId = e.dance.id;
  state.challengeSongId = e.song.id;
  dom.danceSelect.value = e.dance.id;
  dom.songSelect.value = e.song.id;
  // 直接用预载序列,免重载
  if (state.challenge?.session) state.challenge.session.stop();
  state.challenge = { seq: e.seq, scorer: new ScoringAdapter(e.seq), running: false };
  state.coachPlayer = null;
  startChallenge().catch((err) => { stopAll(); setStatus("启动失败: " + err.message); });
}
// 「准备开始」面板的开始按钮
dom.readyGo.addEventListener("click", () => startSong(state.select.selected));

// ---------------------------------------------------------------------------
// 表演模式:播放 FBX/GLB 内嵌动画(AnimationMixer)
// ---------------------------------------------------------------------------
// 表演曲目列表:{ id, label, kind: 'builtin'|'embedded', dance?, clip? }
let performanceOptions = [];
let mixerSeq = 0; // 令牌:让「停止/切换」作废进行中的异步舞曲加载

function enterPerformance() {
  stopMixer();
  if (!state.avatar) {
    dom.btnStart.disabled = true;
    setStatus("请先选择舞者");
    return;
  }
  buildPerformanceOptions();
  // 选歌主页通过 dance 参数指定的表演舞蹈优先选中；没有参数时保留第一个选项。
  if (state.performanceDanceId) {
    const option = performanceOptions.find((o) => o.kind === "builtin" && o.dance.id === state.performanceDanceId);
    if (option) dom.animSelect.value = option.id;
  }
  if (performanceOptions.length) {
    dom.btnStart.disabled = false;
    dom.btnStop.disabled = true;
    setStatus(`表演模式:${performanceOptions.length} 支舞蹈,选好点「开始」播放`);
  } else {
    dom.btnStart.disabled = true;
    setStatus("没有可用舞蹈(内置舞曲 + 模型内嵌动画均不可用)");
  }
}

function buildPerformanceOptions() {
  performanceOptions = [];
  dom.animSelect.innerHTML = "";
  const add = (opt) => {
    performanceOptions.push(opt);
    const el = document.createElement("option");
    el.value = opt.id;
    el.textContent = opt.label;
    dom.animSelect.appendChild(el);
  };
  // 内置舞曲(优先):来自仓库根 fbx/ 目录的 Mixamo 动作
  for (const d of BUILTIN_DANCES) {
    add({ id: "builtin:" + d.id, label: "内置 · " + d.label, kind: "builtin", dance: d });
  }
  // 模型内嵌动画(如默认 Michelle 自带的 SambaDance)
  for (const clip of state.avatar.animations || []) {
    add({ id: "embedded:" + clip.name, label: clip.name, kind: "embedded", clip });
  }
}

// 表演模式循环音乐(与挑战 SongSession 分离,复用 AudioEngine + loop)
let performanceAudio = null;

async function ensurePerformanceAudio() {
  if (performanceAudio) return performanceAudio;
  const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  const audioContext = AudioCtor ? new AudioCtor() : null;
  const engine = new AudioEngine({ audioContext });
  engine.loop = true;
  await engine.load("../songs/hiphop/pop-demo.wav");
  performanceAudio = engine;
  return engine;
}

function startPerformanceMusic() {
  ensurePerformanceAudio()
    .then((engine) => engine.play())
    .catch((e) => console.warn("表演音频播放失败:", e));
}

function stopPerformanceMusic() {
  if (performanceAudio) performanceAudio.stop();
}

async function startMixer(optionId) {
  if (!state.avatar) return;
  const opt = performanceOptions.find((o) => o.id === optionId) || performanceOptions[0];
  if (!opt) return;
  const seq = ++mixerSeq;
  stopMixer();

  let clip;
  if (opt.kind === "builtin") {
    setStatus("正在加载舞曲:" + opt.label + "…");
    try {
      const { root, clips } = await loadDanceClips(opt.dance);
      if (seq !== mixerSeq || state.mode !== "performance") return; // 已被停止/切换
      if (!clips.length) throw new Error("该 FBX 里没有动画片段");
      clip = retargetClipToSkeleton(clips[0], root, state.avatar.object);
      if (!clip.tracks.length) throw new Error("骨骼名对不上,无法重定向到当前舞者");
    } catch (e) {
      if (seq !== mixerSeq || state.mode !== "performance") return;
      console.error(e);
      setStatus("舞曲加载失败:" + e.message);
      dom.btnStart.disabled = false;
      return;
    }
  } else {
    clip = opt.clip;
  }
  if (!clip) return;

  state.avatar.retargeter.reset();
  state.mixer = new THREE.AnimationMixer(state.avatar.object);
  const action = state.mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity); // 动作短,循环播放(与循环背景乐一致)
  action.play();
  state.running = true;
  dom.btnStart.disabled = true;
  dom.btnStop.disabled = false;
  setStatus("播放舞蹈: " + (opt.label || clip.name));
  startPerformanceMusic();
}

function stopMixer() {
  if (state.mixer) {
    state.mixer.stopAllAction();
    state.mixer = null;
  }
  if (state.avatar) state.avatar.retargeter.reset();
  stopPerformanceMusic();
}

dom.animSelect.addEventListener("change", () => startMixer(dom.animSelect.value));

dom.danceType.addEventListener("change", () => {
  state.danceType = dom.danceType.value;
  dom.danceTypeLabel.textContent = dom.danceType.value === "gesture" ? "手势" : "全身";
  if (state.running) stopAll();
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
    if (state.challenge?.session) state.challenge.session.stop();
    state.challenge = { seq, scorer: new ScoringAdapter(seq), running: false };
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

function ensureSession(ch) {
  if (ch.session) return ch.session;
  const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  const audioContext = AudioCtor ? new AudioCtor() : null;
  const scorer = ch.scorer;
  ch.session = new SongSession({
    sequence: ch.seq,
    similarity: (ref, player) => scorer._similarity(ref, player),
    audioContext,
    enableJudge: false, // ScoringAdapter owns the only judgement stream.
    allowSilent: false,
    onSongEnd: () => finishChallenge(),
  });
  return ch.session;
}

async function startChallenge() {
  if (!state.challenge) await rebuildChallenge();
  const ch = state.challenge;
  if (!ch) return;
  const generation = ++startGeneration;
  dom.btnStart.disabled = true;
  dom.btnStop.disabled = false;
  ch.scorer.reset();
  resetScoreHUD();

  lastTier = "";
  lastMilestone = 0;
  lastBeatIdx = -1;

  // 音乐会话:唯一时钟(音频对齐);首建在用户手势内创建 AudioContext
  const session = ensureSession(ch);
  await session.prepare();
  if (generation !== startGeneration) return;

  // 3D 教练(同模型第二实例)跳参考舞,玩家跟着跳
  const coach = await ensureCoach();
  if (generation !== startGeneration) return;
  if (coach) {
    coach.object.visible = true;
    coach.retargeter.reset();
    state.coachPlayer = makeCoachPlayer(ch.seq, coach.retargeter, resolveMode(state.danceType).bones);
  }
  layoutForMode();
  await startCamera();
  if (generation !== startGeneration) { stopAll(); return; }
  if (!state.running) return;

  if (state.mode === 'pk') {
    await highlights.prepare(session.engine, () => generation !== startGeneration);
    if (generation !== startGeneration) { highlights.abort(); return; }
  }

  // 倒计时:GO 时刻 = songTime 0 = 音频起点(绝对 ctx 时间锚定,不用 setTimeout 猜)
  const ctx = session.engine.ctx;
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* noop */ } }
  const goAt = ctx.currentTime + 3.2;
  await session.start(goAt); // 预调度音频与时钟
  ch.scorer.latency.outputLatencySec = ctx.outputLatency || 0;
  if (!await countdownTo(goAt, generation)) return;
  highlights.start();
  ch.running = true;
  challengeTimer = setInterval(() => {
    if (!ch.running) return;
    const t = session.songTime;
    // Give the one in-flight frame time to arrive; frame timestamps remain capture-based.
    const lag = Math.min(.25, (lastPerf?.stages?.captureToResult?.p95Ms ?? 80) / 1000);
    for (const result of ch.scorer.advance(Math.max(0, t - lag))) {
      if (!result.ongoing) { lastTier = ""; judgeFeedback(result.tier, result.combo, result.score); }
    }
    updateScoreHUD({ acc: ch.previewAcc ?? 0 });
    updateChallengeProgress(t, ch); beatPulse(t, ch);
    session.update();
  }, 25);
}

function startCamera() {
  if (state.stream) { state.running = true; return Promise.resolve(); }
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
      lastPerf = snap;
      const rendering = renderPerf.read();
      const p = snap.stages.captureToResult;
      dom.fps.textContent = `识别 ${snap.fps} / 画面 ${rendering.fps} FPS`;
      dom.fps.title = p ? `输入至结果 P50 ${p.p50Ms} / P95 ${p.p95Ms} / P99 ${p.p99Ms} ms` : "等待性能样本";
      document.getElementById("perf-details").textContent = JSON.stringify({ pose: snap, rendering }, null, 2);
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
  lastPoseAt = performance.now();
  lastCaptureToRender = frame.capturedAtMs ?? lastPoseAt;
  if (state.avatar) {
    state.avatar.retargeter.applyFrame(frame, {
      boneDefs,
      mirror: state.mirror,
      flipFacing: state.flipFacing,
    });
  }
  // 置信度(仅用于高光录制判断,不展示给玩家)
  const conf = frame.conf;
  const avg = conf && conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : 0;
  state.latestConf = avg;

  // 挑战判定
  const ch = state.challenge;
  if ((state.mode === "challenge" || state.mode === "pk") && ch && ch.running) {
    const t = ch.session.songTime - Math.max(0, performance.now() - frame.capturedAtMs) / 1000;
    const res = ch.scorer.judge(t, frame);
    if (res) ch.previewAcc = res.acc;
  }
}

function stopAll({ keepCamera = false } = {}) {
  highlights.abort();
  startGeneration++;
  clearInterval(challengeTimer);
  challengeTimer = null;
  dom.centerMsg.classList.add("hidden");
  if (state.stream && !keepCamera) {
    state.stream.stop();
    state.stream = null;
  }
  state.running = false;
  if (state.challenge) {
    state.challenge.running = false;
    state.challenge.session?.stop();
  }
  state.coachPlayer = null;
  if (state.coach) state.coach.retargeter.reset();
  mixerSeq++; // 作废进行中的异步舞曲加载
  stopMixer(); // 停动画并复位主舞者
  dom.btnStart.disabled = !state.avatar;
  dom.btnStop.disabled = true;
  dom.comboBadge.classList.add("hidden");
  setStatus("已停止");
}

dom.btnStart.addEventListener("click", async () => {
  if (!state.avatar) return;
  dom.btnStart.disabled = true;
  try {
    if (state.mode === "performance") {
      await startMixer(dom.animSelect.value);
    } else if (state.mode === "challenge" || state.mode === "pk") {
      await startChallenge();
    } else {
      await startFree();
    }
  } catch (e) {
    stopAll();
    setStatus("启动失败: " + e.message);
    dom.btnStart.disabled = false;
  }
});

dom.btnStop.addEventListener("click", () => stopAll());
dom.resultAgain.addEventListener("click", () => {
  dom.result.classList.add("hidden");
  startChallenge().catch((e) => { stopAll(); setStatus("启动失败: " + e.message); });
});
// 结算「换一首」:留在本页,回到选曲
dom.resultExit.addEventListener("click", () => {
  stopAll({ keepCamera: true });
  enterSelect().catch((e) => setStatus("选曲加载失败: " + e.message));
});
// 顶栏「选曲」:回到选曲态
dom.btnHome.addEventListener("click", (e) => {
  e.preventDefault();
  if (state.running) stopAll({ keepCamera: true });
  enterSelect().catch((err) => setStatus("选曲加载失败: " + err.message));
});

// ---------------------------------------------------------------------------
// 倒计时
// ---------------------------------------------------------------------------
// Audio-clock countdown, cancellable without sleeping through an obsolete start.
async function countdownTo(goAt, generation) {
  const ctx = state.challenge.session.engine.ctx;
  dom.centerMsg.classList.remove("hidden");
  return new Promise((resolve) => {
    const tick = () => {
      if (generation !== startGeneration) { resolve(false); return; }
      const remaining = goAt - ctx.currentTime;
      if (remaining <= 0) { dom.centerMsg.classList.add("hidden"); shutterCam(); resolve(true); return; }
      dom.centerMsgText.textContent = String(Math.min(3, Math.ceil(remaining)));
      setTimeout(tick, 25);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// HUD 更新
// ---------------------------------------------------------------------------
function updateScoreHUD(res) {
  dom.score.textContent = Math.round(state.challenge.scorer.score);
  const combo = res.combo ?? state.challenge.scorer.combo;
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
  dom.comboBadge.classList.add("hidden");
  dom.comboBadgeN.textContent = "0";
}

function updateChallengeProgress(t, ch) {
  const dur = ch.seq.meta.durationSec || 1;
  dom.progressFill.style.width = Math.min(100, (t / dur) * 100) + "%";
  // 节拍指示(优先 timing/v1,回退旧 beatTimesSec)
  const timing = ch.session?.timing;
  let beatIdx = 0;
  if (timing) {
    const b = timing.nearestBeat(t);
    beatIdx = b ? b.index % 4 : 0;
  } else {
    const beats = ch.seq.meta.beatTimesSec;
    if (beats && beats.length > 1) {
      const beat = beats[1] - beats[0] || 0.5;
      beatIdx = Math.floor(t / beat) % 4;
    }
  }
  [...dom.beats.children].forEach((el, i) => el.classList.toggle("on", i === beatIdx));
}

// ---------------------------------------------------------------------------
// 结算头衔(称号)系统:评级 + 特殊成就给出有趣头衔,并暗示下一档头衔以刺激再来一局
// ---------------------------------------------------------------------------
const TITLE_LADDER = [
  { grade: "S", title: "封神舞者", en: "DANCE LEGEND" },
  { grade: "A", title: "节奏大师", en: "RHYTHM MASTER" },
  { grade: "B", title: "舞台新星", en: "STAGE STAR" },
  { grade: "C", title: "渐入佳境", en: "RISING DANCER" },
  { grade: "D", title: "热身完毕", en: "WARM-UP DONE" },
];
const TITLE_TAGLINES = {
  S: "这就是街舞的天花板",
  A: "天生为舞台而生",
  B: "再练一把就能封神",
  C: "手感正在升温",
  D: "下一把就是你的主场",
};
// 结算主色:整个结算界面的霓虹光源都用这一个变量驱动,保证配色统一
const GRADE_COLORS = { S: "#ffd54a", A: "#39ffcf", B: "#4d7cff", C: "#c88bff", D: "#ff8a8a" };

function titleFor(r) {
  const t = r.tallies || {};
  const total = (t.perfect ?? 0) + (t.great ?? 0) + (t.good ?? 0) + (t.miss ?? 0) || 1;
  const perfect = t.perfect ?? 0;
  const fullCombo = r.maxCombo >= total && total > 0;
  const allPerfect = total > 0 && perfect === total;

  // 特殊成就优先于评级头衔
  if (allPerfect) return { title: "人机合一", en: "PERFECT DANCE", tagline: "一音不差,你就是这个舞台的神", special: true, next: null };
  if (fullCombo && (r.grade === "S" || r.grade === "A")) return { title: "完美全连", en: "FULL COMBO", tagline: "零断连,全场为你尖叫", special: true, next: null };

  const idx = TITLE_LADDER.findIndex((x) => x.grade === r.grade);
  const base = idx >= 0 ? TITLE_LADDER[idx] : TITLE_LADDER[TITLE_LADDER.length - 1];
  const next = idx > 0 ? TITLE_LADDER[idx - 1] : null;
  return { title: base.title, en: base.en, tagline: TITLE_TAGLINES[r.grade] || "", special: false, next };
}

// 数字滚动:结算时把大数字从 0 滚到目标值(与 juice 共用时钟,天然支持 hit-stop)
function countUp(el, to, { format = (v) => String(Math.round(v)), duration = 950, delay = 0 } = {}) {
  animate({
    duration, delay, ease: ease.cubicOut,
    onUpdate: (t) => { el.textContent = format(to * t); },
    onComplete: () => { el.textContent = format(to); },
  });
}

// 数据条:宽度从 0 涨到目标百分比,与数字滚动节奏一致
function fillBar(el, to, delay = 0) {
  animate({
    duration: 950, delay, ease: ease.cubicOut,
    onUpdate: (t) => { el.style.width = (to * t).toFixed(2) + "%"; },
    onComplete: () => { el.style.width = to + "%"; },
  });
}

function celebrate(grade, special) {
  const cx = window.innerWidth / 2, cy = window.innerHeight * 0.38;
  const gradeRgb = (GRADE_COLORS[grade] || "#ffd54a").replace("#", "");
  juice.flash("255,255,255", 0.3, 0.18);
  juice.shake(10);
  juice.ring(cx, cy, { size: 320, color: gradeRgb, width: 4, duration: 460 });
  const big = special || grade === "S" || grade === "A";
  const rounds = big ? 3 : 2;
  for (let i = 0; i < rounds; i++) {
    setTimeout(() => {
      juice.burst(cx + (Math.random() - 0.5) * 300, cy - 20 + (Math.random() - 0.5) * 140, {
        count: big ? 70 : 45, speed: big ? 560 : 430, ttl: 1.2,
        colors: [gradeRgb, "255,61,129", "77,124,255", "57,255,207", "255,213,74"],
      });
    }, i * 220);
  }
}

function showResult(r) {
  const meta = titleFor(r);
  const gradeColor = GRADE_COLORS[r.grade] || "#ffd54a";
  dom.result.style.setProperty("--grade", gradeColor);
  dom.resultGrade.textContent = r.grade;
  dom.resultTitle.textContent = meta.title;
  dom.resultTagline.textContent = `${meta.en} · ${meta.tagline}`.toUpperCase();
  dom.resultSong.textContent = `${challengeDance().label} · ${challengeSong().label}`;
  dom.resultNext.textContent = meta.next
    ? `再冲一步 · 解锁「${meta.next.title}」`
    : (meta.special ? "传奇成就已达成,接受全场膜拜吧!" : "已是本曲最高头衔,去刷新纪录吧!");

  dom.result.classList.remove("hidden");
  // 重新触发入场编排(移除再添加 .reveal,强制重排)
  dom.result.classList.remove("reveal");
  void dom.result.offsetWidth;
  dom.result.classList.add("reveal");

  // 先归零,保证「再来一次」时数字与数据条都能干净地从 0 重滚
  dom.statScore.textContent = "0";
  dom.statAcc.textContent = "0%";
  dom.statCombo.textContent = "0";
  dom.statHit.textContent = "0%";
  dom.statAccBar.style.width = "0%";
  dom.statComboBar.style.width = "0%";
  dom.statHitBar.style.width = "0%";

  // 游戏计分不用千分位逗号,纯数字更像街机
  const fmtInt = (v) => Math.round(v).toString();
  countUp(dom.statScore, r.score, { format: fmtInt, delay: 600 });
  countUp(dom.statAcc, r.avgAcc * 100, { format: (v) => Math.round(v) + "%", delay: 700 });
  countUp(dom.statCombo, r.maxCombo, { format: fmtInt, delay: 800 });
  countUp(dom.statHit, r.hitRate * 100, { format: (v) => Math.round(v) + "%", delay: 900 });

  // 数据条:连击按"达成全连的比例"填充,与两个百分比同尺度,一眼看懂离全连多远
  const tales = r.tallies || {};
  const totalNotes = (tales.perfect ?? 0) + (tales.great ?? 0) + (tales.good ?? 0) + (tales.miss ?? 0);
  const comboPct = totalNotes ? Math.min(100, (r.maxCombo / totalNotes) * 100) : 0;
  fillBar(dom.statAccBar, r.avgAcc * 100, 700);
  fillBar(dom.statComboBar, comboPct, 800);
  fillBar(dom.statHitBar, r.hitRate * 100, 900);

  celebrate(r.grade, meta.special);
}

function finishChallenge() {
  const ch = state.challenge;
  if (!ch || !ch.running) return;
  ch.running = false;
  const r = ch.scorer.finalize();
  void highlights.finish(r);
  showResult(r);
  stopAll({ keepCamera: true });
  scheduleReplay();
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function setStatus(s) {
  dom.status.textContent = s;
}

// 判定命中:相框边缘闪对应颜色(金/青/蓝/红)
const TIER_FLASH = { PERFECT: "#ffd54a", GREAT: "#39ffcf", GOOD: "#4d7cff", MISS: "#ff5f6d" };
function flashCamFrame(tier) {
  const f = dom.camWrap;
  f.classList.remove("cam-flash");
  void f.offsetWidth; // 重排以重触发动画
  f.style.setProperty("--flash", TIER_FLASH[tier] || "#ffffff");
  f.classList.add("cam-flash");
}

// 开跳瞬间:拍照式咔嚓白闪
function shutterCam() {
  const f = dom.camWrap;
  f.classList.remove("cam-shutter");
  void f.offsetWidth;
  f.classList.add("cam-shutter");
}

// 键盘:空格 开始/停止,M 镜像,D 工作人员调试开关
window.addEventListener("keydown", (e) => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (state.running) stopAll();
    else if (state.avatar) dom.btnStart.click();
  } else if (e.key === "m" || e.key === "M") {
    dom.btnMirror.click();
  } else if (e.key === "d" || e.key === "D") {
    debugMode = !debugMode;
    applyDebugUI();
    if (state.phase === "playing") dom.controls.classList.toggle("hidden", !debugMode);
  }
});

setMode("pk");
setStatus("正在加载默认舞者…");

// ---------------------------------------------------------------------------
// 选歌主页跳转参数:?mode=challenge&dance=hiphop&song=pop-demo&autoload=1
// ---------------------------------------------------------------------------
function applyLaunchParams() {
  const q = new URLSearchParams(location.search);
  debugMode = q.get("debug") === "1";
  applyDebugUI();
  const danceId = q.get("dance");
  const songId = q.get("song");
  if (danceId && danceById(danceId)) {
    state.challengeDanceId = danceId;
    dom.danceSelect.value = danceId;
    state.challengeSongId = danceById(danceId).defaultSongId;
  }
  if (songId && songById(songId)) {
    state.challengeSongId = songId;
  }
  if (danceId && BUILTIN_DANCES.some((d) => d.id === danceId)) {
    state.performanceDanceId = danceId;
  }
  dom.songSelect.value = state.challengeSongId;
  const mode = q.get("mode");
  if (["free", "challenge", "pk", "performance"].includes(mode)) setMode(mode);
  loadModel(DEFAULT_MODEL);
}

// 启动:先导入歌单(songs/index.json),再组下拉、应用跳转参数
async function init() {
  try {
    await loadSongIndex();
  } catch (e) {
    setStatus("歌单加载失败(需先运行 npm run export-songs):" + e.message);
    return;
  }
  setupChallengePickers();
  applyLaunchParams();
}
init();

// Operators can export anonymous timing metrics; no images or poses are included.
document.getElementById("export-perf").onclick = () => {
  const report = { version: 1, createdAt: new Date().toISOString(), userAgent: navigator.userAgent,
    pose: state.stream?.perf.report() ?? null, rendering: renderPerf.report(),
    note: "captureToResult starts at camera captureTime when available, otherwise video callback; excludes unreported sensor latency. Render submit is not display/photon latency." };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "dance-performance.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (state.running || challengeTimer)) {
    stopAll(); setStatus("页面已离开，本局已停止；返回后可重新开始");
  }
});
window.addEventListener("pagehide", () => stopAll());
