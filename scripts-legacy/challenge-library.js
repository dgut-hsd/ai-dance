/**
 * challenge-library.js — 跟跳挑战的「舞曲库」:把 FBX 动作转成 dance-sequence/v1 序列,
 * 并提供歌曲列表。与 pose_capture 导出的 JSON 同 schema,教练(3D)和评分都吃这个格式。
 *
 * 转换原理(骨架 → canonical):
 *   1. 在休息姿态里测出 FBX 骨架的 right/up/forward 基(用脚趾校正 forward 符号);
 *   2. 逐帧采样动画,取各关节世界坐标,减去髋中点 → 投影到该基上;
 *   3. 得到 canonical 空间(x=右, y=上, z=朝镜头)的关节,再按 BONE_DEFS 算单位向量。
 */

import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { BONE_DEFS } from "../pose_capture/contract.js";

const SAMPLING_FPS = 30;

// 身体尺寸(仅用于 2D 火柴人回放;教练用自己的模型尺寸,评分只看单位向量)
const DIMS = {
  spineLen: 0.52, shoulderWidth: 0.38, hipWidth: 0.32,
  upperArm: 0.28, forearm: 0.26, thigh: 0.44, shin: 0.42, headLen: 0.22,
};

function normalizeBoneName(name) {
  return String(name).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");
}

// 契约关节 → Mixamo 骨骼(取该骨头的原点作为关节点)
const JOINT_BONES = {
  hips_center: ["hips"],
  left_shoulder: ["leftarm"],
  right_shoulder: ["rightarm"],
  left_elbow: ["leftforearm"],
  right_elbow: ["rightforearm"],
  left_wrist: ["lefthand"],
  right_wrist: ["righthand"],
  left_hip: ["leftupleg"],
  right_hip: ["rightupleg"],
  left_knee: ["leftleg"],
  right_knee: ["rightleg"],
  left_ankle: ["leftfoot"],
  right_ankle: ["rightfoot"],
  nose: ["head"],
};

function collectBones(root) {
  const map = new Map();
  root.traverse((o) => { if (o.isBone) map.set(normalizeBoneName(o.name), o); });
  return map;
}

// 在 FBX 休息姿态里测 canonical 基(right/up/forward),forward 用脚趾校正符号
function computeCanonicalBasis(root) {
  root.updateMatrixWorld(true);
  const B = collectBones(root);
  const pos = (keys) => {
    for (const k of keys) { const b = B.get(k); if (b) return b.getWorldPosition(new THREE.Vector3()); }
    return null;
  };

  const hips = pos(["hips"]);
  const larm = pos(["leftarm"]);
  const rarm = pos(["rightarm"]);
  // 胸/颈作为「上」方向的参考;取不到就退到双肩中点
  let chest = pos(["spine2", "chest", "neck", "spine1"]);
  if (!chest && larm && rarm) chest = larm.clone().add(rarm).multiplyScalar(0.5);

  const up = chest && hips ? chest.clone().sub(hips).normalize() : new THREE.Vector3(0, 1, 0);
  const right = larm && rarm ? rarm.clone().sub(larm).normalize() : new THREE.Vector3(1, 0, 0);
  const forward = new THREE.Vector3().crossVectors(right, up).normalize();
  if (forward.lengthSq() < 0.5) forward.set(0, 0, 1);

  // 脚趾永远朝前
  let toe = new THREE.Vector3();
  let ok = false;
  const lf = pos(["leftfoot"]), lt = pos(["lefttoebase", "lefttoe_end"]);
  const rf = pos(["rightfoot"]), rt = pos(["righttoebase", "righttoe_end"]);
  if (lf && lt) { toe.add(lt.clone().sub(lf)); ok = true; }
  if (rf && rt) { toe.add(rt.clone().sub(rf)); ok = true; }
  if (ok) {
    toe.y = 0;
    if (toe.lengthSq() > 1e-8) {
      toe.normalize();
      if (toe.dot(forward) < 0) forward.negate();
    }
  }
  return { right, up, forward };
}

