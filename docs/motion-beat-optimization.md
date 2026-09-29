# 动作生成 × 节拍识别 结合分析 与 姿态自然度优化方案

> 版本：v0.1（分析稿）
> 日期：2026-09-28
> 依据：`docs/` 现有 8 份设计文档 + `pose_capture/`、`web_dance/`、`scoring/`、`server/` 实际源码。
> 结论先行：当前项目的「人物动作」是**动捕 → 契约帧 → FBX 重定向**的确定性管线（非生成模型）；
> 「节拍」是**离线 BPM/onset 计算 + 谱面事件**。二者仅通过**单一时钟对齐**结合，节拍特征对动作生成
> 目前是「零反馈」。姿态不够优美的根因主要来自**数据降维损失 + 逐帧独立 IK 缺时序/运动学约束 +
> 音乐与动作只对齐不耦合**。

---

## 一、项目整体架构与技术栈

### 1.1 定位

DANCE ARENA：浏览器端「摄像头跟跳音游」。用户开网页 → 摄像头 → 跟着 3D 教练跳 → 实时打分。

### 1.2 技术栈摘要

| 层 | 技术 | 位置 |
|---|---|---|
| 前端渲染 | three.js 0.160（CDN importmap） | `web_dance/index.html` |
| 动捕 | MediaPipe Tasks Vision 0.10.14（PoseLandmarker / HandLandmarker，GPU→CPU 自动降级） | `pose_capture/pose-engine.js`、`pose_capture/models/*.task` |
| 音频/主时钟 | Web Audio API（`AudioContext.currentTime` 唯一主时钟） | `web_dance/audio.js` |
| 姿态重定向 | 方向对齐 + 两骨 IK + 根运动积分 | `web_dance/retarget.js`、`web_dance/ik.js` |
| 平滑滤波 | One Euro filter（自适应低通） | `pose_capture/filters.js` |
| 评分引擎 | 纯 JS（无编译），10 骨加权余弦相似 + 事件窗 argmax | `scoring/src/*` |
| 后端（高光） | Node 22 + FFmpeg（ffmpeg-static）+ 阿里云 OSS | `server/`、`web_dance/highlights.js` |
| 测试 | vitest（scoring）、node:test（audio/root-motion） | `scoring/tests/`、`test/` |

### 1.3 核心数据契约（决定一切的数据形状）

- **帧格式**：每条骨骼为**单位方向向量**（`bones[10][3]`），只比「方向」不比绝对 XYZ，平移/缩放不变（`docs/interface-contract.md` §2.5）。
- **骨骼表（10 骨）**：`spine / upper_arm_l / forearm_l / upper_arm_r / forearm_r / thigh_l / shin_l / thigh_r / shin_r / head`。
- **坐标系**：canonical-yup，x=右、y=上、z=朝相机（表演者面朝 `-z`）。
- **节拍 schema**：`timing/v1`（bpm / tempoMap / timeSignatures / beatTimesSec / downbeatsSec）。
- **谱面 schema**：`chart/v1`（notes：`beat/pose/hold/gesture` + timingWindows）。

---

## 二、核心模块与现有功能

### 2.1 动作链路（离线 + 实时共用同一重定向）

```
① 离线参考（每曲一次）  FBX → 标准机位渲染 MP4 → MediaPipe 33 landmark → 归一化
        → dance-sequence/v1 JSON（frames[] 就是「教练动作」）
② 实时玩家             getUserMedia → MediaPipe world landmark → 归一化 → 同构帧
③ 重定向到 3D 模型      retarget.js 把契约帧骨骼方向映射到 FBX/GLB 人形骨架
   ├─ 脊柱：方向对齐 + 多节曲率权重（S 曲线）
   ├─ 四肢：位置级两骨 IK（末端精确，肘/膝弯折用 pole 约束）
   ├─ 头：相对「中性朝向」偏差
   ├─ 根：根速度积分 + 地面接触（跳跃/位移/下蹲）
   └─ 脚：foot-IK 锁水平贴地
```

详解见 `web_dance/retarget.js`、`web_dance/ik.js`、`pose_capture/playback.js`（`reconstructJoints`）、
`pose_capture/root-motion.js`。

### 2.2 节拍与谱面链路

```
① 节拍  timing/v1 由离线 librosa/aubio 算好（bpm/tempoMap/beatTimesSec/downbeatsSec）
        运行时只读（web_dance/audio.js TimingMap），不在浏览器重算
② 谱面  chart/v1（notes 触发判定；权威位置 = 参考序列内嵌 seq.chart）
        chartBuilder 自动编谱（uniform 每 0.5s / extrema 角速度极值），或人工制谱
③ 判定  NoteJudge（audio.js）/ ScoringEngine（scoring/src）+ ScoringAdapter
        （web_dance/scoring-adapter.js）：chart note + 参考帧 + 玩家帧 三方协同
```

---

## 三、当前「动作生成」与「节拍识别」的结合方式（精确到代码）

### 3.1 唯一结合点 = 单一时钟

`main.js` 中教练动作与音乐、节拍、评分全部从同一个 `songTime` 派生：

```js
// web_dance/main.js — makeCoachPlayer：把参考序列按时间逐帧喂给教练
function makeCoachPlayer(seq, retargeter, boneDefs) {
  const fps = seq.meta?.fps || 30;
  const frames = seq.frames || [];
  return {
    update(t) {
      const i = Math.min(frames.length - 1, Math.max(0, Math.round(t * fps)));
      retargeter.applyFrame(frames[i], { boneDefs, mirror: false, rootMotion: false });
    },
  };
}
```

主循环（`challengeTimer`, 25ms tick）：

```js
const t = session.songTime;                 // 唯一时钟（AudioContext.currentTime 派生）
state.coachPlayer.update(t);                // ① 教练动作 = 按 t 线性回放 frames[]
ch.scorer.advance(t - lag);                 // ② 评分 = chart note.t + 玩家帧
session.update();                           // ③ 内部驱动 onBeat 脉冲 + judge.tick
beatPulse(t, ch);                           // ④ 节拍脉冲仅做视觉
```

### 3.2 结合方式的本质

| 维度 | 现状 |
|---|---|
| 时间对齐 | ✅ 通过 `AudioContext.currentTime → songTime` 保证教练/音乐/评分同源，不漂移 |
| 韵律耦合 | ❌ **动作帧是独立录制的，仅按 `round(t*fps)` 线性回放**；节拍强弱、重音、音乐情感完全不反馈到动作上 |
| 节拍参与评分 | ❌ `timing/v1` 目前「旁路」（`docs/data-flow.md` §8）；判定用的是谱面 `note.t`，节拍栅格只做 HUD 对拍 |
| 动作 ≠ 生成 | ⚠️ 是「动捕重放 + 重定向」，不是「根据音乐生成动作」；不存在条件生成 |

> 一句话：**当前是「用同一条时间轴把录好的动作放给录好的音乐」，而不是「音乐驱动/塑造动作」。**
> 这正是「姿态不够优美自然」以及「动作与音乐情感不匹配」的根本来源。

---

## 四、导致姿态不自然的六大技术瓶颈

### B1. 数据表示降维损失（源头性）

契约帧只存 **单位方向向量**，丢失三类信息：

1. **骨长/身材差异**：`reconstructJoints` 用固定人体尺寸（`DEFAULT_DIMS`）重建，回放是「标准身材」，
   原始 FBX 舞者的肢体比例、肩宽、臂长等风格信息全部抹平。
2. **躯干 roll / pitch 丢失**：`rootYaw` 只保留绕竖直轴的偏航，`interface-contract.md` 明确「roll/pitch 不做」，
   转体侧倾、wave 等 3D 动作退化为平面动作（见 `retarget.js` `_applyDir` / `hip-line` 只算偏航）。
3. **四肢扭转（twist）丢失**：肘/腕的自旋、肩关节内旋外旋无法表达，导致手臂姿势「方向对但姿势僵」。

