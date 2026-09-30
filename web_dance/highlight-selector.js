const TIER_WEIGHT = { PERFECT: 100, GREAT: 72, GOOD: 42, MISS: 0 };

function markerScore(marker) {
  const tier = TIER_WEIGHT[marker.tier] || 0;
  const accuracy = Math.max(0, Math.min(1, Number(marker.accuracy) || 0)) * 34;
  const combo = Math.min(30, Math.max(0, Number(marker.combo) || 0)) * 1.2;
  const gain = Math.min(400, Math.max(0, Number(marker.scoreGain) || 0)) * 0.04;
  const confidence = Math.max(0, Math.min(1, Number(marker.confidence) || 0)) * 18;
  return tier + accuracy + combo + gain + confidence;
}

export function selectHighlightSegments(markers, {
  duration = 0,
  count = 3,
  minGap = 5,
  before = 2.5,
  after = 2.5,
  minConfidence = 0.35,
} = {}) {
  const limit = Math.max(0, Number(duration) || 0);
  const candidates = (markers || [])
    .filter((m) => Number.isFinite(m?.time)
      && m.time >= 0
      && m.tier !== "MISS"
      && (TIER_WEIGHT[m.tier] || 0) > 0
      && (Number(m.confidence) || 0) >= minConfidence)
    .map((m) => ({ ...m, _score: markerScore(m) }))
    .sort((a, b) => b._score - a._score || a.time - b.time);

  const chosen = [];
  for (const marker of candidates) {
    if (chosen.some((other) => Math.abs(other.time - marker.time) < minGap)) continue;
    chosen.push(marker);
    if (chosen.length >= count) break;
  }

  const segments = chosen
    .sort((a, b) => a.time - b.time)
    .map((m) => ({
      start: Math.max(0, m.time - before),
      peak: m.time,
      end: limit > 0 ? Math.min(limit, m.time + after) : m.time + after,
      tier: m.tier || "",
      combo: Math.max(0, Number(m.combo) || 0),
      accuracy: Math.max(0, Math.min(1, Number(m.accuracy) || 0)),
      noteId: m.noteId || "",
      fallback: false,
    }));

  // 传播价值不与成绩挂钩：不足三段时从前/中/后补足真人片段。
  const fillerPeaks = [0.25, 0.5, 0.75, 0.125, 0.875].map(ratio => limit * ratio);
  for (const peak of fillerPeaks) {
    if (segments.length >= count) break;
    if (limit >= minGap && segments.some(segment => Math.abs(segment.peak - peak) < minGap)) continue;
    const span = Math.min(5, limit);
    const start = Math.max(0, Math.min(limit - span, peak - span / 2));
    segments.push({ start, peak, end: start + span, tier: "", combo: 0, accuracy: 0, fallback: true });
  }
  while (segments.length < count && limit > 0) {
    const peak = fillerPeaks[segments.length % fillerPeaks.length] || limit / 2;
    const span = Math.min(5, limit);
    const start = Math.max(0, Math.min(limit - span, peak - span / 2));
    segments.push({ start, peak, end: start + span, tier: "", combo: 0, accuracy: 0, fallback: true });
  }
  return segments.sort((a, b) => a.peak - b.peak);
}

export function positiveTitleFor({ perfectCount = 0, maxCombo = 0, completed = true } = {}) {
  if (perfectCount >= 5) return "精准舞者";
  if (maxCombo >= 12) return "连击达人";
  if (completed) return "舞台新星";
  return "勇气新星";
}

