# 视频批量上架(作品工坊 · 视频模式)

把一批舞蹈视频按 `/studio` 的六步流程批量上架进游戏,不用在浏览器里手点。
落地脚本:`tools/studio-video-pipeline.mjs`。

一轮完整跑法(服务已经在跑的前提下):

```bash
npm start                                             # 另开一个窗口
node tools/studio-video-pipeline.mjs --dir 训练视频     # 全部视频
node tools/studio-video-pipeline.mjs --videos 舞蹈7.mp4 # 只做一支(先拿短的试)
```

跑完用自检脚本确认产物真的能被游戏消费:

```bash
node tools/verify-video-dance.mjs
node tools/verify-video-dance.mjs --dances dance7-video,dance5-video
```

---

## 1. 为什么不能纯 Node 跑

六个步骤里有两步的**实现**本来就是浏览器端的,Node 里没有等价物:

| 步骤 | 谁在干活 | 为什么必须在浏览器 |
|---|---|---|
| ③ 动作序列 | MediaPipe PoseLandmarker | 动捕管线(`pose_capture/pose-engine` → `contract` → `filters`)是浏览器模块,`pose_capture/models/*.task` 由 Tasks Vision 的 wasm 运行时加载 |
| ⑤ 判定白影 | `web_dance/silhouette.js` + three.js | 白影来自真实的 3D 骨骼姿态 + WebGL 离屏渲染 |

所以这两步用 Playwright 起真 Chrome,页面用 `page.route()` 现场合成(`tools/video-import-core.mjs`、
`tools/silhouette-payload.mjs`),再从正在运行的服务加载上面那几个模块 ——
**和 `/studio` 页面执行的是同一份代码**,不是第二套实现。

① 素材、② 音频(ffmpeg)、④ 谱面、⑥ 出炉走服务端 HTTP 接口,与页面点按钮完全等价。

## 2. 数据流与产物

```
训练视频/<name>.mp4
  → ① PUT /api/drafts/:id/source?name=<name>.mp4      存进 .drafts/<id>/
  → ② POST /api/drafts/:id/extract-audio              ffmpeg → <stem>.wav
  → ③ PUT /api/drafts/:id/sequence                    无头 Chrome 逐帧识别 → dance-sequence/v1
  → ④ PUT /api/drafts/:id/chart + 重写 sequence        每 2 拍一个判定点,并把 chart 内嵌进序列
  → ⑤ PUT /api/drafts/:id/lane                        逐判定点渲染 PNG(dataURL)→ manifest
  → ⑥ POST /api/drafts/:id/publish                    songs/<danceId>/ + videos/ + web_dance/assets/lane/
```

上架后的产物:

| 产物 | 位置 | 谁消费 |
|---|---|---|
| 序列 | `songs/<danceId>/<danceId>.json` | `web_dance/song-library.js` → 教练/评分 |
| 谱面 | `songs/<danceId>/<danceId>.chart.json` | 谱面编辑器 |
| 音频 | `songs/<danceId>/<stem>.wav` | `audio.js` |
| 参考视频 | `videos/<stem>.mp4` + `videos/index.json` 的映射 | `web_dance/main.js`(视频模式右侧画面) |
| 判定白影 | `web_dance/assets/lane/<danceId>/*.png` + `index.json` | `web_dance/lane-assets.js` |

**谱面必须内嵌进序列顶层 `chart`。** 运行时 `pose-lane.js → computePoseEvents(seq)` 读的是
`seq.chart`,独立的 `<danceId>.chart.json` 只是编辑器的交换格式。只写后者、不写前者,
表现就是「谱面里明明有判定点,判定轨道却是空的」,而且不报任何错。

### 谱面铺点的两条硬约束

1. **判定点的 `t` 只能落在真采到姿态的时间范围里。** 抖音下载的视频末尾通常挂一张
   约 3 秒的片尾卡(「大家都在抖音搜索…」,画面里没有人),MediaPipe 在那里一律返回
   `world=null`,所以序列会比容器时长早约 3 秒结束。按容器时长铺点会铺出一段
   「对着空气跳舞」的判定区。脚本以**最后一帧的时刻**为界(再留 1 拍缓冲),
   并把这段差额打进日志:

   ```
   注:序列最后一帧在 37.67s,视频时长 40.68s —— 末尾 3.01s 没采到姿态(抖音片尾卡,
       画面里没有人),判定点只铺到有画面为止(少铺 3 个)
   ```

2. **`refFrameIdx` 必须按帧自带的 `t` 就近绑定**,不能用 `round(t × fps)` 反推下标 ——
   视频模式按时间对齐,序列抽帧不均匀时下标会随时间线性漂移。
   项目里有回归守着这条:`test/pose-lane.test.js`
   「不变量: 每个判定音符的参考帧时间与 note.t 相差 <= 0.05s」。

两条一起做之后,`note.t` 就等于 `frames[refFrameIdx].t` 本身(零偏差),画面与判定严格同步。

## 3. 参数与取舍

| 参数 | 默认 | 说明 |
|---|---|---|
| `--fps` | 15 | 动捕采样帧率。**这是精度与耗时的主要旋钮**(见下表) |
| `--bpm` | 120 | 谱面 BPM;判定点按「每 2 拍一个」铺,即每 1 秒一个 |
| `--suffix` | `-video` | danceId 后缀:`舞蹈2.mp4` → `dance2-video` |
| `--step` | `all` | `upload,audio,sequence,chart,lane,publish` 任意组合 |
| `--force` | 关 | 已存在的产物也重做 |
| `--dry` | 关 | 只打印计划 |

