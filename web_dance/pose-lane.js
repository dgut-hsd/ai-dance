/**
 * pose-lane.js — 右下角判定轨道(Just Dance 式姿势提示卡)的纯逻辑层。
 *
 * 这里只放「数学 / 决策」,不碰 DOM、不碰 three.js,所以可以在 Node 里直接跑测试
 * (见 test/pose-lane.test.js)。main.js 负责把这里算出来的计划落到 DOM 上。
 *
 * 坐标系约定(与 pose_capture/playback.js 的 reconstructJoints 一致):
 *   joints 是 canonical 坐标,x = 右,y = 上,z = 朝镜头;
 *   laneJointToPixel / laneArrowSpec 里的 x/y 是「画布像素」,y 向下。
 *
 * 轨道语义:谱面上的动作点时刻 = 剪影抵达判定平台的时刻,提前量 LANE_LEAD_SEC 秒入场。
 */

import { parseChart } from "../scoring/src/chartCodec.js";

// ---------------------------------------------------------------------------
// 几何 / 时序常量
// ---------------------------------------------------------------------------
export const LANE_LEAD_SEC = 2.4;        // 剪影从右侧入场、滑到判定平台所需的时长(= 提前量)
export const LANE_ARRIVE_X = 46;         // 判定平台中心的横坐标(轨道内像素)
export const LANE_FIG_W = 98;            // 单个剪影宽度(兜底值;真实值由 laneFigureBox 量出)
export const LANE_FIG_H = 142;           // 单个剪影高度(兜底值;小屏 CSS 会改成 112)
export const LANE_TRACK_FALLBACK_W = 396; // judgeTrack.clientWidth 读不到时的兜底宽度
export const LANE_NEAR_SEC = 0.45;       // 距抵达 ≤ 此值 → 剪影高亮(.near)
export const LANE_STALE_SEC = 0.05;      // 过期超过此值且轨道上没这个元素 → 不再补画
export const LANE_FADE_MS = 300;         // 抵达后的淡出动画时长(移除 DOM 的延迟)
export const LANE_MOTION_LOOKBACK = 0.4; // 箭头方向:比较动作点与它前 0.4s 的姿势
export const LANE_MOTION_MIN = 0.06;     // 关节位移小于此值视为"定住造型",不标箭头
export const LANE_FALLBACK_STEP_SEC = 0.5; // 无谱面时每 0.5s 采一帧当动作点
export const LANE_STAGE_LIFT_MAX = 6;    // 判定平台按拍点浮起的最大像素
export const LANE_STAGE_LIFT_DECAY = 6;  // 浮起的衰减系数(越大越"一点即落")
export const LANE_STAGE_LIFT_EPS = 0.2;  // 平台位移小于此值不写 DOM
export const LANE_PROGRESS_EPS = 0.005;  // 进度条变化小于此值不写 DOM
export const LANE_LABEL_NOW_SEC = 0.05;  // 剩余时间小于此值 → 显示"就是现在"
export const LANE_LABEL_TICK_SEC = 0.1;  // 标签按 0.1s 粒度显示(toFixed(1) 的天然粒度)
export const LANE_PROGRESS_MIN_GAP = 0.2; // 进度条分母下限,避免两个节点过近时抖动

// 剪影渲染器内部「姿势包围盒 → 画布像素」映射用到的关节(与 pose_capture/stick-figure.js 对齐)
export const ARROW_MAP_JOINTS = [
  "left_shoulder", "left_elbow", "left_wrist",
  "right_shoulder", "right_elbow", "right_wrist",
  "left_hip", "left_knee", "left_ankle",
  "right_hip", "right_knee", "right_ankle",
  "nose",
];
export const ARROW_PAD_FRAC = 0.10;
// 方向箭头的候选关节(按可辨识度挑,不是全部关节)
export const ARROW_MOTION_JOINTS = [
  "left_wrist", "right_wrist", "left_elbow", "right_elbow",
  "left_ankle", "right_ankle", "left_knee", "right_knee",
  "hips_center", "nose",
];
export const ARROW_PUSH_PX = 36;    // 箭头相对关节的推出距离
export const ARROW_CLAMP_INSET = 6; // 箭头中心距剪影框边缘的最小留白
export const ARROW_CLAMP_MIN_Y = 10;// 剪影框顶部留白(比左右多留,避免被裁)
export const ARROW_BODY_WEIGHT = 0.55; // 方向混合:运动方向的权重
export const ARROW_AWAY_WEIGHT = 0.85; // 方向混合:远离身体方向的权重
export const ARROW_AWAY_MIN_LEN = 1;   // 关节离髋中心的距离小于此值就不做"远离身体"修正

