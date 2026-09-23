"""第 1 级坐标归一化（Danzle 方案）：髋中心平移 + 躯干长度缩放。

z（伪深度）跨帧不稳定，判定链路统一丢弃，只保留 x/y 归一化结果。
"""

import numpy as np

from .landmarks import LEFT_HIP, RIGHT_HIP, LEFT_SHOULDER, RIGHT_SHOULDER


def hip_center(landmarks):
    lm = np.asarray(landmarks, float)
    if lm.ndim != 2 or lm.shape[0] != 33:
        raise ValueError("landmarks 需为 (33, ...) 形状")
    return (lm[LEFT_HIP, :2] + lm[RIGHT_HIP, :2]) / 2.0


def torso_length(landmarks):
    lm = np.asarray(landmarks, float)
    return float(np.linalg.norm(lm[LEFT_SHOULDER, :2] - lm[LEFT_HIP, :2]))


def normalize_landmarks(landmarks):
    """返回同形状 (33,4) 数组：x/y 已平移缩放，z 置 0，visibility 原样保留。"""
    lm = np.asarray(landmarks, float)
    out = np.zeros_like(lm)
    centered = lm[:, :2] - hip_center(lm)
    scale = torso_length(lm) + 1e-6
    out[:, :2] = centered / scale
    out[:, 3] = lm[:, 3]
    return out


def flatten_normalized(landmarks):
    """Danzle 式坐标向量：返回 (66,) 的归一化 x/y，供坐标类特征/诊断使用。"""
    n = normalize_landmarks(landmarks)
    return n[:, :2].reshape(-1)