// Select a continuous window using one-second quality samples, in recording time.
export function selectHighlight(samples, duration, length = 30) {
  const span = Math.min(length, duration);
  if (!(duration > 0)) throw new Error('Invalid recording duration');
  let best = -Infinity, start = 0;
  const candidates = new Set([0, Math.max(0, duration - span)]);
  for (let t = 1; t + span <= duration; t++) candidates.add(t);
  for (const t of candidates) {
    const window = samples.filter(s => s.t >= t && s.t < t + span);
    const value = window.reduce((sum, s) => sum + (s.conf < .4 ? -2 :
      s.acc + Math.min(s.combo, 50) / 100 + (s.tier === 'PERFECT' ? .5 : 0)), 0) / span;
    if (value > best) { best = value; start = t; }
  }
  return { start, duration: span };
}

export function buildHighlightStory(metadata) {
  const marked = Array.isArray(metadata.highlights) ? metadata.highlights.slice(0, 3) : [];
  const segments = marked.map(segment => {
    const span = Math.min(5, metadata.duration);
    let start = segment.peak - span / 2;
    let end = segment.peak + span / 2;
    if (start < 0) { end -= start; start = 0; }
    if (end > metadata.duration) { start -= end - metadata.duration; end = metadata.duration; }
    return { ...segment, start: Math.max(0, start), end };
  });
  const fillerPeaks = [0.25, 0.5, 0.75].map(ratio => metadata.duration * ratio);
  for (const peak of fillerPeaks) {
    if (segments.length >= 3) break;
    if (metadata.duration >= 5 && segments.some(segment => Math.abs(segment.peak - peak) < 5)) continue;
    const span = Math.min(5, metadata.duration);
    const start = Math.max(0, Math.min(metadata.duration - span, peak - span / 2));
    segments.push({ start, peak, end: start + span, tier: '', combo: 0, accuracy: 0, fallback: true });
  }
  while (segments.length < 3) {
    const peak = fillerPeaks[segments.length] || metadata.duration / 2;
    const span = Math.min(5, metadata.duration);
    const start = Math.max(0, Math.min(metadata.duration - span, peak - span / 2));
    segments.push({ start, peak, end: start + span, tier: '', combo: 0, accuracy: 0, fallback: true });
  }
  segments.sort((a, b) => a.peak - b.peak);
  return {
    segments,
    duration: segments.reduce((sum, segment) => sum + segment.end - segment.start, 0),
    transitionDuration: .12,
    cardDuration: 2,
    title: metadata.highlightTitle || '你的舞台时刻',
  };
}

export function validateMetadata(body, maxDuration = 600) {
  if (!body || !Number.isFinite(body.duration) || body.duration < 1 || body.duration > maxDuration)
    throw new Error('录像时长须为 1～600 秒');
  if (!Array.isArray(body.samples) || body.samples.length > 1200) throw new Error('高光数据格式错误');
  const samples = body.samples.map(s => {
    if (!s || !['t', 'conf', 'acc', 'combo'].every(k => Number.isFinite(s[k])) ||
      s.t < 0 || s.t > body.duration + 1 || s.conf < 0 || s.conf > 1 || s.acc < 0 || s.acc > 1 || s.combo < 0)
      throw new Error('高光数据超出范围');
    return { t: s.t, conf: s.conf, acc: s.acc, combo: Math.min(s.combo, 100000), tier: String(s.tier).slice(0, 12) };
  });
  if (body.highlights != null && (!Array.isArray(body.highlights) || body.highlights.length > 3))
    throw new Error('高光片段格式错误');
  const highlights = (body.highlights || []).map(segment => {
    if (!segment || !['start', 'peak', 'end'].every(k => Number.isFinite(segment[k])) ||
      segment.start < 0 || segment.start >= segment.peak || segment.peak >= segment.end ||
      segment.peak >= body.duration || segment.end > body.duration + .05 ||
      segment.end - segment.start < .5 || segment.end - segment.start > 12)
      throw new Error('高光片段超出范围');
    return {
      start: segment.start,
      peak: segment.peak,
      end: Math.min(body.duration, segment.end),
      tier: ['PERFECT', 'GREAT', 'GOOD'].includes(segment.tier) ? segment.tier : '',
      combo: Math.max(0, Math.min(1e6, Math.round(Number(segment.combo) || 0))),
      accuracy: Math.max(0, Math.min(1, Number(segment.accuracy) || 0)),
      fallback: !!segment.fallback,
    };
  });
  const r = body.result || {};
  return {
    duration: body.duration,
    samples,
    highlights,
    highlightTitle: String(body.highlightTitle || '').slice(0, 24),
    result: {
    score: Math.max(0, Math.min(1e9, Math.round(Number(r.score) || 0))),
    maxCombo: Math.max(0, Math.min(1e6, Math.round(Number(r.maxCombo) || 0))),
    grade: /^[SABCD]$/.test(r.grade) ? r.grade : 'D',
  } };
}
