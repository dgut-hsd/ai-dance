"""metrabs_model.py — MeTRAbs 推断包装(基于 tensorflow_hub 的独立 SavedModel)。

MeTRAbs 无 PyPI 发布,推理通过 tfhub.load() 加载独立 SavedModel(无需其代码库/cameralib/smpl 等依赖)。
模型以 zip 分发(见 docs/MODELS_6_DATASETS.md),下载解压后本地加载,或直接 `tfhub.load('https://bit.ly/metrabs_l')`。

⚠ 两点必须在实测后确认(一次即可):
  1. MeTRAbs 相机坐标系符号 → mapping.CAMERA_TO_CANONICAL(见 mapping.py §坐标轴标定);
     约定与 MediaPipe world landmark 同为 x=图像右/表演者左、y=下、z=远离镜头,故同用 (-1,-1,-1)。
  2. 模型骨架 `smpl_24` 的 24 关节点名(运行时从 SavedModel 的 per_skeleton_joint_names 读取,
     直接交给 mapping 候选名匹配,无需手写死)。
"""

import numpy as np


class MeTRAbsRunner:
    def __init__(self, model_source, skeleton="smpl_24", default_fov_degrees=55.0):
        import tensorflow as tf  # noqa: F401  惰性导入,仅真正推理才需要
        import tensorflow_hub as tfhub

        self._tf = tf
        self.skeleton = skeleton
        self.fov = default_fov_degrees

        # model_source 可为 URL(tfhub 直接拉取)或本地已解压的 SavedModel 目录。
        self.model = tfhub.load(model_source)

        # 关节点名(顺序与 poses3d 第二维一致),交给 mapping 做候选名匹配。
        names = self.model.per_skeleton_joint_names[skeleton].numpy()
        self.joint_names = [n.decode() if isinstance(n, bytes) else str(n) for n in names]

    def detect(self, rgb_uint8):
        """单帧 RGB(H,W,3) uint8 → (24,3) 米制相机系 3D 点。多人的话取人物框中心最靠画面中心者。"""
        import tensorflow as tf

        img = np.asarray(rgb_uint8, dtype=np.uint8)
        image = tf.convert_to_tensor(img)
        pred = self.model.detect_poses(image, default_fov_degrees=self.fov, skeleton=self.skeleton)

        poses3d = pred["poses3d"].numpy()  # (n, 24, 3),毫米相机系(MeTRAbs 输出单位)
        n = poses3d.shape[0]
        if n == 0:
            return None
        if n == 1:
            return np.asarray(poses3d[0], dtype=np.float64) * 0.001  # mm→m,对齐 MediaPipe world landmark

        # 多人:取人物框(像素 [left, top, width, height])中心最接近画面中心者(视频主体通常在中央)。
        boxes = pred["boxes"].numpy()  # (n, >=4)
        h, w = img.shape[:2]
        best_i, best_d = 0, float("inf")
        for i in range(n):
            cx = boxes[i, 0] + boxes[i, 2] / 2.0
            cy = boxes[i, 1] + boxes[i, 3] / 2.0
            d = (cx - w / 2.0) ** 2 + (cy - h / 2.0) ** 2
            if d < best_d:
                best_d, best_i = d, i
        return np.asarray(poses3d[best_i], dtype=np.float64) * 0.001  # mm→m