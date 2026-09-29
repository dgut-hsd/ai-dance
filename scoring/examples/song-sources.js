/**
 * song-sources.js — 离线舞曲构建源(仅构建期用,浏览器运行时不加载)。
 *
 * 承接原 web_dance/challenge-library.js 与 demo-sequence.js 的转换逻辑:
 *   - demo  : buildDemoSequence() 合成 24s 示例舞
 *   - hiphop/salsa : fbxClipToSequence() 把 songs/<danceId>/ 的 Mixamo 动作转成 dance-sequence/v1
 *   - SONGS / CHALLENGE_DANCES / FBX_DANCES : 舞曲配对与歌曲元数据
 *
 * 任何写入 songs/ 的序列与谱面都由 export-songs-cli.js 从这里一次性落盘,
 * 运行时的唯一数据来源是 songs/ 目录文件。
 * FBX→序列的转换逻辑在 ../src/fbxToSequence.js(node/browser 通用,THREE 注入)。
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { BONE_DEFS } from "../../pose_capture/contract.js";
import { DIMS, fbxClipToSequence as fbxClipToSequenceCore, makeSequence as makeSequenceCore, hipRootYaw, shoulderAxisOf } from "../src/fbxToSequence.js";

export const FBX_DANCES = [
  { id: "hiphop", label: "Hip Hop Dancing", fbx: "Hip Hop Dancing.fbx" },
  { id: "salsa", label: "Salsa Dancing", fbx: "Salsa Dancing.fbx" },
];

export const SONGS = [
  { id: "demo-beat", label: "示例节拍", file: "demo-beat.wav", bpm: 120 },
  { id: "pop-demo", label: "Pop Demo", file: "pop-demo.wav", bpm: 120 },
  { id: "samba-demo", label: "Samba Demo", file: "samba-demo.wav", bpm: 100 },
];

export const CHALLENGE_DANCES = [
  { id: "demo", label: "合成示例舞", kind: "demo", defaultSongId: "demo-beat", danceId: "demo-arena-loop" },
  { id: "hiphop", label: "Hip Hop Dancing", kind: "fbx", fbxId: "hiphop", defaultSongId: "pop-demo", danceId: "hiphop" },
  { id: "salsa", label: "Salsa Dancing", kind: "fbx", fbxId: "salsa", defaultSongId: "samba-demo", danceId: "salsa" },
];

// ---- demo 合成(原 demo-sequence.js) --------------------------------------------

const N = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// 每个姿态:10 条骨骼的(canonical)单位向量,顺序同 BONE_DEFS
const POSES = {
  neutral: [
    [0, 1, 0], [-0.12, -0.99, 0.03], [0, -1, 0.05],
    [0.12, -0.99, -0.03], [0, -1, -0.05],
    [-0.07, -0.99, -0.03], [0, -1, 0.05],
    [0.07, -0.99, 0.03], [0, -1, -0.05], [0, 1, 0.05],
  ],
  armsUp: [
    [0, 1, 0], [-0.55, 0.78, -0.15], [-0.2, 0.9, -0.3],
    [0.55, 0.78, 0.15], [0.2, 0.9, 0.3],
    [-0.07, -0.99, -0.03], [0, -1, 0.05],
    [0.07, -0.99, 0.03], [0, -1, -0.05], [0, 1, -0.05],
  ],
  armsT: [
    [0, 1, 0], [-1, 0.02, 0.12], [-1, 0, 0.25],
    [1, 0.02, -0.12], [1, 0, -0.25],
    [-0.07, -0.99, -0.03], [0, -1, 0.05],
    [0.07, -0.99, 0.03], [0, -1, -0.05], [0, 1, 0],
  ],
  armsForward: [
    [0, 1, 0], [-0.05, -0.55, -0.83], [-0.05, -0.35, -0.93],
    [0.05, -0.55, -0.83], [0.05, -0.35, -0.93],
    [-0.07, -0.99, -0.03], [0, -1, 0.05],
    [0.07, -0.99, 0.03], [0, -1, -0.05], [0, 1, -0.12],
  ],
  waveLeft: [
    [0.16, 0.98, 0.05], [-0.55, 0.78, -0.15], [-0.2, 0.9, -0.3],
    [0.12, -0.99, -0.03], [0, -1, -0.05],
    [-0.07, -0.99, -0.03], [0, -1, 0.05],
    [0.07, -0.99, 0.03], [0, -1, -0.05], [-0.12, 0.99, 0.05],
  ],
  squat: [
    [0, 0.86, -0.5], [-0.32, -0.42, -0.85], [-0.3, -0.45, -0.84],
    [0.32, -0.42, -0.85], [0.3, -0.45, -0.84],
    [-0.12, -0.72, -0.68], [0, -0.9, 0.35],
    [0.12, -0.72, -0.68], [0, -0.9, -0.35], [0, 0.86, -0.5],
  ],
};

// [时间秒, 姿态名] 关键帧;24 秒循环
const MOVES = [
  [0, "neutral"], [2, "armsUp"], [4, "armsT"], [6, "armsForward"],
  [8, "waveLeft"], [10, "armsUp"], [12, "squat"], [14, "neutral"],
  [16, "armsT"], [18, "armsForward"], [20, "armsUp"], [22, "neutral"],
];

const DURATION = 24;
const FPS = 30;

function lerpN(a, b, u) {
  return N([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
}

function samplePose(t) {
  t = ((t % DURATION) + DURATION) % DURATION;
  let i = MOVES.length - 1;
  for (let k = 0; k < MOVES.length; k++) {
    if (MOVES[k][0] > t) { i = k - 1; break; }
  }
  const next = (i + 1) % MOVES.length;
  const t0 = MOVES[i][0];
  const t1 = MOVES[next][0] + (next === 0 ? DURATION : 0);
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  const s = u * u * (3 - 2 * u);
  const p0 = POSES[MOVES[i][1]];
  const p1 = POSES[MOVES[next][1]];
  return p0.map((v, idx) => lerpN(v, p1[idx], s));
}

/** 合成示例舞参考序列(demo-arena-loop;音符轨道见 makeSequence)。 */
export function buildDemoSequence() {
  const frames = [];
  for (let i = 0; i < DURATION * FPS; i++) {
    const t = i / FPS;
    frames.push({ t, bones: samplePose(t), conf: new Array(10).fill(1) });
  }
  const beatTimesSec = [];
  for (let b = 0; b < DURATION * 2; b++) beatTimesSec.push(+(b * 0.5).toFixed(3));

  return {
    schema: "dance-sequence/v1",
    danceId: "demo-arena-loop",
    meta: {
      fps: FPS,
      durationSec: DURATION,
      numFrames: frames.length,
      boneCount: BONE_DEFS.length,
      danceType: "full-body",
      source: "synthetic-demo",
      coordinateSystem: "canonical-yup",
      difficulty: 1,
      beatTimesSec,
      timing: {
        version: "timing/v1",
        bpm: 120,
        offsetSec: 0,
        tempoMap: [{ t: 0, bpm: 120 }],
      },
      dimensions: DIMS,
    },
    bones: BONE_DEFS.map(({ name, parent, child }) => ({ name, parent, child })),
    frames,
  };
}

