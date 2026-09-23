/**
 * game.js — DANCE ARENA 选歌主页(Just Dance 式卡片轮播)。
 *
 * 背景复用 scene.js 的三渲二舞池(Dance Spotlight 聚光灯),
 * 卡片上的动作剪影取自 demo-sequence 的真实谱面帧(stick-figure 剪影),
 * 数据复用 challenge-library / dance-library,跳转参数由 main.js 的
 * applyLaunchParams 接收(mode / dance / song / autoload)。
 */

import * as THREE from "three";
import { createScene } from "./scene.js";
import { CHALLENGE_DANCES, SONGS } from "./challenge-library.js";
import { BUILTIN_DANCES } from "./dance-library.js";
import { buildDemoSequence } from "./demo-sequence.js";
import { reconstructJoints } from "../pose_capture/playback.js";
import { renderPoseSilhouette } from "../pose_capture/stick-figure.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 背景舞台(聚光灯 + 移动光束 + 粒子,镜头缓慢环绕)
// ---------------------------------------------------------------------------
const stage = createScene($("stage"));
stage.controls.enabled = false;
stage.camera.position.set(0, 2.4, 8.2);
stage.controls.target.set(0, 1.1, 0);

const clock = new THREE.Clock();
let camT = 0;
function bgLoop() {
  requestAnimationFrame(bgLoop);
  const dt = Math.min(clock.getDelta(), 0.1);
  camT += dt;
  stage.camera.position.x = Math.sin(camT * 0.12) * 0.9;
  stage.camera.lookAt(0, 1.1, 0);
  stage.update(dt);
  stage.render();
}
bgLoop();

// ---------------------------------------------------------------------------
// 选曲数据:每个模式的卡片(entries)与跳转参数
// ---------------------------------------------------------------------------
const DIFF_LABEL = ["入门", "简单", "中等", "困难"];

// 卡片配色与剪影取帧时刻(取自 demo 谱面的关键姿态:2s 举手 / 6s 前伸 / 8s 侧浪 / 12s 下蹲)
const CARD_SKIN = {
  demo:   { a: "#ff3d81", b: "#7c4dff", diff: 1, poseT: 2 },
  hiphop: { a: "#ffb300", b: "#ff3d81", diff: 2, poseT: 12 },
  salsa:  { a: "#00e5a0", b: "#4d7cff", diff: 3, poseT: 8 },
  free:   { a: "#39ffcf", b: "#4d7cff", diff: 1, poseT: 4 },
};

function songOf(id) {
  return SONGS.find((s) => s.id === id) || SONGS[0];
}

function entriesFor(mode) {
  if (mode === "challenge") {
    return CHALLENGE_DANCES.map((d) => {
      const song = songOf(d.defaultSongId);
      const skin = CARD_SKIN[d.id] || CARD_SKIN.demo;
      return {
        key: d.id,
        tag: "跟跳",
        title: d.label,
        sub: `♪ ${song.label}`,
        bpm: song.bpm,
        diff: skin.diff,
        a: skin.a, b: skin.b, poseT: skin.poseT,
        url: `./index.html?mode=challenge&dance=${d.id}&song=${song.id}&autoload=1`,
      };
    });
  }
  if (mode === "performance") {
    return BUILTIN_DANCES.map((d, i) => {
      const skin = CARD_SKIN[d.id] || CARD_SKIN.demo;
      return {
        key: d.id,
        tag: "表演",
        title: d.label,
        sub: "3D 舞者表演 · 无需摄像头",
        bpm: null,
        diff: skin.diff,
        a: skin.a, b: skin.b, poseT: [6, 18][i % 2],
        url: `./index.html?mode=performance&autoload=1`,
      };
    });
  }
  // free
  const skin = CARD_SKIN.free;
  return [{
    key: "free",
    tag: "自由",
    title: "自由舞动",
    sub: "实时动捕镜像 · 想跳就跳",
    bpm: null,
    diff: 1,
    a: skin.a, b: skin.b, poseT: skin.poseT,
    url: "./index.html?mode=free&autoload=1",
  }];
}

