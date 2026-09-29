/**
 * contract.js — 实时端与评分端之间的"接口合同"实现。
 *
 * 唯一权威:骨骼索引、坐标轴标定、归一化、模式(全身/手势)、手型特征。
 * 改这里 = 改全局约定。
 */

// ---------------------------------------------------------------------------
// 33 个 MediaPipe landmark 的索引
// ---------------------------------------------------------------------------
export const MEDIAPIPE_INDEX = {
  nose: 0,
  left_shoulder: 11,
  right_shoulder: 12,
  left_elbow: 13,
  right_elbow: 14,
  left_wrist: 15,
  right_wrist: 16,
  left_hip: 23,
  right_hip: 24,
  left_knee: 25,
  right_knee: 26,
  left_ankle: 27,
  right_ankle: 28,
};

// ---------------------------------------------------------------------------
// 骨骼表(两条模式各一套)
// ---------------------------------------------------------------------------

// 全身舞蹈:9 条(脊柱 + 双臂 + 双腿)
export const BONE_DEFS = [
  { name: "spine",       parent: "hips_center",     child: "shoulders_center" },
  { name: "upper_arm_l", parent: "left_shoulder",   child: "left_elbow" },
  { name: "forearm_l",   parent: "left_elbow",      child: "left_wrist" },
  { name: "upper_arm_r", parent: "right_shoulder",  child: "right_elbow" },
  { name: "forearm_r",   parent: "right_elbow",     child: "right_wrist" },
  { name: "thigh_l",     parent: "left_hip",        child: "left_knee" },
  { name: "shin_l",      parent: "left_knee",       child: "left_ankle" },
  { name: "thigh_r",     parent: "right_hip",       child: "right_knee" },
  { name: "shin_r",      parent: "right_knee",      child: "right_ankle" },
  { name: "head",        parent: "shoulders_center", child: "nose" },
];

// 手势舞:只取上半身(脊柱 + 双臂 + 头),不读腿 → 腿的抖动不进入特征
export const UPPER_BONE_DEFS = [
  { name: "spine",       parent: "hips_center",     child: "shoulders_center" },
  { name: "upper_arm_l", parent: "left_shoulder",   child: "left_elbow" },
  { name: "forearm_l",   parent: "left_elbow",      child: "left_wrist" },
  { name: "upper_arm_r", parent: "right_shoulder",  child: "right_elbow" },
  { name: "forearm_r",   parent: "right_elbow",     child: "right_wrist" },
  { name: "head",        parent: "shoulders_center", child: "nose" },
];

export const BONE_COUNT = BONE_DEFS.length; // 9(全身)

// 舞蹈模式:决定骨骼表 + 是否跑手部模型
export const DANCE_MODES = {
  "full-body": {
    label: "全身舞蹈",
    bones: BONE_DEFS,
    hands: false,
    poseModel: "models/pose_landmarker_full.task",
    handModel: "models/hand_landmarker.task",
  },
  gesture: {
    label: "手势舞",
    bones: UPPER_BONE_DEFS,
    hands: true,
    // 手势舞重点在手:身体用 lite(更快,省算力给手);手模型无 lite 版,用 full
    poseModel: "models/pose_landmarker_lite.task",
    handModel: "models/hand_landmarker.task",
  },
};

export function resolveMode(mode) {
  return DANCE_MODES[mode] || DANCE_MODES["full-body"];
}

// ---------------------------------------------------------------------------
// §1 坐标轴标定(已实测锁定,三轴全反)
// ---------------------------------------------------------------------------
export const AXIS_FLIP = { x: -1, y: -1, z: -1 };

// ---------------------------------------------------------------------------
// 基础向量运算
// ---------------------------------------------------------------------------
function landmarkXYZ(lm) {
  if (!lm) return [0, 0, 0];
  return [lm.x * AXIS_FLIP.x, lm.y * AXIS_FLIP.y, lm.z * AXIS_FLIP.z];
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-6) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// ---------------------------------------------------------------------------
// landmark -> 命名关节点
// ---------------------------------------------------------------------------
export function landmarksToJoints(worldLandmarks) {
  const pt = {};
  for (const [name, idx] of Object.entries(MEDIAPIPE_INDEX)) {
    pt[name] = landmarkXYZ(worldLandmarks[idx]);
  }
  return pt;
}

export function addDerivedJoints(pt) {
  return {
    ...pt,
    hips_center: midpoint(pt.left_hip, pt.right_hip),
    shoulders_center: midpoint(pt.left_shoulder, pt.right_shoulder),
  };
}

// ---------------------------------------------------------------------------
// 置信度(含"贴近画面边缘 = 出画"判定,解决看不见的腿乱抖)
// ---------------------------------------------------------------------------
function nearEdge(v) {
  return v != null && (v <= 0.03 || v >= 0.97);
}

