# models/ — MediaPipe 模型文件

本目录存放 PoseLandmarker 的 `.task` 模型文件。wasm 运行时从 CDN 加载,无需自托管。

## 需要下载的文件(只需一个)

| 文件 | 用途 | 大小 | 说明 |
|---|---|---|---|
| `pose_landmarker_full.task` | 全身姿态(默认) | ~7 MB | 精度/速度平衡,推荐 |
| `pose_landmarker_lite.task` | 低配机 | ~5 MB | 更快,精度略低 |
| `pose_landmarker_heavy.task` | 高精度 | ~26 MB | 慢,一般用不上 |

官方下载地址:

- full:  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`
- lite:  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`
- heavy: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task`

Windows PowerShell 下载(在本目录执行):

```powershell
Invoke-WebRequest -Uri "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task" -OutFile "pose_landmarker_full.task"
```

下载后放进本目录(`pose_capture/models/`),`mocap.js` 默认会找
`models/pose_landmarker_full.task`。

> 如果 `storage.googleapis.com` 在你的网络环境访问不了,用能访问的代理/镜像下载同一个
> 文件,只要文件名一致即可。

## 坐标轴标定(已完成 ✅)

实测结果(MediaPipe PoseLandmarker full 的 world landmarks):

- y 朝**下**、x 朝表演者**左侧**、z 朝**远离镜头**方向 —— 与 canonical frame 完全相反。
- 因此 `contract.js` 里 `AXIS_FLIP = { x: -1, y: -1, z: -1 }`(三个轴都翻)。

> **重要**:队友的「离线参考序列」管线(FBX → MP4 → MediaPipe)必须套用**相同的翻转**,
> 否则参考与玩家会处于镜像 / 上下颠倒 / 前后相反的两个坐标系,评分全错。
> 这一约定以 `contract.js` 的 `AXIS_FLIP` 为唯一权威,双方都从这里读。
