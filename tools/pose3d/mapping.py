"""mapping.py — MeTRAbs SMPL-24 骨架 → 契约关节点/10 骨单位向量/v2 朝向字段。

纯 numpy、无 TF 依赖,可单测。与 pose_capture/contract.js 的 poseFromJoints 及
scoring/examples/song-sources.js 的 fbxClipToSequence 保持逐字段一致:
  - bones:       normalize(child − parent),顺序同 BONE_DEFS(10 条)
  - rootYaw:     atan2(hip.z, hip.x),hip = right_hip − left_hip
  - shoulderAxis: normalize(right_shoulder − left_shoulder)
  - torsoTwist:  wrapAngle(肩轴偏航 − 髋轴偏航)
  - torsoPitch:  atan2(spine.z, spine.y);torsoRoll: atan2(spine.x, spine.y)
"""

import numpy as np

# ---------------------------------------------------------------------------
# §坐标轴标定(⚠ 仍需一次性实测复核,同 models/README.md 的权威签认方式)
# ---------------------------------------------------------------------------
# MeTRAbs 输出为「相机坐标系」,与 MediaPipe world landmark 同一套图像约定:
#   x = 图像右(对正对镜头的人 = 表演者左侧)、y = 图像下、z = 远离镜头(深度)。
# canonical 约定(interface-contract.md §1):x = 表演者右侧、y = 上、z = 朝镜头。
# 故三个轴都与 MediaPipe 一样全翻,等价于 contract.js 的 `AXIS_FLIP={x:-1,y:-1,z:-1}`。
# 实测(正对镜头、抬右手)若某分量反了,只改这里,别散落各处——这是本管线唯一标定权威。
CAMERA_TO_CANONICAL = (-1.0, -1.0, -1.0)  # (x, y, z) 各自的符号

# ---------------------------------------------------------------------------
# SMPL-24 关节名 → 契约关节点(用「候选名」匹配,兼容 MeTRAbs 缩写命名差异)
# ---------------------------------------------------------------------------
# 契约关节点(contract):13 跟踪点 + 2 派生中点。MeTRAbs `smpl_24` 24 关节点。
# 派生点 hips_center/shoulders_center 用 l/r 中点计算,与 contract.js addDerivedJoints 一致。
CONTRACT_JOINTS = (
    "left_hip", "right_hip", "left_knee", "right_knee",
    "left_ankle", "right_ankle", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow", "left_wrist", "right_wrist", "nose",
)

# 每个契约关节点在 smpl_24 里的候选名(按优先级)
JOINT_CANDIDATES = {
    "left_hip":     ("lhip", "left_hip", "hip_l"),
    "right_hip":    ("rhip", "right_hip", "hip_r"),
    "left_knee":    ("lkne", "left_knee", "knee_l"),
    "right_knee":   ("rkne", "right_knee", "knee_r"),
    "left_ankle":   ("lank", "left_ankle", "ankle_l"),
    "right_ankle":  ("rank", "right_ankle", "ankle_r"),
    "left_shoulder": ("lsho", "left_shoulder", "shoulder_l"),
    "right_shoulder": ("rsho", "right_shoulder", "shoulder_r"),
    "left_elbow":   ("lelb", "left_elbow", "elbow_l"),
    "right_elbow":  ("relb", "right_elbow", "elbow_r"),
    "left_wrist":   ("lwri", "left_wrist", "wrist_l"),
    "right_wrist":  ("rwri", "right_wrist", "wrist_r"),
    "nose":         ("head", "nose"),
}

# 契约 10 骨(parent→child),顺序必须与 contract.js BONE_DEFS 完全一致
BONE_DEFS = (
    ("spine", "hips_center", "shoulders_center"),
    ("upper_arm_l", "left_shoulder", "left_elbow"),
    ("forearm_l", "left_elbow", "left_wrist"),
    ("upper_arm_r", "right_shoulder", "right_elbow"),
    ("forearm_r", "right_elbow", "right_wrist"),
    ("thigh_l", "left_hip", "left_knee"),
    ("shin_l", "left_knee", "left_ankle"),
    ("thigh_r", "right_hip", "right_knee"),
    ("shin_r", "right_knee", "right_ankle"),
    ("head", "shoulders_center", "nose"),
)


