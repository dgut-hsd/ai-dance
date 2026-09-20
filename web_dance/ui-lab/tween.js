/**
 * tween.js — 动效原语(实验台与产品页面共用的「冻结 API」)。
 *
 * 单一 rAF 调度器:所有 animate / spring / juice 任务共享一个时钟,
 * 因此 hit-stop(时间冻结)能同时冻住全部 UI 动效。
 *
 * 用法:
 *   animate({ duration, delay, ease, onUpdate, onComplete })   // 返回 { stop() }
 *   spring({ from, to, stiffness, damping, mass, onUpdate, onComplete })
 *                                                              // 返回 { stop(), setTarget() }
 *   ticker.hitStop(ms)   // 冻结整个动效时钟 ms 毫秒
 *   backOut(s) / elasticOut(period)                            // 可配置缓动工厂
 */

const _tasks = new Set();
let _rafId = 0;
let _running = false;
let _last = null;
let _freezeUntil = -Infinity;

function _loop(now) {
  _rafId = requestAnimationFrame(_loop);
  const dt = _last == null ? 0 : Math.min((now - _last) / 1000, 1 / 20);
  _last = now;
  if (now < _freezeUntil) return; // hit-stop:冻结任务,但已消费时间(避免解冻后跳帧)
  for (const task of [..._tasks]) {
    if (!task.update(now, dt)) _tasks.delete(task);
  }
}

function _ensureLoop() {
  if (_running) return;
  _running = true;
  _last = null;
  _rafId = requestAnimationFrame(_loop);
}

export const ticker = {
  add(task) { _tasks.add(task); _ensureLoop(); },
  remove(task) { _tasks.delete(task); },
  hitStop(ms) { _freezeUntil = Math.max(_freezeUntil, performance.now() + ms); },
  get frozen() { return performance.now() < _freezeUntil; },
};

// ---- 基础缓动 ----
export const ease = {
  linear: (t) => t,
  quadOut: (t) => 1 - (1 - t) ** 2,
  cubicOut: (t) => 1 - (1 - t) ** 3,
  expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};

/** 可配置回弹系数的 backOut(s 越大回弹越强,0 = 无回弹)。 */
export function backOut(s = 1.70158) {
  const c1 = s, c3 = c1 + 1;
  return (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** 可配置周期(频率)的 elasticOut,period 越小震荡越密。 */
export function elasticOut(period = 3) {
  const c4 = (2 * Math.PI) / period;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  };
}

/** 0→1 补间,基于共享时钟(dt 累计,天然支持 hit-stop 冻结)。 */
export function animate({
  duration = 400, delay = 0, ease: easeFn = ease.expoOut, onUpdate, onComplete,
} = {}) {
  let elapsed = -delay;
  const task = {
    update(_now, dt) {
      elapsed += dt * 1000;
      if (elapsed < 0) return true;
      const t = Math.min(1, elapsed / duration);
      onUpdate?.(easeFn(t));
      if (t < 1) return true;
      onComplete?.();
      return false;
    },
  };
  ticker.add(task);
  return { stop() { ticker.remove(task); } };
}

/** 弹簧(物理积分),from → to。 */
export function spring({
  from = 0, to = 1, stiffness = 180, damping = 18, mass = 1, velocity = 0,
  precision = 0.002, onUpdate, onComplete,
} = {}) {
  let x = from;
  let v = velocity;
  let t = 0;
  const task = {
    update(_now, dt) {
      t += dt;
      const a = (-stiffness * (x - to) - damping * v) / mass;
      v += a * dt;
      x += v * dt;
      onUpdate?.(x);
      const settled = Math.abs(x - to) < precision && Math.abs(v) < precision;
      if (settled || t > 3) { // 兜底:最多 3s,防欠阻尼永不收敛
        onUpdate?.(to);
        onComplete?.();
        return false;
      }
      return true;
    },
  };
  ticker.add(task);
  return {
    stop() { ticker.remove(task); },
    setTarget(next) { to = next; },
  };
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
