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
  const r = body.result || {};
  return { duration: body.duration, samples, result: {
    score: Math.max(0, Math.min(1e9, Math.round(Number(r.score) || 0))),
    maxCombo: Math.max(0, Math.min(1e6, Math.round(Number(r.maxCombo) || 0))),
    grade: /^[SABCD]$/.test(r.grade) ? r.grade : 'D',
  } };
}