### B2. 两骨 IK 的固有缺陷（`ik.js`）

- **解不唯一**：肘/膝弯折方向由 `pole` 决定，`retarget.js` 用「肘/膝关节点反推 pole」，本身带 MediaPipe 噪声；
  pole 退化时（腕/肘/肩共线、膝近伸直）解会跳变（`ik.js` 里 `clamp` 到 `abs(l1-l2)+EPS`）。
- **逐帧独立求解**：`applyFrame` 每帧独立 `solveTwoBone`，无「与上一帧解一致性」约束 → 极限角时左右横跳、
  「啪」的反折。
- **末端精确 + 中间失准**：只保证腕/踝到位，肘/膝的屈曲角度由 pole 近似；伸直/折叠两端误差大。

### B3. 平滑滤波与响应性的矛盾（`filters.js` + `retarget.js`）

- 输入在 `pose_capture` 已过 One Euro（`beta` 0.5→舞蹈 0.8），`retarget.smooth` 当前=1（不再二次平滑），
  快动作跟手了，但高频抖动仍在关节角层面表现为「肌肉抖动」。
- One Euro 在**笛卡尔点**上滤波，而非**关节角/四元数流形**上滤波，对旋转姿态的平滑是不精确的。

### B4. 根运动方案 C 的漂移与失配（`root-motion.js` + `retarget.js`）

- 水平位移用「速度积分 + 死区 + 指数回中 + 限幅」近似，存在随机游走漂移与「贴地回中」造成的
  前后晃动（`ROOT_VEL_DEADZONE / ROOT_RECENTER / ROOT_MAX_DISP`）。
- 垂直跳跃由速度积分（`_airVy` + `ROOT_AIR_DAMP`），腾空高度与落地触地不可精确，常见「跳跃飘/落地滑」。
- 关键：**教练（参考）`rootMotion:false` 固定站位**，所有位移表现力（走位、转身位移）在教练侧被完全丢弃。

### B5. 足部与头部表现力缺失

- `retarget.js` 脚掌简单「锁水平贴地」（`feet` 循环），**脚踝跖屈/足跟抬起/脚尖朝向全不做**（契约明确忽略足部）。
- 头 = 相对中性朝向的偏差（`_headNeutral`），无脸部朝向与躯干转动的自然耦合，头部动画单调。

### B6. 音乐与动作「只对齐、不耦合」（结合层瓶颈）

- **无高阶音乐特征**：project 只有 BPM/onset 一维信息；没有 onset strength、spectral flux、chroma、
  downbeat 强度、段落能量曲线、音色/情绪标签。
- **谱面事件密度固定**：`chartBuilder` 默认每 0.5s 一个 pose 事件（`intervalFrames = fps*0.5`）或
  extrema 模式按「骨骼角速度极值」采样——**与音乐强弱/小节语义无关**。
- **无时序连贯性建模**：帧与帧是硬切（fps 23/30），无插值/平滑轨迹；无速度/加速度/最小急动度约束，
  动作接缝处「卡顿/抖动」。
- 直接后果：**动作重音不会落在 downbeat、动作幅度不随音乐强弱变化、段落情绪（verse/chorus/drop）无法体现在动作上**。

---

## 五、优化思路与技术方案

> 按「四方向 + 每方向若干可实施方案」组织。每条含 **可行性 / 实施步骤 / 评估指标 / 验证方法**。
> 优先级与落地顺序见 §六。

---

### 方案 A：改进节拍特征提取算法（方向 1）

**A-1 离线端多粒度节拍特征升级（推荐，低风险高收益）**

- 内容：从「单一 BPM + onset」升级为**多粒度节奏描述**，输出增强 schema（提议 `timing/v2` 或 `timing/v1` 扩展字段）：
  - onset strength envelope（每帧的起始强度曲线）
  - downbeat / 小节边界（用 madmom 的 DBN beat tracking 或 essentia 的 RhythmExtractor2013，替代/校准 librosa）
  - 每拍/每小节强度 `beatIntensity[]`、`downbeatIntensity[]`
  - 段落标记 `sections[]`（verse / chorus / breakdown / drop，用反复结构检测或能量突变）
  - 音色/情绪特征（MFCC 均值、谱质心、chroma 主导和声）
- 可行性：**高**。纯离线（librosa/aubio/madmom/essentia 均无浏览器依赖）；不动运行时核心，只扩展 meta 字段（向后兼容）。
- 实施步骤：
  1. 新增 `tools/` 离线脚本，输入音频，输出增强 `timing`；
  2. 对 3 首 demo 曲（demo-beat / pop-demo / samba-demo）跑一遍，人工校对 downbeat/段落；
  3. 扩展 `TimingMap`（`web_dance/audio.js`）查询接口，消费新增字段；旧数据回退到 v1 逻辑。
- 评估指标：onset/downbeat 的 F-measure（对人工标注）、BPM 相对误差 ≤ ±1 BPM、段落边界 ±0.5 小节。
- 验证方法：脚本内置一个含人工标注的 30s 测试音频，输出指标并断言阈值；`npm test` 绿。

**A-2 在线轻量节拍跟随（可选，中收益中风险）**

- 内容：用 Web Audio `AnalyserNode` 实时计算低频能量包络峰值，作为「输出延迟漂移」的在线校正信号，
  校准 `LatencyModel`（不替代离线节拍，只做漂移补偿）。
- 可行性：中。受浏览器权限/设备采样的稳健性限制，作为「校准辅助」而非「节拍真相」。
- 评估指标：在线 onset 与离线 downbeat 的平均绝对时间差；校准前后 totalOffsetSec 的稳定性。
- 验证方法：录一段「节拍器 + 敲击」人工样本，对比 `autoCalibrate` 收敛值。

---

### 方案 B：优化动作生成模型的时序连贯性（方向 2）

**B-1 姿态空间时序滤波 + 关键帧插值（推荐，高收益）**

- 内容：
  1. 把 IK 输出从「逐帧独立四元数」改为**在关节角/四元数流形上做时序平滑**（对每根骨骼的
     世界四元数做 slerp 序列的 One Euro 或 Savitzky-Golay 平滑），替代当前 `smooth=1` 的「零平滑/或线性 slerp」。
  2. 对参考序列做**关键帧提取（基于骨骼角速度局部极值，复用 `chartBuilder.perFrameVelocity`）+ 三次样条/贝塞尔插值**，
     上采样到 60fps 并保证 C¹ 连续，消除 fps 23/30 硬切的接缝抖动。
  3. 可选：施加**最小急动度（minimum jerk）或二阶弹簧-阻尼**轨迹约束。
- 可行性：高。都在消费端（`retarget.js` / `pose_capture/playback.js`）可做，不依赖新模型或外部服务。
- 实施步骤：
  1. 在 `retarget.js` `applyFrame` 内维护每骨的「上一帧世界四元数 + 平滑状态」，替换 `slerp(targetLocal, this.smooth)`；
  2. 新增 `pose_capture/resample.js`（关键帧 + 样条插值），离线/加载时对 `frames[]` 预上采样；
  3. 教练播放（`makeCoachPlayer`）从 `round(t*fps)` 改为「插值采样」。
- 评估指标：骨骼角加速度的 jerk（均方/峰值）↓；帧间骨骼方向跳变（角度差）标准差 ↓。
- 验证方法：离线对 3.json 全序列计算平滑前后 jerk/jump 指标并断言下降；主观 A/B 看卡顿是否消失。

**B-2 IK 多解连续性启发式（推荐）**

- 内容：`solveTwoBone` 返回「上解/下解」两解时，选择**与上一帧中间关节（肘/膝）世界位置最近**的解，
  消除极限角跳变；伸直退化时用上一帧弯折平面作为 pole 兜底。
- 可行性：高。`ik.js` 纯函数改造成本低，可单测。
- 评估指标：肘/膝弯折方向「翻转次数/分钟」↓；伸直态 NaN/跳变计数 → 0。
- 验证方法：`scoring/tests` 里新增 `ik` 连续性单测（合成帧序列：屈→伸→屈 不应翻折）。

