# 视频模式排查手册:视频突然不播 + 选曲首屏卡顿

面向现场工作人员与后续维护者。两类问题的**成因、如何在 30 秒内定位、以及已做的修复**。

对应改动:
- `web_dance/video-source.js`(新增)——参考视频的加载时序状态机与诊断
- `web_dance/main.js` —— 视频模式接入新状态机 + 看门狗 + 首屏调度
- `test/video-source.test.js` —— 15 条单测,用替身 `<video>` 复现三种现场故障
- `test/browser/video-mode.spec.js` —— 真浏览器量测 LCP / 长任务 / 视频健康度

---

## 一、视频突然不播了

### 1.1 先看控制台(30 秒定位)

页面控制台里所有参考视频的动作都带 `[ref-video]` 前缀。**正常一局应该长这样**:

```
[ref-video] src → http://127.0.0.1:8000/videos/%E8%88%9E%E8%B9%881.mp4
[ref-video] loadedmetadata rs=1 ns=1 t=0
[ref-video] canplay rs=4 ns=1 t=0
[ref-video] playing rs=4 ns=1 t=0.001
[ref-video] play() 成功
```

（`rs` = readyState:0 HAVE_NOTHING / 1 HAVE_METADATA / 2 HAVE_CURRENT_DATA / 3 HAVE_FUTURE_DATA / 4 HAVE_ENOUGH_DATA；`ns` = networkState）

**出问题时对照下表**:

| 控制台看到 | 结论 | 处理 |
|---|---|---|
| `play() 被拒 AbortError: The play() request was interrupted by a call to pause()` | 同一元素上"改源/暂停"和"播放"抢跑 | 已修:改为等元数据就绪再 play。若仍出现,把完整日志交给开发 |
| `play() 被拒 NotAllowedError` | 自动播放策略(理论上不会:参考视频永远 muted) | 检查 `#ref-video` 的 `muted` 是否被别的代码改掉 |
| `视频加载失败 MEDIA_ERR_SRC_NOT_SUPPORTED` | 地址取不到或格式不支持 | 直接在浏览器打开该 URL;404 就是后台绑定失效/文件被删 |
| `视频加载失败 MEDIA_ERR_DECODE` | 文件损坏或 H.264 profile 不支持 | `ffmpeg -i 文件` 看编码;`-c:v libx264 -profile:v main -pix_fmt yuv420p` 重转 |
| `视频加载超时 15000ms` | 请求卡住(服务器/网线/上传被截断) | 看服务器是否在跑:`curl -I http://127.0.0.1:8000/videos/xxx.mp4` 应返回 200 且带 `Accept-Ranges: bytes` |
| `waiting` / `stalled` 反复出现 | 解码或带宽被抢占 | 见 1.3:关掉同时跑的录制/推理;视频模式已隐藏全屏 `#fx` |
| `本该在播却没有:… → 补一次 play()` | 有人(或某条异步路径)把视频停住了 | 看门狗已自动救回;连续出现就贴日志给开发 |
| **一条 `[ref-video]` 都没有** | 根本没进视频模式 | 确认后台 `/settings` 的「右侧画面」= 视频,或 `localStorage['dance-side-mode'] === 'video'` |
| 状态栏显示「没有已绑定视频的舞曲」 | 后台没给任何舞曲绑视频 | 去 `/studio` →「右侧画面」绑定 |

### 1.2 一键取证

控制台执行:

```js
__danceVideo.export()   // 打印并返回完整快照(会自动带上"最可能的原因")
```

快照内容:当前地址、readyState/networkState/paused/currentTime、**MediaError.code 的人话解释**、
最近 60 条事件(带时间戳),以及 `errors` 字段里那句结论。工作人员页面的
「导出性能报告」按钮也已把同一份 `video` 段写进 `dance-performance.json`。

### 1.3 现场快速自检(不重启)

```js
// 现在到底在不在播?
__danceVideo.health()

// 人为按停,看门狗应该在 1 秒内救回来,并打印 "本该在播却没有…"
document.getElementById('ref-video').pause()
```

### 1.4 已修复的四个成因