// ---------------------------------------------------------------------------
// 卡片剪影:demo 谱面真实姿态,选中卡循环播放(Just Dance 式动态剪影)
// ---------------------------------------------------------------------------
const demoSeq = buildDemoSequence();
const FPS = demoSeq.meta.fps || 30;

function drawPoseAt(canvas, t, color) {
  const i = Math.max(0, Math.min(demoSeq.frames.length - 1, Math.round(t * FPS)));
  const joints = reconstructJoints(demoSeq.frames[i]);
  renderPoseSilhouette(canvas, joints, undefined, { color });
}

// ---------------------------------------------------------------------------
// 轮播
// ---------------------------------------------------------------------------
const carousel = $("carousel");
let mode = "challenge";
let entries = [];
let selected = 0;

function buildCarousel() {
  entries = entriesFor(mode);
  selected = 0;
  carousel.innerHTML = "";
  for (const e of entries) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.setProperty("--card-a", e.a);
    card.style.setProperty("--card-b", e.b);
    card.innerHTML = `
      <div class="card-cover"></div>
      <canvas width="220" height="220"></canvas>
      <div class="card-tag">${e.tag}</div>
      <div class="card-bottom">
        <div class="card-title">${e.title}</div>
        <div class="card-sub">${e.sub}</div>
        <div class="card-stars">${"★".repeat(e.diff)}<span class="off">${"★".repeat(Math.max(0, 3 - e.diff))}</span></div>
      </div>`;
    card.addEventListener("click", () => {
      const idx = entries.indexOf(e);
      if (idx === selected) launch();
      else select(idx);
    });
    e._card = card;
    e._canvas = card.querySelector("canvas");
    drawPoseAt(e._canvas, e.poseT, "#ffffff");
    carousel.appendChild(card);
  }
  select(0);
}

function select(i) {
  selected = (i + entries.length) % entries.length;
  entries.forEach((e, k) => e._card.classList.toggle("selected", k === selected));
  const e = entries[selected];
  $("song-title").textContent = e.title;
  $("song-sub").textContent = e.sub;
  $("song-bpm").textContent = e.bpm ? `BPM ${e.bpm}` : "自由节奏";
  $("song-diff").textContent = `难度 ${DIFF_LABEL[e.diff] || e.diff}`;
}

function launch() {
  const e = entries[selected];
  if (e) location.href = e.url;
}

// 选中卡的剪影动画(约 12fps 循环谱面)
let animT = 0;
let lastAnimFrame = -1;
setInterval(() => {
  const e = entries[selected];
  if (!e || !e._canvas) return;
  animT = (animT + 0.085) % demoSeq.meta.durationSec;
  const f = Math.round(animT * FPS);
  if (f === lastAnimFrame) return;
  lastAnimFrame = f;
  drawPoseAt(e._canvas, animT, "#ffffff");
}, 85);

// ---------------------------------------------------------------------------
// 交互:模式切换 / 箭头 / 键盘 / 滚轮
// ---------------------------------------------------------------------------
document.querySelectorAll(".mode-btn").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.mode === mode) return;
    mode = b.dataset.mode;
    document.querySelectorAll(".mode-btn").forEach((x) => x.classList.toggle("active", x === b));
    buildCarousel();
  })
);

$("arrow-left").addEventListener("click", () => select(selected - 1));
$("arrow-right").addEventListener("click", () => select(selected + 1));
$("cta").addEventListener("click", launch);

window.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") select(selected - 1);
  else if (e.key === "ArrowRight") select(selected + 1);
  else if (e.key === "Enter" || e.code === "Space") { e.preventDefault(); launch(); }
});

let wheelLock = 0;
window.addEventListener("wheel", (e) => {
  const now = performance.now();
  if (now - wheelLock < 220) return;
  wheelLock = now;
  select(selected + (e.deltaY > 0 ? 1 : -1));
}, { passive: true });

buildCarousel();
