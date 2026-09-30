/**
 * audit-retarget.mjs — 重定向质量体检(两条渲染路径 vs 源 FBX 的真值)。
 *
 * 用途:改完重定向 / ROM / 碰撞 / 基准之后跑一遍,看数字有没有变好 —— 别凭手感调。
 *
 * 用法:
 *   node tools/audit-retarget.mjs                        # 默认体检 copydance1
 *   node tools/audit-retarget.mjs <源fbx> <模型fbx>
 *
 * 指标:10 根契约骨的方向误差(均值/P95/最大)、肘/膝弯折角误差、手进躯干与腿交叉(穿模代理)、
 *       脚底离地与髋高(根运动)。两套基准(通用 Mixamo 参考 / 每支舞自己的源)都测,便于对比。
 *
 * 口径提醒:「头」不要用「肩中点→头关节」(那由脖子决定)或「Head→HeadTop_End 方向」
 * (受骨架局部轴约定影响)判好坏;头的真实误差看 Head 骨世界朝向的四元数夹角,实测 1~3°。
 */
// 最小 DOM 垫片:Node 里 FBXLoader 解析带贴图的模型会碰 document;这里不解码贴图,给个空壳即可。
if (!globalThis.document) {
  const fake = () => ({
    width: 0, height: 0, style: {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, remove() {},
    set src(_v) {}, get src() { return ""; },
  });
  globalThis.document = { createElementNS: () => fake(), createElement: () => fake() };
  if (typeof globalThis.URL.createObjectURL !== "function") {
    globalThis.URL.createObjectURL = () => "blob:stub";
    globalThis.URL.revokeObjectURL = () => {};
  }
}
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { parseFbxFile, fbxClipToSequence } from "../scoring/examples/song-sources.js";
import { captureRestPose, retargetClipToSkeleton } from "../web_dance/dance-library.js";
import { Retargeter } from "../web_dance/retarget.js";
import { applyRetargetTPose } from "../web_dance/avatar.js";
import { createCoachGrounding } from "../web_dance/coach-grounding.js";
import { resolveMode } from "../pose_capture/contract.js";
import { meshSurfaceRadii } from "../web_dance/mesh-collision-radii.js";
import { closestSegmentPoints } from "../web_dance/collision.js";

// 位置参数 = [源 fbx] [模型 fbx];以 -- 开头的是开关,不参与位置参数
const POS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SRC = POS[0] || "songs/copydance1/copydance1.fbx";
const DG = POS[1] || "models/dancer_girl.fbx";
// --radii=<formula|0..1>:碰撞代理半径模式/混合系数(默认 mesh=1,即按蒙皮网格实测)
const RADII_ARG = (process.argv.find((a) => a.startsWith("--radii=")) || "").split("=")[1] ?? "";
const RADII_OPTS = RADII_ARG === "formula" ? { radiiMode: "formula" }
  : RADII_ARG && Number.isFinite(Number(RADII_ARG)) ? { radiiMode: "mesh", radiiBlend: Number(RADII_ARG) }
  : {};
// --allowance=<0..>:碰撞允许量(只压超过它的深层穿插,单位=模型单位)
const ALLOW_ARG = (process.argv.find((a) => a.startsWith("--allowance=")) || "").split("=")[1] ?? "";
const ALLOW_OPTS = ALLOW_ARG && Number.isFinite(Number(ALLOW_ARG)) ? { collisionAllowance: Number(ALLOW_ARG) } : {};
const ab = (p) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => { const l = Math.hypot(...v); return l < 1e-9 ? [0, 0, 0] : v.map((x) => x / l); };
const ANG = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
const BONES = ["spine", "head", "upper_arm_l", "forearm_l", "upper_arm_r", "forearm_r", "thigh_l", "shin_l", "thigh_r", "shin_r"];
const PAIRS = {
  spine: ["hips_center", "shoulders_center"], head: ["shoulders_center", "nose"],
  upper_arm_l: ["left_shoulder", "left_elbow"], forearm_l: ["left_elbow", "left_wrist"],
  upper_arm_r: ["right_shoulder", "right_elbow"], forearm_r: ["right_elbow", "right_wrist"],
  thigh_l: ["left_hip", "left_knee"], shin_l: ["left_knee", "left_ankle"],
  thigh_r: ["right_hip", "right_knee"], shin_r: ["right_knee", "right_ankle"],
};
const BEND = { elbow_l: [["upper_arm_l"], ["forearm_l"]], elbow_r: [["upper_arm_r"], ["forearm_r"]], knee_l: [["thigh_l"], ["shin_l"]], knee_r: [["thigh_r"], ["shin_r"]] };

const _nm = (s) => String(s).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");

/** 「把源骨架的 T-pose 整段搬过来」:目标骨的世界朝向 = 源骨休息姿态的世界朝向(含 roll)。 */
function applySourceOrientations(target, srcRoot) {
  target.updateMatrixWorld(true);
  srcRoot.updateMatrixWorld(true);
  const TB = new Map(), SB = [];
  target.traverse((o) => { if (o.isBone) TB.set(_nm(o.name), o); });
  srcRoot.traverse((o) => { if (o.isBone) SB.push(o); });
  for (const sb of SB) {
    const tb = TB.get(_nm(sb.name));
    if (!tb) continue;
    const srcWorld = sb.getWorldQuaternion(new THREE.Quaternion());
    const parentWorld = tb.parent ? tb.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    tb.quaternion.copy(parentWorld.invert().multiply(srcWorld));
    target.updateMatrixWorld(true);
  }
}

// 头的真实朝向:Head 骨 → HeadTop_End(两侧都精确取这根骨,避免选错子骨)
function headDirOf(root, basis) {
  const head = root.getObjectByName("mixamorigHead");
  if (!head) return null;
  const child = head.children.find((c) => c.isBone && /^mixamorigHeadTop_End$/i.test(c.name))
    ?? head.children.find((c) => c.isBone);
  if (!child) return null;
  const d = child.getWorldPosition(new THREE.Vector3()).sub(head.getWorldPosition(new THREE.Vector3()));
  if (d.lengthSq() < 1e-12) return null;
  d.normalize();
  return [d.dot(basis.right), d.dot(basis.up), d.dot(basis.forward)];
}

function setNeutral(o) {
  const m = new THREE.AnimationMixer(o);
  m.clipAction(o.animations[0]).play();
  m.update(0);
  o.updateMatrixWorld(true);
  let h;
  o.traverse((n) => { if (n.isBone && /(?:^|[:._-])head$/i.test(n.name.replace(/^mixamorig/i, ""))) h = n; });
  if (h) {
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(h.getWorldQuaternion(new THREE.Quaternion()));
    h.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.atan2(-f.y, f.z)));
    o.updateMatrixWorld(true);
  }
}
function avatar({ tpose = true, refSrc = null } = {}) {
  const root = parseFbxFile(ab(DG));
  setNeutral(root);
  if (tpose === true) applyRetargetTPose(root);
  else if (tpose === "perDance" && refSrc) applySourceOrientations(root, parseFbxFile(ab(refSrc)));
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  root.scale.setScalar(2.2 / box.getSize(new THREE.Vector3()).y);
  root.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(root);
  const c = b2.getCenter(new THREE.Vector3());
  root.position.x -= c.x; root.position.z -= c.z; root.position.y -= b2.min.y;
  root.updateMatrixWorld(true);
  const rt = new Retargeter(root);
  captureRestPose(root);
  return { root, rt };
}
function jointsOf(root, basis) {
  const V = (n) => root.getObjectByName(n)?.getWorldPosition(new THREE.Vector3());
  const hipsV = V("mixamorigHips");
  const toC = (p) => { const d = p.clone().sub(hipsV); return [d.dot(basis.right), d.dot(basis.up), d.dot(basis.forward)]; };
  const P = (n) => toC(V(n));
  const la = P("mixamorigLeftArm"), ra = P("mixamorigRightArm");
  return {
    hips_center: [0, 0, 0], shoulders_center: [(la[0] + ra[0]) / 2, (la[1] + ra[1]) / 2, (la[2] + ra[2]) / 2],
    left_shoulder: la, left_elbow: P("mixamorigLeftForeArm"), left_wrist: P("mixamorigLeftHand"),
    right_shoulder: ra, right_elbow: P("mixamorigRightForeArm"), right_wrist: P("mixamorigRightHand"),
    left_hip: P("mixamorigLeftUpLeg"), left_knee: P("mixamorigLeftLeg"), left_ankle: P("mixamorigLeftFoot"),
    right_hip: P("mixamorigRightUpLeg"), right_knee: P("mixamorigRightLeg"), right_ankle: P("mixamorigRightFoot"),
    nose: P("mixamorigHead"),
  };
}
const dirsOf = (J) => Object.fromEntries(Object.entries(PAIRS).map(([k, [p, c]]) => [k, norm(sub(J[c], J[p]))]));
const bendOf = (d) => Object.fromEntries(Object.entries(BEND).map(([k, [[a], [b]]]) => [k, ANG(d[a], d[b])]));
function penOf(J, unit = 0.24) {
  const axis = (p, a, b) => { const v = sub(b, a), w = sub(p, a); const t = Math.max(0, Math.min(1, (w[0] * v[0] + w[1] * v[1] + w[2] * v[2]) / (v[0] ** 2 + v[1] ** 2 + v[2] ** 2 || 1))); return Math.hypot(w[0] - v[0] * t, w[1] - v[1] * t, w[2] - v[2] * t) / unit; };
  return { hand: Math.min(axis(J.left_wrist, J.hips_center, J.shoulders_center), axis(J.right_wrist, J.hips_center, J.shoulders_center)), leg: Math.min(axis(J.left_ankle, J.right_hip, J.right_ankle), axis(J.right_ankle, J.left_hip, J.left_ankle)) };
}

