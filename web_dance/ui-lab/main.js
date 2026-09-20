/**
 * main.js — HIT LAB:命中判定动效实验台(音游手感样板)。
 *
 * 复用主页面舞池背景;把一次「命中」做成一份多轨动效谱:
 *   判定文字 / 冲击波环 / 定向火花 / 震屏 / hit-stop / 闪光 / 暗角 / 里程碑爆点。
 * 一个 Juice 总控(0=扁平,10=全开)+ 每轨倍率微调 + 随 combo 递增的力度曲线。
 * 调好后「复制配方」回填主页面。
 */
import * as THREE from "three";
import { createScene } from "../scene.js";
import { animate, spring, ease, backOut, lerp, clamp01, ticker } from "./tween.js";
import { createJuice } from "./juice.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 背景舞池(复用主页面 scene.js,禁用轨道旋转)
// ---------------------------------------------------------------------------
const scene = createScene($("stage"));
scene.controls.enabled = false;
scene.camera.position.set(0, 2.1, 5.6);
scene.controls.target.set(0, 0.85, 0);
scene.controls.update();

const clock = new THREE.Clock();
(function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = clock.getDelta();
  if (!ticker.frozen) scene.update(dt); // hit-stop 时背景一并冻结
  scene.renderer.render(scene.scene, scene.camera);
})();

const juice = createJuice({ canvas: $("fx"), shakeTarget: $("shake-layer") });

// ---------------------------------------------------------------------------
// 配方(总控 + 每轨倍率)
// ---------------------------------------------------------------------------
const recipe = {
  juice: 8,        // 总控 0-10
  shakeMul: 1,     // 震屏倍率
  hitStopMul: 1,   // 冻结倍率
  sparksMul: 1,    // 火花倍率
  ringMul: 1,      // 冲击波尺寸倍率
  milestone: 10,   // 里程碑 combo 间隔
};

// 判定多轨谱:颜色 + 每轨的"设计值"
const GRADES = {
  perfect: {
    label: "PERFECT", color: "#ffd54a", rgb: "255,213,74",
    ring: { size: 150, width: 3.5, duration: 340, count: 2 },
    sparks: { count: 26, rays: 12, speed: 420 },
    shake: 5, hitStop: 70, flashA: 0.30, vignette: 0.20,
  },
  great: {
    label: "GREAT", color: "#39ffcf", rgb: "57,255,207",
    ring: { size: 120, width: 2.5, duration: 300, count: 1 },
    sparks: { count: 16, rays: 8, speed: 330 },
    shake: 3, hitStop: 40, flashA: 0.15, vignette: 0.08,
  },
  miss: {
    label: "MISS", color: "#ff4d5e", rgb: "255,77,94", flat: true,
    ring: { size: 90, width: 2, duration: 260, count: 1 },
    sparks: { count: 6, rays: 4, speed: 200 },
    shake: 9, hitStop: 20, flashA: 0.10, vignette: 0.30,
  },
};

