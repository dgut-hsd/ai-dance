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
import { renderPoseSilhouette } from "../pose_capture/stick-figure.js";
import { createScene } from "./scene.js";
import { createJuice } from "./ui-lab/juice.js";
import { loadAvatar, DEFAULT_MODEL, detectExt } from "./avatar.js";
import { SimpleScorer } from "./simple-score.js";
import { buildDemoSequence } from "./demo-sequence.js";
import { SongSession, AudioEngine } from "./audio.js";
import { BUILTIN_DANCES, loadDanceClips, retargetClipToSkeleton, captureRestPose } from "./dance-library.js";
import { SONGS, CHALLENGE_DANCES, loadFbxSequence } from "./challenge-library.js";

// 动作预期(Just Dance 式右侧滚动列):把谱面音符当作"动作时刻",按时间差换算成纵向位移。
const MOVE_NOW_LINE_Y = 10;          // "现在"判定线距滚动区顶部的像素
const MOVE_FALLBACK_INTERVAL = 2.0;  // 无谱面时,按此固定间隔生成动作时刻
const MOVE_HORIZON = 3;              // 最多展示接下来 N 个动作
const MOVE_EXIT_SEC = 0.45;          // 卡片滑过判定线后的淡出时长
const MOVE_ENTER_SEC = 0.30;         // 新卡片淡入时长

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
  challengeDanceId: "demo",
  challengeSongId: "demo-beat",
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
  moveTrack: $("move-track"),
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

function judgeFeedback(tier, combo) {
  const p = avatarScreen();
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
    scene.update(dt);
    // 改了骨骼后必须手动刷新 Skeleton,否则蒙皮不更新
    state.skeletons?.forEach((s) => s.update());
    // 表演模式:FBX/GLB 内嵌动画
    if (state.mixer) state.mixer.update(dt);
    // 跟跳挑战:教练按歌曲时钟跳参考舞
    if (state.mode === "challenge" && state.challenge?.running && state.coachPlayer) {
      const t = state.challenge.session?.songTime ?? 0;
      state.coachPlayer.update(t);
    }
    // 兼容两种 scene 版本:合成器版走 scene.render(),老版直接渲染
    if (scene.render) scene.render();
    else scene.renderer.render(scene.scene, scene.camera);
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
  setStatus("正在加载舞者…");
  dom.menuStatus.textContent = "正在加载 3D 模型…";
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
  // 旧本地模型 URL 不再需要(教练要复用当前 URL,所以只在新模型加载时回收旧的)
  if (state.modelSource?.url?.startsWith("blob:")) URL.revokeObjectURL(state.modelSource.url);
  loadModel(url, ext);
});

// ---------------------------------------------------------------------------
// 挑战舞曲选择(舞蹈 + 歌曲;配对表来自 challenge-library.js,与选歌主页共用)
// ---------------------------------------------------------------------------
function challengeDance() {
  return CHALLENGE_DANCES.find((d) => d.id === state.challengeDanceId) || CHALLENGE_DANCES[0];
}
function challengeSong() {
  return SONGS.find((s) => s.id === state.challengeSongId) || SONGS[0];
}

// 把歌曲的音频 + BPM 覆盖到序列上(用于内置 demo 序列换歌)
function applySongToSequence(seq, song) {
  seq.chart = { ...seq.chart, audio: song.url };
  const bpm = song.bpm;
  seq.meta.timing = { version: "timing/v1", bpm, offsetSec: 0, tempoMap: [{ t: 0, bpm }] };
  const beat = 60 / bpm;
  const beats = [];
  for (let t = 0; t <= seq.meta.durationSec; t += beat) beats.push(+t.toFixed(3));
  seq.meta.beatTimesSec = beats;
  return seq;
}

