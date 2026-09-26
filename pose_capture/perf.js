export function distribution(samples) {
  if (!samples.length) return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n) => +n.toFixed(2);
  const p = (q) => round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]);
  return { count: samples.length, avgMs: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maxMs: p(1) };
}
// Bounded windows and the last 10,000 samples per stage for operator export.
export class PerfMonitor {
  constructor() {
    this.start = performance.now(); this.lastRead = this.start;
    this.frames = 0; this.totalFrames = 0; this.dropped = 0;
    this.window = {}; this.history = {};
  }
  fpsTick() { this.frames++; this.totalFrames++; }
  drop() { this.dropped++; }
  record(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    for (const bucket of [this.window, this.history]) {
      const values = bucket[name] ||= []; values.push(ms);
      if (values.length > 10000) values.shift();
    }
  }
  read() {
    const now = performance.now();
    const fps = +(this.frames * 1000 / Math.max(1, now - this.lastRead)).toFixed(1);
    const stages = Object.fromEntries(Object.entries(this.window).map(([k, v]) => [k, distribution(v)]));
    this.window = {}; this.frames = 0; this.lastRead = now;
    return { fps, stages, dropped: this.dropped };
  }
  report() {
    return { elapsedSec: (performance.now() - this.start) / 1000,
      totalFrames: this.totalFrames, dropped: this.dropped,
      stages: Object.fromEntries(Object.entries(this.history).map(([k, v]) => [k, distribution(v)])) };
  }
}