// ---------------------------------------------------------------------------
// 门控:什么时候这张卡该出现
// ---------------------------------------------------------------------------

// 当前在跳哪支舞、跳到第几秒。判定轨道只在「正式挑战进行中」显示:
// 选曲首页/试跳/倒计时/表演模式都不显示。
export function activePoseSource(state) {
  if ((state?.mode === "challenge" || state?.mode === "pk") && state?.challenge?.running) {
    const ch = state.challenge;
    if (ch?.seq) return { seq: ch.seq, t: ch.session?.songTime ?? 0 };
  }
  return null;
}

export function poseLaneGate({ disabled = false, videoSide = false, hasTrack = true, hasSource = false } = {}) {
  return !(disabled || videoSide || !hasTrack || !hasSource);
}

// 拍长(秒):优先序列拍栅格,其次 bpm,最后 0.5s
export function beatDurFor(seq) {
  const beats = seq?.meta?.beatTimesSec;
  if (beats && beats.length > 1) {
    const d = beats[1] - beats[0];
    if (d > 0.05) return d;
  }
  const bpm = seq?.meta?.timing?.bpm || seq?.meta?.bpm;
  if (bpm > 0) return 60 / bpm;
  return 0.5;
}

// ---------------------------------------------------------------------------
// 判定事件
// ---------------------------------------------------------------------------

// 没有谱面(或谱面解析失败)时的回退:每 0.5s 采一帧当动作点
export function fallbackPoseEvents(seq, stepSec = LANE_FALLBACK_STEP_SEC) {
  if (!seq?.frames?.length) return [];
  const fps = seq.meta?.fps || 30;
  const step = Math.max(1, Math.round(fps * stepSec));
  return seq.frames.filter((_, i) => i % step === 0).map((f) => ({ t: f.t }));
}

// 谱面 → 判定事件。谱面解析失败会被静默吞掉并降级成 0.5s 采样(不抛错、不提示)。
export function computePoseEvents(seq) {
  if (!seq) return [];
  let events = [];
  try {
    events = parseChart(seq, seq.chart);
  } catch {
    events = [];
  }
  if (!events.length) events = fallbackPoseEvents(seq);
  return events;
}

// 参考序列里最接近 t 的一帧(导出可能缺帧,按时间戳二分而不是按 fps 下标)
export function frameAtTime(frames, t) {
  if (!frames?.length) return null;
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].t < t) lo = mid + 1; else hi = mid; }
  if (!lo) return frames[0];
  if (lo >= frames.length) return frames[frames.length - 1];
  return t - frames[lo - 1].t <= frames[lo].t - t ? frames[lo - 1] : frames[lo];
}

// ---------------------------------------------------------------------------
// 每帧计划:剪影位置 / 标签 / 进度条 / 平台律动
// ---------------------------------------------------------------------------

export function laneEventKey(t) {
  return t.toFixed(3);
}

export function lanePxPerSec(trackW) {
  return Math.max(1, ((trackW || LANE_TRACK_FALLBACK_W) - LANE_ARRIVE_X) / LANE_LEAD_SEC);
}

export function laneFigX(dt, pxPerSec) {
  return LANE_ARRIVE_X + Math.max(0, dt) * pxPerSec;
}

// 剪影的真实盒子:小屏媒体查询会把 .lane-fig 高度改成 112px(见 style.css)。
// canvas 内部分辨率、包围盒映射、箭头夹取都必须用这个真实尺寸,否则剪影会被 CSS 压扁、
// 箭头会跑到可见框外面被 #judge-lane 裁掉。量不到(隐藏/未布局)时退回常量。
export function laneFigureBox(el, fallbackW = LANE_FIG_W, fallbackH = LANE_FIG_H) {
  const w = Math.round(el?.offsetWidth || el?.clientWidth || 0) || fallbackW;
  const h = Math.round(el?.offsetHeight || el?.clientHeight || 0) || fallbackH;
  return { w, h };
}