| # | 原代码 | 症状 | 现在 |
|---|---|---|---|
| 1 | `video.src = url;` 之后立刻 `video.pause()` | 改完源马上打断,后续 `play()` 抛 AbortError 且被 `.catch(()=>{})` 吞掉 → **画面永远停住,零线索** | `prepareRefVideo()` 只加载不播;`playRefVideo()` 等 `loadedmetadata` 后再 play |
| 2 | 未 ready 就写 `currentTime = 0` | 留下 pending seek,`play()` 与 seek 抢跑 → 卡住不报错 | `VideoSource.seek()` 等 `seeked` 落定再继续 |
| 3 | 每次 `setRefVideo()` 都赋值 `src` | 反复打断正在播的画面(翻卡/吸引态每 5 秒一次) | `VideoSource.load()` 幂等:同地址直接复用,只有换曲才切源 |
| 4 | `startChallenge()` 中途 `return`(倒计时被打断、切歌、切标签页) | 之后**没有任何路径再调 play** → 一直静止 | `renderLoop` 里的看门狗:本局本该在播却没在播,1 秒后补一次 play 并留日志 |

另外修掉一个不报错的隐性问题:视频模式原来仍在合成全屏 `#fx` 特效画布(无内容),
现在 `display:none`,不再和白拿解码器抢栅格化预算。

### 1.5 数据链路自检(怀疑不是前端)

```powershell
# 服务器在跑吗
curl.exe -I http://127.0.0.1:8000/videos/舞蹈1.mp4
# 期望:200 / Content-Type: video/mp4 / Accept-Ranges: bytes

# 支持分段取吗(视频 seek 与缓冲依赖它)
curl.exe -r 0-1023 -o NUL -w "%{http_code} %{size_download}`n" http://127.0.0.1:8000/videos/舞蹈1.mp4
# 期望:206 1024

# 文件本身有没有问题
node -e "const p=require('ffmpeg-static');require('child_process').execFileSync(p,['-i','videos/舞蹈1.mp4'],{stdio:'inherit'})"
```

`Accept-Ranges` 缺失或返回 200 而不是 206 → 视频**只能从头播,一 seek 就卡**,这是服务器配置问题而非前端。
当前 `server/app.js` 用 `express.static` 挂 `/videos`,分段与 ETag 都正常。

---

## 一附、摄像头上的火柴人骨架开关

后台「游戏设置 → 摄像头」里的复选框 **显示火柴人骨架**:

- 存储键:`localStorage['dance-camera-stick']`(`"1"` 显示 / `"0"` 隐藏;**没有这个键 = 显示**,与历史行为一致)
- 游戏页在启动与 `storage` 事件时读取 → 在设置页改完,游戏页**不用刷新**就会跟上
- 关掉只是"不画骨架":姿态识别、跟跳、评分走的是同一条数据管线,完全不受影响
- 关掉还省掉每帧一次 320×240 的 `clearRect` + 骨骼绘制(`pose_capture/stick-figure.js` 的 `renderStickFigure` 整个不调用),这点预算留给视频解码

排查时如果"摄像头画面干净、没有骨架",先查这个键:

```js
localStorage.getItem('dance-camera-stick')   // null 或 "1" = 应显示;"0" = 已关闭
```

> 注意:`#cam-stick` 有自己的 `position/width/height` 规则,ID 选择器优先级高于 `[hidden]` 的
> UA 默认 `display:none`,所以 CSS 里必须显式写 `#cam-stick[hidden] { display: none; }`,
> 否则属性设了也藏不住(这条已写进 `web_dance/style.css`)。

---

## 一附二、播放期间的每帧开销(还会不会卡)

视频模式下播放期间每帧真正在干的活:

| 每帧开销 | 量级 | 说明 |
|---|---|---|
| `highlights.draw()` 的绘制调用 | **0.05–0.13 ms** | 三次 `drawImage` + 填底。主线程几乎不花时间 |
| `requestFrame()` 逼出的合成器重绘 | **主要开销** | 看不见的 1080×1920 画布每帧仍被整张重绘 |
| 姿态推理(Worker)+ 视频解码 | 独立线程 | `captureToResult` p95 约 3 ms,与渲染并行 |
| 右下判定轨道 DOM 写入 | 可忽略 | 已按需节流,`?nohint=1` 实测对帧率无影响 |

