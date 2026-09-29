import { BONE_DEFS } from "../../pose_capture/contract.js";
const SAMPLING_FPS = 30;
const DIMS = {
  spineLen: 0.52, shoulderWidth: 0.38, hipWidth: 0.32,
  upperArm: 0.28, forearm: 0.26, thigh: 0.44, shin: 0.42, headLen: 0.22,
};
function normalizeBoneName(name) {
  return String(name).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");
}
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
function computeCanonicalBasis(THREE, root) {
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
function toCanonical(p, hips, basis) {
  const d = p.clone().sub(hips);
  return [d.dot(basis.right), d.dot(basis.up), d.dot(basis.forward)];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-6 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
};
export function makeSequence(frames, { bpm, audio, danceId, durationSec }) {
  const beat = 60 / bpm;
  const notes = [];
  for (let t = 0; t <= durationSec; t += beat * 2) {
    notes.push({ id: `${danceId}-${Math.round(t * 1000)}`, t: +t.toFixed(3), type: "pose" });
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
    chart: { version: "chart/v2", audio, notes },
  };
}
export function fbxClipToSequence(THREE, clip, root, { bpm = 120, audio = "pop-demo.wav", danceId = "fbx-dance", loopTo = 24 } = {}) {
  const basis = computeCanonicalBasis(THREE, root);
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
    frames.push({ t: +t.toFixed(3), bones, conf: new Array(BONE_DEFS.length).fill(1) });
  }
  return makeSequence(frames, { bpm, audio, danceId, durationSec: dur });
}
export { DIMS, SAMPLING_FPS };