// canvas 内部分辨率 = 真实盒子 × dpr(与 renderPoseSilhouette 的 W/H 同一坐标系)
export function laneCanvasSize(box, dpr = 1) {
  const w = box?.w || LANE_FIG_W;
  const h = box?.h || LANE_FIG_H;
  return { width: Math.round(w * dpr), height: Math.round(h * dpr) };
}

// 剪影的水平居中位移:平台中心 - 半个真实宽度
export function laneFigTranslateX(x, figW = LANE_FIG_W) {
  return x - figW / 2;
}

// 底部标签 + 进度条:下一个动作名 + 还有几秒到它。
//
// 两段语义:
//  - 已经有节点到点过(t >= events[0].t):进度条 = 上一个节点 → 下一个节点,走满 = 现在就该做它。
//  - 第一个动作之前(没有"上一个节点"):标签指向 events[0],进度条用入场提前量 LANE_LEAD_SEC 当分母,
//    走满 = 它抵达平台 —— 与轨道上正在飞来的剪影同步。
//    (曾经这里 i 保持初值 0 → 标签指向 events[1]、进度条卡在 0,两者互相矛盾。)
export function laneLabelState(events, t) {
  const first = events[0];
  if (t < first.t) {
    const remain = first.t - t;
    const text = (first.moveId || "")
      + (remain > LANE_LABEL_NOW_SEC ? ` · ${remain.toFixed(1)}s` : " · 就是现在");
    const progress = Math.min(1, Math.max(0, 1 - remain / LANE_LEAD_SEC));
    return { i: 0, cur: null, next: first, up: first, remain, text, progress, beforeFirst: true };
  }
  let i = 0;
  for (let k = events.length - 1; k >= 0; k--) if (events[k].t <= t) { i = k; break; }
  const cur = events[i];
  const next = events[Math.min(events.length - 1, i + 1)];
  const up = next.t > t ? next : cur;
  const remain = Math.max(0, up.t - t);
  const text = (up.moveId || "") + (remain > LANE_LABEL_NOW_SEC ? ` · ${remain.toFixed(1)}s` : " · 就是现在");
  const gap = Math.max(LANE_PROGRESS_MIN_GAP, next.t - cur.t);
  const progress = t < cur.t ? 0 : Math.min(1, (t - cur.t) / gap);
  return { i, cur, next, up, remain, text, progress, beforeFirst: false };
}

// 判定平台跟着拍点上下浮一下(越接近拍点越高)
export function laneStageLift(t, beatDur) {
  const beat = beatDur > 0 ? beatDur : LANE_FALLBACK_STEP_SEC;
  const frac = ((t / beat) % 1 + 1) % 1;
  return LANE_STAGE_LIFT_MAX * Math.exp(-frac * LANE_STAGE_LIFT_DECAY);
}

export function shouldWriteProgress(p, last) {
  return p - last >= LANE_PROGRESS_EPS || p < last;
}

export function shouldWriteStageLift(lift, last) {
  return Math.abs(lift - last) > LANE_STAGE_LIFT_EPS;
}

/**
 * 每帧的纯计划。main.js 只负责把结果写到 DOM。
 *
 * @returns {{
 *   hidden: boolean, clear: boolean, empty: boolean,
 *   figs: Array<{key:string, ev:object, dt:number, x:number, near:boolean, arrive:boolean}>,
 *   remove: string[], label: ?{text:string, moveId:string, remain:number},
 *   progress: number, stageLift: number
 * }}
 *  - hidden: 该隐藏卡片(并清空轨道)
 *  - clear:  需要 laneClear()
 *  - empty:  卡片可见但没有任何事件可画(原实现直接 return,卡片保持空白)
 *  - figs:   需要渲染/更新的剪影(已抵达正在淡出的不在其中)
 *  - remove: 需要移除的 key(已不在视野里)
 */
