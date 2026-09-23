const GAME_BANDS = [
  { edge: 0.05, grade: "perfect", value: 1 },
  { edge: 0.12, grade: "great", value: 0.8 },
  { edge: 0.2, grade: "good", value: 0.6 },
  { edge: 0.25, grade: "miss", value: 0 }
];
function gradeOf(deltaT, bands = GAME_BANDS, windowEdge = 0.25) {
  const abs = Math.abs(deltaT);
  for (const band of bands) {
    if (abs <= band.edge) return band.grade;
  }
  return "miss";
}
function timingValue(deltaT, bands = GAME_BANDS, windowEdge = 0.25) {
  const abs = Math.abs(deltaT);
  for (const band of bands) {
    if (abs <= band.edge) return band.value;
  }
  return 0;
}
function expTimingValue(deltaT, sigma) {
  return Math.exp(-Math.abs(deltaT) / sigma);
}
export {
  GAME_BANDS,
  expTimingValue,
  gradeOf,
  timingValue
};
