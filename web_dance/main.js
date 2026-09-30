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
import { loadAvatar, DEFAULT_MODEL, detectExt, realignRetargeter } from "./avatar.js";
import { createCoachGrounding } from "./coach-grounding.js";
import { recenterSequenceTravel } from "./root-travel.js";
import { ScoringAdapter } from "./scoring-adapter.js";
import { SongSession, AudioEngine } from "./audio.js";
import { SelectionPreviewAudio } from "./selection-preview-audio.js";
import { HighlightController } from "./highlights.js";
import { HighlightReplayController } from "./highlight-replay.js";
import { resultCopyFor } from "./result-copy.js";
import { BUILTIN_DANCES, loadDanceClips, retargetClipToSkeleton, captureRestPose } from "./dance-library.js";
import { loadSongIndex, dances, songs, danceById, songById, loadSequence } from "./song-library.js";
import {
  createSilhouetteRenderer, renderSilhouetteFrame, canvasToPng, pickSignatureTimes, cropToAlpha,
} from "./silhouette.js";
// 右下判定轨道的几何/时序常量与纯逻辑(可在 Node 单测:test/pose-lane.test.js)
import {
  LANE_FALLBACK_STEP_SEC,
  activePoseSource, beatDurFor, computePoseEvents,
  planPoseLaneFrame,
} from "./pose-lane.js";
// 判定轨道的 DOM 应用层 / 单张剪影构造 / 逐点白影资源(与谱面编辑器共用,保证所见即所得)
import { createLaneView } from "./lane-view.js";
import { buildLaneFigure } from "./lane-figure.js";
import { laneAssetFor, laneAssetUrl, loadLaneManifest } from "./lane-assets.js";

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
  sideMode: "model",         // model | video:右侧显示 3D 模型还是教学视频
  videoMap: {},              // danceId -> 视频文件名(来自 /api/videos-map)
  refVideoUrl: null,         // 当前 <video id=ref-video> 的 src,避免重复加载
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
  refPanel: $("ref-panel"),
  refVideo: $("ref-video"),
  moveTrack: $("move-track"),
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
  songPickOpen: $("song-pick-open"),
  songPickShade: $("song-pick-shade"),
  songPickDrawer: $("song-pick-drawer"),
  songPickClose: $("song-pick-close"),
  songPickPrev: $("song-pick-prev"),
  songPickNext: $("song-pick-next"),
  songPickCurrent: $("song-pick-current"),
  songPickStart: $("song-pick-start"),
  poseHint: $("pose-hint"),
  judgeStage: $("judge-stage"),
  judgeTrack: $("judge-track"),
  result: $("result"),
  resultGrade: $("result-grade"),
  resultTitle: $("result-title"),
  resultTagline: $("result-tagline"),
  resultSong: $("result-song"),
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

// 右侧画面模式:model(3D 模型/舞台) | video(3:4 参考视频)。由后台 /settings 写入 localStorage。
function isVideoSide() {
  return state.sideMode === "video";
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
  // 高光合成时把 pk 分屏里被推到右侧的 3D 教练重新居中。
  stageShift: () => scene.getSplitXOffset(),
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
// 结算后立即串播本地三个高光片段；完整原片继续在后台上传。
const replayOverlay = $("replay"), replayVideo = $("replay-video"), replayClose = $("replay-close");
const replayTitle = $("replay-title"), replayCount = $("replay-count");
const replayTier = $("replay-tier"), replayCombo = $("replay-combo");
let replayTimer = null;
function closeReplay() {
  clearTimeout(replayTimer);
  replayPlayer.stop();
  replayOverlay.classList.add("hidden");
  $("result").classList.remove("result-mini");
}
const replayPlayer = new HighlightReplayController({
  video: replayVideo,
  onSegmentChange: (segment, index, total) => {
    replayCount.textContent = `${index + 1} / ${total}`;
    replayTier.textContent = segment.fallback ? "精彩回放" : (segment.tier || "精彩动作");
    replayCombo.textContent = segment.combo > 1 ? `${segment.combo} COMBO` : "";
    replayCombo.hidden = segment.combo <= 1;
    replayOverlay.classList.remove("segment-pop");
    void replayOverlay.offsetWidth;
    replayOverlay.classList.add("segment-pop");
  },
  onComplete: closeReplay,
});
function scheduleReplay(expectedGeneration = startGeneration) {
  clearTimeout(replayTimer);
  replayTimer = setTimeout(() => {
    if (expectedGeneration !== startGeneration) return;
    const replay = highlights.getReplay();
    if (!replay) return;
    replayTitle.textContent = "你的舞台时刻";
    $("result").classList.add("result-mini");
    replayOverlay.classList.remove("hidden");
    void replayPlayer.start(replay.url, replay.segments);
  }, 500);
}
if (replayClose) replayClose.addEventListener("click", closeReplay);

// ---------------------------------------------------------------------------
// 游戏手感层(juice):冲击波 / 火花 / 闪光 / 震屏 / 暗角 / hit-stop
// ---------------------------------------------------------------------------
const juice = createJuice({ canvas: dom.fx, shakeTarget: dom.stage });
let lastTier = "";
let lastMilestone = 0;
let lastBeatIdx = -1;

// 把舞者胸口投影到屏幕坐标,作为命中特效的爆发点
function avatarScreen() {
  if (!state.avatar) {
    // 视频模式没有 3D 舞者:命中特效以左侧真人摄像头为中心爆发。
    if (isVideoSide()) return { x: window.innerWidth * 0.22, y: window.innerHeight * 0.5 };
    return { x: window.innerWidth / 2, y: window.innerHeight * 0.38 };
  }
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
    if (!isVideoSide()) {
      scene.update(dt);
      // 改了骨骼后必须手动刷新 Skeleton,否则蒙皮不更新
      state.skeletons?.forEach((s) => s.update());
      // 表演模式:FBX/GLB 内嵌动画
      if (state.mixer) state.mixer.update(dt);
    }
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
    if (!isVideoSide()) {
      // 兼容两种 scene 版本:合成器版走 scene.render(),老版直接渲染
      if (scene.render) scene.render();
      else scene.renderer.render(scene.scene, scene.camera);
    }
    highlights.draw(); // Copy WebGL immediately, before its drawing buffer can be cleared.
  } catch (e) {
    // 渲染异常绝不能再中断整页初始化(否则按钮都不会挂载)
    console.error("renderLoop error:", e);
  }
}

