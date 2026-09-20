/**
 * perf.js — 轻量性能/帧率监控。
 *
 * 用 performance.now() 给每帧的各个阶段计时,按 1 秒窗口聚合。
 * 用法:
 *   const monitor = new PerfMonitor();
 *   monitor.fpsTick();              // 每处理完一帧调用一次
 *   monitor.record("inference", ms); // 记录某阶段耗时(毫秒)
 *   monitor.read();                 // 返回 { fps, stages } 并重置阶段窗口
 */

export class PerfMonitor {
  constructor() {
    this.fps = 0;                 // 最近一个完整窗口的端到端帧率
    this._fpsCount = 0;
    this._fpsStart = performance.now();
    this._stages = {};            // name -> { sum, count, max }
  }

  // 每处理完一帧调用一次
  fpsTick() {
    this._fpsCount++;
    const now = performance.now();
    const elapsed = now - this._fpsStart;
    if (elapsed >= 1000) {
      this.fps = Math.round((this._fpsCount * 1000) / elapsed);
      this._fpsCount = 0;
      this._fpsStart = now;
    }
  }

  // 记录某阶段耗时
  record(name, ms) {
    let s = this._stages[name];
    if (!s) s = this._stages[name] = { sum: 0, count: 0, max: 0 };
    s.sum += ms;
    s.count++;
    if (ms > s.max) s.max = ms;
  }

  // 返回自上次 read() 以来各阶段的平均/峰值耗时,并重置阶段窗口
  read() {
    const stages = {};
    for (const [name, s] of Object.entries(this._stages)) {
      stages[name] = {
        avgMs: +(s.sum / s.count).toFixed(2),
        maxMs: +s.max.toFixed(2),
        count: s.count,
      };
    }
    this._stages = {};
    return { fps: this.fps, stages };
  }
}