// ---- FBX 转换(原 challenge-library.js) -----------------------------------------

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

/** 一个序列的基础框架 + 每 2 拍一个 pose 音符的谱面(音符轨道判定)。 */
export function makeSequence(frames, { bpm, audio, danceId, durationSec }) {
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

/**
 * 把一段 FBX 动画片段转成 dance-sequence/v1 序列(短片段自动循环到 loopTo 秒)。
 * @param {THREE.AnimationClip} clip
 * @param {THREE.Object3D} root FBX 根(含骨架,尚未被动画驱动)
 * @param {{ bpm?: number, audio?: string, danceId?: string, loopTo?: number }} opts
 */
export function fbxClipToSequence(clip, root, { bpm = 120, audio = "pop-demo.wav", danceId = "fbx-dance", loopTo = 24 } = {}) {
  const basis = computeCanonicalBasis(root);
  const B = collectBones(root);

  const jointBone = {};
  for (const [joint, keys] of Object.entries(JOINT_BONES)) {
    for (const k of keys) { if (B.has(k)) { jointBone[joint] = B.get(k); break; } }
  }

  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.update(0);

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

    const joints = {
      ...J,
      shoulders_center: J.left_shoulder && J.right_shoulder
        ? [(J.left_shoulder[0] + J.right_shoulder[0]) / 2,
           (J.left_shoulder[1] + J.right_shoulder[1]) / 2,
           (J.left_shoulder[2] + J.right_shoulder[2]) / 2]
        : [0, 0, 0],
    };
    const bones = BONE_DEFS.map((b) => norm(sub(joints[b.child], joints[b.parent])));

    // 与 pose_capture/contract.js / fbxToSequence.js 同式,保证评分侧 yaw 对齐拿得到基准
    const rootYaw = hipRootYaw(joints);
    const shoulderAxis = shoulderAxisOf(joints);
    frames.push({
      t: +t.toFixed(3),
      bones,
      ...(Number.isFinite(rootYaw) ? { rootYaw } : {}),
      ...(shoulderAxis ? { shoulderAxis } : {}),
      conf: new Array(BONE_DEFS.length).fill(1)
    });
  }

  return makeSequence(frames, { bpm, audio, danceId, durationSec: dur });
}

/** 用 FBXLoader 离线解析一份 FBX(ArrayBuffer)。 */
export function parseFbxFile(ab) {
  return new FBXLoader().parse(ab, "");
}