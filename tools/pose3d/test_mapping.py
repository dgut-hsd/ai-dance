"""test_mapping.py — 纯 numpy 单测,验证 SMPL-24→契约映射的数学正确性(不依赖 TF)。

运行(在仓库根目录):
  python tools/pose3d/test_mapping.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from tools.pose3d import mapping, smooth


def _unit(v):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    return abs(n - 1.0) < 1e-6


def _make_canonical():
    """正对镜头站立、双臂下垂的契约关节 dict(已 canonical:x右/y上/z朝镜头)。"""
    hip_y, sh_y = 0.9, 1.4
    d = {
        "hips_center":   ( 0.0, hip_y, 0.0),
        "shoulders_center": (0.0, sh_y, 0.0),
        "left_hip":      (-0.09, hip_y, 0.0),
        "right_hip":     ( 0.09, hip_y, 0.0),
        "left_knee":     (-0.09, 0.45, 0.0),
        "right_knee":    ( 0.09, 0.45, 0.0),
        "left_ankle":    (-0.09, 0.08, 0.0),
        "right_ankle":   ( 0.09, 0.08, 0.0),
        "left_shoulder": (-0.19, sh_y, 0.0),
        "right_shoulder":( 0.19, sh_y, 0.0),
        "left_elbow":    (-0.19, 1.08, 0.0),
        "right_elbow":   ( 0.19, 1.08, 0.0),
        "left_wrist":    (-0.19, 0.82, 0.0),
        "right_wrist":   ( 0.19, 0.82, 0.0),
        "nose":          ( 0.0, 1.55, 0.05),
    }
    return {k: np.array(v, dtype=float) for k, v in d.items()}


def _smpl_names():
    return ["pelv", "lhip", "rhip", "bell", "lkne", "rkne", "spin", "lank", "rank",
            "thor", "ltoe", "rtoe", "neck", "lcla", "rcla", "head", "lsho", "rsho",
            "lelb", "relb", "lwri", "rwri", "lhan", "rhan"]


def test_apply_canonical():
    out = mapping.apply_canonical([1.0, 2.0, -3.0])
    assert np.allclose(out, [-1.0, -2.0, 3.0]), out


def test_smpl_to_contract_joints():
    names = _smpl_names()
    idx = {n: i for i, n in enumerate(names)}
    pos = np.zeros((len(names), 3), dtype=float)
    def setp(name, xyz):
        pos[idx[name]] = xyz

    # 相机系小数演示;关键是名字→位置映射与派生中点
    setp("lhip", (-0.09, -0.9, 2.0)); setp("rhip", (0.09, -0.9, 2.0))
    setp("lkne", (-0.09, -0.45, 2.0)); setp("rkne", (0.09, -0.45, 2.0))
    setp("lank", (-0.09, -0.08, 2.0)); setp("rank", (0.09, -0.08, 2.0))
    setp("lsho", (-0.19, -1.4, 2.0)); setp("rsho", (0.19, -1.4, 2.0))
    setp("lelb", (-0.19, -1.08, 2.0)); setp("relb", (0.19, -1.08, 2.0))
    setp("lwri", (-0.19, -0.82, 2.0)); setp("rwri", (0.19, -0.82, 2.0))
    setp("head", (0.0, -1.55, 1.95))

    by_name = mapping.resolve_joints(names, pos)
    j = mapping.smpl_to_contract_joints(by_name)
    # 13 跟踪点 + 2 派生中点
    assert len(j) == 15, len(j)
    for k in mapping.CONTRACT_JOINTS:
        assert k in j, k
    # 派生中点 = l/r 平均
    assert np.allclose(j["hips_center"], (j["left_hip"] + j["right_hip"]) / 2.0)
    assert np.allclose(j["shoulders_center"], (j["left_shoulder"] + j["right_shoulder"]) / 2.0)
    # 缩写名命中 positions
    assert np.allclose(j["left_hip"], pos[idx["lhip"]])
    assert np.allclose(j["nose"], pos[idx["head"]])


def test_compute_bones_count_and_unit():
    j = _make_canonical()
    bones = mapping.compute_bones(j)
    assert len(bones) == 10, len(bones)
    assert len(bones) == len(mapping.BONE_DEFS)
    for b in bones:
        assert _unit(b), b
    # 顺序与 BONE_DEFS 一致:第 6 条是 thigh_l(parent=left_hip, child=left_knee)
    assert mapping.BONE_DEFS[5][0] == "thigh_l"
    # 站姿左大腿垂直向下 → (0,-1,0)
    assert np.allclose(bones[5], [0.0, -1.0, 0.0], atol=1e-6), bones[5]


def test_compute_orientations():
    j = _make_canonical()
    o = mapping.compute_orientations(j)
    # 髋轴 +x(右-左) → rootYaw = atan2(0, +x) = 0
    assert abs(o["rootYaw"]) < 1e-9, o["rootYaw"]
    # 肩轴 = +x 单位向量
    assert np.allclose(o["shoulderAxis"], [1.0, 0.0, 0.0], atol=1e-6)
    # 肩轴偏航 - 髋轴偏航 = 0
    assert abs(o["torsoTwist"]) < 1e-9
    # 脊柱竖直向上 → pitch/roll 均为 0
    assert abs(o["torsoPitch"]) < 1e-9
    assert abs(o["torsoRoll"]) < 1e-9

    # 髋轴转向 +z → rootYaw = +π/2
    j2 = dict(j); j2["right_hip"] = np.array([0.0, 0.9, 0.09]); j2["left_hip"] = np.array([0.0, 0.9, -0.09])
    o2 = mapping.compute_orientations(j2)
    assert abs(o2["rootYaw"] - np.pi / 2) < 1e-6, o2["rootYaw"]


def test_compute_dimensions_keys():
    j = _make_canonical()
    d = mapping.compute_dimensions(j)
    expect = {"spineLen", "shoulderWidth", "hipWidth", "upperArm", "forearm", "thigh", "shin", "headLen"}
    assert set(d.keys()) == expect, set(d.keys())
    # spine 两点 y 差 = 0.5
    assert abs(d["spineLen"] - 0.5) < 1e-9, d["spineLen"]


def test_joints_to_frame():
    j = _make_canonical()
    f = mapping.joints_to_frame(j, 0.5)
    assert f["t"] == 0.5
    assert len(f["bones"]) == 10
    assert len(f["conf"]) == 10 and all(abs(c - 1.0) < 1e-9 for c in f["conf"])
    for k in ("rootYaw", "shoulderAxis", "torsoTwist", "torsoRoll", "torsoPitch", "rootYawConf"):
        assert k in f, k


def test_one_euro():
    f = smooth.OneEuro(min_cutoff=1.5, beta=0.5, d_cutoff=1.0)
    first = f(np.array([0.0, 0.0, 0.0]), 0.0)
    assert np.allclose(first, [0.0, 0.0, 0.0])  # 首帧原样返回
    # 后续帧向目标收敛但被低通衰减(不会瞬间跳变)
    y = f(np.array([1.0, 0.0, 0.0]), 1 / 30.0)
    assert 0.0 < y[0] < 1.0, y


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print(f"\n{len(tests)} 项全部通过")


if __name__ == "__main__":
    main()