async function rebuildChallenge() {
  const dance = challengeDance();
  const song = challengeSong();
  if (state.running) stopAll();
  let seq;
  if (dance.kind === "fbx") {
    setStatus("正在生成舞曲:" + dance.label + "…");
    seq = await loadFbxSequence(dance.fbx, song);
  } else {
    seq = applySongToSequence(buildDemoSequence(), song);
  }
  state.challenge = { seq, scorer: new SimpleScorer(seq), running: false };
  state.coachPlayer = null;
  setStatus(`已选:${dance.label} / ${song.label}`);
}

function setupChallengePickers() {
  for (const d of CHALLENGE_DANCES) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.label;
    dom.danceSelect.appendChild(o);
  }
  for (const s of SONGS) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.label;
    dom.songSelect.appendChild(o);
  }
  dom.danceSelect.value = state.challengeDanceId;
  dom.songSelect.value = state.challengeSongId;

  dom.danceSelect.addEventListener("change", () => {
    state.challengeDanceId = dom.danceSelect.value;
    const dance = challengeDance();
    state.challengeSongId = dance.defaultSongId;
    dom.songSelect.value = dance.defaultSongId;
    rebuildChallenge().catch((e) => setStatus("舞曲加载失败:" + e.message));
  });
  dom.songSelect.addEventListener("change", () => {
    state.challengeSongId = dom.songSelect.value;
    rebuildChallenge().catch((e) => setStatus("舞曲加载失败:" + e.message));
  });
}
setupChallengePickers();

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------
function setMode(mode) {
  if (state.running) stopAll();
  state.mode = mode;
  modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const isChallenge = mode === "challenge";
  const isPerformance = mode === "performance";
  dom.scorePanel.classList.toggle("hidden", !isChallenge);
  dom.refPanel.classList.toggle("hidden", !isChallenge);
  dom.btnLoadRef.classList.toggle("hidden", !isChallenge);
  dom.dancePicker.classList.toggle("hidden", !isChallenge);
  dom.songPicker.classList.toggle("hidden", !isChallenge);
  dom.animPicker.classList.toggle("hidden", !isPerformance);
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
    state.avatar.object.position.x = 1.1;
    if (state.coach) {
      state.coach.object.visible = true;
      state.coach.object.position.x = -1.1;
    }
    scene.camera.position.set(0, 1.9, 6.6);
    scene.controls.target.set(0, 0.95, 0);
    scene.controls.update();
  } else {
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
  const fps = seq.meta?.fps || 30;
  const frames = seq.frames || [];
  return {
    update(t) {
      const i = Math.min(frames.length - 1, Math.max(0, Math.round(t * fps)));
      const frame = frames[i];
      // 教练固定站位跟跳,不消费根运动(否则会跟着参考序列的位移满场跑)
      if (frame) retargeter.applyFrame(frame, { boneDefs, mirror: false, rootMotion: false });
    },
  };
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
  await engine.load("audio/pop-demo.wav");
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
    state.challenge = { seq, scorer: new SimpleScorer(seq), running: false };
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
    onJudge: (r) => handleNoteJudge(ch, r),
    onSongEnd: () => finishChallenge(),
  });
  return ch.session;
}

// 音符判定反馈:独立于连续评分 judgeFeedback,避免 lastTier 去重互扰
function handleNoteJudge(ch, r) {
  if (r.ongoing) return;
  if (r.tier !== "MISS") ch.noteBonus = (ch.noteBonus || 0) + r.score;
  const p = avatarScreen();
  if (r.tier === "PERFECT") {
    showJudge("PERFECT", "#39ffcf");
    juice.ring(p.x, p.y, { size: 130, color: "57,255,207", width: 3.5, duration: 300 });
    juice.sparks(p.x, p.y, { count: 14, rays: 8, speed: 300 });
  } else if (r.tier === "GREAT") {
    showJudge("GREAT", "#4d7cff");
    juice.ring(p.x, p.y, { size: 100, color: "77,124,255", width: 3, duration: 260 });
    juice.sparks(p.x, p.y, { count: 8, rays: 5, speed: 220 });
  } else {
    showJudge("MISS", "#ff5f6d");
    juice.vignette(0.16);
    juice.shake(3);
  }
}