// ---------------------------------------------------------------------------
// 模型加载
// ---------------------------------------------------------------------------
async function loadModel(url, type) {
  setStatus("准备中…");
  dom.menuStatus.textContent = "";
  try {
    const avatar = await loadAvatar(url, type, readModelBrightness());
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
    } else if (state.mode === "performance") {
      // 表演模式的曲目列表要等舞者就绪才能建(打开页面时 setMode 早于模型加载,那次会 bail),
      // 不补这一步:从主页「表演」卡片进来时下拉是空的、点「开始」没反应。
      enterPerformance();
    }
  } catch (e) {
    console.error(e);
    dom.menuStatus.textContent = "加载失败: " + e.message;
    setStatus("模型加载失败");
  }
}

// ---------------------------------------------------------------------------
// 视频参考模式(右侧 3:4 MP4 替换 3D 教练/舞台)
// ---------------------------------------------------------------------------
function videoUrlFor(danceId) {
  const name = state.videoMap[danceId];
  return name ? `/videos/${encodeURIComponent(name)}` : null;
}

// 设置 ref-video 的 src;只在地址变化时重载,避免反复打断播放。
function setRefVideo(url) {
  if (!url) {
    if (state.refVideoUrl) {
      dom.refVideo.removeAttribute("src");
      dom.refVideo.load();
      state.refVideoUrl = null;
    }
    return;
  }
  const abs = new URL(url, location.href).href;
  if (state.refVideoUrl !== abs) {
    dom.refVideo.src = abs;
    state.refVideoUrl = abs;
  }
}

function playRefVideo({ restart = false } = {}) {
  if (!state.refVideoUrl) return;
  dom.refVideo.muted = true;
  dom.refVideo.loop = true;
  if (restart) dom.refVideo.currentTime = 0;
  dom.refVideo.play().catch(() => {});
}

function stopRefVideo() {
  dom.refVideo.pause();
  if (state.refVideoUrl) dom.refVideo.currentTime = 0;
}

async function loadVideoMap() {
  try {
    const r = await fetch("/api/videos-map");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    state.videoMap = data.mapping || {};
  } catch (e) {
    state.videoMap = {};
    console.warn("视频绑定加载失败:", e);
  }
}