const srcSeq = (() => { const r = parseFbxFile(ab(SRC)); return fbxClipToSequence(r.animations[0], r, { bpm: 103.36, audio: "x", danceId: "c", loopTo: 0 }); })();
const defs = resolveMode("full-body").bones;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// 源的头朝向(同一口径:Head → HeadTop_End),按源自己的 canonical 基换算,逐帧
const srcHeadDirs = (() => {
  const root = parseFbxFile(ab(SRC));
  const clip0 = root.animations[0];
  const B = new Map();
  root.traverse((o) => { if (o.isBone) B.set(_nm(o.name), o); });
  root.updateMatrixWorld(true);
  const wp = (k) => B.get(k)?.getWorldPosition(new THREE.Vector3()) ?? null;
  const hips0 = wp("hips"), la0 = wp("leftarm"), ra0 = wp("rightarm");
  const chest0 = wp("spine2") ?? wp("spine1");
  const up = chest0.clone().sub(hips0).normalize();
  const right = ra0.clone().sub(la0).normalize();
  const forward = new THREE.Vector3().crossVectors(right, up).normalize();
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip0).play();
  const out = [];
  const n = Math.round(clip0.duration * 30);
  for (let i = 0; i <= n; i++) {
    if (i > 0) mixer.update(1 / 30);
    root.updateMatrixWorld(true);
    const head = wp("head");
    const top = wp("headtop_end");
    if (!head || !top) { out.push(null); continue; }
    const d = top.clone().sub(head).normalize();
    out.push([d.dot(right), d.dot(up), d.dot(forward)]);
  }
  return out;
})();