---

### 方案 C：增强动作与音乐情感的匹配度（方向 3）

**C-1 能量 → 动作幅度/速度 调制（推荐，中收益）**

- 内容：消费 A-1 产出的 `beatIntensity/downbeatIntensity/段落`，在教练（及玩家镜像）呈现层做**幅度与速度调制**：
  - 强拍/chorus → 动作目标姿态的插值速度↑、重音帧加一个短促的「hit 增强」（overshoot + 回弹）；
  - 弱拍/verse → 幅度衰减、平滑过渡；
  - downbeat → 触发一个明确的「卡点」强调（躯干/手臂方向瞬时突进）。
- 可行性：中。偏「表现层后处理」，不改数据契约；需要在 `Retargeter` 增加「节奏驱动增益」参数。
- 实施步骤：
  1. `makeCoachPlayer.update(t)` 里读取 `TimingMap` 当前拍强度，算 `gain(t)`；
  2. `Retargeter.applyFrame` 增加可选 `intensity` 参数，对脊柱/手臂方向的类间插值速度与 overshoot 做缩放；
  3. 保留「无 timing 数据时 gain=1」回退。
- 评估指标：动作重音帧时间与 downbeat 的对齐误差（ms）↓；主观「卡点感」评分↑。
- 验证方法：把增强后的教练动作与纯净版并排录屏做 A/B，邀请试玩者打分（1–5 卡点/自然度）。

**C-2 动作库与音乐段落情绪映射（中收益，需内容积累）**

- 内容：建「动作卡 = 音乐能量/情绪标签」的检索表；谱面事件按段落情绪选择动作（高能→大框架动作，
  低能→小动作/停顿），替代当前 `chartBuilder` 固定 0.5s 采样。
- 可行性：中。依赖内容量（曲库/动作库），与 roadmap 的「内容管线」联动。
- 评估指标：自动编谱事件与音乐段落的能量相关性（Pearson）↑；事件密度随强度单调性↑。
- 验证方法：对 1 支曲目人工标注段落能量，量化事件采样与能量的相关性。

**C-3 生成式「音乐条件动作生成」（远，PoC 阶段）**

- 内容：引入 Music2Dance 类模型（如 Bailando、EDGE、Lumiere/DanceDiffusion 路线），以 A-1 音乐特征
  （beat × 色谱 × 能量）为条件生成动作序列，再经现有重定向管线驱动 3D 教练。
- 可行性：**低–中（重）**。需 GPU/模型权重/推理延迟优化，与「纯前端零依赖」架构冲突；定位为**内容生产侧离线生成**而非运行时。
- 实施步骤：1) 离线跑通一条 Music2Dance demo → 2) 转契约帧 → 3) 对比现有动捕管线质量。
- 评估指标：FID / 姿态多样性 / 与音乐 beat-alignment score（Bailando 官方 metric）。
- 验证方法：在独立 `research/` 环境跑 PoC，出客观指标后再决策是否进主线。

---

### 方案 D：引入人体运动学约束提升姿态自然度（方向 4）

**D-1 关节限位 + 躯干/髋 roll-pitch 补全（推荐，高收益）**

- 内容：
  1. `ik.js` / `retarget.js` 增加**关节限位**（肘/膝屈曲范围、肩球窝约束），把 IK 解钳制在生理可行域内，消除反折/超生理角度。
  2. 从躯干的左右髋/肩连线（当前仅用于 yaw 的 `hip-line`）额外估计**躯干 roll（侧倾）与 pitch（前倾/后仰）**，
     补进 `rootYaw` 之外的 `bodyTilt`，让 wave/侧倾动作恢复 3D 表现力（需扩展契约帧可选字段，向后兼容）。
- 可行性：高。限位为纯几何约束；roll/pitch 为「可选扩展字段」，旧数据不提供则回退。
- 实施步骤：
  1. 定义每关节 DOF 与 range 表（常量），在 `solveTwoBone` 与 `_applyDir` 后夹取/投影；
  2. 在契约帧试加 `bodyTilt：[roll,pitch]`（可选），`retarget.js` 消费；
  3. 回放 3.json 对比。
- 评估指标：关节角越界帧比例 → 0；反折/锁死帧比例↓；主观「动作像真人」评分↑。
- 验证方法：单测断言 IK 解始终落在 range 内；回放录屏 A/B。

**D-2 足部接触约束（消 footskating）（中收益）**

- 内容：在 `root-motion.js`/`retarget.js` 里，当 `grounded=true` 时锁定支撑脚踝的世界位置（接触点约束），
  减少脚步滑移；脚掌从「锁水平」升级为「按着地状态做跖屈/脚跟抬起」。
- 可行性：中。需脚踝骨骼有「着地/离地」判定与接触锚点维护，复杂度高于 D-1。
- 评估指标：支撑脚踝贴地期间的世界位移（footskating 距离）↓。
- 验证方法：对站立/踏步片段量化支撑脚踝滑动距离，断言下降。

**D-3 姿态先验 / 运动学正则（远）**

- 内容：引入 SMPL/VPoser 类人体姿态先验（GMM/VAE），把 IK 残差投影到「自然姿态流形」，用先验对重定向结果做反投影正则。
- 可行性：低–中（重）。需引入姿态模型权重，量化/推理成本高，暂作技术储备。
- 评估指标：先验负对数似然（姿态自然度代理）↓；重建误差与自然度的权衡曲线。
- 验证方法：离线在 `3.json` 上 run 一次，输出指标供决策。

---

## 六、分阶段实施路线与优先级

| 阶段 | 内容 | 收益 | 风险/成本 | 依赖 |
|---|---|---|---|---|
| **P0（立即）** | B-1 姿态空间时序平滑 + 插值；B-2 IK 多解连续性 | 直接消除卡顿/反折，最显眼 | 低 | 无 |
| **P0（立即）** | D-1 关节限位 + 躯干 roll/pitch 补全 | 姿态更像真人 | 低 | 无 |
| **P1（短期）** | A-1 多粒度节拍特征升级（离线） | 给 C 供料 | 低 | 无 |
| **P1（短期）** | C-1 能量→幅度/速度调制 | 「卡点感」落地 | 中 | A-1 |
| **P2（中期）** | D-2 足部接触约束；A-2 在线节拍校准 | 手感打磨 | 中 | P0/P1 |
| **P3（中期）** | C-2 动作库与段落情绪映射 | 内容质量 | 中 | 曲库积累 |
| **P4（远/储备）** | C-3 生成式音乐条件动作；D-3 姿态先验 | 内容产能质变 | 高 | 独立研究 |

> 原则：**先做「零模型依赖、纯几何/时序」的 P0**（B-1/B-2/D-1），它们最能直接提升姿态自然度；
> 生成模型（C-3）放到最后且只在离线内容生产侧试水，不进入运行时，避免破坏「纯前端零依赖」架构。

---

## 七、风险评估与边界

1. **契约兼容性**：所有新增（`bodyTilt`、`sections`、`beatIntensity`）一律「可选字段 + 默认可回退」，
   禁止破坏 `timing/v1` / `chart/v1` / `dance-sequence/v1` 已冻结结构（升级须升版本号）。
2. **实时性**：B/C 的插值与调制在消费端主线程跑，需注意每帧预算；P0 方案均为 O(n) 轻量计算，可控制。
3. **过度工程**：D-3 / C-3 / A-2 属放大器，地基（P0）未稳前不投入；避免「为优化而优化」。
4. **数据降维是根**：B/D 只能缓解、不能根治 B1 的信息丢失；根治需在「离线契约帧」侧补充
   `bodyTilt`、骨长（`meta.dimensions` 已具备）甚至完整关节角——这是与内容管线协同的长期方向。

---

## 八、关键文件索引

