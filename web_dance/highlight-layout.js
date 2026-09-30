export function highlightLayout(width = 720, height = 1280) {
  const margin = Math.round(width * 0.035);
  const coachW = Math.round(width * 0.30);
  const coachH = Math.round(height * 0.245);
  return {
    camera: { x: 0, y: 0, w: width, h: height },
    coach: {
      x: width - margin - coachW,
      y: margin + 52,
      w: coachW,
      h: coachH,
      radius: 20,
      fit: "cover",
      zoom: 1.25,
    },
  };
}
