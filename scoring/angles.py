"""关节角度特征：每个关节三元组表示为顶点处的两个单位方向向量。

特征天然不受平移/缩放/旋转影响。两副姿态在某一关节的相似度 = 两对单位向量点积均值。
"""

import numpy as np

from .landmarks import JOINT_TRIPLETS

_EPS = 1e-8


def _unit_from_b(b, to):
    """顶点 B 指向 to 的单位方向向量；零长度段返回 None。"""
    d = to - b
    n = np.linalg.norm(d)
    if n <= _EPS:
        return None
    return d / n


def extract_angle_features(landmarks):
    """返回 {joint_name: (u, v)}，u,v 为顶点 B 处指向 A / C 的单位向量。

    任一段退化（长度≈0）时该关节为 None，评分时跳过并重新分配权重。
    landmarks: 任意 (33, k>=2) 数组，仅用前两列 x/y。
    """
    xy = np.asarray(landmarks, float)[:, :2]
    feats = {}
    for name, (a, b, c) in JOINT_TRIPLETS.items():
        u = _unit_from_b(xy[b], xy[a])
        v = _unit_from_b(xy[b], xy[c])
        feats[name] = (u, v) if u is not None and v is not None else None
    return feats


def joint_similarity(ref, player):
    """两个 (u,v) 特征在 [-1,1] 内的相似度；任一缺失返回 None。"""
    if ref is None or player is None:
        return None
    u_ref, v_ref = ref
    u_pl, v_pl = player
    return float((np.dot(u_ref, u_pl) + np.dot(v_ref, v_pl)) / 2.0)


def similarity_map(ref_landmarks, player_landmarks):
    """逐关节余弦相似度字典，供诊断/测试直接使用。"""
    r = extract_angle_features(ref_landmarks)
    p = extract_angle_features(player_landmarks)
    return {name: joint_similarity(r[name], p[name]) for name in JOINT_TRIPLETS}