| 关注点 | 文件 |
|---|---|
| 数据契约 / 帧格式 / 节拍 / 谱面 schema | `docs/interface-contract.md` |
| 数据流与引擎消费现状 | `docs/data-flow.md`、`docs/scoring-engine-spec.md` |
| 音频引擎 + 节拍查询（TimingMap）+ 判定 | `web_dance/audio.js` |
| 姿态重定向 / IK / 根运动 | `web_dance/retarget.js`、`web_dance/ik.js`、`pose_capture/root-motion.js` |
| 平滑滤波 | `pose_capture/filters.js` |
| 关节点重建与回放 | `pose_capture/playback.js` |
| 自动编谱 | `scoring/src/chartBuilder.js` |
| 运行时评分适配 | `web_dance/scoring-adapter.js` |
| 教练播放与主循环 | `web_dance/main.js`（`makeCoachPlayer` / `challengeTimer`） |

---

## 附：方案 A（节拍特征升级）详细实施步骤

> 目标：把「单一 BPM + onset」升级为**多粒度节奏描述**（每拍强度、downbeat、段落、音色/情绪），
> 输出**向后兼容的 `timing/v2`**，作为方案 C（情感匹配）的数据地基。全部离线执行，不动运行时核心。

### 0. 目标产物与数据契约

新增 `timing/v2`，在 `timing/v1` 字段基础上**扩展**（不删不改 v1 字段，保证旧数据回退）：

```jsonc
{
  "schema": "timing/v2",
  // —— 以下与 v1 完全一致（向后兼容）——
  "bpm": 128.0,
  "tempoMap": [/* {t, bpm} */],
  "timeSignatures": [{ "t": 0, "num": 4, "den": 4 }],
  "beatTimesSec": [/* 每拍时间 */],
  "downbeatsSec": [/* 每小节强拍 */],
  // —— 以下为 v2 新增字段 ——
  "onsetStrength": [/* 每帧(hop 样本维) onset 强度,0~1 */],      // 起始强度包络
  "beatIntensity": [/* 与 beatTimesSec 等长,每拍强度 0~1 */],     // 节奏/强弱核心
  "downbeatIntensity": [/* 与 downbeatsSec 等长 */],
  "sections": [{ "t": 0, "label": "intro", "energy": 0.31 }],      // 段落结构 + 能量
  "timbre": { "mfccMean": [/* 13 维 */], "centroid": 2100, "chromaMean": [/* 12 维 */] }, // 音色/和声
  "hopSec": 0.02321995465,     // 便于下游对齐 onsetStrength 时间轴
  "probe": "librosa-0.10 / madmom-0.19"   // 生成工具指纹(可追溯)
}
```

### 1. 目录与依赖

```
ai-dance/
└── tools/
    └── beat/                  # 新增离线工具目录(独立于浏览器 main 构建)
        ├── requirements.txt   # numpy, librosa, aubio, madmom(可选), essentia(可选), scikit-learn
        ├── extract_timing.py   # 核心:音频 → timing/v2 JSON
        ├── annotate.py         # 人工标注辅助(打点 → 生成 ground truth)
        └── eval_timing.py      # 对标人工标注,输出 F-measure/BPM 误差
```

```
python -m venv tools/beat/.venv
tools/beat/.venv/Scripts/pip install -r tools/beat/requirements.txt
```

> 选型：`librosa` 做 onset/beat/MFCC（纯 Python，易装）；`madmom` 的 DBN 做 downbeat（质量最佳但有重依赖，
> 作为可选；缺它时回退「beats + 4/4 强拍假设」）；`aubio` 做 BPM 交叉校验。

### 2. 分步实施（每步可独立验收）

**Step 1 — 加载与预处理**：`librosa.load` → mono / 22050Hz → STFT（hop 512 ≈ 23ms）。
验收：`beatTimesSec` 时间轴与浏览器 `AudioEngine` 的 `songTime` 对齐（允许 +-1 hop）。

**Step 2 — onset strength envelope**：`librosa.onset.onset_strength(y, sr)` 得逐帧包络；
用 `librosa.onset.onset_detect(... backtrack=True)` 得 onset 时刻。产出 `onsetStrength[]`。
验收：可视化 overlay，onset 峰值肉眼对齐鼓点/重音。

**Step 3 — BPM / beat grid**：`librosa.beat.beat_track(y, sr)` 得 `bpm` + beats；
与 `aubio.tempo` 结果交叉校验，|ΔBPM| ≤ 1 才采用，否则取更稳的一个。产出 `bpm`/`beatTimesSec`。

**Step 4 — downbeat**：优先 `madmom.features.downbeats.DBNBeatTrackingProcessor` 出小节边界；
无 madmom 时回退「beats 按 4/4 每 4 拍 = 强拍」（读 `timeSignatures`）。产出 `downbeatsSec`。
验收：强拍对齐重低音/底鼓（人工抽 30s 校验）。

**Step 5 — 每拍强度**：对 `onsetStrength[]` 在每拍窗口内取峰值 → min-max 归一化 → `beatIntensity[]`；
同法对 downbeat 窗得 `downbeatIntensity[]`。这是 C-1「能量→幅度调制」直接输入。

**Step 6 — 段落检测**：按 2s 窗算 RMS 能量曲线 → 变化点分割（或 sklearn 的固定窗 KMeans 聚 3-4 类）
→ 映射 label（intro/verse/chorus/drop/outro）。产出 `sections[]` + 每段 `energy`。
验收：段落边界 ±0.5 小节内（对人工标注）。

**Step 7 — 音色/和声**：`librosa.feature.mfcc` 均值（`timbre.mfccMean`）、`spectral_centroid`（`centroid`）、
`chroma_cqt` 均值（`chromaMean`）。为 C-2/C-3 预留。

**Step 8 — 序列化**：按上面契约写 `timing/v2`，并**保留 v1 字段**。
验收：JSON schema 校验通过；浏览器旧代码加载仍正常（v1 字段齐全）。

### 3. 核心代码骨架（`extract_timing.py`）

```python
import json, librosa, numpy as np

def extract(audio_path: str) -> dict:
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    hop = 512
    onset = librosa.onset.onset_strength(y=y, sr=sr)            # Step 2
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=hop)  # Step 3
    beat_times = librosa.frames_to_time(beats, sr=sr, hop_length=hop)
    # Step 5:每拍窗口内 onset 峰值 → 归一化
    beat_intensity = _per_beat_peak(onset, beats)
    # Step 7
    mfcc = librosa.feature.mfcc(y=y, sr=sr).mean(axis=1).tolist()
    centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    return {
        "schema": "timing/v2",
        "bpm": float(tempo),
        "beatTimesSec": beat_times.tolist(),
        "beatIntensity": beat_intensity,
        "onsetStrength": onset.tolist(),
        "timbre": {"mfccMean": mfcc, "centroid": centroid},
        "hopSec": hop / sr,
    }

def _per_beat_peak(onset, beats):
    out = []; prev = 0
    for b in beats:
        seg = onset[prev:b]; out.append(float(seg.max()) if len(seg) else 0.0); prev = b
    m, M = min(out), max(out)
    return [(v - m) / (M - m + 1e-9) for v in out]
```

### 4. 浏览器消费侧改造（`web_dance/audio.js`）

`TimingMap` 增加 v2 字段读取，**缺省回退**：

```js
// 读 v2 扩展字段；旧数据(v1)下返回 null，调用方据此回退到「无节奏驱动」逻辑
getBeatIntensity(t)   { /* 二分 beatTimesSec → beatIntensity[i]，越界返 null */ }
getSectionAt(t)       { /* 二分 sections[].t → {label, energy} */ }
getDownbeatIntensity(t){ /* 二分 downbeatsSec → downbeatIntensity[i] */ }
```

调用点（方案 C-1 落地时）：
`makeCoachPlayer.update(t)` 里取 `timing.getBeatIntensity(t)`，作为 `applyFrame` 的 `intensity` 参数（幅度/速度调制）。

### 5. 验证与验收指标