实测(Intel Iris Xe,headed Chrome,同一台机器,中位数):

| 配置 | 帧率 | 编码产出 |
|---|---|---|
| 不录制 | 48.9 fps | — |
| 录制(画布在文档内,每帧推帧) | 46.0 fps | 1029 kbps |
| 录制(画布脱离文档,每帧推帧) | **54.0 fps** | **1251 kbps** |

`requestFrame` 节流到每 3 帧一次只能到 52.3 fps,却把码率砍到 698 kbps —— 不划算,已放弃。

### 已经做的两处改动

1. **录制画布脱离文档**(`highlights.js`)
   放在文档里时它每帧被合成器整张重绘一次,而画面本来就看不见(+17% 帧率、+22% 编码产出)。
   代价是"脱离文档可能不产帧"确实存在,所以做了带证据判据的自动回退,见下。

2. **特效层静止时跳过合成**(`highlights.js` + `ui-lab/juice.js` 的 `isIdle()`)
   `fx` 画布绝大多数帧是空的,把它 1:1 混进录制画布是白花钱;静止时不合成。

### 回退判据(为什么不能按时间判断)

现场千万别把"首发分片晚到"当成故障。实测**健康的录制**在中途也可能只冲到个位数字节
(3 秒录制的 `bytesDuring` 多次测得 **1 字节**,数据在 `stop()` 时才一次性涌出),
首发分片时间在 1.8–2.2 秒之间波动。所以判据是:

- 构造时:`videoTrack.requestFrame` 不存在 → 直接留在文档里(不走这条路);
- 运行中:只有 `requestFrame()` **真的抛错** + 1.2 秒内确实一个分片都没有 → 才挂回文档。

`test/browser/recording.spec.js` 用四个场景把这条判据钉住了(失败+无数据才回退;
无证据不回退;健康不回退;太早不回退)。

### 关于帧率数字怎么读

- 上述数字是 **headless Chrome** 里量与 CI 里跑出来的。现场大头是**GPU 合成 + 视频解码 + 姿态推理
  三者抢同一块显卡**,低端工控机(核显/J4125 档)会比这里的数字更差。
- 所以别只看帧率,现场更应该看工作人员面板的「导出性能报告」:
  `pose.stages.captureToResult.p95`(识别链路)与 `rendering.stages.renderFrame`(帧间隔)。
- 如果现场确实卡,下一步优先级:
  1. 关掉高光录制(选曲页取消「录制我的高光时刻」)—— 这是唯一确定的大头;
  2. 在「游戏设置 → 摄像头」关掉火柴人骨架(省一次 320×240 清屏+绘制);
  3. 把参考视频换成更小的文件(现在是 832×1108 / 1.6 Mbps / 6.3 MB)。

---

## 二、选曲首屏:LCP 3.77s / INP 240ms

### 2.1 结论(实测前后对比)

同一台机器、同一份代码、headless Chrome、摄像头用桩替换、视频用真实 `videos/舞蹈1.mp4`:

| 指标 | 改动前 | 改动后 | 说明 |
|---|---|---|---|
| 选曲 UI 出现 | **4904 ms** | **642 ms** | 抽屉可交互的时间 |
| LCP | **5212 ms**(元素 `div#song-pick-title`) | **884 ms** | 现场报的 3.77s 是同一元素 |
| 选曲 UI 出现后最长任务 | **235 ms** | **85 ms** | 现场报的 INP 240ms 就是它 |
| 点击 → 画面更新 | 18 ms | 13 ms | 空转,不是瓶颈 |

复现命令:`npx playwright test test/browser/video-mode.spec.js`
（原始数字用同一 spec 在 `git stash` 后的代码上量得。）

> 现场 3.77s 与实验室基线 5.2s 的差异来自三处:CDN 是否命中、网络快慢、音频/摄像头是否已授权。
> 结论一致:**主要开销不是渲染,而是"选曲首屏被一堆不该在这时候做的事挡住了"**。