function summarize(label, rows) {
  const dirErr = {}, bendErr = {};
  for (const k of BONES) dirErr[k] = [];
  for (const k of Object.keys(BEND)) bendErr[k] = [];
  const hands = [], legs = [], feet = [], hips = [], headReal = [], overlaps = [];
  for (const r of rows) {
    for (const k of BONES) dirErr[k].push(r.dirErr[k]);
    for (const k of Object.keys(BEND)) bendErr[k].push(r.bendErr[k]);
    hands.push(r.pen.hand); legs.push(r.pen.leg); feet.push(r.footY); hips.push(r.hipY);
    if (r.headReal != null) headReal.push(r.headReal);
    if (r.overlap != null) overlaps.push(r.overlap);
  }
  const all = BONES.filter((k) => k !== "head").flatMap((k) => dirErr[k]);
  console.log(`\n=== ${label} ===`);
  console.table(BONES.map((k) => ({
    骨: k === "head" ? "head(契约口径,仅参考)" : k,
    均值: (dirErr[k].reduce((a, b) => a + b, 0) / dirErr[k].length).toFixed(1) + "°",
    P95: pct(dirErr[k], 0.95).toFixed(0) + "°",
    最大: Math.max(...dirErr[k]).toFixed(0) + "°",
  })));
  console.log(`  9 骨平均(不含 head) ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)}°  P95 ${pct(all, 0.95).toFixed(1)}°`);
  console.log("  注:「head」这一行是契约口径(肩中点→头关节,方向由脖子决定),不进总平均;" +
    "头的真实误差要用 Head 骨世界朝向四元数夹角单独量,实测 1~3°。");
  if (headReal.length) console.log(`  头骨真实朝向(Head→HeadTop_End)误差:均值 ${(headReal.reduce((a, b) => a + b, 0) / headReal.length).toFixed(1)}°  最大 ${Math.max(...headReal).toFixed(0)}°`);
  console.log(`  弯折角误差  肘 ${((bendErr.elbow_l.reduce((a, b) => a + b, 0) / bendErr.elbow_l.length).toFixed(1))}°/${((bendErr.elbow_r.reduce((a, b) => a + b, 0) / bendErr.elbow_r.length).toFixed(1))}°  膝 ${((bendErr.knee_l.reduce((a, b) => a + b, 0) / bendErr.knee_l.length).toFixed(1))}°/${((bendErr.knee_r.reduce((a, b) => a + b, 0) / bendErr.knee_r.length).toFixed(1))}°`);
  console.log(`  穿模:手进躯干 ${hands.filter((h) => h < 0.35).length}/${hands.length} 帧(最小 ${Math.min(...hands).toFixed(2)})  腿交叉 ${legs.filter((l) => l < 0.12).length} 帧(最小 ${Math.min(...legs).toFixed(2)})`);
  if (overlaps.length) {
    const bad = overlaps.filter((g) => g < 0).length;
    const min = Math.min(...overlaps);
    console.log(`  网格级穿模(实测表面,负=肉眼可见压进去):${bad}/${overlaps.length} 帧(${(bad / overlaps.length * 100).toFixed(1)}%)  最深 ${min.toFixed(3)}(占身高 ${(min / 2.2 * 100).toFixed(1)}%)`);
  }
  console.log(`  脚底 Y ${Math.min(...feet).toFixed(3)}~${Math.max(...feet).toFixed(3)}(摆幅 ${(Math.max(...feet) - Math.min(...feet)).toFixed(3)})  髋高 ${Math.min(...hips).toFixed(2)}~${Math.max(...hips).toFixed(2)}`);
}

