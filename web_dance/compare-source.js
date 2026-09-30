/**
 * compare-source.js — 诊断页:左=源动作直接套到 dancer_girl(未重定向),右=当前管线。
 * 用来判断「手/手臂穿模」到底是源姿势本身+厚衣服的几何问题,还是重定向引入的。
 * 用法:http://localhost:8000/web_dance/compare-source.html?dance=copydance1
 * 自动化:window.__cmp = { seek(t), freeze(), resume(), done }
 */
import * as THREE from "three";
import { loadAvatar, realignRetargeter } from "./avatar.js";
import { loadDanceClips, retargetClipToSkeleton, captureRestPose, BUILTIN_DANCES } from "./dance-library.js";

const norm = (n) => String(n).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");
const DANCE_ID = new URLSearchParams(location.search).get("dance") || "copydance1";

// ---------- 场景 / 相机 / 灯光 ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 50);
camera.position.set(0, 1.72, 5.1);
camera.lookAt(0, 1.02, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 5, 4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -4; key.shadow.camera.right = 4;
key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
key.shadow.camera.far = 20;
scene.add(key);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(12, 12),
  new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.9 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- 模型 ----------
const [left, right] = await Promise.all([
  loadAvatar("../models/dancer_girl.fbx"),
  loadAvatar("../models/dancer_girl.fbx"),
]);
left.object.position.x = -1.65;
right.object.position.x = +1.65;
scene.add(left.object, right.object);

const dance = BUILTIN_DANCES.find((d) => d.id === DANCE_ID) ?? BUILTIN_DANCES[0];
const { root: srcRoot, clips } = await loadDanceClips(dance);
const srcClip = clips[0];

// 右:当前管线(按舞源重对齐 + 手臂直通 + 碰撞 + 走位)
realignRetargeter(right, srcRoot);
captureRestPose(right.object);
const rightClip = retargetClipToSkeleton(srcClip, srcRoot, right.object, {
  preserveArmRotations: true, collision: true, rootMotion: true, radiiMode: "mesh",
});

// 左:源动作直接套上 —— 每帧把源骨的世界四元数原样搬到目标骨(无 delta 修正、无碰撞、无走位)
const leftClip = rawCopyClip(srcClip, srcRoot, left.object);

const leftMixer = new THREE.AnimationMixer(left.object);
const rightMixer = new THREE.AnimationMixer(right.object);
for (const c of left.object.skeletons ?? []) c.castShadow = true;
const a1 = leftMixer.clipAction(leftClip); a1.play();
const a2 = rightMixer.clipAction(rightClip); a2.play();

function rawCopyClip(clip, srcRoot, dstRoot) {
  const srcByName = new Map(); srcRoot.traverse((o) => { if (o.isBone) srcByName.set(o.name, o); });
  const dstByKey = new Map(); dstRoot.traverse((o) => { if (o.isBone) dstByKey.set(norm(o.name), o); });
  const pairs = [];
  for (const [name, src] of srcByName) { const d = dstByKey.get(norm(name)); if (d) pairs.push({ src, dst: d }); }
  const depth = new Map(); (function walk(o, d) { depth.set(o, d); for (const c of o.children) walk(c, d + 1); })(srcRoot, 0);
  pairs.sort((a, b) => (depth.get(a.src) ?? 0) - (depth.get(b.src) ?? 0));
  const pairOfSrc = new Map(pairs.map((p) => [p.src, p]));

  const mixer = new THREE.AnimationMixer(srcRoot);
  mixer.clipAction(clip).play();
  const dur = clip.duration || 1;
  const total = Math.round(dur * 30);
  const dt = dur / total;
  const times = [];
  const sampleOf = new Map(pairs.map((p) => [p.src, []]));

  for (let i = 1; i <= total; i++) { // 跳过 bind 帧,与 retargetClipToSkeleton 一致
    mixer.setTime(i * dt);
    srcRoot.updateMatrixWorld(true);
    const srcWorldOf = new Map();
    for (const p of pairs) srcWorldOf.set(p.src, p.src.getWorldQuaternion(new THREE.Quaternion()));
    for (const p of pairs) {
      const sw = srcWorldOf.get(p.src);
      const pp = p.src.parent ? pairOfSrc.get(p.src.parent) : null;
      const parentWorld = pp
        ? srcWorldOf.get(pp.src)
        : (p.dst.parent ? p.dst.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion());
      const local = parentWorld.clone().invert().multiply(sw);
      sampleOf.get(p.src).push(local.x, local.y, local.z, local.w);
    }
    times.push((i - 1) * dt);
  }
  const tracks = [];
  for (const p of pairs) {
    const arr = sampleOf.get(p.src);
    if (arr?.length) tracks.push(new THREE.QuaternionKeyframeTrack(p.dst.name + ".quaternion", times, arr));
  }
  return new THREE.AnimationClip(clip.name, dur, tracks);
}

// ---------- 循环 ----------
const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.05, clock.getDelta());
  leftMixer.update(dt);
  rightMixer.update(dt);
  for (const o of [left.object, right.object]) o.updateMatrixWorld(true);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

window.__cmp = {
  seek(t) { leftMixer.setTime(Math.max(0, t)); rightMixer.setTime(Math.max(0, t)); },
  freeze() { leftMixer.timeScale = 0; rightMixer.timeScale = 0; },
  resume() { leftMixer.timeScale = 1; rightMixer.timeScale = 1; },
  duration() { return Math.min(leftClip.duration, rightClip.duration); },
  done: true,
};
console.info(`[compare-source] ${DANCE_ID} 就绪;左=源直接套上,右=当前管线`);