**为什么是 15fps 而不是 30fps**:视频模式是按**时间**对齐判定点的
(`chart.notes[].t` 找序列里最近的帧),不是按帧下标;游戏侧对参考帧做插值。
15fps 的参考动作在评分精度上足够,而耗时直接砍半。已有作品 `dance1-video` 用的是 30fps,
两者能共存(谱面里的 `refFrameIdx = round(t × fps)`,各自按自己的 fps 算)。

### 实测耗时(纯 CPU 机器,Chrome 无头 + SwiftShader 软件 WebGL)

| 视频 | 时长 | 采样 | 帧数 | 动捕耗时 | 每帧 |
|---|---|---|---|---|---|
| 舞蹈7.mp4 | 15.5s | 15fps | 184 | 2:43 | 0.9s |
| 舞蹈5.mp4 | 24.0s | 15fps | 360 | 4:00 | 0.7s |
| 舞蹈3.mp4 | 25.0s | 15fps | 328 | 5:53 | 1.1s |
| 舞蹈6.mp4 | 25.0s | 15fps | 370 | 5:55 | 1.0s |

`识别`(MediaPipe 推理)约占 2/3,`定位`(逐帧 seek + createImageBitmap)约占 1/3。
白影那步很快:25 个判定点约 7 秒。

> 实测过的优化方向与结论:
> - **并行开多个页面更快?** 不是。1 页 613ms/帧、2 页 1053ms/帧、4 页 2091ms/帧 ——
>   纯 CPU 推理,多开只是互相抢核。串行跑最快(`tools/bench-parallel.mjs` 是那次测量)。
> - **先降分辨率再识别?** MediaPipe 内部本来就会缩放到 256×256 再推理,
>   先转码只是拿脚本复杂度换一点点,不值得。
> - **改用服务端 MeTRAbs 3D 回归?** 精度更高,但本机 `tools/pose3d/models/metrabs_eff2s_y4/`
>   的权重文件 `variables.data-00000-of-00001` 缺失(该文件在 `.gitignore` 里),
>   且当前 Python 3.11 没装 TensorFlow —— 走不通,所以用浏览器 MediaPipe。

## 4. 断点续跑

每一步开工前先看草稿里该文件在不在,在就跳过(除非 `--force`)。
中途中断直接重跑同一条命令即可:

```bash
node tools/studio-video-pipeline.mjs --step sequence   # 只补动作序列
node tools/studio-video-pipeline.mjs --force --step lane  # 白影换模型重生成
```

- 同一个源视频名 → 复用同一条草稿(按 `files.source` 匹配),不会重复建作品。
- 白影模型默认 `/models/Michelle.glb`,与 `tools/lane-silhouettes.mjs` 的默认值一致。

## 5. 已知坑(都踩过并修好了)

- **`color: #ffffff` 插进页面模板会炸**:`#ffffff` 被 JS 当私有字段名解析,
  报 `Private field '#ffffff' must be declared in an enclosing class`。必须传数字 `0xffffff`。
- **服务端的序列/谱面接口回的是 `text/plain`**:走 `JSON.parse(await res.json())` 拿不到内容,
  要 `res.text()`。
- **`Page.evaluate` 会打断页面导航**:同一页面里先取视频再 `goto` 下一个地址,
  前一个 `evaluate` 会以 "Execution context was destroyed" 失败。自检脚本按「每支舞一个干净页面」写。
- **没有模型时进不去选曲态**:视频模式右边放的是参考视频、不用 3D 模型,但 `enterSelect`
  仍要等 `layoutForMode` 收尾。自检要带 `?autoload=1`,否则一直停在「正在加载默认舞者…」。
- **选曲抽屉一打开永远停在第 0 张卡**(`buildSelectCards()` 结尾写死 `selectCard(0)`),
  与 `?dance=` 参数无关。所以自检是「点开抽屉 → 点目标那张卡」,不是靠 URL 参数。
- **末尾那段「没有画面」不是 bug**:先按容器时长铺点,再用「就近取帧」绑 `refFrameIdx`,
  就会出现「t=39.0 的判定点绑到 37.67s 的帧」—— 偏移 1.3~2.3 秒。
  真因是片尾卡里没有人:姿态检测返回 null 是**正确**行为,不该去改检测阈值,
  该改的是铺点范围(见上文「谱面铺点的两条硬约束」)。
- **`node_modules` 会被外部清空**:动捕跑到一半发现 `Cannot find package '@playwright/test'`,
  服务也跟着 404/ECONNREFUSED —— 不是脚本的问题,`npm install` 重建依赖、重启服务即可续跑
  (每一步都有跳过逻辑,不会白干)。

## 6. 相关文件

| 文件 | 职责 |
|---|---|
| `tools/studio-video-pipeline.mjs` | 六步编排 + 续跑 + 谱面生成 |
| `tools/video-import-core.mjs` | ③ 的浏览器 harness(逐帧 seek + 识别 → `dance-sequence/v1`) |
| `tools/silhouette-payload.mjs` | ⑤ 的白影 harness(用内存里的序列出图,不经过歌单) |
| `tools/verify-video-dance.mjs` | 上架后自检(视频可加载 / 序列有帧 / 谱面能解析 / 白影存在 / 选曲 UI) |
| `tools/smoke-video-import.mjs` | 单独验证无头 Chrome 里的 MediaPipe 能不能跑 |
| `tools/bench-parallel.mjs` | 测「开 N 个页面并行动捕」的加速比 |