def _norm(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else np.zeros(3)


def wrap_angle(a):
    return float(np.arctan2(np.sin(a), np.cos(a)))


def resolve_joints(smpl_names, smpl_positions):
    """smpl_names: list[str](模型推理时返回,顺序与 smpl_positions 一致);
    smpl_positions: (N,3) 相机系 3D 点(米)。返回按名字索引的 dict: name -> (3,) 相机系点。"""
    idx = {n: i for i, n in enumerate(smpl_names)}
    by_name = {}
    for n, i in idx.items():
        by_name[n] = np.asarray(smpl_positions[i], dtype=np.float64)
    return by_name


def smpl_to_contract_joints(by_name):
    """把 smpl_24 关节点 dict(相机系)映射为契约 12 关节点 dict(相机系)。
    缺失关节按 0 填充(与 contract.js 的 [0,0,0] 语义一致)。"""
    out = {}
    for cj in CONTRACT_JOINTS:
        hit = None
        for cand in JOINT_CANDIDATES[cj]:
            if cand in by_name:
                hit = by_name[cand]
                break
        out[cj] = hit if hit is not None else np.zeros(3)
    # 派生中点
    out["hips_center"] = (out["left_hip"] + out["right_hip"]) / 2.0
    out["shoulders_center"] = (out["left_shoulder"] + out["right_shoulder"]) / 2.0
    return out


def apply_canonical(p, axis_flip=CAMERA_TO_CANONICAL):
    """相机系 → canonical(x右,y上,z朝镜头)。"""
    return np.asarray(p, dtype=np.float64) * np.asarray(axis_flip, dtype=np.float64)


def joints_to_canonical(joints):
    """整帧关节点 dict 相机系 → canonical 系。"""
    return {k: apply_canonical(v) for k, v in joints.items()}


def compute_bones(joints):
    """按 BONE_DEFS 顺序算 10 条骨骼单位向量(canonical 系)。"""
    bones = []
    for _, parent, child in BONE_DEFS:
        bones.append(_norm(joints[child] - joints[parent]))
    return bones


def compute_orientations(joints):
    """v2 朝向字段:rootYaw / shoulderAxis / torsoTwist / torsoPitch / torsoRoll。"""
    hip = joints["right_hip"] - joints["left_hip"]
    root_yaw = float(np.arctan2(hip[2], hip[0]))
    shoulder_axis = _norm(joints["right_shoulder"] - joints["left_shoulder"])
    sh_yaw = float(np.arctan2(shoulder_axis[2], shoulder_axis[0]))
    torso_twist = wrap_angle(sh_yaw - root_yaw)

    spine = _norm(joints["shoulders_center"] - joints["hips_center"])
    torso_pitch = float(np.arctan2(spine[2], spine[1]))  # 前倾(绕 x)
    torso_roll = float(np.arctan2(spine[0], spine[1]))   # 侧倾(绕 z)
    return {
        "rootYaw": root_yaw,
        "shoulderAxis": shoulder_axis.tolist(),
        "torsoTwist": torso_twist,
        "torsoPitch": torso_pitch,
        "torsoRoll": torso_roll,
    }


def compute_dimensions(joints):
    """身体尺寸(米)mean 两边,口径同 playback.js computeDimensions。"""
    def d(a, b):
        return float(np.linalg.norm(joints[a] - joints[b]))
    return {
        "spineLen": d("hips_center", "shoulders_center"),
        "shoulderWidth": d("left_shoulder", "right_shoulder"),
        "hipWidth": d("left_hip", "right_hip"),
        "upperArm": (d("left_shoulder", "left_elbow") + d("right_shoulder", "right_elbow")) / 2,
        "forearm": (d("left_elbow", "left_wrist") + d("right_elbow", "right_wrist")) / 2,
        "thigh": (d("left_hip", "left_knee") + d("right_hip", "right_knee")) / 2,
        "shin": (d("left_knee", "left_ankle") + d("right_knee", "right_ankle")) / 2,
        "headLen": d("shoulders_center", "nose"),
    }


def joints_to_frame(joints, t):
    """canonical 系关节点 dict + 时间 t → 一帧契约对象(同 export.js 帧结构)。"""
    bones = compute_bones(joints)
    ori = compute_orientations(joints)
    return {
        "t": round(float(t), 3),
        "bones": [b.tolist() for b in bones],
        "conf": [1.0] * len(BONE_DEFS),
        "rootYaw": round(ori["rootYaw"], 4),
        "rootYawConf": 1,
        "shoulderAxis": [round(float(x), 4) for x in ori["shoulderAxis"]],
        "torsoTwist": round(ori["torsoTwist"], 4),
        "torsoRoll": round(ori["torsoRoll"], 4),
        "torsoPitch": round(ori["torsoPitch"], 4),
    }