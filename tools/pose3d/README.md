# pose3d — 离线服务端 3D 动捕（MeTRAbs）

把「上传视频 → 3D 动捕」从浏览器端 MediaPipe 单目深度，替换为服务端 MeTRAbs 真 3D 回归，
消除单目深度歧义（膝盖弯曲方向反向的根因）。产出与 `pose_capture/export.js` 的
`exportVideoToSequence` 同构的 `dance-sequence/v1` 序列，直接供 retarget / 评分消费。

## 当前使用的模型

**`metrabs_eff2s_y4`**（EfficientNetV2-S，含 AIST-Dance++ 舞蹈训练数据）。

> 说明：早期采用 `metrabs_eff2l_y4_360`（EfficientNetV2-L + 360° 旋转增强，最大最慢）。
> 因纯 CPU 推理下约 3 秒/帧太慢，已切换为 `metrabs_eff2s_y4`（约 3 倍速）。`metrabs_eff2l_y4_360`
> 已从本机删除，不再使用。模型出处对比表见 `.metrabs-src/docs/MODELS_6_DATASETS.md`（第三方参考，不改动）。

模型目录约定：`tools/pose3d/models/metrabs_eff2s_y4/`（`saved_model.pb` + `variables/`）。
默认由 `__main__.py` 的 `--model` 参数指向该目录，也可改用任一 MeTRAbs SavedModel 目录或 tfhub URL。

## 环境

TensorFlow（MeTRAbs 依赖）对 Python 版本有要求，建议用独立 conda 环境（本项目用 `pose3d`，Python 3.11）：

```bash
conda create -n pose3d python=3.11 -y && conda activate pose3d
pip install -r tools/pose3d/requirements.txt
```

服务端通过环境变量 `POSE3D_PYTHON` 指定该环境 Python 路径（如 `D:\anaconda\envs\pose3d\python.exe`）。
用 `setx POSE3D_PYTHON "..."` 永久配置后重启终端 / 服务。

## 命令行用法

在仓库根目录执行：

```bash
python -m tools.pose3d --input 舞.mp4 --out 舞.json
python -m tools.pose3d --input 舞.mp4 --out - --fps 5 --no-smooth
```

常用参数：`--fps`（采样帧率，服务端固定 5）、`--model`、`--fov`、`--no-smooth`、
`--progress`（NDJSON 流式逐帧进度，供服务端 `/api/pose3d` 桥接透传）。