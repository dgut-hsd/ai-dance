/**
 * lane-view.js — 右下判定卡片的 DOM 应用层(游戏页与谱面编辑器共用)。
 *
 * pose-lane.js 负责"算什么"(纯逻辑),这里负责"写到 DOM 上":剪影的位置/高亮/抵达淡出、
 * 判定平台律动、标签与进度条节流。剪影的内容(3D 白影 PNG 还是 2D 兜底)由调用方的
 * buildFigure 决定,所以游戏页和编辑器的表现完全一致 —— 编辑器里看到的卡片就是玩家看到的。
 */
import {
  LANE_FADE_MS, LANE_FIG_W, laneFigureBox, laneFigTranslateX,
  shouldWriteProgress, shouldWriteStageLift,
} from "./pose-lane.js";

/**
 * @param root/track/stage      DOM(与 dance.html 的 #pose-hint 结构一致)
 * @param fill/name             可选槽位:进度条 / 动作名+倒计时。当前游戏页与编辑器都不挂载它们
 *                              (卡片只留剪影 + 平台);想加回任一个,HTML 里放回对应元素并在
 *                              创建时传进来即可,这里的写入逻辑与节流都还在、有测试覆盖。
 * @param buildFigure  ({ el, ev, seq, dpr, entry }) => { w, h }
 *        调用方往 el 里塞 canvas 或 <img>,并返回该剪影的显示尺寸(用于居中与箭头)
 */
export function createLaneView({ root, track, stage, fill, name, buildFigure, doc = document }) {
  const figs = new Map();   // key -> { el, arrived, box }
  let lastLabel = "";
  let lastProgress = -1;
  let lastLift = -1;

  function remove(key) {
    const fig = figs.get(key);
    if (!fig) return;
    fig.el.remove();
    figs.delete(key);
  }

  function clear() {
    for (const key of [...figs.keys()]) remove(key);
  }

  /** 停止/重开时用:清空轨道并把节流缓存复位,下一局该写的都重新写一遍 */
  function reset() {
    clear();
    lastLabel = "";
    lastProgress = -1;
    lastLift = -1;
  }

  const trackedKeys = () => [...figs.keys()];
  const arrivedKeys = () => [...figs].filter(([, fig]) => fig.arrived).map(([key]) => key);

  function update(plan, { seq = null, dpr = 1, entryFor = null } = {}) {
    if (plan.hidden) { root.classList.add("hidden"); clear(); return; }
    root.classList.remove("hidden");
    if (plan.empty) return; // 没有可画的判定点:卡片保持可见(与原实现一致)

    for (const f of plan.figs) {
      let fig = figs.get(f.key);
      if (!fig) {
        const el = doc.createElement("div");
        el.className = "lane-fig";
        track.appendChild(el);
        const entry = entryFor ? entryFor(f.ev) : null;
        const box = buildFigure({ el, ev: f.ev, seq, dpr, entry }) || laneFigureBox(el);
        fig = { el, arrived: false, box };
        figs.set(f.key, fig);
      }
      fig.el.style.transform = `translateX(${laneFigTranslateX(f.x, fig.box.w).toFixed(1)}px)`;
      fig.el.classList.toggle("near", f.near);

      // 抵达判定平台:剪影立刻消失(淡出 + 放大)
      if (f.arrive) {
        fig.arrived = true;
        fig.el.classList.add("arrive");
        setTimeout(() => remove(f.key), LANE_FADE_MS);
      }
    }
    // 清掉已经不在视野里的
    for (const key of plan.remove) remove(key);

    // 律动:判定平台跟着拍点上下浮一下(越接近拍点越高)
    if (stage && shouldWriteStageLift(plan.stageLift, lastLift)) {
      lastLift = plan.stageLift;
      stage.style.transform = `translateY(${(-plan.stageLift).toFixed(2)}px)`;
    }

    // 标签:下一个动作名 + 还有几秒到它(0.1s 粒度,避免每帧写 DOM)
    if (plan.label && name && plan.label.text !== lastLabel) {
      lastLabel = plan.label.text;
      name.textContent = plan.label.text;
    }

    // 进度条:上一个节点 → 下一个节点,走满 = 现在就该做它
    if (shouldWriteProgress(plan.progress, lastProgress)) {
      lastProgress = plan.progress;
      if (fill) fill.style.width = (plan.progress * 100).toFixed(1) + "%";
    }
  }

  return { update, clear, reset, remove, trackedKeys, arrivedKeys, figs, defaultWidth: LANE_FIG_W };
}
