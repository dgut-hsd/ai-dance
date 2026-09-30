/**
 * videoMeta.js — 视频素材的比例识别(纯函数,可单测)。
 *
 * 为什么需要:游戏视频模式的右侧画面以前是**固定 55vw × 100vh + object-fit: cover**,
 * 容器比例由屏幕决定、和视频本身无关。1920×1080 上容器是 1056×1080(≈0.98),而仓库里的
 * 训练视频绝大多数是 720×1280(0.5625)—— 视频被放大到 1920 宽后左右各裁掉约 41%,
 * 舞者的手脚经常在画面外(动捕本身没这问题:export.js 用 createImageBitmap 读的是完整帧)。
 *
 * 现在把比例当成素材的属性识别出来、写进 videos/index.json,页面据此摆容器,
 * 不再靠"猜一个 55vw"。
 */

/** 判定容差:实测有 720×1282 这种比 9:16 差 0.1% 的录制文件,不能被判成"其他"。 */
export const RATIO_TOLERANCE = 0.02;

/** 三大类。portrait 两类是主线(仓库 16 支里 14 支是 9:16),landscape 是兜底。 */
export const RATIO_CLASSES = ['portrait-9x16', 'portrait-3x4', 'landscape'];

/**
 * 带 ±2% 容差的比例相等判定。
 * @param {number} ratio 实际宽高比
 * @param {number} nominal 标称宽高比
 */
export function ratioMatches(ratio, nominal) {
  const r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) return false;
  return Math.abs(r - nominal) / nominal <= RATIO_TOLERANCE;
}

/**
 * 把宽高归到比例档位。拿不到尺寸时返回 null(调用方据此退回「一律完整显示」的兜底)。
 * @param {number|null} width
 * @param {number|null} height
 * @returns {'portrait-9x16'|'portrait-3x4'|'landscape'|null}
 */
export function ratioClassOf(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const ratio = w / h;
  if (ratioMatches(ratio, 9 / 16)) return 'portrait-9x16';
  if (ratioMatches(ratio, 3 / 4)) return 'portrait-3x4';
  return 'landscape';
}

/**
 * 探测结果 → 写进 videos/index.json 的那一条。
 * 探测失败(ffmpeg 认不出这个文件)时保留 null,页面会走兜底而不是拿错比例。
 * @param {{width?: number|null, height?: number|null, duration?: number|null}|null} probe
 */
export function videoFileMeta(probe) {
  const width = Number.isFinite(Number(probe?.width)) && Number(probe?.width) > 0 ? Math.round(Number(probe.width)) : null;
  const height = Number.isFinite(Number(probe?.height)) && Number(probe?.height) > 0 ? Math.round(Number(probe.height)) : null;
  const duration = Number.isFinite(Number(probe?.duration)) && Number(probe?.duration) > 0 ? Math.round(Number(probe.duration)) : null;
  const ratio = width && height ? Math.round((width / height) * 10000) / 10000 : null;
  return { width, height, ratio, ratioClass: ratioClassOf(width, height), duration };
}

/** 后台可见的文案,例如 "9:16 · 720×1280"。识别不出来时给一句人话,别显示 null。 */
export function ratioLabel(width, height) {
  const cls = ratioClassOf(width, height);
  const name = { 'portrait-9x16': '9:16 竖屏', 'portrait-3x4': '3:4 竖屏', landscape: '横屏' }[cls];
  if (!name) return '比例未知';
  return Number.isFinite(Number(width)) && Number.isFinite(Number(height)) && width > 0 && height > 0
    ? `${name} · ${Math.round(width)}×${Math.round(height)}`
    : name;
}
