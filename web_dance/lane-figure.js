/**
 * lane-figure.js — 单张剪影的构造(游戏页与谱面编辑器共用)。
 *
 * 优先用 tools/lane-silhouettes.mjs 预渲染的「3D 白影 PNG」(和选曲卡同一套质感),
 * 没有资源时才退回 2D 剪影,保证新加的舞曲照样能玩。
 * 箭头:方向仍由参考序列的关节时序算出;锚点优先用 manifest 里的真实像素
 * (白影是固定取景渲染的,关节像素由生成器写进 manifest,比用包围盒反推准)。
 */
import { LANE_FIG_W, frameAtTime, laneArrowSpec, laneCanvasSize, laneFigureBox } from "./pose-lane.js";
import { laneAssetBox, laneAssetJointPixels, laneAssetUrl } from "./lane-assets.js";
import { reconstructJoints } from "../pose_capture/playback.js";
import { renderPoseSilhouette } from "../pose_capture/stick-figure.js";

// 箭头 DOM:位置与角度由 pose-lane.js 的 laneArrowSpec 算好
export function laneArrowElement(spec, doc = document) {
  const arrow = doc.createElement("i");
  arrow.className = "lane-arrow";
  arrow.style.transform =
    `translate(${spec.x.toFixed(1)}px, ${spec.y.toFixed(1)}px) rotate(${spec.deg.toFixed(1)}deg)`;
  return arrow;
}

/**
 * 往 el 里画一张剪影,返回它的显示尺寸(车道用它居中、箭头用它夹取)。
 * @param entry lane-assets.js 的 manifest 条目;为 null 时走 2D 兜底
 */
export function buildLaneFigure({ el, ev, seq, dpr = 1, entry = null, doc = document }) {
  const nodeT = ev.targetT ?? ev.t;
  const frames = seq?.frames || [];
  const dims = seq?.meta?.dimensions;
  const frame = frameAtTime(frames, nodeT);
  const jointsNow = frame ? reconstructJoints(frame, dims, seq.bones) : null;
  const boxH = laneFigureBox(el).h;
  const jointsAt = (tt) => {
    const f = frameAtTime(frames, tt);
    return f ? reconstructJoints(f, dims, seq.bones) : null;
  };
  const arrowFor = (figW, figH, jointPixels) => {
    if (!jointsNow) return null;
    const spec = laneArrowSpec({
      nodeT, firstT: frames[0]?.t ?? 0, jointsNow, jointsAt, dpr, figW, figH, jointPixels,
    });
    return spec ? laneArrowElement(spec, doc) : null;
  };

  const url = laneAssetUrl(entry);
  if (url) {
    const box = laneAssetBox(entry, boxH);
    el.style.width = box.w + "px";
    const img = doc.createElement("img");
    img.className = "lane-fig-img";
    img.alt = "";
    img.draggable = false;
    img.src = url;
    el.appendChild(img);
    // manifest 里的锚点是"图片像素",按显示比例换算到 CSS 像素
    const arrow = arrowFor(box.w, box.h, laneAssetJointPixels(entry, box.h / entry.h));
    if (arrow) el.appendChild(arrow);
    return box;
  }

  el.style.width = LANE_FIG_W + "px";
  const canvas = doc.createElement("canvas");
  const size = laneCanvasSize({ w: LANE_FIG_W, h: boxH }, dpr);
  canvas.width = size.width;
  canvas.height = size.height;
  el.appendChild(canvas);
  if (jointsNow) renderPoseSilhouette(canvas, jointsNow, seq.bones, { color: "#ffd7a6" });
  const arrow = arrowFor(LANE_FIG_W, boxH, null);
  if (arrow) el.appendChild(arrow);
  return { w: LANE_FIG_W, h: boxH };
}