export function planPoseLaneFrame({
  events = [],
  t = 0,
  trackW = 0,
  beatDur = LANE_FALLBACK_STEP_SEC,
  trackedKeys = [],
  arrivedKeys = [],
  disabled = false,
  videoSide = false,
  hasTrack = true,
  hasSource = false,
} = {}) {
  if (!poseLaneGate({ disabled, videoSide, hasTrack, hasSource })) {
    return { hidden: true, clear: true, empty: false, figs: [], remove: [], label: null, progress: 0, stageLift: 0 };
  }
  if (!events.length) {
    return { hidden: false, clear: false, empty: true, figs: [], remove: [], label: null, progress: 0, stageLift: 0 };
  }

  const tracked = new Set(trackedKeys);
  const arrived = new Set(arrivedKeys);
  const pxPerSec = lanePxPerSec(trackW);

  // 这一帧应该还在轨道上的剪影:还没到平台的(含刚到的正在淡出)
  const live = new Set();
  const figs = [];
  for (const ev of events) {
    const dt = ev.t - t;
    if (dt > LANE_LEAD_SEC) break; // 事件按 t 排序,后面的只会更远
    const key = laneEventKey(ev.t);
    if (dt < -LANE_STALE_SEC && !tracked.has(key)) continue; // 早过点的,直接跳过
    live.add(key);
    if (arrived.has(key)) continue; // 已抵达:停在平台上等淡出动画结束,不再更新位置
    figs.push({
      key, ev, dt,
      x: laneFigX(dt, pxPerSec),
      near: dt <= LANE_NEAR_SEC,
      arrive: dt <= 0,
    });
  }
  const remove = trackedKeys.filter((key) => !live.has(key));

  const label = laneLabelState(events, t);
  return {
    hidden: false,
    clear: false,
    empty: false,
    figs,
    remove,
    label: { text: label.text, moveId: label.up.moveId, remain: label.remain },
    progress: label.progress,
    stageLift: laneStageLift(t, beatDur),
  };
}

// ---------------------------------------------------------------------------
// 方向箭头
// ---------------------------------------------------------------------------

function arrowsUsable(joints) {
  return joints && ARROW_MAP_JOINTS.some((n) => joints[n]);
}

// 剪影渲染器内部的"姿势包围盒 → 画布像素"映射(与 stick-figure.js 的常量保持一致:
// 同一批关节、同一 10% padding、同一等比缩放),用它把"正在动的那个关节"换算到画布坐标,
// 箭头才能贴在动作旁边而不是乱飘。figW/figH 传剪影的真实盒子(小屏是 98x112)。
export function laneJointToPixel(joints, name, dpr = 1, figW = LANE_FIG_W, figH = LANE_FIG_H) {
  const pts = ARROW_MAP_JOINTS.map((n) => joints[n]).filter(Boolean);
  if (!pts.length || !joints[name]) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const W = figW * dpr;
  const H = figH * dpr;
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const pad = Math.min(W, H) * ARROW_PAD_FRAC;
  const scale = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const p = joints[name];
  return {
    x: (W / 2 + (p[0] - cx) * scale) / dpr,
    y: (H / 2 - (p[1] - cy) * scale) / dpr,
  };
}

// 比较两个姿势,找位移最大的关节(候选都是看得出来的末端/根节点)
export function laneBestMotion(jointsFrom, jointsTo) {
  let best = null;
  for (const name of ARROW_MOTION_JOINTS) {
    const a = jointsFrom?.[name];
    const b = jointsTo?.[name];
    if (!a || !b) continue;
    const mx = b[0] - a[0];
    const my = b[1] - a[1];
    const mag = Math.hypot(mx, my);
    if (!best || mag > best.mag) best = { name, mx, my, mag };
  }
  return best;
}

/**
 * 这个动作"哪个部位往哪动":比较动作点与它前面的姿势,取位移最大的关节。
 * 慢舞(幅度小)自动拉长回溯窗口到 0.8s;整首的第一个动作没有更早的姿势,就用往后 0.4s 的起手方向。
 *
 * @param jointsAt (t) => joints | null,由调用方提供(要 reconstructJoints,属于渲染层的活)
 * @param jointPixels { name: [x,y] } 可选:该帧关节在"实际显示的剪影图"里的像素坐标。
 *        给了就用它当箭头锚点(3D 白影 PNG 是固定取景 + 不裁剪,坐标由生成器写进 manifest,
 *        比用包围盒反推准);没给就退回 laneJointToPixel 的包围盒映射。
 * @returns null(定住造型)或 { joint, x, y, deg, dx, dy, mag }
 */
