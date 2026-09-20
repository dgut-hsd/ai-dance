/**
 * filters.js — 平滑滤波(M4)。
 *
 * One Euro filter(Casiez et al. 2012):自适应低通 —— 静止时强平滑,快速动作时
 * 自动放宽截止频率以保持响应,不像重 Kalman 那样引入明显"拖尾"延迟。
 *
 * PoseSmoother:按关节置信度(visibility/presence)冻结不可见部位,解决
 * "看不见的腿乱抖"(那是数据不可靠问题,不是滤波强度问题)。
 */

export class OneEuroFilter {
  constructor({ minCutoff = 1.5, beta = 0.5, dCutoff = 1.0, maxDt = 0.1 } = {}) {
    this.minCutoff = minCutoff; // Hz,静止时的截止频率(越低越平滑)
    this.beta = beta;           // 速度自适应系数(越大,快动作越贴,但抖动也越贴)
    this.dCutoff = dCutoff;     // Hz,速度估计的滤波
    this.maxDt = maxDt;         // 秒,限制最大时间步(防止冻结后恢复时跳变)
    this.reset();
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = null;
    this.tPrev = null;
  }

  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, t) {
    if (this.xPrev == null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = t;
      return x;
    }
    let dt = t - this.tPrev;
    if (dt <= 0) return this.xPrev; // 时间没前进,保持
    dt = Math.min(dt, this.maxDt);

    const dx = (x - this.xPrev) / dt;
    const edx = this.dxPrev + this._alpha(this.dCutoff, dt) * (dx - this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const xHat = this.xPrev + this._alpha(cutoff, dt) * (x - this.xPrev);

    this.xPrev = xHat;
    this.dxPrev = edx;
    this.tPrev = t;
    return xHat;
  }
}

const FREEZE_VISIBILITY = 0.5; // 置信度低于此值视为"不可见/不可靠",冻结

export class PoseSmoother {
  constructor(oneEuroOptions) {
    this.oneEuroOptions = oneEuroOptions;
    this.filters = {};   // name -> { x, y, z }
    this.lastGood = {};  // name -> [x, y, z]
  }

  // joints: { name -> [x,y,z] }(13 个原始关节点,不含派生中点)
  // vis:    { name -> 0..1 }
  // t:      秒,单调递增
  smooth(joints, vis, t) {
    const out = {};
    for (const [name, pos] of Object.entries(joints)) {
      const v = vis[name] ?? 1;
      if (v < FREEZE_VISIBILITY) {
        // 不可见:保持上一帧可靠位置(没有 lastGood 时退回原始值)
        out[name] = this.lastGood[name] ? this.lastGood[name].slice() : pos.slice();
      } else {
        const f = this._filtersFor(name);
        const s = [
          f.x.filter(pos[0], t),
          f.y.filter(pos[1], t),
          f.z.filter(pos[2], t),
        ];
        out[name] = s;
        this.lastGood[name] = s.slice();
      }
    }
    return out;
  }

  _filtersFor(name) {
    if (!this.filters[name]) {
      const o = this.oneEuroOptions;
      this.filters[name] = {
        x: new OneEuroFilter(o),
        y: new OneEuroFilter(o),
        z: new OneEuroFilter(o),
      };
    }
    return this.filters[name];
  }
}

// 手部平滑器:手比身体更灵活、更快,用更高 beta(更跟手)的 One Euro。
// 按 handedness 分键,分别跟踪左手/右手。
export class HandSmoother {
  constructor(oneEuroOptions) {
    this.oneEuroOptions = oneEuroOptions;
    this.filters = {}; // key(handedness) -> OneEuroFilter[21*3]
  }

  smooth(hands, t) {
    if (!hands || !hands.length) return hands;
    return hands.map((hand) => {
      if (!hand.handedness || !hand.landmarks) return hand;
      const key = hand.handedness;
      const lms = hand.landmarks;
      const fs = this._filtersFor(key, lms.length);
      const smoothed = lms.map((p, i) => [
        fs[i * 3].filter(p[0], t),
        fs[i * 3 + 1].filter(p[1], t),
        fs[i * 3 + 2].filter(p[2], t),
      ]);
      return { handedness: hand.handedness, landmarks: smoothed };
    });
  }

  _filtersFor(key, count) {
    if (!this.filters[key]) {
      const arr = [];
      for (let i = 0; i < count * 3; i++) {
        arr.push(new OneEuroFilter(this.oneEuroOptions));
      }
      this.filters[key] = arr;
    }
    return this.filters[key];
  }
}