// 把世界坐标转到 canonical(x=右,y=上,z=朝镜头),髋为原点
function toCanonical(p, hips, basis) {
  const d = p.clone().sub(hips);
  return [d.dot(basis.right), d.dot(basis.up), d.dot(basis.forward)];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-6 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * 把一段 FBX 动画片段转成 dance-sequence/v1 序列。
 * @param {THREE.AnimationClip} clip
 * @param {THREE.Object3D} root FBX 根(含骨架,尚未被动画驱动)
 * @param {{ bpm?: number, audio?: string, danceId?: string }} opts
 */
export function fbxClipToSequence(clip, root, { bpm = 120, audio = "audio/pop-demo.wav", danceId = "fbx-dance", loopTo = 24 } = {}) {
  const basis = computeCanonicalBasis(root);
  const B = collectBones(root);

  // 各关节对应的骨头(取不到就跳过)
  const jointBone = {};
  for (const [joint, keys] of Object.entries(JOINT_BONES)) {
    for (const k of keys) { if (B.has(k)) { jointBone[joint] = B.get(k); break; } }
  }

  // 采样
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.update(0);

  // 短片段循环补足到至少 loopTo 秒(如 Salsa 只有 2s,循环到 24s 才够跟跳);mixer 默认 LoopRepeat,直接步进即可。
  const clipDur = Math.max(0.001, clip.duration || 0);
  const dur = Math.max(clipDur, loopTo);
  const total = Math.max(2, Math.round(dur * SAMPLING_FPS));
  const dt = dur / total;
  const frames = [];

  for (let i = 0; i <= total; i++) {
    const t = i * dt;
    if (i > 0) mixer.update(dt);
    root.updateMatrixWorld(true);

    const hips = jointBone.hips_center?.getWorldPosition(new THREE.Vector3());
    if (!hips) continue;
    const J = {};
    for (const [joint, bone] of Object.entries(jointBone)) {
      J[joint] = toCanonical(bone.getWorldPosition(new THREE.Vector3()), hips, basis);
    }

    // 由关节点算 10 条骨骼单位向量(顺序同 BONE_DEFS)
    const joints = {
      ...J,
      shoulders_center: J.left_shoulder && J.right_shoulder
        ? [(J.left_shoulder[0] + J.right_shoulder[0]) / 2,
           (J.left_shoulder[1] + J.right_shoulder[1]) / 2,
           (J.left_shoulder[2] + J.right_shoulder[2]) / 2]
        : [0, 0, 0],
    };
    const bones = BONE_DEFS.map((b) => norm(sub(joints[b.child], joints[b.parent])));

    frames.push({ t: +t.toFixed(3), bones, conf: new Array(BONE_DEFS.length).fill(1) });
  }

  return makeSequence(frames, { bpm, audio, danceId, durationSec: dur });
}

function makeSequence(frames, { bpm, audio, danceId, durationSec }) {
  const beat = 60 / bpm;
  const notes = [];
  for (let t = 0; t <= durationSec; t += beat * 2) {
    notes.push({ id: `${danceId}-${Math.round(t * 1000)}`, t: +t.toFixed(3), type: "pose", lane: "body" });
  }
  const beatTimesSec = [];
  for (let t = 0; t <= durationSec; t += beat) beatTimesSec.push(+t.toFixed(3));

  return {
    schema: "dance-sequence/v1",
    danceId,
    meta: {
      fps: SAMPLING_FPS,
      durationSec,
      numFrames: frames.length,
      boneCount: BONE_DEFS.length,
      danceType: "full-body",
      source: "fbx-converted",
      coordinateSystem: "canonical-yup",
      difficulty: 1,
      beatTimesSec,
      timing: { version: "timing/v1", bpm, offsetSec: 0, tempoMap: [{ t: 0, bpm }] },
      dimensions: DIMS,
    },
    bones: BONE_DEFS.map(({ name, parent, child }) => ({ name, parent, child })),
    frames,
    chart: { version: "chart/v1", audio, notes },
  };
}

// ---------------------------------------------------------------------------
// 内置挑战舞曲 + 歌曲库
// ---------------------------------------------------------------------------

// FBX 动作(仓库根 fbx/ 目录)
export const FBX_DANCES = [
  { id: "hiphop", label: "Hip Hop Dancing", url: "../fbx/Hip Hop Dancing.fbx", bpm: 100, audio: "audio/pop-demo.wav" },
  { id: "salsa", label: "Salsa Dancing", url: "../fbx/Salsa Dancing.fbx", bpm: 180, audio: "audio/samba-demo.wav" },
];

// 歌曲库(可独立于舞蹈选择)
export const SONGS = [
  { id: "demo-beat", label: "示例节拍", url: "audio/demo-beat.wav", bpm: 120 },
  { id: "pop-demo", label: "Pop Demo", url: "audio/pop-demo.wav", bpm: 120 },
  { id: "samba-demo", label: "Samba Demo", url: "audio/samba-demo.wav", bpm: 100 },
];

// 跟跳挑战的舞曲配对:选歌主页(game.js)与游戏页(main.js)共用这一份
export const CHALLENGE_DANCES = [
  { id: "demo", label: "合成示例舞", kind: "demo", defaultSongId: "demo-beat" },
  { id: "hiphop", label: "Hip Hop Dancing", kind: "fbx", fbx: FBX_DANCES[0], defaultSongId: "pop-demo" },
  { id: "salsa", label: "Salsa Dancing", kind: "fbx", fbx: FBX_DANCES[1], defaultSongId: "samba-demo" },
];

const _cache = new Map(); // fbxDance.id -> sequence

/**
 * 加载一支 FBX 舞曲并转成挑战序列(缓存)。
 */
export async function loadFbxSequence(fbxDance, song) {
  const key = `${fbxDance.id}:${song?.id || "default"}`;
  if (_cache.has(key)) return _cache.get(key);
  const loader = new FBXLoader();
  const root = await loader.loadAsync(encodeURI(fbxDance.url));
  const clip = (root.animations || [])[0];
  if (!clip) throw new Error("该 FBX 里没有动画片段");
  const seq = fbxClipToSequence(clip, root, {
    bpm: song?.bpm ?? fbxDance.bpm,
    audio: song?.url ?? fbxDance.audio,
    danceId: fbxDance.id,
  });
  _cache.set(key, seq);
  return seq;
}
