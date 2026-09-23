import { ScoringEngine } from "./engine.js";
import { summarize } from "./metrics.js";
function replay(events, frames, opts = {}) {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const engine = new ScoringEngine(events, opts);
  const all = [];
  for (const f of sorted) {
    const released = engine.ingest(f);
    if (released.length > 0) all.push(...released);
  }
  all.push(...engine.close());
  return summarize(all);
}
export {
  replay
};