export function visibilitiesFromLandmarks(landmarks) {
  const vis = {};
  for (const [name, idx] of Object.entries(MEDIAPIPE_INDEX)) {
    const lm = landmarks?.[idx];
    if (!lm) {
      vis[name] = 0;
      continue;
    }
    const visibility = typeof lm.visibility === "number" ? lm.visibility : 1;
    const presence = typeof lm.presence === "number" ? lm.presence : 1;
    const inFrame = !nearEdge(lm.x) && !nearEdge(lm.y);
    vis[name] = inFrame ? Math.min(visibility, presence) : 0;
  }
  vis.hips_center = Math.min(vis.left_hip, vis.right_hip);
  vis.shoulders_center = Math.min(vis.left_shoulder, vis.right_shoulder);
  return vis;
}

// ---------------------------------------------------------------------------
// 命名关节点 -> 契约姿态(bones + rootYaw + conf),按给定骨骼表
// ---------------------------------------------------------------------------
export function poseFromJoints(joints, vis = {}, boneDefs = BONE_DEFS) {
  const bones = [];
  const conf = [];
  for (const b of boneDefs) {
    const v = normalize(sub(joints[b.child], joints[b.parent]));
    if (v) {
      bones.push(v);
      conf.push(Math.min(vis[b.parent] ?? 1, vis[b.child] ?? 1));
    } else {
      bones.push([0, 0, 0]);
      conf.push(0);
    }
  }
  return { bones, rootYaw: computeRootYaw(joints), conf };
}

function computeRootYaw(joints) {
  const hip = sub(joints.right_hip, joints.left_hip);
  return Math.atan2(hip[2], hip[0]);
}

// 肩轴方向 = normalize(右肩 - 左肩)。与髋轴(rootYaw)相比:
//  - 水平投影(x/z)反映「身体朝向」的偏航,肩点比髋点更稳、更少被遮挡;
//  - y 分量反映躯干侧倾(roll),这是 rootYaw 一维丢失的信息。
export function computeShoulderAxis(joints) {
  return normalize(sub(joints.right_shoulder, joints.left_shoulder));
}

// ---------------------------------------------------------------------------
// 手型特征:HandLandmarker world landmarks(手腕原点)归一化到尺度无关
// 手腕 = 原点,以"手腕→中指掌指关节(索引9)"的长度为 1
// ---------------------------------------------------------------------------
export function normalizeHandShape(worldLandmarks) {
  if (!worldLandmarks || worldLandmarks.length < 10) return null;
  const w = worldLandmarks[0];
  const m = worldLandmarks[9];
  // 手部世界坐标与 pose 世界坐标同源,应用相同的坐标轴标定(否则会上下颠倒/镜像)
  const wc = [w.x * AXIS_FLIP.x, w.y * AXIS_FLIP.y, w.z * AXIS_FLIP.z];
  const mc = [m.x * AXIS_FLIP.x, m.y * AXIS_FLIP.y, m.z * AXIS_FLIP.z];
  const scale = Math.hypot(mc[0] - wc[0], mc[1] - wc[1], mc[2] - wc[2]) || 1;
  return worldLandmarks.map((lm) => {
    const p = [lm.x * AXIS_FLIP.x, lm.y * AXIS_FLIP.y, lm.z * AXIS_FLIP.z];
    return [
      (p[0] - wc[0]) / scale,
      (p[1] - wc[1]) / scale,
      (p[2] - wc[2]) / scale,
    ];
  });
}

