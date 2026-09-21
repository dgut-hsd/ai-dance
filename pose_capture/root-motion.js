/**
 * root-motion.js — 根运动通道(方案 C:根速度 + 地面接触)。
 *
 * 契约帧的 bones 是平移不变的(单位向量),髋中点位移在归一化时被丢弃,
 * 导致跳跃 / 前后左右移动无法还原。这里从 MediaPipe world landmark 的
 * 绝对髋中点推导「根速度」(相邻帧有限差分,天然消掉世界原点漂移),
 * 并估算「是否贴地」(最低脚踝相对地面),供消费端:
 *   - 水平:积分速度得到前后/左右位移;
 *   - 垂直:贴地时用运动学(脚踝反推髋高,蹲下正确),腾空时用速度积分(跳跃);
 *   - 贴地标志用于抑制垂直/水平积分漂移。
 */

export class RootMotionTracker {
  constructor(opts = {}) {
    this.groundEps = opts.groundEps ?? 0.12; // 米:最低脚踝距地面小于此值视为贴地
    this.floorEma = opts.floorEma ?? 0.05;   // 地面估计缓慢回升系数(越小回升越慢)
    this.maxDt = opts.maxDt ?? 0.1;          // 秒:超过则视为丢帧/暂停,速度清零
    this.velEma = opts.velEma ?? 0.5;        // 速度低通系数(0~1,越小越平滑)

    this._prev = null;   // { hips: [x,y,z], t }
    this._vel = null;    // 上一帧平滑后速度 [vx,vy,vz]
    this._floorY = null; // 地面高度估计(canonical y,米)
  }

  reset() {
    this._prev = null;
    this._vel = null;
    this._floorY = null;
  }

  /**
   * @param {object} joints 命名关节点(须含 hips_center / left_ankle / right_ankle)
   * @param {number} t 秒,单调递增
   * @returns {{ rootVel:[number,number,number], grounded:boolean }}
   */
  update(joints, t) {
    const hips = joints?.hips_center;
    const ankleL = joints?.left_ankle;
    const ankleR = joints?.right_ankle;

    // ---- 1) 地面接触:用「最低的一只脚踝」估计地面,判断是否贴地 ----
    let grounded = false;
    if (ankleL && ankleR) {
      const lowest = Math.min(ankleL[1], ankleR[1]);
      if (this._floorY == null) {
        this._floorY = lowest;
      } else if (lowest < this._floorY) {
        this._floorY = lowest; // 地面下移(蹲/换站位/原点漂移)快速跟随
      } else {
        this._floorY += (lowest - this._floorY) * this.floorEma; // 否则缓慢回升
      }
      grounded = lowest - this._floorY < this.groundEps;
    }

    // ---- 2) 根速度:髋中点相邻帧差分(有限差分,消掉静态偏移) ----
    let rootVel = [0, 0, 0];
    if (hips && this._prev && this._prev.hips) {
      const dt = t - this._prev.t;
      if (dt > 1e-4) {
        if (dt > this.maxDt) {
          // 间隔过大(丢帧/切后台):视为不连续,速度清零并重置低通
          rootVel = [0, 0, 0];
          this._vel = null;
        } else {
          const raw = [
            (hips[0] - this._prev.hips[0]) / dt,
            (hips[1] - this._prev.hips[1]) / dt,
            (hips[2] - this._prev.hips[2]) / dt,
          ];
          // 位移已过 One Euro,这里再对速度做一阶低通压高频
          if (this._vel) {
            rootVel = [
              this._vel[0] + this.velEma * (raw[0] - this._vel[0]),
              this._vel[1] + this.velEma * (raw[1] - this._vel[1]),
              this._vel[2] + this.velEma * (raw[2] - this._vel[2]),
            ];
          } else {
            rootVel = raw;
          }
          this._vel = rootVel.slice();
        }
      }
    }

    if (hips) {
      this._prev = { hips: hips.slice(), t };
    }
    return { rootVel, grounded };
  }
}