async function enterVideoMode() {
  setStatus("准备视频参考…");
  dom.menuStatus.textContent = "";
  try {
    await loadVideoMap();
    document.body.classList.add("video-side");
    dom.refVideo.classList.remove("hidden");
    // 视频模式不渲染 3D 舞台;高光录制时把「3D 教练」换成参考视频。
    highlights.stage = dom.refVideo;
    highlights.stageShift = () => 0;
    dom.menu.classList.add("hidden");
    dom.hud.classList.remove("hidden");
    dom.btnStart.disabled = false;
    setStatus("视频参考已就绪");
    if (state.mode === "pk" || state.mode === "challenge") {
      enterSelect().catch((e) => setStatus("选曲加载失败:" + e.message));
    }
  } catch (e) {
    console.error(e);
    dom.menuStatus.textContent = "视频加载失败: " + e.message;
    setStatus("视频加载失败");
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
  if (mode !== "pk") stopPreviewMusic(); // 离开选曲页就别再试听
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
    const coach = await loadAvatar(state.modelSource.url, state.modelSource.type, readModelBrightness());
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
  // 走位去漂移(见 root-travel.js):源录像里的缓慢漂移会把人带出舞台;
  // 编舞真的左右移动(快的那部分)原样保留。
  const travel = recenterSequenceTravel(seq, { tauSec: 2.5, limit: 2.2 });
  if (travel) {
    console.info(
      `[coach] 走位去漂移后:水平最大 ${travel.maxTravel.toFixed(2)} 单位` +
      (travel.clampedFrames ? `,限幅 ${travel.clampedFrames} 帧` : ""),
    );
  }
  const frames = seq.frames || [];
  const keepShoesAboveStage = createCoachGrounding(retargeter.root);
  // 有 rootPos 的序列(新导出的内置曲)就消费根运动:教练跟参考一样走位(编舞一般自己回到中间);
  // 旧序列没有这个字段 → applyFrame 内部自动回退到原来的「固定站位 + 脚贴地运动学」。
  const hasRootPos = frames.some((f) => Array.isArray(f.rootPos));
  return {
    update(t) {
      // 插值采样(而非 round(t*fps) 硬切),消除低帧率接缝抖动
      const frame = sampleFrame(frames, t);
      if (frame) {
        retargeter.applyFrame(frame, { boneDefs, mirror: false, rootMotion: hasRootPos });
        keepShoesAboveStage();
      }
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

// 选曲卡剪影:优先用「判定轨道白影」(assets/lane/,模型离屏渲染的 3D 白影)——
// 每支舞都已经逐判定点生成好了,和右下角判定轨道用的是同一批图,天然「所见即所得」。
// 从中挑关节铺得最开的一帧当招牌动作(与 tools/gen-silhouettes.mjs 的挑法同一个思路)。
function laneCardSilhouette(danceId) {
  const notes = laneManifest?.dances?.[danceId]?.notes;
  if (!Array.isArray(notes) || !notes.length) return null;
  let best = null, bestSpread = -1;
  for (const n of notes) {
    const pts = Object.values(n.joints || {});
    let m = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d > m) m = d;
      }
    }
    if (m > bestSpread) { bestSpread = m; best = n; }
  }
  return best ? laneAssetUrl(best) : null;
}

// 白影是「固定取景、不裁剪」渲染的,单张里人物只占中间一条;
// 直接贴到卡片上会显得又细又小 —— 先按 alpha 裁到人物再显示。
async function setCroppedSilhouette(img, url) {
  try {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    img.src = canvasToPng(cropToAlpha(c, { padFrac: 0.08 }));
  } catch {
    img.src = url; // 裁剪失败就原样用原图
  }
}

// 循环播放序列(吸引态 / 试跳),教练原地跟跳不消费根运动
function makeLoopCoachPlayer(seq, retargeter, boneDefs) {
  const frames = seq.frames || [];
  const dur = seq.meta?.durationSec || 1;
  const keepShoesAboveStage = createCoachGrounding(retargeter.root);
  return {
    update(t) {
      const tt = t % dur;
      const frame = sampleFrame(frames, tt);
      if (frame) {
        retargeter.applyFrame(frame, { boneDefs, mirror: false, rootMotion: false });
        keepShoesAboveStage();
      }
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
//   几何/时序纯逻辑 → ./pose-lane.js
//   DOM 应用层      → ./lane-view.js(与谱面编辑器共用,保证"编辑器里看到的卡片 = 玩家看到的")
//   剪影资源        → ./lane-assets.js(tools/lane-silhouettes.mjs 逐判定点预渲染的 3D 白影 PNG)
// ---------------------------------------------------------------------------
const poseHintCache = new WeakMap(); // seq -> 动作事件数组
// 排查性能用:?nohint=1 可整体关掉右下角判定轨道,便于对比帧率
const poseHintDisabled = new URLSearchParams(location.search).get("nohint") === "1";
// 碰撞代理半径模式:默认按蒙皮网格实测(衣服厚度);加 ?collisionradii=old 回到旧的按骨长估算,便于 A/B 对比。
const COLLISION_RADII_MODE = new URLSearchParams(location.search).get("collisionradii") === "old" ? "formula" : "mesh";
// 逐点白影清单(缺失/404 都不报错,自动退回 2D 剪影,不影响可玩性)
let laneManifest = null;
let laneManifestPromise = null;
function ensureLaneManifest() {
  if (!laneManifestPromise) {
    laneManifestPromise = loadLaneManifest().then((m) => { laneManifest = m; return m; }).catch(() => null);
  }
  return laneManifestPromise;
}

const laneView = createLaneView({
  root: dom.poseHint, track: dom.judgeTrack, stage: dom.judgeStage,
  // 进度条与文字标签都不挂载了(见 lane.css):lane-view 的 fill/name 是可选槽位
  buildFigure: (args) => buildLaneFigure(args),
});

// 渲染循环必须等上面判定轨道的常量/变量都初始化后才能启动(否则 updatePoseLane 会命中 TDZ)。
renderLoop();

function poseEventsFor(seq) {
  if (!seq) return [];
  if (poseHintCache.has(seq)) return poseHintCache.get(seq);
  const events = computePoseEvents(seq);
  poseHintCache.set(seq, events);
  return events;
}

// 造一张剪影(2D 兜底 / 3D 白影)的逻辑已抽到 ./lane-figure.js,游戏页与编辑器共用。

function updatePoseLane() {
  if (!dom.poseHint) return;
  const src = activePoseSource(state);
  // 视频模式也有时钟:挑战开始后 session.songTime 照常走、参考视频与 GO 同步开播,
  // 所以轨道在视频模式同样可用,不再隐藏。
  const plan = planPoseLaneFrame({
    events: src ? poseEventsFor(src.seq) : [],
    t: src?.t ?? 0,
    trackW: dom.judgeTrack?.clientWidth || 0,
    beatDur: src ? beatDurFor(src.seq) : LANE_FALLBACK_STEP_SEC,
    trackedKeys: laneView.trackedKeys(),
    arrivedKeys: laneView.arrivedKeys(),
    disabled: poseHintDisabled,
    hasTrack: !!dom.judgeTrack,
    hasSource: !!src,
  });
  const seq = src?.seq ?? null;
  laneView.update(plan, {
    seq,
    dpr: globalThis.devicePixelRatio || 1,
    entryFor: seq ? (ev) => laneAssetFor(laneManifest, seq.danceId, ev.t) : null,
  });
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

// 抽屉轮播:选中卡居中,相邻卡带透视层级向两侧展开。
function layoutCards() {
  const n = state.select.entries.length;
  state.select.entries.forEach((e, k) => {
    if (!e.el) return;
    let off = k - state.select.selected;
    if (n > 1) {
      if (off > n / 2) off -= n;
      if (off < -n / 2) off += n;
    }
    const distance = Math.abs(off);
    const x = off * 132;
    const y = distance * 10;
    const scale = Math.max(0.72, 1 - distance * 0.16);
    const rotate = off * -13;
    e.el.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotateY(${rotate}deg) scale(${scale})`;
    e.el.style.zIndex = String(n + 2 - distance);
    e.el.style.opacity = distance > 2 ? "0" : String(Math.max(0.34, 1 - distance * 0.28));
    e.el.style.pointerEvents = distance > 2 ? "none" : "auto";
  });
}

async function seqFor(entry) {
  return loadSequence(entry.dance.danceId);
}

async function enterSelect() {
  stopPreviewMusic();
  state.phase = "select";
  state.mode = "pk";
  clearTimeout(state.select.revertTimer);
  clearInterval(cardAnimTimer);
  state.select.player = null;
  laneView.reset();
  document.body.classList.add("pk-mode");
  scene.setSplitLayout(true);
  // 选曲态只留:摄像头 + 教练/视频 + 选曲入口;其余 HUD 收起
  dom.result.classList.add("hidden");
  dom.scorePanel.classList.add("hidden");
  dom.controls.classList.add("hidden");
  dom.dancePicker.classList.add("hidden");
  dom.songPicker.classList.add("hidden");
  dom.btnLoadRef.classList.add("hidden");
  dom.animPicker.classList.add("hidden");
  dom.centerMsg.classList.add("hidden");

  if (isVideoSide()) {
    // 视频模式:右侧不放 3D 教练/舞台,改为参考视频(选曲态即预览)。
    document.body.classList.add("video-side");
    dom.refVideo.classList.remove("hidden");
  } else {
    const coach = await ensureCoach();
    if (!coach) { setStatus("教练加载失败"); return; }
    coach.object.visible = true;
    coach.retargeter.reset();
    layoutForMode(); // pk 布局:隐藏玩家 3D,显示教练
  }

  // 两个列表按「作品出身模式」分:
  //   视频模式(右侧放参考视频) → 只留绑了视频的舞曲;
  //   3D 模式(右侧放 3D 教练)   → 剔除「视频作品」(mode==='video'),它们本来就该在视频模式下跳。
  // 兜底:视频作品要是把视频解绑了,就退回 3D 列表,免得两个列表都看不到、彻底消失。
  // 选曲列表按「作品出身模式」分:
  //   视频模式(右侧放参考视频) → 只留绑了视频的舞曲;
  //   3D 模式(右侧放 3D 教练)   → 剔除视频作品(mode==='video'),它们该在视频模式下跳。
  // 兜底:视频作品要是把视频解绑了,就退回 3D 列表,免得两个列表都看不到、彻底消失。
  const list = isVideoSide()
    ? dances().filter((d) => videoUrlFor(d.id))
    : dances().filter((d) => d.mode !== "video" || !videoUrlFor(d.id));
  if (isVideoSide() && !list.length) {
    setStatus("没有已绑定视频的舞曲（请在后台「右侧画面」为舞曲绑定视频）");
  }
  const entries = list.map((dance) => {
    const song = songById(dance.defaultSongId) || songs()[0];
    return { dance, song, skin: SELECT_SKIN[dance.id] || SELECT_SKIN.demo, seq: null, el: null };
  });
  await Promise.all(entries.map(async (e) => { e.seq = await seqFor(e); }));
  // 选曲卡的剪影来自判定轨道白影清单,先确保它到手(通常早就加载完了)
  await ensureLaneManifest();

  state.select.entries = entries;
  state.select.selected = 0;
  buildSelectCards();
  dom.songPick.classList.remove("hidden");
  setSongPickerOpen(false);
  startAttract(0);
  await startCamera();
  setStatus("选一支舞");
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
      <img class="sc-sil" alt="" draggable="false">
      <div class="sc-heat">${heat}</div>
      <div class="sc-info">
        <div class="sc-title">${e.dance.label}</div>
        <div class="sc-meta">♪ ${e.song.label}</div>
      </div>`;
    // 剪影优先级:判定轨道白影(模型渲染) → 老的预生成 PNG → 页面内实时渲染 → demo 兜底。
    // 注意别再把 demo.png 当默认值:它总能加载成功,error 回调永远不触发,
    // 新舞曲会一直顶着同一张通用剪影(这正是之前 pose 卡不走模型通道的原因)。
    const silImg = card.querySelector(".sc-sil");
    const fallbackSil = () => { silImg.src = inPageSilhouette(e) || SILHOUETTES.demo; };
    silImg.addEventListener("error", fallbackSil, { once: true });
    const laneUrl = laneCardSilhouette(e.dance.danceId);
    if (laneUrl) setCroppedSilhouette(silImg, laneUrl);
    else if (SILHOUETTES[e.dance.id]) silImg.src = SILHOUETTES[e.dance.id];
    else fallbackSil();
    card.addEventListener("click", () => {
      selectCard(i);
      preview(i);
    });
    dom.songPickStrip.appendChild(card);
    e.el = card;
  });
  selectCard(0);
}

function selectCard(i) {
  const n = state.select.entries.length;
  if (!n) return;
  i = ((i % n) + n) % n;
  state.select.selected = i;
  state.select.entries.forEach((e, k) => e.el.classList.toggle("selected", k === i));
  const e = state.select.entries[i];
  if (dom.songPickCurrent && e) {
    dom.songPickCurrent.textContent = `${e.dance.label} · ${e.song.label}`;
  }
  layoutCards();
}

function setSongPickerOpen(open) {
  if (!dom.songPick) return;
  const shouldOpen = Boolean(open);
  const wasOpen = dom.songPick.classList.contains("picker-open");
  dom.songPick.classList.toggle("picker-open", shouldOpen);
  dom.songPickOpen?.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
  if (wasOpen && !shouldOpen) stopSelectionPreview();
}

/** 关闭抽屉就是退出预览:音乐、3D 试跳和视频试看同步停止。 */
function stopSelectionPreview() {
  stopPreviewMusic();
  clearTimeout(state.select.revertTimer);
  clearInterval(cardAnimTimer);
  state.select.player = null;
  if (state.coach) state.coach.retargeter.reset();
  if (isVideoSide()) stopRefVideo();
}

function stepSongPicker(delta) {
  if (!state.select.entries.length) return;
  const next = state.select.selected + delta;
  selectCard(next);
  preview(state.select.selected);
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (dom.songPick?.classList.contains("picker-open")) setSongPickerOpen(false);
});

dom.songPickOpen?.addEventListener("click", () => {
  setSongPickerOpen(true);
  preview(state.select.selected);
});
dom.songPickClose?.addEventListener("click", () => setSongPickerOpen(false));
dom.songPickShade?.addEventListener("click", () => setSongPickerOpen(false));
function pulseSongArrow(button) {
  if (!button) return;
  button.classList.remove("switching");
  void button.offsetWidth;
  button.classList.add("switching");
  setTimeout(() => button.classList.remove("switching"), 360);
}
dom.songPickPrev?.addEventListener("click", () => {
  pulseSongArrow(dom.songPickPrev);
  stepSongPicker(-1);
});
dom.songPickNext?.addEventListener("click", () => {
  pulseSongArrow(dom.songPickNext);
  stepSongPicker(1);
});
dom.songPickStart?.addEventListener("click", () => startSong(state.select.selected));

let songWheelLocked = false;
dom.songPickDrawer?.addEventListener("wheel", (event) => {
  if (Math.abs(event.deltaY) < 8 || songWheelLocked) return;
  event.preventDefault();
  songWheelLocked = true;
  stepSongPicker(event.deltaY > 0 ? 1 : -1);
  setTimeout(() => { songWheelLocked = false; }, 180);
}, { passive: false });

function preview(i) {
  const e = state.select.entries[i];
  if (!e?.seq) return;
  playSelectionPreview(e);
  if (isVideoSide()) {
    setRefVideo(videoUrlFor(e.dance.id));
    playRefVideo({ restart: true });
  } else {
    const coach = state.coach;
    if (!coach) return;
    state.select.clock = 0;
    state.select.player = makeLoopCoachPlayer(e.seq, coach.retargeter, resolveMode(state.danceType).bones);
    animateCardPose(i);
  }
  clearTimeout(state.select.revertTimer);
  state.select.revertTimer = setTimeout(() => startAttract(state.select.selected), 5000);
}

function startAttract(i) {
  const e = state.select.entries[i];
  clearInterval(cardAnimTimer);
  if (!e?.seq) return;
  if (isVideoSide()) {
    setRefVideo(videoUrlFor(e.dance.id));
    playRefVideo();
    return;
  }
  const coach = state.coach;
  if (!coach) return;
  state.select.clock = 0;
  state.select.player = makeLoopCoachPlayer(e.seq, coach.retargeter, resolveMode(state.danceType).bones);
  if (e._canvas) drawCardSilhouette(e._canvas, e.seq);
}

function startSong(i) {
  const e = state.select.entries[i];
  if (!e) return;
  state.phase = "playing";
  state.select.player = null;
  stopPreviewMusic(); // 试听停掉,音乐交给挑战会话(放的是同一首)
  laneView.reset();
  clearTimeout(state.select.revertTimer);
  clearInterval(cardAnimTimer);
  dom.songPick.classList.add("hidden");
  setSongPickerOpen(false);
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

// 表演模式音乐(与挑战 SongSession 分离,复用 AudioEngine):每支舞放**自己的**曲子。
// 曲子按 danceId 从歌单找(songs/index.json 里 dance.defaultSongId 对应的音频),
// 歌单里没有的(比如模型内嵌动画)才退回原来的循环伴奏。
// 节奏对齐:动作比曲子短(salsa 2.25s / 曲子 24s)→ 动作与曲子都循环(原有手感);
// 动作和曲子差不多长(copydance1 28.7s / 曲子 30s)→ 各放一遍,曲子放完自动收尾,
// 否则每循环一次动作和音乐就错开一点。
const PERFORMANCE_FALLBACK_AUDIO = "../songs/hiphop/pop-demo.wav";
// 动作长度 ≥ 曲子长度 × 这个比例 → 认为「动作和曲子是同一支舞」,只放一遍;
// 明显更短(salsa 2.25s / 曲子 24s = 0.09)才循环补齐。
const PERFORMANCE_LOOP_RATIO = 0.8;
let performanceAudio = null;
let performanceAudioUrl = null;

/** 这支舞自己的音乐 URL;歌单里查不到就返回 null。 */
function performanceMusicUrl(dance) {
  const d = danceById(dance?.id) || dances().find((x) => x.danceId === dance?.id);
  const song = d ? (songById(d.defaultSongId) || songs()[0]) : null;
  return d && song?.file ? `../songs/${d.danceId}/${song.file}` : null;
}

async function ensurePerformanceAudio(url = PERFORMANCE_FALLBACK_AUDIO) {
  // 只建一个引擎/一个 AudioContext(浏览器对 AudioContext 数量有上限),切舞时只换音频。
  if (!performanceAudio) {
    const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    performanceAudio = new AudioEngine({ audioContext: AudioCtor ? new AudioCtor() : null });
  }
  if (performanceAudioUrl !== url) {
    performanceAudio.stop();
    await performanceAudio.load(url); // 换曲:重新解码,时长随之更新
    performanceAudioUrl = url;
  }
  return performanceAudio;
}

/** 动作长度 ≈ 曲子长度 → 只放一遍(放完 stopMixer);明显更短 → 两边都循环。 */
function applyPerformanceLoop(engine, action, clipDurationSec) {
  const musicDur = engine.durationSec || 0;
  const once = musicDur > 0 && clipDurationSec >= musicDur * PERFORMANCE_LOOP_RATIO;
  engine.loop = !once;
  engine.onEnded = once ? () => stopMixer() : null;
  if (action) action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  return once;
}

function startPerformanceMusic(opt, action, clipDurationSec, token) {
  const url = (opt?.kind === "builtin" ? performanceMusicUrl(opt.dance) : null) || PERFORMANCE_FALLBACK_AUDIO;
  ensurePerformanceAudio(url)
    .then((engine) => {
      if (token !== mixerSeq || state.mode !== "performance") return; // 已切歌/已停止
      applyPerformanceLoop(engine, action, clipDurationSec);
      return engine.play();
    })
    .catch((e) => console.warn("表演音频播放失败:", e));
}

function stopPerformanceMusic() {
  if (!performanceAudio) return;
  performanceAudio.onEnded = null;
  performanceAudio.stop(); // 保留引擎/AudioContext,只停播放
}

// ---------------------------------------------------------------------------
// PK 选曲页试听:独立于表演模式和正式挑战的 AudioEngine。
// 点卡片/切换卡片会同时从头试听音乐、试看动作;开始挑战或离开选曲页立即停止。
// ---------------------------------------------------------------------------
const selectionPreviewAudio = new SelectionPreviewAudio({ AudioEngine, debounceMs: 180 });

function playSelectionPreview(entry) {
  if (!entry || state.phase !== "select") return;
  const url = performanceMusicUrl(entry.dance) || PERFORMANCE_FALLBACK_AUDIO;
  selectionPreviewAudio.request(url, {
    onPlaying: () => {
      if (state.phase === "select") dom.songPick.classList.add("previewing");
    },
  });
}

function stopPreviewMusic() {
  selectionPreviewAudio.stop();
  dom.songPick?.classList.remove("previewing");
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
      // 用这支舞自己的源骨架当重定向基准,比通用参考更贴合(实测方向误差 4.6°→2.1°、腿 11°→1.5°)。
      // 重定向基准变了 → Retargeter 与休息姿态缓存都要重建;只在同系骨架(有 Hips)时做。
      if (/(?:^|\/)dancer_girl\.fbx(?:[?#]|$)/i.test(state.modelSource?.url || "")) {
        realignRetargeter(state.avatar, root);
        captureRestPose(state.avatar.object);
      }
      // 同系(Mixamo 命名)源 + dancer_girl 时,手臂直接用源局部旋转,不要用「另一个休息姿态」去修正
      // —— 否则肘部会过度折叠、手插进躯干。实测(手进躯干帧数,开/不开):
      //   hiphop 9→0、salsa 13→0(本来就是开着的)、copydance1 79→25。三支舞都只变好,故按模型开而不按舞曲挑。
      const preserveArmRotations =
        /(?:^|\/)dancer_girl\.fbx(?:[?#]|$)/i.test(state.modelSource?.url || "");
      clip = retargetClipToSkeleton(clips[0], root, state.avatar.object, { preserveArmRotations, radiiMode: COLLISION_RADII_MODE });
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
  action.setLoop(THREE.LoopRepeat, Infinity); // 先按循环起跳;音乐加载完由 applyPerformanceLoop 决定放一遍还是循环
  action.play();
  state.running = true;
  dom.btnStart.disabled = true;
  dom.btnStop.disabled = false;
  // 调试钩子(?debughook=1):让自动化测试能精确 seek 到某一帧并冻结,做同帧 A/B 截图。
  if (new URLSearchParams(location.search).get("debughook") === "1") {
    window.__dance = {
      mixer: state.mixer,
      avatar: state.avatar,
      seek(t) { state.mixer.setTime(Math.max(0, t)); },
      freeze() { state.mixer.timeScale = 0; },
      resume() { state.mixer.timeScale = 1; },
    };
  }
  const musicUrl = opt.kind === "builtin" ? performanceMusicUrl(opt.dance) : null;
  setStatus(`播放舞蹈: ${opt.label || clip.name}` + (musicUrl ? ` · ♪ ${musicUrl.split("/").pop()}` : ""));
  startPerformanceMusic(opt, action, clip.duration, seq);
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

  if (isVideoSide()) {
    // 视频模式:备好当前舞曲绑定的参考视频,GO 时同步开播(循环)。
    setRefVideo(videoUrlFor(state.challengeDanceId));
    if (state.refVideoUrl) dom.refVideo.pause();
  } else {
    // 3D 教练(同模型第二实例)跳参考舞,玩家跟着跳
    const coach = await ensureCoach();
    if (generation !== startGeneration) return;
    if (coach) {
      coach.object.visible = true;
      coach.retargeter.reset();
      state.coachPlayer = makeCoachPlayer(ch.seq, coach.retargeter, resolveMode(state.danceType).bones);
    }
    layoutForMode();
  }
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
  if (isVideoSide()) playRefVideo({ restart: true });
  highlights.start();
  ch.running = true;
  challengeTimer = setInterval(() => {
    if (!ch.running) return;
    const t = session.songTime;
    // Give the one in-flight frame time to arrive; frame timestamps remain capture-based.
    const lag = Math.min(.25, (lastPerf?.stages?.captureToResult?.p95Ms ?? 80) / 1000);
    for (const result of ch.scorer.advance(Math.max(0, t - lag))) {
      if (!result.ongoing) {
        highlights.markJudge({
          time: t,
          tier: result.tier,
          accuracy: result.acc,
          combo: result.combo,
          scoreGain: result.score,
          confidence: state.latestConf,
          noteId: result.noteId,
        });
        lastTier = ""; judgeFeedback(result.tier, result.combo, result.score);
      }
    }
    updateScoreHUD({ acc: ch.previewAcc ?? 0 });
    updateChallengeProgress(t, ch); beatPulse(t, ch);
    session.update();
  }, 25);
}

function readCameraParams() {
  try { return JSON.parse(localStorage.getItem("dance-camera-params") || "null"); } catch { return null; }
}

function readModelBrightness() {
  const v = parseFloat(localStorage.getItem("dance-model-brightness"));
  return Number.isFinite(v) ? Math.max(0.2, Math.min(3, v)) : 1;
}

function startCamera() {
  if (state.stream) { state.running = true; return Promise.resolve(); }
  const boneDefs = resolveMode(state.danceType).bones;
  setStatus("加载 MediaPipe 模型…");
  return startPoseStream({
    video: dom.cam,
    canvas: dom.camStick,
    mode: state.danceType,
    // 后台 /staff 选择的摄像头;为空则用默认前置
    deviceId: localStorage.getItem("dance-camera-device-id") || null,
    // /settings 保存的 USB 相机参数(exposure/白平衡/对焦等)
    cameraParams: readCameraParams(),
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
  stopPreviewMusic();
  highlights.abort();
  stopRefVideo();
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
  dom.btnStart.disabled = !(state.avatar || isVideoSide());
  dom.btnStop.disabled = true;
  dom.comboBadge.classList.add("hidden");
  setStatus("已停止");
}

dom.btnStart.addEventListener("click", async () => {
  if (!state.avatar && !isVideoSide()) return;
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
}

// ---------------------------------------------------------------------------
// 结算页只保留评级与成绩；特殊成绩仍用于控制庆祝动效强度。
// ---------------------------------------------------------------------------
// 结算主色:整个结算界面的霓虹光源都用这一个变量驱动,保证配色统一
const GRADE_COLORS = { S: "#ffd54a", A: "#39ffcf", B: "#4d7cff", C: "#c88bff", D: "#ff8a8a" };

function isSpecialResult(r) {
  const t = r.tallies || {};
  const total = (t.perfect ?? 0) + (t.great ?? 0) + (t.good ?? 0) + (t.miss ?? 0) || 1;
  const perfect = t.perfect ?? 0;
  const fullCombo = r.maxCombo >= total && total > 0;
  const allPerfect = total > 0 && perfect === total;

  return allPerfect || (fullCombo && (r.grade === "S" || r.grade === "A"));
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
  const special = isSpecialResult(r);
  const copy = resultCopyFor(r.grade);
  const gradeColor = GRADE_COLORS[r.grade] || "#ffd54a";
  dom.result.style.setProperty("--grade", gradeColor);
  dom.resultGrade.textContent = r.grade;
  dom.resultTitle.textContent = copy.title;
  dom.resultTagline.textContent = copy.tagline;
  dom.resultSong.textContent = `${challengeDance().label} · ${challengeSong().label}`;

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

  celebrate(r.grade, special);
}

async function finishChallenge() {
  const ch = state.challenge;
  if (!ch || !ch.running) return;
  ch.running = false;
  const r = ch.scorer.finalize();
  showResult(r);
  const replayReady = highlights.finish(r);
  stopAll({ keepCamera: true });
  const replayGeneration = startGeneration;
  await replayReady;
  scheduleReplay(replayGeneration);
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
    else if (state.avatar || isVideoSide()) dom.btnStart.click();
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
async function applyLaunchParams() {
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
  // 后台 /settings 选择的「右侧画面」模式;仅在跟跳(pk/challenge)下生效,free/performance 仍用 3D。
  state.sideMode = localStorage.getItem("dance-side-mode") === "video" ? "video" : "model";
  if (isVideoSide() && (state.mode === "pk" || state.mode === "challenge")) {
    await enterVideoMode();
  } else {
    state.sideMode = "model";
    // 后台 /settings 选择的模型;未选择则用默认 dancer_girl.fbx
    loadModel(localStorage.getItem("dance-model") || DEFAULT_MODEL);
  }
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
  ensureLaneManifest(); // 逐点 3D 白影清单:缺失/404 会自动退回 2D 剪影
  // 视频绑定表两种模式都要用:3D 模式下也要靠它判断「这支舞是不是视频作品」,
  // 否则 videoUrlFor() 恒为 null,选曲过滤会失效(曾经只有进视频模式才加载)。
  await loadVideoMap();
  await applyLaunchParams();
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