| 指标 | 目标 | 方法 |
|---|---|---|
| onset/downbeat F-measure | ≥ 0.90（对 30s 人工标注） | `eval_timing.py`，容忍窗 ±70ms |
| BPM 相对误差 | ≤ ±1 BPM | librosa vs aubio 交叉 |
| 段落边界 | ±0.5 小节 | 对人工标注 |
| 旧数据回退 | v1 加载不报错、无节拍驱动时功能正常 | 浏览器手动回归 |

### 6. 与下游方案的关系

- `beatIntensity/downbeatIntensity` → **C-1 能量→幅度/速度调制**（下一步直接可做）。
- `sections/label` → **C-2 动作库与段落情绪映射**。
- `onsetStrength/timbre` → **C-3 生成式条件动作** 的输入特征。

---

## 十、问题复盘与对症改进：手臂弯曲 & 身体转动

> 触发：现版本「学习生成」的舞蹈动作里，① 手臂无法自然弯曲；② 身体不能有效转动，
> 直接导致踩不准节拍、动作流畅度差。本节定位根因、给出已实施的对症修复，并评估「换模型」路线。

### 10.1 数据链路定位（先确认「模型」到底是谁）

两条动捕链路，共享同一「MediaPipe 单目世界坐标 → 契约帧 → FBX 重定向」管线：

| 链路 | 入口 | 是否带 `shoulderAxis` |
|---|---|---|
| 实时（玩家） | `pose_capture/contract.js` `buildFrame` | ✅ 有（`computeShoulderAxis`） |
| 离线（教练/学习） | `pose_capture/export.js` `exportVideoToSequence` | ❌ **原缺失**（只写 `{t,bones,rootYaw,conf}`） |

关键事实：**离线「学习」出的参考序列缺 `shoulderAxis`**，而 `reconstructJoints` 里
`frame.shoulderAxis || lateral` 会回退到「髋轴」——等于**离线数据把肩轴强制锁在髋轴上**。
这是「身体转不动」的直接数据 bug。

### 10.2 问题①：手臂无法自然弯曲 —— 根因

按贡献排序：

1. **单目深度噪声（数据源）**：`landmarksToJoints(world)` 用的是 MediaPipe 回归出的 3D world
   坐标，深度(z 朝镜头)精度有限。手臂朝前/朝后深屈曲时，前臂在画面里「缩短」，
   `forearm_l` 与 `upper_arm_l` 的 3D 夹角被低估 → 重定向 IK 反解的 `d` 趋向伸直。
2. **One Euro 平滑过度（末端点）**：`PoseSmoother`（`filters.js`）对所有 world 关节点
   用**同一组**参数（默认 `minCutoff 1.5 / beta 0.5`，舞蹈模式 `beta 0.8`）。手腕/肘这类
   末端点在快节奏屈曲时被低通「抹平」，深弯曲跟不上、趋向浅弯。
3. **契约降维 + 标准骨长失衡**：契约帧只存单位方向，重定向用模型自身骨长（`this.dims`）
   重建腕目标；当 MediaPipe 估出的臂长与 3D 模型臂长不一致时，腕目标「够不到/过远」，
   IK 被迫夹取到伸直，弯曲失真。
4. **重定向丢轴向扭转**：`_applyDir` 只对齐「骨骼父→子方向」，上臂/前臂的自旋(roll/twist)
   丢失 → 手臂「方向对但像木棍」。

### 10.3 问题②：身体不能有效转动 —— 根因

1. **离线序列缺 `shoulderAxis`**（`export.js` 与 `buildFrame` 不一致）→ 肩轴被锁成髋轴，
   **肩髋相对扭转与侧倾全部丢失**。 ← **本轮已修**
2. **`rootYaw` 只有一维偏航**：`computeRootYaw = atan2(hip.z, hip.x)`，只描述绕竖直轴的转身，
   躯干前倾(pitch)、左右侧倾(roll)完全丢失。
3. **单目转身关键点跳变**：转身到侧对镜头时，左右髋在 2D 上重叠/交叉，`atan2` 在 ±π 处
   跳变 → `bodyYaw` 突变（身体「抽搐」而非流畅转身）。
4. **重定向单轴刚性转**：`applyFrame` 里只有一个 `bodyYaw` 同时旋转 hips + 脊柱 rest 基准，
   无「胸椎相对髋」的独立扭转，上身像一根绕竖直轴转的棍。

### 10.4 已实施的改进

**本轮（对症两个问题）：**

| 改动 | 文件 | 作用 |
|---|---|---|
| 导出 `computeShoulderAxis` | `pose_capture/contract.js` | 统一肩轴计算，`buildFrame` 复用 |
| 离线帧补 `shoulderAxis` | `pose_capture/export.js` | 教练序列携带肩轴，修复与实时端不一致 |
| 身体朝向改用「肩轴水平投影」+ 记录 `_torsoRoll` | `web_dance/retarget.js` | 转身更稳（肩点更少遮挡），侧倾信息就位 |
| 放宽肘最深折叠 `minBend 0.40→0.28` | `web_dance/retarget.js` | 允许抱臂/深屈肘，防锁死反折 |
| 修复限位 clamp `dMin`/`dMax` 取值反了 | `web_dance/ik.js` | 原 clamp 下限>上限，`d` 恒钳到伸直 → 手臂无法弯曲 |
| clamp 后重定位可达目标 `target=a+dir·d` | `web_dance/ik.js` | 目标过近/过远时骨长不守恒、折叠角误算为接近 0 |

**2026-09-28 补丁（写单测时暴露并修复的 `ik.js` 直接根因）：**

上一轮把「放宽限位 `minBend 0.40→0.28`」当作唯一的手臂限位改动，但单元测试
`test/ik.test.js`（T-ARM-1/2/5）暴露出 `solveTwoBone` 还有两处会让「放宽」完全不生效的 bug，
它们才是「手臂无法弯曲」在几何/数值层的直接主因：

1. **限位 clamp 的 `dMin`/`dMax` 赋值反了**：`dMin` 用了 `maxBend`（伸直端，数值大）、
   `dMax` 用了 `minBend`（折叠端，数值小），`clamp(d, dMin, dMax)` 传入「下限 > 上限」，
   结果 `d` 恒等于伸直值，肘/膝永远无法折叠——之前 `minBend` 参数形同虚设。
2. **clamp 后未重新定位目标点**：`d` 被夹取后仍用「实际目标 `b` 的方向」构造 `p1`
   （`mid = a + dir·l1·cosA`），当目标过近/过远时 `p1` 越过 `b`，导致下骨长不守恒、
   折叠角 γ 被误算成接近 0。已改为夹取后重建可达目标 `target = a + dir·d` 再解算。

配套单测：`test/ik.test.js`（锁肘/膝限位、深折叠、解连续性、腿限位）、
`test/contract.test.js`（锁 `computeShoulderAxis` 的偏航/roll/退化）。全量 `npm test` 63 例通过、无回归。

**2026-09-28 补丁Ⅱ（「过度弯曲」根因修复：生理限位校准 S1）：**

现象：修复手臂可弯曲后，实测又出现**手臂/腿部弯折超出人类运动学范围**的「过度弯曲」。
根因分析（按贡献排序）见下，最终落地 S1 生理限位校准：

1. **直接·手臂**：上一轮为「抱臂」把 `ARM_LIMITS.minBend` 放宽到 `0.28`（肘内角仅 16°），
   低于肘关节生理屈曲极限（最大屈曲约 140° → 残余内角约 40°，γ≈0.70），允许非生理深度折叠。
2. **数据源**：单目深度歧义使腕/踝目标假性过近。
3. **代码层**：clamp 后 `target` 重定位把「假性过近」压到折叠端，放大了 1。
4. **腿的异常**：膝过度弯曲更可能是膝盖方向 flip（pole 用膝盖关节点定位）所致，非限位主因。
5. **缺 γ 时序平滑**（后续 10.6）。

本轮落地（`web_dance/retarget.js` 常量 + 单测同步）：

