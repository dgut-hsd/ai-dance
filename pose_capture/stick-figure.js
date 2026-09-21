/**
 * stick-figure.js — 2D 火柴人渲染(显示层,与评分无关)。
 *
 * 数据是 3D 的,但 2D 画布只投影 x/y;z 用颜色/粗细编码。
 * boneDefs 决定画哪些骨骼;hands 可选,画手部 21 点骨架。
 * head 骨骼不画连线,改为在鼻子位置画一个圆(标准火柴人头)。
 */

import { BONE_DEFS } from "./contract.js";

// MediaPipe Hand 的 21 点连接关系
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],       // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],  // 中指(含掌 5-9)
  [9, 13], [13, 14], [14, 15], [15, 16],// 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],// 小指(含掌 13-17)
  [0, 17],
];

const HAND_SCALE = 0.09;   // 归一化手型(1 = 腕→中指掌指关节)折算成米的可视大小
const HEAD_RADIUS = 0.06;  // 头圆半径(米),画在 nose 位置

export function renderStickFigure(canvas, joints, boneDefs = BONE_DEFS, hands = null) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pt = joints;
  const scale = h / 2.0;
  const cx = w / 2;
  const cy = h / 2;

  const px = (p) => cx + p[0] * scale;
  const py = (p) => -p[1] * scale + cy;

  const hasHead = boneDefs.some((b) => b.name === "head");

  // 骨骼线(head 跳过,单独画圆)
  for (const b of boneDefs) {
    if (b.name === "head") continue;
    const a = pt[b.parent];
    const c = pt[b.child];
    if (!a || !c) continue;
    const zMid = (a[2] + c[2]) / 2;

    ctx.beginPath();
    ctx.moveTo(px(a), py(a));
    ctx.lineTo(px(c), py(c));
    ctx.strokeStyle = zColor(zMid);
    ctx.lineWidth = 3 + zMid * 2;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  // 关节小点(nose 跳过,由头圆代替)
  const referenced = new Set();
  for (const b of boneDefs) {
    referenced.add(b.parent);
    referenced.add(b.child);
  }
  referenced.delete("nose");
  for (const name of referenced) {
    const p = pt[name];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(px(p), py(p), 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }

  // 头:在鼻子位置画一个圆
  if (hasHead && pt.nose) {
    ctx.beginPath();
    ctx.arc(px(pt.nose), py(pt.nose), HEAD_RADIUS * scale, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = zColor(pt.nose[2]);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 手(手势舞)
  if (hands && Array.isArray(hands)) {
    drawHands(ctx, px, py, pt, hands);
  }
}

function wristFor(handedness, joints) {
  const h = (handedness || "").toLowerCase();
  if (h === "left") return joints.left_wrist;
  if (h === "right") return joints.right_wrist;
  return null;
}

function drawHands(ctx, px, py, joints, hands) {
  ctx.strokeStyle = "#ffd54a";
  ctx.fillStyle = "#ffd54a";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";

  for (const hand of hands) {
    const wrist = wristFor(hand.handedness, joints);
    if (!wrist) continue;
    const lms = hand.landmarks || [];

    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = lms[a];
      const pb = lms[b];
      if (!pa || !pb) continue;
      const wa = [
        wrist[0] + pa[0] * HAND_SCALE,
        wrist[1] + pa[1] * HAND_SCALE,
        wrist[2] + pa[2] * HAND_SCALE,
      ];
      const wb = [
        wrist[0] + pb[0] * HAND_SCALE,
        wrist[1] + pb[1] * HAND_SCALE,
        wrist[2] + pb[2] * HAND_SCALE,
      ];
      ctx.beginPath();
      ctx.moveTo(px(wa), py(wa));
      ctx.lineTo(px(wb), py(wb));
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(px(wrist), py(wrist), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function zColor(z) {
  const t = Math.max(0, Math.min(1, (z + 0.5) / 1.0));
  const r = 255;
  const g = Math.round(100 + 155 * t);
  const b = Math.round(40 + 140 * (1 - t));
  return `rgb(${r}, ${g}, ${b})`;
}

// ---------------------------------------------------------------------------
// 轮廓剪影渲染(Just Dance 风格):把骨架连成一个顺畅丝滑的实心人形剪影。
//
// 与胶囊画法(逐骨粗线)不同:
//   - 四肢画成「渐细平滑肢体」:两侧用二次贝塞尔曲线,关节/端部用圆头收尾;
//   - 躯干是肩/髋四个角点围成的圆角多边形;
//   - 脖子 + 头,整体是一条连续光滑的轮廓,没有"圆柱感"。
//   - 自动按包围盒缩放/居中,画布尺寸随意(适配不同卡片大小)。
// ---------------------------------------------------------------------------

// 剪影配置:limb = 一串顺序关节 + 每个关节的半径(米),用于"渐细"画法
const SILHOUETTE = {
  headRadius: 0.10,
  neck: { joints: ["shoulders_center", "nose"], radii: [0.042, 0.042] },
  torsoCorners: ["left_shoulder", "right_shoulder", "right_hip", "left_hip"],
  limbs: [
    { joints: ["left_shoulder", "left_elbow", "left_wrist"], radii: [0.055, 0.045, 0.032] },
    { joints: ["right_shoulder", "right_elbow", "right_wrist"], radii: [0.055, 0.045, 0.032] },
    { joints: ["left_hip", "left_knee", "left_ankle"], radii: [0.075, 0.060, 0.045] },
    { joints: ["right_hip", "right_knee", "right_ankle"], radii: [0.075, 0.060, 0.045] },
  ],
};
const SILHOUETTE_PAD_FRAC = 0.10;

export function renderPoseSilhouette(canvas, joints, boneDefs = BONE_DEFS, { color = "#e8edff" } = {}) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!joints) return;

  // 包围盒:链上所有关节 + 躯干角点 + 鼻子
  const names = new Set();
  SILHOUETTE.limbs.forEach((c) => c.joints.forEach((n) => names.add(n)));
  SILHOUETTE.torsoCorners.forEach((n) => names.add(n));
  names.add("nose");
  const pts = [...names].map((n) => joints[n]).filter(Boolean);
  if (!pts.length) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const pad = Math.min(W, H) * SILHOUETTE_PAD_FRAC;
  const scale = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const P = (name) => {
    const p = joints[name];
    return p ? [W / 2 + (p[0] - cx) * scale, H / 2 - (p[1] - cy) * scale] : null;
  };

  ctx.fillStyle = color;

  // 1) 躯干:肩线 + 髋线四个角点围成的圆角多边形(实心)
  const torso = SILHOUETTE.torsoCorners.map(P).filter(Boolean);
  if (torso.length >= 3) {
    ctx.beginPath();
    smoothClosed(ctx, torso);
    ctx.fill();
  }

  // 2) 四肢:渐细平滑肢体
  for (const limb of SILHOUETTE.limbs) {
    const pts2 = limb.joints.map(P).filter(Boolean);
    if (pts2.length < 2) continue;
    taperedLimb(ctx, pts2, limb.radii.map((r) => r * scale));
  }

  // 3) 脖子 + 头
  const neck = SILHOUETTE.neck.joints.map(P).filter(Boolean);
  if (neck.length >= 2) taperedLimb(ctx, neck, SILHOUETTE.neck.radii.map((r) => r * scale));
  const nose = P("nose");
  if (nose) {
    ctx.beginPath();
    ctx.arc(nose[0], nose[1], SILHOUETTE.headRadius * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 从当前点出发,用二次贝塞尔平滑地穿过点列(终点落在最后一个点)
function traceSmooth(ctx, pts) {
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  if (pts.length >= 2) ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}

// 平滑闭合曲线(圆角多边形)
function smoothClosed(ctx, pts) {
  const n = pts.length;
  if (n < 2) return;
  ctx.moveTo((pts[0][0] + pts[n - 1][0]) / 2, (pts[0][1] + pts[n - 1][1]) / 2);
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const nxt = pts[(i + 1) % n];
    ctx.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2);
  }
  ctx.closePath();
}

// 渐细平滑肢体:两侧平滑曲线围成的实心形状,关节/端部用圆头收尾
function taperedLimb(ctx, pts, radii) {
  const n = pts.length;
  if (n < 2) return;

  // 每点法线(2D):端点取所在段方向,内部取相邻两段方向平均(平滑转折)
  const N = [];
  for (let i = 0; i < n; i++) {
    let dx, dy;
    if (i === 0) { dx = pts[1][0] - pts[0][0]; dy = pts[1][1] - pts[0][1]; }
    else if (i === n - 1) { dx = pts[n - 1][0] - pts[n - 2][0]; dy = pts[n - 1][1] - pts[n - 2][1]; }
    else {
      const d1x = pts[i][0] - pts[i - 1][0], d1y = pts[i][1] - pts[i - 1][1];
      const d2x = pts[i + 1][0] - pts[i][0], d2y = pts[i + 1][1] - pts[i][1];
      const l1 = Math.hypot(d1x, d1y) || 1, l2 = Math.hypot(d2x, d2y) || 1;
      dx = d1x / l1 + d2x / l2; dy = d1y / l1 + d2y / l2;
    }
    const len = Math.hypot(dx, dy) || 1;
    N.push([-dy / len, dx / len]);
  }

  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    L.push([pts[i][0] + N[i][0] * radii[i], pts[i][1] + N[i][1] * radii[i]]);
    R.push([pts[i][0] - N[i][0] * radii[i], pts[i][1] - N[i][1] * radii[i]]);
  }

  ctx.beginPath();
  ctx.moveTo(L[0][0], L[0][1]);
  traceSmooth(ctx, L);
  ctx.lineTo(R[n - 1][0], R[n - 1][1]);
  traceSmooth(ctx, R.slice().reverse());
  ctx.closePath();
  ctx.fill();

  // 圆头/圆关节(覆盖端部直线段,并平滑肘/膝等转折)
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.arc(pts[i][0], pts[i][1], radii[i], 0, Math.PI * 2);
    ctx.fill();
  }
}