// 把 HandLandmarker 的原始结果转成契约 hands 数组
export function handsFromResult(handsResult) {
  const world = handsResult?.worldLandmarks;
  if (!world || world.length === 0) return null;
  const hc = handsResult.handedness || handsResult.handednesses || null;
  const out = [];
  for (let i = 0; i < world.length; i++) {
    const label =
      hc?.[i]?.[0]?.categoryName || hc?.[i]?.[0]?.displayName || null;
    const landmarks = normalizeHandShape(world[i]);
    if (landmarks) out.push({ handedness: label, landmarks });
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// 拼装 §3 帧对象(实时端)
// ---------------------------------------------------------------------------
let seq = 0;

export function buildFrame(t, joints, vis = {}, boneDefs = BONE_DEFS, hands = null, root = null) {
  const { bones, rootYaw, conf } = poseFromJoints(joints, vis, boneDefs);
  const frame = {
    t,
    bones,      // 顺序见所选模式骨骼表
    rootYaw,
    rootYawConf: Math.min(vis.left_hip ?? 1, vis.right_hip ?? 1),
    shoulderAxis: computeShoulderAxis(joints),
    conf,
    _src: "live",
    _seq: seq++,
  };
  if (hands) frame.hands = hands; // 仅 gesture 模式存在
  // 根运动通道(方案 C):rootVel = 髋中点速度(米/秒),grounded = 是否贴地。
  // 均为可选字段,缺省时消费端回退到「脚贴地」运动学(向后兼容旧序列)。
  if (root) {
    if (Array.isArray(root.rootVel)) frame.rootVel = root.rootVel;
    if (typeof root.grounded === "boolean") frame.grounded = root.grounded;
  }
  return frame;
}

// ---------------------------------------------------------------------------
// S3 深度约束:用 2D 夹角先验修正 3D 末端「假性过近」(根因2、3)
// ---------------------------------------------------------------------------
//
// 单目 3D 的深度(z)歧义会让腕/踝相对肘/膝「假性过近」,表现为肘/膝 3D 折叠角
// 明显小于(更折叠于)2D 图像里测得的投影夹角。2D 检测精度高、不受深度歧义影响,
// 故用 2D 夹角作为更可靠的上限先验,把末端沿 3D 平面旋转到至少等于 2D 夹角,
// 抑制过度弯曲。需在 One-Euro 平滑「之前」作用于原始 3D joints。

// 3D 关节夹角(顶点 mid 处):∠(root→mid, end→mid)
function _jointAngle3(root, mid, end) {
  const u = sub(root, mid);
  const v = sub(end, mid);
  const lu = Math.hypot(u[0], u[1], u[2]);
  const lv = Math.hypot(v[0], v[1], v[2]);
  if (lu < 1e-9 || lv < 1e-9) return null;
  return Math.acos(_clamp((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv), -1, 1));
}

function _clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

// 2D 图像夹角(顶点 b 处):归一化图像坐标 x/y,夹角尺度无关
function _jointAngle2D(a, b, c) {
  if (!a || !b || !c) return null;
  const ux = a.x - b.x, uy = a.y - b.y;
  const vx = c.x - b.x, vy = c.y - b.y;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return null;
  return Math.acos(_clamp((ux * vx + uy * vy) / (lu * lv), -1, 1));
}

// 肢体四元组:root/mid/end 的 joint 名(对应 MEDIAPIPE_INDEX)
const LIMB_TRIPLES = [
  { root: "left_shoulder", mid: "left_elbow", end: "left_wrist" },
  { root: "right_shoulder", mid: "right_elbow", end: "right_wrist" },
  { root: "left_hip", mid: "left_knee", end: "left_ankle" },
  { root: "right_hip", mid: "right_knee", end: "right_ankle" },
];

// 目标 γ 的生理 clamp(与 web_dance/retarget.js 一致的保守限位)
const DEPTH_MIN_BEND = 0.55; // ≈31°,统一保守折叠下限
const DEPTH_MAX_BEND = Math.PI;

export function constrainLimbDepth(worldJoints, imgLandmarks) {
  if (!worldJoints || !imgLandmarks) return worldJoints;
  const out = { ...worldJoints };

  for (const t of LIMB_TRIPLES) {
    const J = out[t.root], M = out[t.mid];
    if (!J || !M || !out[t.end]) continue;
    const g3 = _jointAngle3(J, M, out[t.end]);
    const g2 = _jointAngle2D(
      imgLandmarks[MEDIAPIPE_INDEX[t.root]],
      imgLandmarks[MEDIAPIPE_INDEX[t.mid]],
      imgLandmarks[MEDIAPIPE_INDEX[t.end]]
    );
    if (g3 == null || g2 == null) continue;
    // 触发:3D 比 2D 明显更折叠(深度假性过近),且 3D 已处于明显弯曲
    if (!(g3 < g2 - 0.10 && g3 < 1.0)) continue;
    const target = _clamp(g2, DEPTH_MIN_BEND, DEPTH_MAX_BEND);
    if (!(target > g3 + 0.05)) continue;

    // 在 u×v 平面内把末端方向旋转到目标夹角,保持前臂/小腿长度 |v| 不变
    const u = sub(J, M); // mid → root
    const v = sub(out[t.end], M); // mid → end
    const lu = Math.hypot(u[0], u[1], u[2]);
    const lv = Math.hypot(v[0], v[1], v[2]);
    if (lu < 1e-9 || lv < 1e-9) continue;
    const uhat = [u[0] / lu, u[1] / lu, u[2] / lu];

    let n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const ln = Math.hypot(n[0], n[1], n[2]);
    if (ln < 1e-9) continue; // u∥v,方向退化,跳过
    n = [n[0] / ln, n[1] / ln, n[2] / ln];

    let w = [
      n[1] * uhat[2] - n[2] * uhat[1],
      n[2] * uhat[0] - n[0] * uhat[2],
      n[0] * uhat[1] - n[1] * uhat[0],
    ];
    const lw = Math.hypot(w[0], w[1], w[2]);
    if (lw < 1e-9) continue;
    w = [w[0] / lw, w[1] / lw, w[2] / lw];
    // 让 w 与 v 的侧向分量同向,保证 v' 落在 v 原侧
    if (v[0] * w[0] + v[1] * w[1] + v[2] * w[2] < 0) w = [-w[0], -w[1], -w[2]];

    const st = Math.sin(target), ct = Math.cos(target);
    out[t.end] = [
      M[0] + lv * (ct * uhat[0] + st * w[0]),
      M[1] + lv * (ct * uhat[1] + st * w[1]),
      M[2] + lv * (ct * uhat[2] + st * w[2]),
    ];
  }
  return out;
}