// ---- 表演路径 ----
function perfRows(opts = {}) {
  const { root, rt } = avatar({ tpose: opts.perDance ? "perDance" : true, refSrc: opts.perDance ? SRC : null });
  const R = meshSurfaceRadii(root); // 网格实测真实表面(度量"肉眼看到的穿模")
  const sr = parseFbxFile(ab(SRC));
  const clip = retargetClipToSkeleton(sr.animations[0], sr, root, { preserveArmRotations: true, collision: true, rootMotion: true, ...RADII_OPTS, ...ALLOW_OPTS, ...opts });
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.update(0);
  // 源片段第 0 帧若是 bind pose 会被丢掉 → 时间栅格整体前移,比对源时要对齐
  const shift = Math.max(0, srcSeq.frames.length - clip.tracks[0].times.length);
  const n = Math.round(clip.duration * 30);
  const rows = [];
  const V = (nm) => root.getObjectByName(nm)?.getWorldPosition(new THREE.Vector3());
  for (let i = 0; i <= n; i++) {
    if (i > 0) mixer.update(1 / 30);
    const J = jointsOf(root, rt.basis);
    const d = dirsOf(J);
    const src = srcSeq.frames[Math.min(i + shift, srcSeq.frames.length - 1)];
    const sBend = bendOf(Object.fromEntries(BONES.map((k) => [k, src.bones[defs.findIndex((b) => b.name === k)]])));
    const tBend = bendOf(d);
    const hd = headDirOf(root, rt.basis);
    const sh = srcHeadDirs[Math.min(i + shift, srcHeadDirs.length - 1)];
    rows.push({
      dirErr: Object.fromEntries(BONES.map((k) => [k, ANG(d[k], src.bones[defs.findIndex((b) => b.name === k)])])),
      bendErr: Object.fromEntries(Object.keys(BEND).map((k) => [k, Math.abs(sBend[k] - tBend[k])])),
      headReal: hd && sh ? ANG(hd, sh) : null,
      pen: penOf(J),
      overlap: meshOverlapOf(root, R),
      footY: Math.min(...["mixamorigLeftFoot", "mixamorigRightFoot", "mixamorigLeftToeBase", "mixamorigRightToeBase"].map(V).filter(Boolean).map((p) => p.y)),
      hipY: V("mixamorigHips").y,
    });
  }
  return rows;
}

