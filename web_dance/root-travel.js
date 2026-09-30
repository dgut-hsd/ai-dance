/**
 * root-travel.js — 走位(根水平位移)的「去漂移 + 限幅」处理。
 *
 * 问题:源录像里的髋部水平位移包含两种成分 —— ①编舞真的左右移动(快,几拍内回到中间)
 * ②整支舞的缓慢漂移(慢,累积到 2~3 个身位)。直接照搬会把舞者带出舞台
 * (实测 copydance1 的 Z 摆幅 2.96 单位,而地台半径只有 2.88)。
 *
 * 处理:去掉**低频**成分(移动平均,τ≈2.5s),保留快的那部分;再按舞台上限夹一次兜底。
 * 舞蹈"自己回到中间"的那部分(快)原样保留,缓慢漂移被慢慢拉回中心 —— 脚在地上的滑移
 * 被摊到几秒里,几乎看不出来(硬夹会在极值处直接"卡住",滑移看得见)。
 */

/**
 * @param {Array<[number, number, number]>} samples [x,y,z](只改 x/z)
 * @param {number} dt 采样间隔(秒)
 * @param {{tauSec?:number, limit?:number}} [opts]
 * @returns {Array<[number, number, number]>} 处理后的副本
 */
export function recenterTravel(samples, dt, opts = {}) {
  const tau = Math.max(0.2, opts.tauSec ?? 2.5);
  const limit = Math.max(0, opts.limit ?? 2.2);
  const n = samples.length;
  if (!n) return [];
  const half = Math.max(1, Math.round(tau / Math.max(1e-6, dt)));
  const out = samples.map((s) => [s[0], s[1], s[2]]);

  // 低频成分 = 中心滑动平均(窗口在两端自动收窄,避免边界把均值拉偏)
  const lowX = new Float64Array(n);
  const lowZ = new Float64Array(n);
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    if (i === 0) {
      for (let j = lo; j <= hi; j++) { sx += samples[j][0]; sz += samples[j][2]; }
    } else {
      const prevLo = Math.max(0, i - 1 - half);
      const prevHi = Math.min(n - 1, i - 1 + half);
      for (let j = prevLo; j < lo; j++) { sx -= samples[j][0]; sz -= samples[j][2]; }
      for (let j = prevHi + 1; j <= hi; j++) { sx += samples[j][0]; sz += samples[j][2]; }
    }
    const cnt = hi - lo + 1;
    lowX[i] = sx / cnt;
    lowZ[i] = sz / cnt;
  }

  let clamped = 0;
  let maxTravel = 0;
  for (let i = 0; i < n; i++) {
    let x = samples[i][0] - lowX[i];
    let z = samples[i][2] - lowZ[i];
    const r = Math.hypot(x, z);
    if (r > limit) {
      x *= limit / r;
      z *= limit / r;
      clamped += 1;
    }
    maxTravel = Math.max(maxTravel, Math.min(r, limit));
    out[i][0] = x;
    out[i][2] = z;
  }
  out.clampedFrames = clamped;
  out.maxTravel = maxTravel;
  return out;
}

/**
 * 就地处理一帧序列的 rootPos(教练/挑战路径用):返回统计信息,重复调用只处理一次。
 * @param {{frames:Array}} seq
 */
export function recenterSequenceTravel(seq, opts = {}) {
  const frames = seq?.frames ?? [];
  if (!frames.length || !Array.isArray(frames[0]?.rootPos)) return null;
  if (seq.__travelRecentered) return seq.__travelStats ?? null;
  const dt = frames.length > 1 ? Math.max(1e-3, (frames[1].t - frames[0].t) || 1 / 30) : 1 / 30;
  const done = recenterTravel(frames.map((f) => f.rootPos), dt, opts);
  frames.forEach((f, i) => {
    const orig = f.rootPos;
    f.rootPos = [done[i][0], orig[1], done[i][2]]; // y(蹲/跳)原样保留
  });
  seq.__travelRecentered = true;
  seq.__travelStats = { clampedFrames: done.clampedFrames, maxTravel: done.maxTravel };
  return seq.__travelStats;
}
