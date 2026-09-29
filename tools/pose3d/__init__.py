"""pose3d — 离线服务端 3D 人体姿态回归(MeTRAbs) → dance-sequence/v1 契约序列。

目的:替换「上传视频 → MediaPipe 单目 world landmark」这条链路上的深度估计,
消除单目 3D 的深度歧义(典型症状:膝盖弯折方向反向)。产出与
pose_capture/export.js 的 exportVideoToSequence 完全同构的序列 JSON,
供现有 retarget/评分直接消费,不触碰浏览器运行时。

子模块:
  - mapping.py : SMPL-24 骨架 → 契约 12 关节点 + 10 骨单位向量 + v2 朝向字段,
                 含 MeTRAbs 相机坐标系 → canonical 的轴标定。纯 numpy,可单测。
  - smooth.py  : One-Euro 时序平滑(对齐 pose_capture/filters.js 语义)。
  - video.py   : 视频 → 逐帧 RGB 数组(cv2,惰性导入)。
  - metrabs_model.py : MeTRAbs 推断包装(惰性导入,仅处理视频时才需要 TF)。
"""

__version__ = "0.1.0"