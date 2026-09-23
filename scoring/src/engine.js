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
      if (p.best === null || scored.poseScore > p.best.poseScore) {
        p.best = {
          t: scored.t,
          poseScore: scored.poseScore,
          conf: resolveConf(frame)
        };
      }
    }
    const released = [];
    while (this.pending.length > 0 && this.pending[0].closeAt <= tf) {
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
