import { resolveConf } from "./contractValidate.js";
import {
  scoreEvent,
  scoreFrameAgainstEvent
} from "./eventScorer.js";
class ScoringEngine {
  pending = [];
  opts;
  lastT = Number.NEGATIVE_INFINITY;
  constructor(events, opts = {}) {
    this.opts = {
      poseWeight: opts.poseWeight ?? 0.65,
      timingWeight: opts.timingWeight ?? 0.35,
      timingFn: opts.timingFn ?? "discrete",
      timingSigma: opts.timingSigma ?? 0.2,
      bands: opts.bands,
      windowEdge: opts.windowEdge ?? 0.25,
      yawMode: opts.yawMode ?? "none",
      refYaw: opts.refYaw ?? 0,
      minPoseScore: opts.minPoseScore,
      minCompleteness: opts.minCompleteness,
      weights: opts.weights
    };
    this.pending = events.map((event) => ({
      event,
      best: null,
      closeAt: event.t + event.window.late
    })).sort((a, b) => a.closeAt - b.closeAt);
  }
  ingest(frame) {
    const tf = frame.t;
    if (tf < this.lastT) {
      throw new Error(
        `ScoringEngine expects monotonic frame times, got ${tf} after ${this.lastT}`
      );
    }
    this.lastT = tf;
    for (const p of this.pending) {
      const lo = p.event.t + p.event.window.early;
      const hi = p.event.t + p.event.window.late;
      if (tf < lo || tf > hi) continue;
      const scored = scoreFrameAgainstEvent(p.event, frame, this.opts);
      if (p.best === null || scored.poseScore > p.best.poseScore + 1e-9 ||
        (Math.abs(scored.poseScore - p.best.poseScore) <= 1e-9 &&
          Math.abs(scored.t - p.event.t) < Math.abs(p.best.t - p.event.t))) {
        p.best = {
          t: scored.t,
          poseScore: scored.poseScore,
          conf: resolveConf(frame)
        };
      }
    }
    const released = this.releaseUpTo(tf);
    return released;
  }
  // 按时间推进:释放所有窗口已闭合(closeAt <= t)的待决事件。
  // 与 ingest 共用,允许驱动方(如计时器)在无帧到达时也按时序结算。
  releaseUpTo(t) {
    const released = [];
    while (this.pending.length > 0 && this.pending[0].closeAt <= t) {
      const p = this.pending.shift();
      if (p === void 0) break;
      released.push(scoreEvent(p.event, p.best, this.opts));
    }
    return released;
  }
  close() {
    const released = [];
    for (const p of this.pending) {
      released.push(scoreEvent(p.event, p.best, this.opts));
    }
    this.pending = [];
    return released;
  }
}
export {
  ScoringEngine
};
