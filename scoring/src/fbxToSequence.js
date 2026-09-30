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

// 契约 §1/§2.5:rootYaw = atan2(hipAxis.z, hipAxis.x),hipAxis = right_hip − left_hip。
// 缺 rootYaw 时 chartCodec 的 targetYaw 为 undefined,评分侧 yaw 对齐拿不到基准。
// 导出供离线生成器/单测直接复用(sampleFbxFrames 内部也走这两个函数,保证只有一份算法)。
export function hipRootYaw(joints) {
  const r = joints?.right_hip, l = joints?.left_hip;
  if (!r || !l) return undefined;
  return Math.atan2(r[2] - l[2], r[0] - l[0]);
}
/** 肩轴 = normalize(右肩 − 左肩);与 pose_capture/contract.js 的 computeShoulderAxis 同式。 */
export function shoulderAxisOf(joints) {
  const r = joints?.right_shoulder, l = joints?.left_shoulder;
  return r && l ? norm(sub(r, l)) : undefined;
}
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
// ---------------------------------------------------------------------------
// v2 可选字段(FBX 直导,补丁Ⅴ):把 FBX 里被压成 10 骨单位向量时丢掉的朝向补导出来。
// 为什么需要:retarget.js 的 bodyYaw(骨盆偏航 =「转弯」)依赖 rootYaw/shoulderAxis,
// 只导单位向量的话 FBX 教练的骨盆偏航永不更新,看起来「不转身」。
// 全部为可选字段,消费端按「字段是否存在」回退(见 docs/motion-beat-optimization.md §10.9)。
//   rootYaw       髋轴偏航 atan2(hip.z, hip.x)
//   shoulderAxis  肩轴单位向量(右肩−左肩,canonical)
//   torsoTwist    胸椎扭转 = 肩轴偏航 − 髋轴偏航
//   torsoRoll / torsoPitch  躯干侧倾 / 前倾(由脊柱方向分解)
//   armTwist      [左上臂,右上臂,左前臂,右前臂] 绕长轴的轴向扭转
// ---------------------------------------------------------------------------
const ARM_TWIST_BONES = ["leftarm", "rightarm", "leftforearm", "rightforearm"];

// 「首帧是 bind pose」的判定:两个条件同时成立才丢 ——
//   (1) 首帧与骨架静态(bind)姿态足够接近(留 25° 余量:派生关节如「髋→肩中点」会差几度);
//   (2) 首帧→第二帧是一个明显跳变(> 10°/帧,而正常舞蹈帧间只有 ~9°)。
// 实测:copydance1(Rokoko)= 5.8° / 111° → 丢;内置 hiphop(Mixamo)= 98° / 1.8° → 保留,不受影响。
const BIND_FRAME_EPS_RAD = 25 * Math.PI / 180;
const BIND_FRAME_JUMP_RAD = 10 * Math.PI / 180;

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** 各臂骨「长轴」在该骨自身坐标系下的方向(休息姿态采样;不假设局部 Y 轴就是长轴)。 */
function armTwistAxes(THREE, B) {
  return ARM_TWIST_BONES.map((name) => {
    const bone = B.get(name);
    if (!bone) return null;
    const child = bone.children.find((c) => c.isBone) || bone;
    return child.getWorldPosition(new THREE.Vector3())
      .sub(bone.getWorldPosition(new THREE.Vector3()))
      .normalize()
      .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert())
      .normalize();
  });
}

/** swing-twist 分解里绕长轴的扭转量:2·atan2(旋转向量·长轴, w)。 */
function armTwistValues(THREE, B, axes) {
  return axes.map((axis, i) => {
    if (!axis) return 0;
    const q = B.get(ARM_TWIST_BONES[i]).getWorldQuaternion(new THREE.Quaternion());
    return +(2 * Math.atan2(q.x * axis.x + q.y * axis.y + q.z * axis.z, q.w)).toFixed(4);
  });
}

/**
 * 采样一段 FBX 动画为契约帧(30fps,短片段按 loopTo 秒循环)。
 * 两条消费路径(浏览器点谱面编辑器 / Node 的 export-songs)都从这里取帧,避免各写一份。
 * @returns {{ frames: object[], durationSec: number }}
 */