async function startChallenge() {
  const ch = state.challenge;
  if (!ch) return;
  ch.scorer.reset();
  resetScoreHUD();
  ch.noteBonus = 0;
  lastTier = "";
  lastMilestone = 0;
  lastBeatIdx = -1;

  // 音乐会话:唯一时钟(音频对齐);首建在用户手势内创建 AudioContext
  const session = ensureSession(ch);
  await session.prepare();

  // 3D 教练(同模型第二实例)跳参考舞,玩家跟着跳
  const coach = await ensureCoach();
  if (coach) {
    coach.object.visible = true;
    coach.retargeter.reset();
    state.coachPlayer = makeCoachPlayer(ch.seq, coach.retargeter, resolveMode(state.danceType).bones);
  }
  layoutForMode();
  await startCamera();
  if (!state.running) return;

  // 倒计时:GO 时刻 = songTime 0 = 音频起点(绝对 ctx 时间锚定,不用 setTimeout 猜)
  const ctx = session.engine.ctx;
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* noop */ } }
  const goAt = ctx.currentTime + 3.2;
  await session.start(goAt); // 预调度音频与时钟
  await countdownTo(goAt);   // 3 / 2 / 1 / GO

  ch.running = true;
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
    const t = ch.session?.songTime ?? 0;
    const res = ch.scorer.judge(t, frame, boneDefs);
    if (res) {
      updateScoreHUD(res);
      judgeFeedback(res.tier, res.combo);
    }
    ch.session?.feed(t, frame);
    ch.session?.update(); // 内部含节拍 + 音符判定 + 结束检测(onSongEnd)
    updateChallengeProgress(t, ch);
    beatPulse(t, ch);
  }
}

