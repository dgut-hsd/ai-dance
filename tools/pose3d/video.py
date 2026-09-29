"""video.py — 视频 → 逐帧 RGB 数组(惰性导入 cv2,仅处理视频时才需要 opencv)。

采样策略:按目标 fps 均匀抽样,返回 (t_sec, rgb_uint8[H,W,3]) 序列生成器。
"""


def iter_frames(path, fps=30.0):
    import cv2

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {path}")

    src_fps = cap.get(cv2.CAP_PROP_FPS)
    if not src_fps or src_fps <= 0:
        src_fps = 30.0
    src_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = src_count / src_fps if src_fps > 0 else 0.0

    step = max(1.0, src_fps / max(float(fps), 1.0))
    idx = 0
    next_idx = 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        # 只取落在采样栅格上的帧
        if int(round(next_idx)) == idx:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            t = idx / src_fps
            yield t, rgb
            next_idx += step
        idx += 1

    cap.release()
    return duration, src_fps


def count_and_duration(path):
    """返回 (帧数, 时长秒, 源 fps);用于 meta.numFrames/durationSec。"""
    import cv2

    cap = cv2.VideoCapture(path)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    duration = src_count / src_fps if src_fps > 0 else 0.0
    return src_count, duration, src_fps


def count_samples(path, fps=30.0):
    """按 iter_frames 的采样栅格,返回实际会处理的帧数(供流式进度 total)。"""
    import cv2

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return 0
    src_fps = cap.get(cv2.CAP_PROP_FPS)
    if not src_fps or src_fps <= 0:
        src_fps = 30.0
    src_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()

    step = max(1.0, src_fps / max(float(fps), 1.0))
    total = 0
    next_idx = 0.0
    for idx in range(src_count):
        if int(round(next_idx)) == idx:
            total += 1
            next_idx += step
    return total