export function sampleFbxFrames(THREE, clip, root, { loopTo = 24 } = {}) {
  const basis = computeCanonicalBasis(THREE, root);
  const B = collectBones(root);
  const jointBone = {};
  for (const [joint, keys] of Object.entries(JOINT_BONES)) {
    for (const k of keys) { if (B.has(k)) { jointBone[joint] = B.get(k); break; } }
  }
  const twistAxes = armTwistAxes(THREE, B); // 必须在播放前采样(此时还是休息姿态)
  const readJoints = () => {
    const hips = jointBone.hips_center?.getWorldPosition(new THREE.Vector3());
    if (!hips) return null;
    const J = {};
    for (const [joint, bone] of Object.entries(jointBone)) {
      J[joint] = toCanonical(bone.getWorldPosition(new THREE.Vector3()), hips, basis);
    }
    return {
      ...J,
      shoulders_center: J.left_shoulder && J.right_shoulder
        ? [(J.left_shoulder[0] + J.right_shoulder[0]) / 2,
           (J.left_shoulder[1] + J.right_shoulder[1]) / 2,
           (J.left_shoulder[2] + J.right_shoulder[2]) / 2]
        : [0, 0, 0],
    };
  };
  const contractBones = (joints) => BONE_DEFS.map((b) => norm(sub(joints[b.child], joints[b.parent])));
  const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

  // 有些 FBX 导出(例如 Rokoko)会把骨架静态姿态(bind pose / T-pose)当成第 0 帧。
  // 先记下这个姿态的契约骨方向,采样完再看首帧是不是它 —— 是就丢掉(见循环之后)。
  root.updateMatrixWorld(true);
  const bindJoints = readJoints();
  const bindBones = bindJoints ? contractBones(bindJoints) : null;
  // 根位移与骨盆倾斜的基准(必须在播放前采):
  //   bindHipsWorld 髋的世界位置;hipUnit 髋高(髋到最低脚踝的竖直距离)当作体尺 → 位移按它归一化,
  //   目标端再乘自己的髋高,这样与骨架绝对尺寸无关。
  const bindHipsWorld = jointBone.hips_center ? jointBone.hips_center.getWorldPosition(new THREE.Vector3()) : null;
  const footYs = ["left_ankle", "right_ankle"]
    .map((k) => jointBone[k]?.getWorldPosition(new THREE.Vector3()).y)
    .filter((y) => Number.isFinite(y));
  const hipUnit = bindHipsWorld && footYs.length
    ? Math.max(0.05, Math.abs(bindHipsWorld.y - Math.min(...footYs)))
    : 0;
  // 骨盆倾斜要输出「相对 bind 姿态的增量」:目标骨架的休息姿态本身就带倾斜(基准对齐过的),
  // 输出绝对角会在目标上**重复计入**一次(实测三种符号组合全变差)。
  const pelvisTiltOf = (bone) => {
    if (!bone) return null;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()));
    return [
      Math.atan2(up.dot(basis.forward), up.dot(basis.up)),  // pitch
      Math.atan2(up.dot(basis.right), up.dot(basis.up)),    // roll
    ];
  };
  const bindPelvisTilt = pelvisTiltOf(B.get("hips"));

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
    const joints = readJoints();
    if (!joints) continue;
    const bones = contractBones(joints);
    // v2 朝向字段(见本函数上方的说明):髋轴/肩轴/扭转/侧倾前倾/手臂轴向扭转
    const shoulderAxis = shoulderAxisOf(joints);
    const rootYaw = hipRootYaw(joints);
    const torsoUp = norm(joints.shoulders_center); // canonical 里髋即原点
    // 追加字段(可选,消费端按存在性判断):
    //   rootPos       根位移 = (髋世界位置 − bind 位置) 投到 canonical 基、再除以髋高 → 与骨架尺寸无关
    //   pelvisPitch/Roll  骨盆上轴的绝对前倾/侧倾(骨盆自身坐标,休息姿态≈0)
    const hb = B.get("hips");
    const tilt = pelvisTiltOf(hb);
    const hipsNow = jointBone.hips_center?.getWorldPosition(new THREE.Vector3());
    const rootPos = bindHipsWorld && hipsNow
      ? hipsNow.clone().sub(bindHipsWorld).divideScalar(hipUnit || 1)
      : null;
    frames.push({
      t: +t.toFixed(3),
      bones,
      conf: new Array(BONE_DEFS.length).fill(1),
      rootYaw: +rootYaw.toFixed(4),
      rootYawConf: 1,
      shoulderAxis: [+shoulderAxis[0].toFixed(4), +shoulderAxis[1].toFixed(4), +shoulderAxis[2].toFixed(4)],
      torsoTwist: +wrapAngle(Math.atan2(shoulderAxis[2], shoulderAxis[0]) - rootYaw).toFixed(4),
      torsoRoll: +Math.atan2(torsoUp[0], torsoUp[1]).toFixed(4),
      torsoPitch: +Math.atan2(torsoUp[2], torsoUp[1]).toFixed(4),
      armTwist: armTwistValues(THREE, B, twistAxes),
      ...(rootPos ? { rootPos: [+rootPos.dot(basis.right).toFixed(4), +rootPos.dot(basis.up).toFixed(4), +rootPos.dot(basis.forward).toFixed(4)] } : {}),
      ...(tilt && bindPelvisTilt ? {
        pelvisPitch: +(tilt[0] - bindPelvisTilt[0]).toFixed(4),
        pelvisRoll: +(tilt[1] - bindPelvisTilt[1]).toFixed(4),
      } : {}),
    });
  }
  // 首帧 == 骨架 bind pose、而第二帧已经是真动作 → 丢掉这个「T-pose 帧」,时间轴整体前移一帧。
  // 不丢的话:播放会从 T-pose 猛切进动作(看着不连贯),而且这一帧会被当成 t=0 的参考姿态参与判定。
  if (bindBones && frames.length > 2) {
    const toBind = Math.max(...frames[0].bones.map((v, i) => angleBetween(v, bindBones[i])));
    const toNext = Math.max(...frames[0].bones.map((v, i) => angleBetween(v, frames[1].bones[i])));
    if (toBind < BIND_FRAME_EPS_RAD && toNext > BIND_FRAME_JUMP_RAD) {
      frames.shift();
      frames.forEach((f, i) => { f.t = +(i * dt).toFixed(3); });
      console.warn(
        `[fbxToSequence] 源片段第 0 帧是骨架 bind pose(与静态姿态差 ${(toBind * 180 / Math.PI).toFixed(1)}°,` +
        `下一帧差 ${(toNext * 180 / Math.PI).toFixed(1)}°):已丢弃并整体前移 ${dt.toFixed(4)}s`,
      );
    }
  }
  return { frames, durationSec: dur };
}

export function fbxClipToSequence(THREE, clip, root, { bpm = 120, audio = "pop-demo.wav", danceId = "fbx-dance", loopTo = 24 } = {}) {
  const { frames, durationSec } = sampleFbxFrames(THREE, clip, root, { loopTo });
  return makeSequence(frames, { bpm, audio, danceId, durationSec });
}
// hipRootYaw / shoulderAxisOf 已在上面用 `export function` 导出(离线生成器按名字取用)。
export { DIMS, SAMPLING_FPS };