function stopAll() {
  if (state.stream) {
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
  dom.confFill.style.width = "0%";
  dom.confLabel.textContent = "置信度 --";
  setStatus("已停止");
}

dom.btnStart.addEventListener("click", async () => {
  if (!state.avatar) return;
  dom.btnStart.disabled = true;
  try {
    if (state.mode === "performance") {
      await startMixer(dom.animSelect.value);
    } else if (state.mode === "challenge") {
      await startChallenge();
    } else {
      await startFree();
    }
  } catch (e) {
    setStatus("启动失败: " + e.message);
    dom.btnStart.disabled = false;
  }
});

dom.btnStop.addEventListener("click", stopAll);
dom.resultAgain.addEventListener("click", () => {
  dom.result.classList.add("hidden");
  startChallenge().catch((e) => setStatus("启动失败: " + e.message));
});

// ---------------------------------------------------------------------------
// 倒计时
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countdownTo(goAt) {
  const ctx = state.challenge.session.engine.ctx;
  const labels = ["3", "2", "1", "GO!"];
  dom.centerMsg.classList.remove("hidden");
  for (let i = 0; i < labels.length; i++) {
    const target = goAt - (labels.length - 1 - i) * 0.8;
    await sleep(Math.max(0, (target - ctx.currentTime) * 1000));
    dom.centerMsgText.textContent = labels[i];
    dom.centerMsgText.style.animation = "none";
    void dom.centerMsgText.offsetWidth; // 重启动画
    dom.centerMsgText.style.animation = "";
    if (labels[i] === "GO!") {
      juice.flash("255,255,255", 0.25, 0.16);
      juice.shake(6);
    }
  }
  dom.centerMsg.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// HUD 更新
// ---------------------------------------------------------------------------
function updateScoreHUD(res) {
  dom.score.textContent = Math.round(state.challenge.scorer.score + (state.challenge.noteBonus || 0));
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
  // 清空动作预期滚动列
  for (const [, card] of moveCards) card.el.remove();
  moveCards.clear();
}

// ---------------------------------------------------------------------------
// 动作预期:Just Dance 式右侧滚动列
// ---------------------------------------------------------------------------
const moveCards = new Map(); // timeKey -> { el, canvas, label, born }

// 动作时刻列表(秒,升序):优先谱面音符;无谱面则按固定间隔生成
function getMoveTimes(ch) {
  const notes = ch.session?.chart?.notes;
  if (notes && notes.length) return notes.map((n) => n.t);
  const dur = ch.seq.meta.durationSec || 0;
  const out = [];
  for (let t = 0; t <= dur + 1e-6; t += MOVE_FALLBACK_INTERVAL) out.push(+t.toFixed(3));
  return out;
}

// 在右上角渲染一条竖直滚动列(Just Dance 式):
//   - 顶部判定线处「钉住」当前动作(白色剪影 + 粉色发光 + 呼吸脉动);
//   - 下方接下来的动作随歌曲时间向上滚动(灰色 → 最远深灰),到点后升格为当前。
function renderMoveColumn(ch, now) {
  const track = dom.moveTrack;
  if (!track) return;
  const times = getMoveTimes(ch);
  const dims = ch.seq.meta.dimensions || {};
  const bones = ch.seq.bones;

  // 自适应尺寸:卡片高度随滚动区宽度变化;canvas 后台像素按 dpr 放大保证清晰
  const trackW = track.clientWidth || 150;
  const dpr = globalThis.devicePixelRatio || 1;
  const cardH = Math.round(Math.min(120, Math.max(80, trackW * 0.75)));
  const gap = Math.round(cardH * 0.16);
  const spacing = cardH + gap;

  // 滚动速度:按最小动作间隔算,保证卡片永不重叠
  let minGap = Infinity;
  for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1]);
  if (!isFinite(minGap) || minGap <= 0) minGap = MOVE_FALLBACK_INTERVAL;
  const pxPerSec = spacing / minGap;

  // 当前动作下标(最大的 t <= now)
  let curIdx = -1;
  for (let i = times.length - 1; i >= 0; i--) if (times[i] <= now) { curIdx = i; break; }

  // 可见卡片:退出中的(上一个动作)+ 当前(钉住)+ 接下来 N 个
  const cards = [];
  if (curIdx >= 0) {
    const exitElapsed = now - times[curIdx]; // 上一个动作已退出多久
    if (curIdx - 1 >= 0 && exitElapsed < MOVE_EXIT_SEC) {
      cards.push({ t: times[curIdx - 1], tier: "exit", exitElapsed });
    }
    cards.push({ t: times[curIdx], tier: "active" });
  }
  for (let i = curIdx + 1; i <= curIdx + MOVE_HORIZON && i < times.length; i++) {
    cards.push({ t: times[i], tier: i === curIdx + MOVE_HORIZON ? "far" : "next" });
  }

  // 移除不再需要的卡片
  const needed = new Set(cards.map((c) => c.t.toFixed(3)));
  for (const [key, card] of moveCards) {
    if (!needed.has(key)) { card.el.remove(); moveCards.delete(key); }
  }

  cards.forEach((c) => {
    const key = c.t.toFixed(3);
    let card = moveCards.get(key);
    if (!card) {
      const el = document.createElement("div");
      el.className = "move-card";
      el.style.height = cardH + "px";
      const canvas = document.createElement("canvas");
      canvas.className = "move-sil";
      canvas.width = Math.round(trackW * dpr);
      canvas.height = Math.round(cardH * dpr);
      const label = document.createElement("span");
      label.className = "move-time";
      el.appendChild(canvas);
      el.appendChild(label);
      track.appendChild(el);
      card = { el, canvas, label, born: now };
      moveCards.set(key, card);
      // 该动作的姿势固定,只画一次剪影
      const frame = ch.scorer.frameAt(c.t);
      if (frame) {
        const joints = reconstructJoints(frame, dims, bones);
        renderPoseSilhouette(card.canvas, joints, bones);
      }
    }

    // 定位:当前钉在判定线;退出中的向上滑走;接下来的向上滚动逼近判定线
    let y;
    if (c.tier === "active") y = MOVE_NOW_LINE_Y;
    else if (c.tier === "exit") y = MOVE_NOW_LINE_Y - c.exitElapsed * pxPerSec;
    else y = MOVE_NOW_LINE_Y + (c.t - now) * pxPerSec;
    card.el.style.transform = `translateY(${y.toFixed(1)}px)`;

    // 透明度:退出淡出 / 最远降透明度 / 新卡淡入
    let opacity = 1;
    if (c.tier === "exit") opacity = Math.max(0, 1 - c.exitElapsed / MOVE_EXIT_SEC);
    else if (c.tier === "far") opacity = 0.62;
    const enter = Math.min(1, Math.max(0, (now - card.born) / MOVE_ENTER_SEC));
    card.el.style.opacity = (opacity * enter).toFixed(2);

    // 层级:当前 / 最远 / 普通后续
    card.el.classList.toggle("active", c.tier === "active");
    card.el.classList.toggle("far", c.tier === "far");

    // 倒计时(仅未来动作)
    card.label.textContent = (c.tier === "next" || c.tier === "far") ? (c.t - now).toFixed(1) + "s" : "";
  });
}