export function laneArrowSpec({
  nodeT, firstT = 0, jointsNow, jointsAt, dpr = 1,
  figW = LANE_FIG_W, figH = LANE_FIG_H, jointPixels = null,
}) {
  if (!arrowsUsable(jointsNow) || typeof jointsAt !== "function") return null;
  let best = null;
  for (const lb of [LANE_MOTION_LOOKBACK, LANE_MOTION_LOOKBACK * 2]) {
    const prev = jointsAt(nodeT - lb);
    if (!prev) continue;
    const cand = laneBestMotion(prev, jointsNow);
    if (cand && (!best || cand.mag > best.mag)) best = cand;
    if (best && best.mag >= LANE_MOTION_MIN) break;
  }
  if ((!best || best.mag < LANE_MOTION_MIN) && nodeT - LANE_MOTION_LOOKBACK <= firstT + 1e-6) {
    const next = jointsAt(nodeT + LANE_MOTION_LOOKBACK);
    if (next) {
      const cand = laneBestMotion(jointsNow, next);
      if (cand && (!best || cand.mag > best.mag)) best = cand;
    }
  }
  if (!best || best.mag < LANE_MOTION_MIN) return null; // 几乎没动(定住造型)就不标箭头

  const ux = best.mx / best.mag;
  const uy = best.my / best.mag;
  const anchorPx = jointPixels?.[best.name];
  const bodyPx = jointPixels?.hips_center;
  const anchor = Array.isArray(anchorPx)
    ? { x: anchorPx[0], y: anchorPx[1] }
    : laneJointToPixel(jointsNow, best.name, dpr, figW, figH);
  const body = Array.isArray(bodyPx)
    ? { x: bodyPx[0], y: bodyPx[1] }
    : laneJointToPixel(jointsNow, "hips_center", dpr, figW, figH);
  if (!anchor) return null;

  // 出箭头的方向:运动方向 + 远离身体的方向(否则下蹲/手落下的动作箭头会压在身体上)
  // uy 是 canonical(向上为正),这里的 dy 换成屏幕方向(向下为正)。
  let dx = ux;
  let dy = -uy;
  if (body) {
    const ox = anchor.x - body.x;
    const oy = anchor.y - body.y;
    const olen = Math.hypot(ox, oy);
    if (olen > ARROW_AWAY_MIN_LEN) {
      dx = dx * ARROW_BODY_WEIGHT + (ox / olen) * ARROW_AWAY_WEIGHT;
      dy = dy * ARROW_BODY_WEIGHT + (oy / olen) * ARROW_AWAY_WEIGHT;
    }
  }
  const dlen = Math.hypot(dx, dy) || 1;
  dx /= dlen;
  dy /= dlen;

  // 箭头基准朝上(0°),CSS rotate(θ) 把基准向量 (0,-1) 映射成 (sinθ, -cosθ)。
  // 要让它指向运动方向 (dx,dy)(屏幕坐标,y 向下),就必须解 sinθ = dx、cosθ = -dy,
  // 即 θ = atan2(dx, -dy)。(曾经写成 atan2(dx, dy):竖直分量被镜像,
  // 上举画成向下箭头、下蹲画成向上箭头,只有水平动作是对的。)
  const deg = Math.atan2(dx, -dy) * 180 / Math.PI;
  // 限制在剪影框内,否则举手/下落类动作的箭头会被轨道边缘裁掉
  const x = Math.min(figW - ARROW_CLAMP_INSET, Math.max(ARROW_CLAMP_INSET, anchor.x + dx * ARROW_PUSH_PX));
  const y = Math.min(figH - ARROW_CLAMP_INSET, Math.max(ARROW_CLAMP_MIN_Y, anchor.y + dy * ARROW_PUSH_PX));
  return { joint: best.name, mag: best.mag, x, y, deg, dx, dy };
}

// 箭头在屏幕上真正指向的单位向量(基准箭头朝上,rotate(deg) 之后)
export function arrowFacing(deg) {
  const r = deg * Math.PI / 180;
  return { x: Math.sin(r), y: -Math.cos(r) };
}