const state = { combo: 0, auto: false, autoTimer: null, circleRevert: 0 };
const mix = () => recipe.juice / 10;
const heat = () => 1 + Math.min(state.combo, 50) * 0.02; // 力度曲线:连击越高越"热"

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function hitPoint() {
  const r = $("hit-circle").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function setCombo(n) {
  state.combo = n;
  $("combo-num").textContent = String(n);
  $("heat").textContent = "热度 ×" + heat().toFixed(2);
}

// ---------------------------------------------------------------------------
// 判定文字(PERFECT / GREAT / MISS,字母逐字 stagger 弹出)
// ---------------------------------------------------------------------------
function spawnJudgment(spec, x, y, m) {
  const layer = $("judge-text");
  const el = document.createElement("div");
  el.className = "judge-pop";
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.style.color = spec.color;
  el.style.textShadow = spec.flat ? "0 0 10px rgba(255,77,94,0.6)" : `0 0 22px ${spec.color}`;

  const stagger = spec.flat ? 0 : lerp(0, 34, m);
  [...spec.label].forEach((ch) => {
    const s = document.createElement("span");
    s.textContent = ch;
    el.appendChild(s);
  });
  layer.appendChild(el);

  [...el.querySelectorAll("span")].forEach((s, i) => {
    s.style.opacity = "0";
    s.style.transform = "scale(1.7)";
    animate({
      duration: spec.flat ? 160 : 230,
      delay: i * stagger,
      ease: spec.flat ? ease.cubicOut : backOut(1.9),
      onUpdate: (t) => {
        s.style.opacity = String(clamp01(t));
        s.style.transform = `scale(${1.7 - 0.7 * clamp01(t)})`;
      },
    });
  });

  const hold = [...el.querySelectorAll("span")].length * stagger + 200;
  animate({
    duration: 300, delay: hold, ease: ease.cubicOut,
    onUpdate: (t) => {
      el.style.opacity = String(1 - t);
      el.style.transform = `translate(-50%, -50%) translateY(${-24 * t}px) scale(${1 + 0.12 * t})`;
    },
    onComplete: () => el.remove(),
  });
}

// ---------------------------------------------------------------------------
// 里程碑(COMBO ×N 印章)
// ---------------------------------------------------------------------------
function spawnMilestone() {
  const { x, y } = hitPoint();
  const layer = $("judge-text");
  const el = document.createElement("div");
  el.className = "milestone-pop";
  el.style.left = x + "px";
  el.style.top = (y + 64) + "px";
  el.textContent = `COMBO ×${state.combo}`;
  el.style.opacity = "0";
  layer.appendChild(el);
  spring({ from: 0.7, to: 1, stiffness: 220, damping: 12, onUpdate: (v) => { el.style.transform = `translate(-50%,-50%) scale(${v})`; } });
  animate({
    duration: 140, ease: ease.quadOut, onUpdate: (t) => { el.style.opacity = String(t); },
    onComplete: () => {
      animate({
        duration: 700, delay: 300, ease: ease.cubicOut,
        onUpdate: (t) => { el.style.opacity = String(1 - t); },
        onComplete: () => el.remove(),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// combo 数字:挤压(预备)→ 弹簧过冲(跟随)
// ---------------------------------------------------------------------------
function bumpCombo(h) {
  const num = $("combo-num");
  num.style.textShadow = `0 0 ${8 + h * 6}px rgba(255,213,74,${Math.min(0.8, 0.45 + h * 0.08)})`;
  animate({
    duration: 60, ease: ease.linear,
    onUpdate: (t) => { num.style.transform = `scale(${1 - 0.2 * t})`; },
    onComplete: () => {
      spring({ from: 0.8, to: 1, stiffness: 240, damping: 11, onUpdate: (x) => { num.style.transform = `scale(${x})`; } });
    },
  });
}

function breakCombo() {
  const num = $("combo-num");
  setCombo(0);
  num.style.color = "#ff4d5e";
  num.style.textShadow = "0 0 14px #ff4d5e";
  animate({
    duration: 220, ease: ease.cubicOut,
    onUpdate: (t) => { num.style.transform = `scale(${1 - 0.4 * t}) translateX(${Math.sin(t * 22) * 5 * (1 - t)}px)`; },
    onComplete: () => { num.style.color = ""; num.style.textShadow = ""; num.style.transform = ""; },
  });
}

// ---------------------------------------------------------------------------
// 命中圈:判定瞬间边框/辉光换成等级色 + 一下挤压
// ---------------------------------------------------------------------------
function bumpCircle(spec) {
  const c = $("hit-circle");
  c.style.borderColor = spec.color;
  c.style.boxShadow = `0 0 26px ${spec.color}, inset 0 0 18px ${spec.color}55`;
  spring({ from: 0.9, to: 1, stiffness: 300, damping: 13, onUpdate: (x) => { c.style.transform = `scale(${x})`; } });
  clearTimeout(state.circleRevert);
  state.circleRevert = setTimeout(() => { c.style.borderColor = ""; c.style.boxShadow = ""; }, 300);
}

// ---------------------------------------------------------------------------
// 核心:一次命中 = 一份多轨动效谱
// ---------------------------------------------------------------------------
function doHit(grade) {
  const spec = GRADES[grade];
  const m = mix();
  const { x, y } = hitPoint();

  spawnJudgment(spec, x, y, m);
  bumpCircle(spec);

  let h;
  if (grade === "miss") {
    breakCombo();
    h = 1;
  } else {
    setCombo(state.combo + 1);
    h = heat();
    bumpCombo(h);
  }

  // 冲击波环(juice 中等以上才开,高 juice 加一次回声环)
  if (m >= 0.4) {
    const extra = m >= 0.7 ? 1 : 0;
    for (let i = 0; i < spec.ring.count + extra; i++) {
      juice.ring(x, y, {
        size: spec.ring.size * recipe.ringMul * (0.85 + 0.15 * h),
        color: spec.rgb,
        width: spec.ring.width * (0.7 + 0.3 * m),
        duration: spec.ring.duration,
        delay: i * 70,
      });
    }
  }

  // 定向火花(juice 较高才开)
  if (m >= 0.55) {
    juice.sparks(x, y, {
      count: Math.round(spec.sparks.count * recipe.sparksMul * m * h),
      rays: Math.round(spec.sparks.rays * m),
      speed: spec.sparks.speed * (0.85 + 0.15 * h),
      gravity: 620,
      colors: grade === "miss" ? [spec.rgb, "200,60,80"] : [spec.rgb, "255,255,255", "77,124,255"],
    });
  }

  // 震屏 / hit-stop / 闪光 / 暗角
  juice.shake(spec.shake * recipe.shakeMul * m * (grade === "miss" ? 1.4 : 1));
  juice.hitStop(spec.hitStop * recipe.hitStopMul * m);
  juice.flash(spec.rgb, spec.flashA * m, 0.16);
  juice.vignette(spec.vignette * m);

  // 里程碑爆点
  if (grade !== "miss" && state.combo > 0 && state.combo % recipe.milestone === 0) {
    juice.flash("255,213,74", 0.5, 0.24);
    juice.vignette(0.5);
    juice.hitStop(110);
    juice.ring(x, y, { size: spec.ring.size * recipe.ringMul * 1.6, color: "255,213,74", width: 5, duration: 480 });
    juice.sparks(x, y, { count: 40, rays: 18, speed: 520, gravity: 500, colors: ["255,213,74", "255,61,129", "57,255,207"] });
    juice.shake(12);
    spawnMilestone();
  }
}

// ---------------------------------------------------------------------------
// 控制
// ---------------------------------------------------------------------------
document.querySelectorAll(".grade-btn").forEach((b) => b.addEventListener("click", () => doHit(b.dataset.grade)));

$("btn-auto").addEventListener("click", () => {
  state.auto = !state.auto;
  $("btn-auto").classList.toggle("active", state.auto);
  if (state.auto) {
    const fire = () => {
      const r = Math.random();
      doHit(r < 0.72 ? "perfect" : r < 0.92 ? "great" : "miss");
    };
    fire();
    state.autoTimer = setInterval(fire, 340);
  } else {
    clearInterval(state.autoTimer);
  }
});

$("btn-reset").addEventListener("click", () => setCombo(0));

window.addEventListener("keydown", (e) => {
  if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === "p" || e.key === "P") doHit("perfect");
  else if (e.key === "g" || e.key === "G") doHit("great");
  else if (e.key === "m" || e.key === "M") doHit("miss");
  else if (e.code === "Space") { e.preventDefault(); $("btn-auto").click(); }
});

// ---------------------------------------------------------------------------
// 配方输出
// ---------------------------------------------------------------------------
const sliderMap = {
  juice:      { input: "p-juice",      label: "v-juice",      fmt: (v) => v.toFixed(1) },
  shakeMul:   { input: "p-shakeMul",   label: "v-shakeMul",   fmt: (v) => v.toFixed(1) + "×" },
  hitStopMul: { input: "p-hitStopMul", label: "v-hitStopMul", fmt: (v) => v.toFixed(1) + "×" },
  sparksMul:  { input: "p-sparksMul",  label: "v-sparksMul",  fmt: (v) => v.toFixed(1) + "×" },
  ringMul:    { input: "p-ringMul",    label: "v-ringMul",    fmt: (v) => v.toFixed(2) + "×" },
  milestone:  { input: "p-milestone",  label: "v-milestone",  fmt: (v) => Math.round(v) },
};

function buildRecipeSnippet() {
  return [
    "// ui-lab 命中判定配方 —— 回填 web_dance/main.js",
    "const HIT_FEEL = {",
    `  juice: ${recipe.juice},`,
    `  shakeMul: ${recipe.shakeMul},`,
    `  hitStopMul: ${recipe.hitStopMul},`,
    `  sparksMul: ${recipe.sparksMul},`,
    `  ringMul: ${recipe.ringMul},`,
    `  milestone: ${recipe.milestone},`,
    "};",
  ].join("\n");
}

function updateRecipeOut() { $("recipe-out").textContent = buildRecipeSnippet(); }

for (const [key, cfg] of Object.entries(sliderMap)) {
  const input = $(cfg.input);
  const label = $(cfg.label);
  input.value = String(recipe[key]);
  label.textContent = cfg.fmt(recipe[key]);
  input.addEventListener("input", () => {
    recipe[key] = Number(input.value);
    label.textContent = cfg.fmt(recipe[key]);
    updateRecipeOut();
  });
}

$("copy-recipe").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildRecipeSnippet());
  } catch (e) {
    const r = document.createRange();
    r.selectNodeContents($("recipe-out"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const toast = $("toast");
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 1200);
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
updateRecipeOut();
setTimeout(() => doHit("perfect"), 500);
