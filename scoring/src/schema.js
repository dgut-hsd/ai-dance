const BONE_COUNT = 10;
const BONE_DEFS = [
  { name: "spine", parent: "hips_center", child: "shoulders_center" },
  { name: "upper_arm_l", parent: "left_shoulder", child: "left_elbow" },
  { name: "forearm_l", parent: "left_elbow", child: "left_wrist" },
  { name: "upper_arm_r", parent: "right_shoulder", child: "right_elbow" },
  { name: "forearm_r", parent: "right_elbow", child: "right_wrist" },
  { name: "thigh_l", parent: "left_hip", child: "left_knee" },
  { name: "shin_l", parent: "left_knee", child: "left_ankle" },
  { name: "thigh_r", parent: "right_hip", child: "right_knee" },
  { name: "shin_r", parent: "right_knee", child: "right_ankle" },
  { name: "head", parent: "shoulders_center", child: "nose" }
];
const BONES = {
  SPINE: 0,
  UPPER_ARM_L: 1,
  FOREARM_L: 2,
  UPPER_ARM_R: 3,
  FOREARM_R: 4,
  THIGH_L: 5,
  SHIN_L: 6,
  THIGH_R: 7,
  SHIN_R: 8,
  HEAD: 9
};
const DEFAULT_BONE_WEIGHTS = [
  0.285,
  0.095,
  0.095,
  0.095,
  0.095,
  0.07125,
  0.07125,
  0.07125,
  0.07125,
  0.05
];
export {
  BONES,
  BONE_COUNT,
  BONE_DEFS,
  DEFAULT_BONE_WEIGHTS
};
