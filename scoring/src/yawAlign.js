import { BONES } from "./schema.js";
function rotateYaw(bones, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return bones.map(([x, y, z]) => {
    return [x * c + z * s, y, -x * s + z * c];
  });
}
function projectXZ(v) {
  const x = v[0];
  const z = v[2];
  const len = Math.hypot(x, z);
  if (len < 1e-6) return null;
  return [x / len, z / len];
}
function estimateYawFromHipLine(bones) {
  const tl = projectXZ(bones[BONES.THIGH_L] ?? [0, 0, 0]);
  const tr = projectXZ(bones[BONES.THIGH_R] ?? [0, 0, 0]);
  if (!tl || !tr) return 0;
  const sx = tl[0] + tr[0];
  const sz = tl[1] + tr[1];
  const len = Math.hypot(sx, sz);
  if (len < 1e-6) return 0;
  return Math.atan2(sx / len, -sz / len);
}
function getYaw(frame, mode) {
  if (mode === "hip-line") {
    return estimateYawFromHipLine(frame.bones);
  }
  return frame.rootYaw ?? 0;
}
function alignPlayer(playerBones, playerYaw, refYaw) {
  return rotateYaw(playerBones, playerYaw - refYaw);
}
export {
  alignPlayer,
  estimateYawFromHipLine,
  getYaw,
  rotateYaw
};
