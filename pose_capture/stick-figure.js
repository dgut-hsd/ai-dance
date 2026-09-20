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