function updateChallengeProgress(t, ch) {
  const dur = ch.seq.meta.durationSec || 1;
  dom.progressFill.style.width = Math.min(100, (t / dur) * 100) + "%";
  // 动作预期:Just Dance 式右侧滚动列(当前 + 接下来 N 个动作剪影)
  renderMoveColumn(ch, t);
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

function finishChallenge() {
  const ch = state.challenge;
  if (!ch || !ch.running) return;
  ch.running = false;
  const r = ch.scorer.finalize();
  dom.resultGrade.textContent = r.grade;
  dom.resultGrade.className = "grade-" + r.grade.toLowerCase();
  dom.resultScore.textContent = "得分 " + (r.score + (ch.noteBonus || 0));
  dom.resultAcc.textContent = "平均匹配 " + Math.round(r.avgAcc * 100) + "%";
  dom.resultCombo.textContent = "最大连击 " + r.maxCombo;
  dom.result.classList.remove("hidden");
  // 结算庆祝
  juice.burst(window.innerWidth / 2, window.innerHeight * 0.5, { count: 80, speed: 550, ttl: 1.1 });
  juice.flash("255,255,255", 0.3, 0.2);
  juice.shake(12);
  stopAll();
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
    if (state.running) stopAll();
    else if (state.avatar) dom.btnStart.click();
  } else if (e.key === "m" || e.key === "M") {
    dom.btnMirror.click();
  }
});

setMode("free");
setStatus("就绪 — 请选择舞者");

// ---------------------------------------------------------------------------
// 选歌主页(game.html)跳转参数:?mode=challenge&dance=hiphop&song=pop-demo&autoload=1
// ---------------------------------------------------------------------------
function applyLaunchParams() {
  const q = new URLSearchParams(location.search);
  const danceId = q.get("dance");
  const songId = q.get("song");
  if (danceId && CHALLENGE_DANCES.some((d) => d.id === danceId)) {
    state.challengeDanceId = danceId;
    dom.danceSelect.value = danceId;
    state.challengeSongId = challengeDance().defaultSongId;
  }
  if (songId && SONGS.some((s) => s.id === songId)) {
    state.challengeSongId = songId;
  }
  dom.songSelect.value = state.challengeSongId;
  const mode = q.get("mode");
  if (["free", "challenge", "performance"].includes(mode)) setMode(mode);
  if (q.get("autoload") === "1") loadModel(DEFAULT_MODEL);
}
applyLaunchParams();
