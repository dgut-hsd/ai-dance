# pose_capture/ — 实时端 + 视频导出(摄像头/视频 -> MediaPipe -> 契约帧)

这是"摄像头/视频 -> 33 world landmarks -> 归一化 -> 契约帧 -> 火柴人"的浏览器端管线,
对应 `docs/interface-contract.md` 里的「实时端」。与 `frontend_dis`(3D 角色展示)解耦,
互不依赖。

## 文件

| 文件 | 职责 | 里程碑 |
|---|---|---|
| `contract.js` | 骨骼索引 + 坐标轴标定 + 归一化 + 拼帧 | M2 |
| `pose-engine.js` | MediaPipe 模型加载/推理(实时与导出共用) | M1 |
| `filters.js` | One Euro 滤波 + 低置信度冻结 | M4 |
| `mocap.js` | 摄像头 -> MediaPipe -> 平滑 -> 契约帧回调 | M0/M1/M4 |
| `export.js` | 视频 -> 逐帧 -> dance-sequence JSON 导出 | 导出 |
| `playback.js` | 序列 JSON 回放(重建关节 + 动画) | 回放 |
| `stick-figure.js` | 2D 火柴人(深度用颜色编码) | M3 起步 |
| `index.html` | 验证页(实时 + 视频导出) | M0–M4 |
| `models/` | `.task` 模型文件(已下载) | M0 |
| `perf.js` | 性能/帧率监控 | 调优 |

## 运行

不需要 Python。静态托管即可:

```bash
# 在仓库根目录
python -m http.server 8000
# 浏览器打开 http://localhost:8000/pose_capture/
```

(ES module 不能从 `file://` 打开,必须走 http;`localhost` 满足 getUserMedia 的安全要求。)

## 用法

顶部有**模式选择**:`全身舞蹈`(9 条骨骼)或 `手势舞`(上半身 5 条骨骼 + 手型)。
三种入口(实时/导出/预览)都用这个模式;导出的 JSON 会带 `danceType` 标签。

1. **实时**:点"启动摄像头",看火柴人 + 性能 + 契约帧。
2. **视频导出**:选一段视频(如 3D 角色跳舞渲染的 MP4),点"导出 JSON",
   逐帧跑 MediaPipe 后下载一个 `dance-sequence/v1` 参考文件。
3. **回放**:导出后点"播放动画",在当前页面用火柴人回放刚导出的序列(也支持下载)。
4. **同步预览**:选视频后点"同步预览",一边放视频一边实时画出火柴人(不落 JSON)。

## 完成标准

- **M0**:摄像头跑通。
- **M1**:持续拿到 33 个 world landmark。
- **M2**:9 条单位向量;坐标轴已标定(`{x:-1, y:-1, z:-1}`)。
- **M4**:挥手不抖、静止不漂;看不见部位被冻结。
- **导出**:导出的 JSON 符合 `docs/interface-contract.md` §4 格式。

## 调参

`startPoseStream({ smoothing })` / `exportVideoToSequence({ smoothing })` 控制 One Euro
filter,默认 `{ minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 }`(偏跟手,适合舞蹈):

- 觉得**抖**:`minCutoff` 调小(如 1.0),或 `beta` 调小(0.2–0.3)。
- 觉得**延迟/拖尾、跟不上快动作**:`beta` 调大(0.8–1.0)。
- 冻结阈值在 `filters.js` 的 `FREEZE_VISIBILITY`(默认 0.5)。

## 已知取舍 / 后续工作

- **MediaPipe 跑在主线程**,不是 Web Worker(0.10.14 无经典包,module worker 又禁
  `importScripts`)。以后要卸载到 worker,需用 Vite/esbuild 打包。
- **wasm 从 jsdelivr CDN 加载**,未自托管。访问慢可下载 `wasm/` 到本地并改
  `pose-engine.js` 里的 `TASKS_VISION`。
- **导出按视频原生帧率逐帧采集**(实时播放速度)。要更快/固定 fps,可改成手动 seek
  循环,后续优化。