// 网格级穿模(实测表面):只量「前臂+手」这段(肘→手尖)——用户抱怨的"手交叉陷进身体"就是它。
// 上臂贴着躯干是正常接触,不算穿模,所以不量上臂。负=肉眼可见压进去。
function meshOverlapOf(root, R) {
  const V = (n) => root.getObjectByName(n)?.getWorldPosition(new THREE.Vector3());
  const hips = V("mixamorigHips");
  const chest = V("mixamorigSpine2") ?? V("mixamorigSpine1");
  const headP = V("mixamorigHead");
  let worst = Infinity;
  for (const side of ["Left", "Right"]) {
    const elbow = V(`mixamorig${side}ForeArm`);
    const handBone = root.getObjectByName(`mixamorig${side}Hand`);
    const tip = (handBone?.children.find((c) => c.isBone) ?? handBone).getWorldPosition(new THREE.Vector3());
    const seg = [elbow, tip];
    const r = Math.max(R.armLowerR, R.handR);
    const { pa, pb } = closestSegmentPoints(seg[0], seg[1], hips, chest);
    worst = Math.min(worst, pa.distanceTo(pb) - (r + R.torsoR));
    const { pa: pa2, pb: pb2 } = closestSegmentPoints(seg[0], seg[1], headP, headP);
    worst = Math.min(worst, pa2.distanceTo(pb2) - (r + R.headR));
  }
  return worst;
}

// ---- 教练路径(含 createCoachGrounding,与运行时一致)----
function coachRows(opts = {}) {
  const { root, rt } = avatar({ tpose: opts.perDance ? "perDance" : true, refSrc: opts.perDance ? SRC : null });
  const ground = createCoachGrounding(root);
  const rows = [];
  const V = (nm) => root.getObjectByName(nm)?.getWorldPosition(new THREE.Vector3());
  let fi = 0;
  for (const f of srcSeq.frames) {
    rt.applyFrame(f, { boneDefs: defs, mirror: false, rootMotion: false, ...opts });
    ground();
    const J = jointsOf(root, rt.basis);
    const d = dirsOf(J);
    const sBend = bendOf(Object.fromEntries(BONES.map((k) => [k, f.bones[defs.findIndex((b) => b.name === k)]])));
    const tBend = bendOf(d);
    const hd = headDirOf(root, rt.basis);
    const sh = srcHeadDirs[Math.min(fi, srcHeadDirs.length - 1)];
    fi++;
    rows.push({
      dirErr: Object.fromEntries(BONES.map((k) => [k, ANG(d[k], f.bones[defs.findIndex((b) => b.name === k)])])),
      bendErr: Object.fromEntries(Object.keys(BEND).map((k) => [k, Math.abs(sBend[k] - tBend[k])])),
      headReal: hd && sh ? ANG(hd, sh) : null,
      pen: penOf(J),
      footY: Math.min(...["mixamorigLeftFoot", "mixamorigRightFoot", "mixamorigLeftToeBase", "mixamorigRightToeBase"].map(V).filter(Boolean).map((p) => p.y)),
      hipY: V("mixamorigHips").y,
    });
  }
  return rows;
}

summarize("表演路径:基准 = 烘好的 hiphop 参考", perfRows());
summarize("表演路径:基准 = 这支舞自己的源(per-dance)", perfRows({ perDance: true }));
summarize("教练路径:基准 = 烘好的 hiphop 参考", coachRows());
summarize("教练路径:基准 = 这支舞自己的源(per-dance)", coachRows({ perDance: true }));
