#!/usr/bin/env python3
"""pose3d CLI — 离线服务端 3D 动捕:视频 → MeTRAbs → dance-sequence/v1 序列 JSON。

替换「上传视频 → MediaPipe 单目深度」链路,消除单目深度歧义(膝盖反向的根因)。
产出与 pose_capture/export.js 的 exportVideoToSequence 同构,可直接被 retarget/评分消费。

用法(在仓库根目录执行):
  python -m tools.pose3d --input 舞.mp4 --out 舞.json
  python -m tools.pose3d --input 舞.mp4 --out - --fps 25 --no-smooth

依赖:见 tools/pose3d/requirements.txt。首次运行会下载 MeTRAbs 权重,较慢属正常。
"""

import argparse
import json
import sys
from pathlib import Path

from . import mapping, smooth, video, metrabs_model


def build_sequence(frames_smpl, joint_names, args):
    """frames_smpl: list[(t, (24,3) 相机系 3D 点)]。粘合映射→平滑→契约。"""
    # 1. 相机系联动关节点(raw,按帧)
    raw_joints = []
    ts = []
    for t, pose in frames_smpl:
        by_name = mapping.resolve_joints(joint_names, pose)
        raw_joints.append(mapping.smpl_to_contract_joints(by_name))
        ts.append(t)

    # 2. 时序平滑(可选,默认开)
    if not args.no_smooth:
        joints_seq = smooth.smooth_joint_sequence(
            raw_joints, ts,
            min_cutoff=args.min_cutoff, beta=args.beta, d_cutoff=args.d_cutoff,
        )
    else:
        joints_seq = raw_joints

    # 3. 相机系 → canonical → 帧 + 尺寸均值
    frames = []
    dims_sum = None
    dims_count = 0
    for t, joints in zip(ts, joints_seq):
        cj = mapping.joints_to_canonical(joints)
        frames.append(mapping.joints_to_frame(cj, t))
        d = mapping.compute_dimensions(cj)
        if dims_sum is None:
            dims_sum = dict(d)
        else:
            for k in dims_sum:
                dims_sum[k] += d[k]
        dims_count += 1

    dimensions = {k: round(v / dims_count, 3) for k, v in dims_sum.items()} if dims_count else {}

    return {
        "schema": "dance-sequence/v1",
        "danceId": Path(args.input).stem,
        "meta": {
            "fps": args.fps,
            "durationSec": round(ts[-1], 3) if ts else 0.0,
            "numFrames": len(frames),
            "boneCount": len(mapping.BONE_DEFS),
            "danceType": "full-body",
            "source": "metrabs-server",
            "coordinateSystem": "canonical-yup",
            "dimensions": dimensions,
        },
        "bones": [{"name": n, "parent": p, "child": c} for n, p, c in mapping.BONE_DEFS],
        "frames": frames,
    }


def main():
    ap = argparse.ArgumentParser(description="MeTRAbs 视频 → dance-sequence/v1")
    ap.add_argument("--input", required=True, help="输入视频文件")
    ap.add_argument("--out", required=True, help="输出 JSON('-'=stdout)")
    ap.add_argument("--fps", type=float, default=30.0, help="采样帧率")
    ap.add_argument(
        "--model",
        default=str(Path(__file__).resolve().parent / "models" / "metrabs_eff2s_y4"),
        help="MeTRAbs SavedModel 目录(默认本地 eff2s_y4)或 tfhub URL",
    )
    ap.add_argument("--fov", type=float, default=55.0, help="默认垂直视场角(无内参时)")
    ap.add_argument("--no-smooth", action="store_true", help="关闭时序平滑")
    ap.add_argument(
        "--progress",
        action="store_true",
        help="stdout 按 NDJSON 流式输出逐帧进度(progress 行+末尾 result/error 行),供服务端流式桥接",
    )
    ap.add_argument("--min-cutoff", type=float, default=1.5)
    ap.add_argument("--beta", type=float, default=0.5)
    ap.add_argument("--d-cutoff", type=float, default=1.0)
    args = ap.parse_args()

    sys.stderr.write(f"[pose3d] 加载 MeTRAbs 模型 {args.model} …\n")
    runner = metrabs_model.MeTRAbsRunner(
        args.model, skeleton="smpl_24", default_fov_degrees=args.fov
    )

    def emit(obj):
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def fail(msg):
        if args.progress:
            emit({"error": msg})
        else:
            sys.stderr.write(f"[pose3d] {msg}\n")
            sys.exit(2)

    try:
        total = video.count_samples(args.input, args.fps) if args.progress else 0
        frames_smpl = []
        sys.stderr.write("[pose3d] 逐帧推断中…\n")
        if args.progress:
            emit({"progress": {"current": 0, "total": total}})
        current = 0
        for t, rgb in video.iter_frames(args.input, args.fps):
            pose = runner.detect(rgb)
            current += 1
            if args.progress:
                emit({"progress": {"current": current, "total": total}})
            if pose is not None:
                frames_smpl.append((t, pose))
        if not frames_smpl:
            fail("未检测到任何人体姿态")
            return

        sys.stderr.write(f"[pose3d] 共 {len(frames_smpl)} 帧,组装序列…\n")
        seq = build_sequence(frames_smpl, runner.joint_names, args)

        text = json.dumps(seq, ensure_ascii=False, separators=(",", ":"))
        if args.progress:
            emit({"result": seq})
            sys.stderr.write("[pose3d] 完成,已流式输出\n")
        elif args.out == "-":
            sys.stdout.write(text)
        else:
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text)
            sys.stderr.write(f"[pose3d] 已写出 {args.out}\n")
    except Exception as e:
        fail(f"3D 动捕失败: {e}")


if __name__ == "__main__":
    main()