| 参数 | 改动 | 生理依据 |
|---|---|---|
| `ARM_LIMITS.minBend` | `0.28 → 0.70`（约 40°） | 对齐肘关节生理屈曲极限（约 140° 屈曲 → 残余内角约 40°） |
| `LEG_LIMITS.maxBend` | `Math.PI → Math.PI * 0.985`（约 177°） | 膝不允许完全锁直，防反折（hyperextension） |

配套单测同步：`test/ik.test.js` 常量对齐；`T-ARM-1b` 可达目标从 `[0.2,0.3,0.5]` 调整为
`[0.3,0.4,0.5]`（新 `dMin≈0.206`，`d=0.2` 变为不可达）；`T-ARM-2` 由「深折叠<50°」重写为
「过度弯曲防护」（断言 γ 被钳到 `minBend≈0.70`）；`T-ARM-5` 腿伸直断言由 `g>3.1` 改为
`g>3.05 && g<=π`。全量 `npm test` 63 例通过、无回归。

> 遗留（P0 后续 S2）：膝盖方向防护（pole 定位修正）尚未落地，本轮以「防反折 `maxBend`」先行收敛，
> 完整膝盖方向稳定见 10.6 的 `rootYaw` 解旋与末端点独立平滑。

**2026-09-28 补丁Ⅲ（「过度弯曲」根因全线修复：S2 膝盖方向防护 + S3 深度约束 + S4 γ 时序平滑 + S5 单测前置）：**

按「系统性修复过度弯曲」方案落地剩余 S2~S5（S1 生理限位已完成于补丁Ⅱ）：

| 方案 | 根因 | 落地位置 | 改动 |
|---|---|---|---|
| S2 膝盖方向防护 | 4 | `web_dance/retarget.js` + `web_dance/ik.js` | 肘/膝点低置信(< `minConf`)回退固定 front/back `poleDir`；`solveTwoBone` 在 pole 退化时优先用上一帧 `hint` 锁定弯折方向 |
| S3 深度约束 | 2、3 | `pose_capture/contract.js` 新增 `constrainLimbDepth`；`mocap.js`/`export.js` 在平滑前接入 | 用 2D 腕/肘、踝/膝夹角(图像投影)作先验，3D 夹角明显小于 2D 时沿 `u×v` 平面旋转末端、抬升到 2D 夹角，抑制「假性过近」 |
| S4 γ 时序平滑 | 5 | `web_dance/ik.js`(`gammaHint`/`gammaMaxStep`) + `retarget.js`(`_prevGamma`) | 折叠角 γ 单帧变化限幅(`GAMMA_MAX_STEP=0.35`)，吃掉单帧尖峰、保留快速深屈 |
| S5 单测前置 | 全部 | `test/ik.test.js` + `test/contract.test.js` | 新增 T-ARM-6(γ 永不跌破生理下限)、T-ARM-7(S4 平滑)、T-DEPTH-1/2(S3 深度约束) |

参数与判定：
- `GAMMA_MAX_STEP = 0.35` rad/帧：吃掉 >0.35 的单帧尖峰，保留 ~0.16 rad/帧 的快速深屈(30fps 下半秒折叠不被拦)。
- S3 触发：`γ3 < γ2 − 0.10 且 γ3 < 1.0`(3D 明显更折叠)，目标 `γ = clamp(γ2, 0.55, π)`，且仅当提升 > 0.05 才改写末端；修正保持前臂/小腿长度 `|E−M|` 不变。
- S2 回退判定：读契约帧 `conf` 中 `upper_arm_${side}`/`thigh_${side}`(肘/膝对应上臂/大腿骨骼)的置信度，低于 `minConf` 视为不可靠。

全量 `npm test` 67 例通过、无回归(较补丁Ⅱ新增 T-ARM-6/7、T-DEPTH-1/2 四例)。

**上一轮（B/D 纯几何时序，仍生效）：** `ik.js` 的 `limits`（关节限位）+ `hint`（解连续性）、
`playback.js` 的 `sampleFrame`（插值）、`main.js` 教练插值采样。

> 说明：`_torsoRoll` 本轮**仅记录、未消费**。完整的 roll/pitch 应用见 10.6，作为下一步而非
> 本轮一并落地——躯干旋转涉及 `bodyYaw`×`m` 坐标变换，需在浏览器里逐帧验证，避免引入更难查的翻转 bug。

### 10.5 换模型评估（「必要时换模型」的技术选型）

**外部评测证据（2026 更新，金标准 = Vicon/MoCap）：**

| 来源 | 关键结论 |
|---|---|
| IEEE TPAMI 2026（Kahl 等，118 篇综述 + 16 框架实测，Vicon 金标准） | **MeTRAbs 单目 3D 关节角精度最佳**；MediaPipe 3D 误差显著偏高、可靠性偏低；MHFormer/MMPose 居中；2D 侧 rtmlib/AlphaPose/YOLOv7 领先 |
| PLoS ONE 2026（Ienaga & Sekine，MoCap 金标准） | RTM-tri(RTMPose 3D) 关键点置信度优于 MP-tri；**立体 >> 单目**（最优单目 ~49mm 平均误差且失败率高） |
| BlazePose GHUM Holistic（Google，arXiv 2206.11678） | 现状模型 = 2D/3D landmark + GHUM lifter，无强运动学先验 |

**候选对比：**

| 候选 | 2D 精度 | 深度/3D | 运动学先验 | 浏览器可跑 | 成本 |
|---|---|---|---|---|---|
| MediaPipe BlazePose（现状） | 高 | 回归(单目,有限) | 无 | ✅ WASM/GPU | 极低 |
| RTMPose / RTMO / ViTPose | 更高 | 需另配 lifting | 无 | 部分(onnxruntime-web) | 中 |
| **MeTRAbs（精度 leader）** | 高 | 准(单目相对) | 弱 | ❌ TF/Python 离线 | 高 |
| MotionBERT / MHFormer / MotionAGFormer | 依赖 2D | 显著更准(时序) | 弱 | 重/不实时 | 高(离线) |
| **SMPL 回归 ROMP / BEV / TRACE** | 高 | 准 + 网格/关节旋转 | ✅ 强 | ✅ ONNX 可浏览器 | 中-高 |
| SMPL 回归 HybrIK / CLIFF / WHAM / TEMPO | 高 | 准(可运动学) | ✅ 强 | ❌ 离线 | 高 |

**结论与路线（据此可果断决策）：**

1. **「手臂弯曲/身体转身」主因不是 BlazePose 能力上限，而是单目深度歧义 + 本项目数据表示与平滑**；
   10.4 + 10.6 数据侧重置是收益/成本比最高的动作，先做。
2. **短期升级（不换模型，成本极低）**：BlazePose `complexity=2`、关/降 `smooth_landmarks`（深弯曲不被内置平滑吃掉）、
   末端点独立平滑（10.6）、`rootYaw` 解旋、肩髋相对扭转。
3. **中期换模型 = 离线内容生产侧**（不碰浏览器运行时，保持「纯前端零依赖」）：离线「学习」管线接入
   **MeTRAbs**（单目 3D 关节角精度最佳，TF/Python 离线）或 **SMPL 回归（ROMP/BEV/TRACE，带 ONNX 导出）**，
   把更准的 3D 关节/SMPL 旋转转回 `dance-sequence/v1`。若坚持浏览器内跑，ROMP 的 ONNX 版本可上 onnxruntime-web，
   是「可浏览器 + 强运动学先验」的折中。
4. **长期（生成式）**：C-3 的 Music2Dance 条件生成，直接产出带节拍的自然动作序列（见前文方案 C-3）。

> 判断：**先做数据侧改造（10.4 + 10.6），收益/成本比远高于立刻换模型**；若深弯曲仍不达标，
> 中期离线端接 MeTRAbs 或 SMPL 回归即可根本性改善 3D 精度。

### 10.6 后续方案（roll/pitch 完整落地 + 末端点平滑）

