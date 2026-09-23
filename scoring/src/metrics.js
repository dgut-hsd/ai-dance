function summarize(scores) {
  const tallies = {
    perfect: 0,
    great: 0,
    good: 0,
    miss: 0
  };
  const inWindow = [];
  for (const s of scores) {
    tallies[s.grade] = (tallies[s.grade] ?? 0) + 1;
    if (s.inWindow) inWindow.push(s);
  }
  const mean = (vals) => vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length;
  const poseAccuracy = mean(inWindow.map((s) => s.poseScore));
  const rhythmScore = mean(inWindow.map((s) => s.timingValue));
  const completeness = mean(inWindow.map((s) => s.completeness));
  const diffSum = scores.reduce((a, s) => a + s.difficulty, 0);
  const total = diffSum > 0 ? scores.reduce((a, s) => a + s.eventScore * s.difficulty, 0) / diffSum : 0;
  return {
    perEvent: scores,
    tallies,
    poseAccuracy,
    rhythmScore,
    completeness,
    total
  };
}
export {
  summarize
};