### 2.2 三个真正的成因

1. **three.js 走公网 CDN**(`cdn.jsdelivr.net`,1.2MB 未压缩)
   `main.js` 是 module,`import "three"` 解析前整页一动不动。国内现场这一项就能吃掉 2–4 秒。
   → 已改为本地 `./vendor/three.module.min.js`(655KB,分发包里自带,离线可跑)。

2. **`enterSelect()` 里 `await startCamera()`**
   MediaPipe Worker 启动 + 9MB wasm 编译 + 9MB 模型加载 + 摄像头授权,全部发生在
   `#song-pick` 显示之前。现场大量机器上这一步就是 LCP 的等待时间。
   → 已改为:先把选曲 UI 亮出来并让出一帧,再用 `requestIdleCallback` 预热摄像头
   (玩家从"看到抽屉"到"点开始"通常好几秒,足够;真来不及由 `startChallenge()` 兜底 await)。

3. **序列解析 + 白影图 `fetch→createImageBitmap→drawImage→toDataURL` 同步跑在首帧**
   每支舞一张 256×256 PNG 的裁剪+PNG 编码是几百 KB 级的同步重活。
   → 已改为:序列空闲加载(点「开始挑战」时若还没到会等一次,不重复加载);
   白影图改为清单到货后逐张补,并做两级缓存(裁剪结果按 url 缓存、招牌帧选择结果按舞曲缓存)。

### 2.3 还剩什么(可选优化)

- 首个长任务 ~370–430ms 是 **three.js + main.js 的解析与执行**。要进一步降,只能拆分首屏 bundle
  (把选曲 UI 与 3D 舞台/评分模块拆成按需动态 import),改动面较大。
  当前它发生在选曲 UI 出现**之前**,不影响点击手感,只影响首屏出现时间。
- 首屏之外的页面(`/studio`、`/editor`、`/lab`、`ui-lab/stage.html`、`compare-source.html`、根 `index.html`)
  仍在从 jsdelivr 取 three。同样建议改成本地 vendor(把 `importmap` 指到 `./vendor/three.module.min.js`)。
- `web_dance/vendor/three-addons/` 只保留了真正被 import 的 18 个文件(400KB,运行时按需拉取)。
  将来新增 addon import 时,记得同步把对应文件放进 `vendor/three-addons/`。

---

## 三、回归测试

```powershell
# 单元测试(含 video-source 的 15 条) — 185 passed
npm test

# 真浏览器:首屏性能预算 + 视频健康度 + 空列表提示 + 骨架开关
npx playwright test test/browser/video-mode.spec.js

# 高光录制必须真的产出可播放画面(不依赖音频素材)
npx playwright test test/browser/recording.spec.js

# 全部浏览器用例
npx playwright test
```

`test/browser/video-mode.spec.js` 里写了硬预算,超了会直接失败:

- LCP < 2500ms
- CLS < 0.1
- 选曲 UI 出现后的最长任务 < 200ms
- 点击 → 画面更新 < 200ms
- 开局后 `#ref-video` 必须真的在播;被按停后 1 秒内自动恢复
- 火柴人骨架开关:默认显示,设为 `0` 后 `#cam-stick` 的 `display` 必须是真的 `none`,且摄像头仍正常启动

`test/browser/recording.spec.js` 是高光录制的安全网(原来的 `highlights.spec.js` 依赖一个
仓库里不存在的 `web_dance/audio/pop-demo.wav`,harness 起不来,等于没有覆盖):

- 录制 3 秒的 blob 必须 > 20 KB(空录像只有容器头),并且真的能解码播放、分辨率 1080×1920
- 看门狗四个场景:失败+无数据才回退;无证据不回退;健康不回退;太早不回退

> 已知既有问题(与本次改动无关,改动前同样失败):`test/browser/highlights.spec.js` 依赖的
> `web_dance/audio/pop-demo.wav` 在仓库里不存在,harness 页面会卡在 `window.harnessReady`。