1. **躯干 roll（侧倾）应用**：消费已记录 `_torsoRoll`，对 `Chest`（`spineDriven` 末尾）额外施加绕
   `basis.forward` 的 roll 旋转，恢复 wave/侧腰/倾斜动作。需逐帧验证不引入翻转。
2. **躯干 pitch（前倾）独立增强**：`spine` 方向已含前倾，但受 `up.lerp(spineDir, f)` 稀释；
   对 `Chest` 增加以「前倾角」为权重的额外旋转，前倾更充分。
3. **胸椎扭转**：`shoulderYaw − rootYaw` 作为胸椎相对髋的扭转角，施加到 `Chest`，让上身能「拧转」。
4. **末端点独立平滑**：`PoseSmoother` 支持 per-joint 参数（腕/肘/踝/膝 `beta` 上调到 1.2~1.5、
   `minCutoff` 下调），深屈曲不再被抹平；躯干/髋保持默认防止抖。
5. **rootYaw 时序解旋**：在消费端对 bodyYaw 做角度 unwrap（±π 连续性），消除转身关键点交叉跳变。

### 10.7 评估指标与验证方法

| 问题 | 指标 | 验证 |
|---|---|---|
| 手臂弯曲 | 肘夹角 γ 分布覆盖到 <50° 的比例；「深屈曲动作」（如抱臂）能否还原 | 播放训练序列，量化肘夹角 vs 原始 video 的对应夹角误差 |
| 身体转动 | 转身角度误差、侧倾角度误差 | 离线：对比 rootYaw/shoulderAxis 序列；播放：肉眼 + 录屏 A/B |
| 流畅度 | 帧间骨骼方向跳变（jerk）↓、肘/膝弯折方向翻转次数↓ | 离线算前后帧指标断言下降 |
| 卡点 | 动作重音帧 vs downbeat 对齐误差↓ | 结合方案 A/C 的 timing 数据，A/B 试玩打分 |

### 10.8 完整透视投影标定：头部转动 + 手臂弯曲 + 腿部轨迹（补丁Ⅳ，S6）

**背景**：S1~S5 已收敛「过度弯曲」的数值/几何根因，但实测仍残留三个**表现层**问题——
① 头部无法自然转动；② 手臂关节弯曲角度异常（肘横向「鸡翅」漂移）；③ 腿部运动轨迹不合生理
（髋无约束、膝深折仍偏宽松）。三者共同根因是**标定只停留在「坐标轴约定 + 两骨 IK γ 限位」，
缺医学关节活动度(ROM)驱动的运动学约束系统**。本节把标定升级为「S6：完整透视投影标定」。

**核心新增**：`web_dance/rom.js` —— 医学 ROM 常量 + 4 个纯函数助手的**单一权威来源**
（`retarget.js` 与 `test/rom.test.js`、`test/ik.test.js` 均从此 import，不再本地复制限位常量）。

---

#### (1) 标定参数调整方法

| 标定对象 | 方法 | 落点 |
|---|---|---|
| 坐标系（canonical→模型世界基） | `m` 矩阵把 `canonical(x右,y上,z朝镜头)` 映射到模型 `basis.right/up/forward`，mirror/flipFacing 已 baked 进 `m` | `retarget.js` |
| 头向量 | `head = normalize(nose − shoulders_center)`（与躯干偏航天然解耦，不受 `bodyYaw` 污染） | `reconstructJoints` → `retarget.js` 头处理 |
| 头中性朝向 | 首帧头向量记录为 `_headNeutral`，后续分解相对此中性 | `retarget.js`（`_headNeutral`） |
| 身体前向 | `bodyYaw · basis.forward`（腿髋约束的参考前向，随转身同步旋转） | `retarget.js` 四肢循环 |

#### (2) 运动学约束条件设定

| 关节 | 约束 | 实现 |
|---|---|---|
| 肘/膝（两骨 IK γ） | `minBend=40°`(内角)、`maxBend=177°`(防反折) | `ARM_LIMITS`/`LEG_LIMITS`（来源 `rom.js`），经 `solveTwoBone` limits 生效 |
| 颈椎（头） | 分离俯仰 pitch（屈曲≤50°、后伸≤45°）与偏航 yaw（各侧≤75°） | `decomposeHead` + `clampNeck` + `neckQuaternion` |
| 髋（大腿方向） | 前后摆：前向分量 ∈ `[−sin(hipExtension), sin(hipFlexion)]` = `[−sin30°, sin125°]` | `clampLegDirection`（矢状面约束） |

#### (3) 异常姿态检测与修正算法

- **头部转动**：旧代码「头向量相对中性最短弧单方向对齐」无法区分点头/转头/歪头，且不叠加
  `bodyYaw`。新算法：`decomposeHead(head, neutral, up, right)` 把头向量分解为躯干基下的
  pitch(矢状面倾角差) 与 yaw(绕上轴的水平叉积角)，→ `clampNeck` 钳到颈椎 ROM，→
  `neckQuaternion` 重建颈旋四元数，最终组合 `bodyYaw × qNeck × headRestQuat`。
- **手臂弯曲异常（鸡翅漂移）**：肘 pole 原由单目噪声定位的肘点反推，横向帧间抖动大。新增
  `ELBOW_POLE_BLEND=0.35`，把肘 pole 向上一帧肘位置(`_prevMid`)混合 35%，削弱深度噪声导致的
  横向漂移（膝已由 S2 前向 pole + 防护处理，不做此混合）。
- **腿部轨迹**：`clampLegDirection` 把「髋→踝」方向钳到生理矢状锥内，**仅改方向、长度守恒**；
  只约束前后摆分量，再按比例 renormalize 垂直分量——严格满足髋 ROM 角度限位，且不引入
  「侧抬/抬升」伪影（轴对齐三分量 clamp 的已知缺陷，见下「已知边界」）。

#### (4) 基于医学数据的关节角度限制范围（`rom.js` 权威表）

| 关节 | ROM | 常量 | 取值 |
|---|---|---|---|
| 颈椎轴向旋转(转头) | 60–80° | `neckYaw` | 75° |
| 颈椎屈曲(点头) | 45–50° | `neckFlexion` | 50° |
| 颈椎后伸(仰头) | 45° | `neckExtension` | 45° |
| 肘屈曲 | 140–150° | `elbowMinBend`(残余内角) | 40° |
| 肘伸展 | 0°(过伸<10°) | `elbowMaxBend` | 177° |
| 膝屈曲 | 135–145° | `kneeMinBend`(残余内角) | 40° |
| 膝伸展 | 0° | `kneeMaxBend` | 177° |
| 髋屈曲(前摆) | 120–145° | `hipFlexion` | 125° |
| 髋后伸(后摆) | 20–40° | `hipExtension` | 30° |
| 髋外展(侧抬) | 45° | `hipAbduction` | 45°(预留) |

> 约定统一为放射：内角γ，π=完全伸直、0=完全折叠；`minBend` 取「最大屈曲对应的残余内角」。

#### (5) 测试与验证

新增 `test/rom.test.js`（9 例：ROM 值、T-HEAD-1~6 head 分解/限幅/重建往返、T-LEG-1~3 腿约束、
normAngle）。同步 `test/ik.test.js` 改为 import `rom.js` 常量（膝 `minBend` 0.55→40°）。
**全量 `npm test` 78 例全部通过、无回归**（较补丁Ⅲ新增 9 例 rom 测试 + 调整 1 处）。

#### (6) 已知边界与后续

- 髋**外展(侧抬)**不强制（`hipAbduction` 预留）：舞蹈数据中极少超界，强加易引入侧歪伪影；
  如需可仿照矢状面约束加「冠状面」第二重约束。
- `decomposeHead` 的 pitch/yaw 为非交换欧拉近似，用于小角度(<约 60°)足够；极端侧屈+转头叠加时有
  数度耦合误差，但对「消除诡异姿态」目标无影响。
- 头/腿约束均在 **重定向消费端**（`retarget.js`）做，未改数据契约；镜像已由 `m` 矩阵对头向量的
  x 翻转体现，故 `decomposeHead` 不额外 negate `right`。

