"""MediaPipe Pose 33 点骨架 schema 常量。

与组员2 的提取模块对齐：landmarks 为 shape (33, 4) 数组，
列依次为 x, y（归一化图像坐标）、z（伪深度，判定不使用）、visibility。
"""

import numpy as np

NOSE = 0
LEFT_EYE_INNER = 1
LEFT_EYE = 2
LEFT_EYE_OUTER = 3
RIGHT_EYE_INNER = 4
RIGHT_EYE = 5
RIGHT_EYE_OUTER = 6
LEFT_EAR = 7
RIGHT_EAR = 8
MOUTH_LEFT = 9
MOUTH_RIGHT = 10
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
LEFT_ELBOW = 13
RIGHT_ELBOW = 14
LEFT_WRIST = 15
RIGHT_WRIST = 16
LEFT_PINKY = 17
RIGHT_PINKY = 18
LEFT_INDEX = 19
RIGHT_INDEX = 20
LEFT_THUMB = 21
RIGHT_THUMB = 22
LEFT_HIP = 23
RIGHT_HIP = 24
LEFT_KNEE = 25
RIGHT_KNEE = 26
LEFT_ANKLE = 27
RIGHT_ANKLE = 28
LEFT_HEEL = 29
RIGHT_HEEL = 30
LEFT_FOOT_INDEX = 31
RIGHT_FOOT_INDEX = 32

NUM_LANDMARKS = 33

# 关节三元组 (A, apex B, C)：夹角顶点在 B，由线段 BA 与 BC 构成。
# 增删此处即可扩展/收窄判定关节集，评分逻辑无需改动。
JOINT_TRIPLETS = {
    "L_elbow":    (LEFT_SHOULDER, LEFT_ELBOW, LEFT_WRIST),
    "R_elbow":    (RIGHT_SHOULDER, RIGHT_ELBOW, RIGHT_WRIST),
    "L_shoulder": (LEFT_ELBOW, LEFT_SHOULDER, RIGHT_SHOULDER),
    "R_shoulder": (RIGHT_ELBOW, RIGHT_SHOULDER, LEFT_SHOULDER),
    "L_knee":     (LEFT_HIP, LEFT_KNEE, LEFT_ANKLE),
    "R_knee":     (RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE),
    "L_hip":      (LEFT_KNEE, LEFT_HIP, RIGHT_HIP),
    "R_hip":      (RIGHT_KNEE, RIGHT_HIP, LEFT_HIP),
    "torso_lean": (RIGHT_SHOULDER, LEFT_SHOULDER, LEFT_HIP),
    "torso_sway": (LEFT_SHOULDER, RIGHT_SHOULDER, RIGHT_HIP),
    "hip_sway":   (LEFT_SHOULDER, LEFT_HIP, RIGHT_HIP),
}

JOINT_GROUPS = {
    "arms":  ["L_elbow", "R_elbow", "L_shoulder", "R_shoulder"],
    "legs":  ["L_knee", "R_knee", "L_hip", "R_hip"],
    "torso": ["torso_lean", "torso_sway", "hip_sway"],
}

DEFAULT_JOINT_GROUP_WEIGHTS = {"arms": 0.4, "legs": 0.3, "torso": 0.3}

# 参与判定的全部关节点（完整度指标统计范围）
USED_JOINTS = sorted({j for tri in JOINT_TRIPLETS.values() for j in tri})


def visibility_ok(landmarks, joints, threshold):
    """给定关节点的平均可见性是否跨过阈值。visibility ∈ [0,1]。"""
    lm = np.asarray(landmarks, float)
    return bool(float(lm[list(joints), 3].mean()) >= threshold)