**支线 A 结论（是否换 MeTRAbs/SMPL）**：本轮三个表现层问题已在消费端用 ROM 约束收敛，**非数据源
能力上限所致**；单目深度歧义(数据源噪声)仍在，但对「自然转动/弯曲/轨迹」目标已不构成阻断。
维持「先数据侧、后换模型」判断：若后续臂长重建仍显僵硬、或要求更强 3D 精度，再在**离线内容
生产侧**接 MeTRAbs（单目 3D 关节角精度 leader，TF/Python 离线）或 SMPL 回归（ROMP/BEV，带 ONNX
可浏览器），转回 `dance-sequence/v1`，不碰浏览器运行时（见 10.5）。

### 10.9 支线 A 落地：FBX 骨架直导 v2 可选字段（补丁Ⅴ）

**结论先行**：内置曲目（salsa/hiphop）的参考序列本来就「**直接从 FBX 提取**」，不是视频→
MediaPipe 那套。故「更强 3D 精度」的数据就在 FBX 里，无需 MeTRAbs/SMPL、无需 TF/PyTorch、无 SMPL
license 门槛——只差把 FBX 里被 `fbxClipToSequence` 压缩掉的朝向字段**补导**出来。

**根因（对应三项主观观感里仍未改善的「转弯」）**：`fbxClipToSequence` 只把完整 3D 四元数动画
压成 10 骨单位向量，**既不输出 `rootYaw` 也不输出 `shoulderAxis`**，而 `retarget.js` 的 `bodyYaw`
（骨盆偏航，即「转弯」）恰好依赖这两个字段 → FBX 教练的骨盆偏航永不更新，看似「不转身」。

**v2 可选字段（向后兼容 `dance-sequence/v1`，浏览器端按「字段是否存在」消费）**：

| 字段 | 类型 | 语义 |
|---|---|---|
| `rootYaw` / `rootYawConf` | number | 髋轴偏航（`atan2(hip.z, hip.x)`）及其置信度=1 |
| `shoulderAxis` | [x,y,z] | 肩轴单位向量（右肩−左肩，canonical） |
| `torsoTwist` | number | **胸椎扭转** = 肩轴偏航 − 髋轴偏航（绕脊柱轴的反向旋转，salsa 关键） |
| `torsoRoll` / `torsoPitch` | number | 躯干侧倾 / 前倾（由脊柱方向分解，显式标量） |
| `armTwist` | [4] | 手臂轴向扭转 `[左上臂,右上臂,左前臂,右前臂]`（肩内/外旋 + 前臂旋前/旋后） |

**改动落地**（三处，均向后兼容）：

1. `scoring/examples/song-sources.js`：`fbxClipToSequence` 每帧补导上述字段；新增 `wrapAngle` 与
   `computeArmTwist`（`2·atan2(旋转向量·长轴, w)` 的 swing-twist 轴向投影）。
2. `pose_capture/playback.js`：`sampleFrame` 插值帧携带并线性插值这些字段（肩轴插值后重归一化），
   否则教练走 `sampleFrame` 会把新字段剥掉。
3. `web_dance/retarget.js`：新增 `_twistWorld`（世界系绕轴转骨）；当帧含 `torsoTwist` 时——
   骨盆朝向改挂 `rootYaw`、胸椎扭转沿 `SPINE_TARGETS` 曲率权重分布到脊柱、头部随胸腔全量扭转
   （颈旋 `qNeck` 仍相对中性头方向解出，不含体轴扭转）。无 `torsoTwist` 的旧/实时帧走原策略，
   **实时行为零改动**。

**`armTwist` 消费端暂缓**：轴向扭转只影响「肘平面朝向/手掌朝向」，对当前低模布偶姿态视觉收益
小、且需对上/下臂做反向扭转校正，风险高；字段已随序列落盘，供后续逐步增强。

**结果**：`npm run export-songs` 重新生成 salsa(721 帧)/hiphop(721 帧)，新字段非零有效
（salsa `torsoTwist`≈-0.16 rad、`armTwist` 各分量非零）；**`npm test` 全量 78 例通过、无回归**。

### 10.10 肩立体锥 + 髋冠状面 + 胶囊碰撞避免（补丁Ⅵ）

**背景**：补丁Ⅴ后「转身幅度 + 胸腔反向扭动」已初具雏形，但三项观感仍残留——
(1) 手臂关节弯曲异常；(2) 腿部轨迹异常；(3) 交叠动作穿模。三者根因不同，分别从
「方向锥约束」与「几何推开」两个层面补全。

**新增 ROM 常量（`web_dance/rom.js`）**：肩后伸 `shoulderExtension 60°`、内收
`shoulderAdduction 40°`、外展 `shoulderAbduction 180°`（供引用不硬钳）、髋内收
`hipAdduction 30°`。均为 AAOS 查表值，弧度统一。

**`clampArmDirection(rel, up, forward, right, sideSign)` — 肩关节立体锥**：
把「肩→末端」方向在躯干坐标系下做两个独立下界——前向分量 ≥ `−sin(shoulderExtension)`
（防上臂过度后摆/反折）、自身侧向分量 ≥ `−sin(shoulderAdduction)`（防上臂跨身体中线
对侧太深 → 天然防穿躯干）。外展/前屈 180° 不硬钳。只改方向、长度守恒。

**`clampLegCoronal(rel, up, forward, right, sideSign)` — 髋冠状面**：把「髋→踝」的
自身侧向分量钳到 `[−sin(hipAdduction), sin(hipAbduction)]`，治腿侧向漂移超生理/轨迹
异常，同时保留交叉步空间（内收下限 30°）。矢量面（前后摆）仍由既有 `clampLegDirection` 负责，
两者在 `retarget.js` 内顺序串联：先矢状后冠状。

**`sideSign` 语义**：模型自身侧符号（右 = +1、左 = −1），由骨骼名
（`…right…`/`…left…`）推导，而非 `endName`（后者在 `mirror` 下会翻转），镜像稳健。

**`web_dance/collision.js`（新增，纯函数可单测）— 胶囊碰撞检测 + 轻量几何推开**：
- `closestSegmentPoints`：线段–线段最近点（含端点夹取）。
- `capsulePenetration`：胶囊重叠量 `overlap>0` + 单位分离轴「A→B」。
- `separateCapsulePairs`：对给定胶囊对做多轮最小平移分离；端点采用**共享 `Vector3` 引用**
  （如「肘 = 上臂 p1 = 前臂 p0」），推开后相邻段自动一致；端点 `movable0/movable1` 控制
  可否动，固定端（躯干/头/肢体根）不动。

**`web_dance/retarget.js` 接入**：IK 后新增 `_resolveCollisions()`——把躯干（髋→胸）、头
（退化球）与每个驱动肢体的上/下两段抽象为胶囊，检测「肢体 vs 躯干」「前臂 vs 头」「双腿对侧
互穿」三类重叠，做 3 轮推开（`pushFactor 0.6`），再把（可能移动的）肘/膝、腕/踝位置写回
`_applyDir` 方向，并更新 `_prevMid` hint 以保持帧间弯折连续。仅重叠时触发，休息姿态不动作。

**测试**：`test/rom.test.js` 新增 7 例（T-ARM-1~4、T-LEG-C1~3）；`test/collision.test.js`
新增 7 例（T-COL-1~7）。**`npm test` 全量 92 例通过、无回归。**

---

## 十一、关键文件索引（增补）

| 关注点 | 文件 |
|---|---|
| 肩轴/髋轴数据源 | `pose_capture/contract.js`（`computeShoulderAxis` / `computeRootYaw`） |
| 离线学习导出 | `pose_capture/export.js` |
| 身体朝向 + 躯干 roll 记录 | `web_dance/retarget.js` |
| 关节限位 + 解连续性 | `web_dance/ik.js` |
| 医学 ROM 常量 + 头/腿运动学约束 | `web_dance/rom.js` |