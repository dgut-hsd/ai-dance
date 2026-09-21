# 动作数据接口契约(草案 v0.1)

> 状态:**DRAFT** — 结构已冻结,标 `[待定]` 的字段由双方在联调前补齐并回填本文档。
> 本文档是「离线参考序列」与「实时玩家帧」之间的**合同**。两条链路各自把数据
> 转成同一种帧格式后,评分模块才能直接对它们求差。
>
> **冻结记录**:§4.1 `timing/v1` 与 §4.2 `chart/v1` 已于本次修订**冻结为 v1.0**;
> 后续变更必须升版本号,不得静默修改。其余 `[待定]` 项维持 DRAFT。
> 配套音频引擎接口设计见 `docs/audio-engine-api.md`。

---

## 0. 核心原则(为什么这样设计)

1. **同一帧格式,两处复用。** 参考序列文件里的 `frames[]`,和实时端每帧发出的消息,
   结构完全一致。评分 = 对两个同构序列做时间对齐 + 相似度,不存在"3D 模型 vs 关键点"
   这种跨表示比较。

2. **存"骨骼方向",不存绝对 XYZ。** 绝对坐标会被身高、离镜头远近、朝向污染。
   骨骼单位方向向量天然对平移和缩放不变,对朝向只需做一次 yaw 对齐。

3. **MediaPipe 是"标尺",两边都用它。** 参考(离线)和玩家(实时)都先经过
   MediaPipe 的 33 个 world landmark,再各自归一化成本帧格式。系统性偏差互相抵消。

---

## 1. 坐标系(Canonical Frame)

所有 `bones` 向量、`rootPos` 都必须先归一到这个坐标系:

| 约定 | 值 |
|---|---|
| 原点 | 髋中点 `hips_center` |
| 单位 | 米 |
| 轴 | 右手系:`x` = 表演者右侧,`y` = 竖直向上,`z` = 朝相机(表演者面朝 `-z`) |

**[待定] MediaPipe 原始 world landmark 的轴朝向随版本/API 变**
(旧 `Pose` 与 Tasks `PoseLandmarker` 可能 `y` 朝下、`x` 左右相反)。
联调时做一次**标定**并回填:让测试者正对镜头、右手抬起,
记录哪个分量变化,写出每个轴需要的翻转(±1)。归一化函数必须集中在一处
(建议 `contract.js`),别散落在各处。

---

## 2. 骨骼索引(必须先冻结的拓扑)

基于 MediaPipe Pose 的 33 个 landmark。派生点为两个原始点的中点。

| # | 骨骼名 | 父端点 | 子端点 | MediaPipe 索引(父→子) |
|---|---|---|---|---|
| 0 | `spine` | hips_center(派生) | shoulders_center(派生) | (23+24)/2 → (11+12)/2 |
| 1 | `upper_arm_l` | left_shoulder | left_elbow | 11 → 13 |
| 2 | `forearm_l` | left_elbow | left_wrist | 13 → 15 |
| 3 | `upper_arm_r` | right_shoulder | right_elbow | 12 → 14 |
| 4 | `forearm_r` | right_elbow | right_wrist | 14 → 16 |
| 5 | `thigh_l` | left_hip | left_knee | 23 → 25 |
| 6 | `shin_l` | left_knee | left_ankle | 25 → 27 |
| 7 | `thigh_r` | right_hip | right_knee | 24 → 26 |
| 8 | `shin_r` | right_knee | right_ankle | 26 → 28 |
| 9 | `head` | shoulders_center(派生) | nose | (11+12)/2 → 0 |

- 共 **10 条骨骼**,`bones[]` 数组严格按上表顺序。
- 脚踝之后的足部细节忽略(v1 评分权重低,且 Rokoko 脚部易滑)。
- 手势舞模式的骨骼表 = 上表去掉 4 条腿 + head(共 6 条)。

---

## 2.5 从关节点到骨骼的数学原理(归一化)

离线端和实时端都必须用**完全相同**的下面这套计算,否则两边数据无法比较。

### 2.5.1 输入:12 个跟踪点 + 2 个派生中点

跟踪点(MediaPipe 索引,先经 §1 坐标轴标定):

```
左/右肩 11/12、左/右肘 13/14、左/右腕 15/16、
左/右髋 23/24、左/右膝 25/26、左/右踝 27/28
```

派生中点:

```
hips_center      = (left_hip + right_hip) / 2
shoulders_center = (left_shoulder + right_shoulder) / 2
```

### 2.5.2 每条骨骼 = 一个向量(子点 − 父点)

对 §2 里的每条骨骼 `parent → child`,设父点 `P=(px,py,pz)`、子点 `C=(cx,cy,cz)`:

```
v = C − P = (cx−px, cy−py, cz−pz)
```

例(右臂自然下垂):右肩 P=(0.30, 1.40, −0.20),右肘 C=(0.35, 1.10, −0.18)

```
v = (0.35−0.30, 1.10−1.40, −0.18−(−0.20)) = (0.05, −0.30, 0.02)
```

### 2.5.3 归一化:除以向量长度,得到单位向量

```
|v| = √(vx² + vy² + vz²)
unit = v / |v|
```

上例:

```
|v| = √(0.05² + 0.30² + 0.02²) ≈ 0.3048
unit = (0.05/0.3048, −0.30/0.3048, 0.02/0.3048) ≈ (0.164, −0.984, 0.066)
```

这个单位向量 ≈ (0.164, −0.984, 0.066),含义:该骨骼几乎竖直**向下**(y ≈ −0.98,
canonical 坐标系 y 向上),即"右臂垂在体侧"。

### 2.5.4 为什么必须归一化(三种不变性)

- **平移不变**(相减):消掉"人站在画面哪个位置"的影响。
- **缩放不变**(除长度):消掉"身高、离镜头远近"的影响——1.9m 的人站近 vs 1.6m 的人
  站远,做同一个动作,骨骼向量几乎相同。
- **等价于关节角**:3D 单位向量只有"方向"这 2 个自由度,信息量 = 一个 2 自由度的
  关节角(俯仰 + 方位),而且没有欧拉角的万向锁问题。

结果:**两个不同身高、不同距离的人做同一动作,`bones` 几乎一致**,评分比的是"动作"
而不是"人"。

### 2.5.5 队友必须逐条复刻(任何一条不同,数据不可比)

1. §1 坐标轴翻转 `{x:-1, y:-1, z:-1}`(见 models/README,已实测锁定);
2. 相同的 12 个跟踪点 + 2 个派生中点定义;
3. §2 的 9 条骨骼及其顺序;
4. 相同的单位向量归一化;
5. `conf` 约定:取骨骼两端点置信度的较小值(无置信度数据时填 1)。

---

## 3. 帧格式(Frame Schema)

单帧 JSON。实时端每条消息、参考文件每帧,都用它。

```jsonc
{
  "t": 0.066,                // number,相对起点秒数
  "bones": [                 // 9 条骨骼方向,顺序见 §2
    [0.0, 0.92, 0.38],       // spine      单位向量 (x,y,z)
    [-0.4, 0.8, 0.45],       // upper_arm_l
    [-0.2, -0.1, 0.97],      // forearm_l
    // ... 共 9 组, 每组长度归一为 1.0
  ],
  "rootYaw": 0.12,           // number,躯干绕竖直轴偏航角(弧度),用于对齐;[待定]精确定义
  "rootPos": [0, 0, 0],      // [可选] 髋中点(米),恒为原点可省略
  "conf": [0.95, 0.9, ...]   // [可选] 每骨骼置信度 0..1,评分时降权
}
```

字段约束:
- `bones` 每组 3 个 `number`,逐组归一化(模长 = 1);数据损坏时允许 `[0,0,0]` 并配 `conf=0`。
- `conf` 长度 = 骨骼数,缺省视为全 1。
- 建议参考文件省略 `conf`(离线可复核),实时帧始终带 `conf`。
- **手势舞(`danceType:"gesture"`)的帧额外带 `hands` 字段**:`[{handedness, landmarks}]`,
  `landmarks` 为每手 21 个点(手腕为原点、尺度归一化);全身舞蹈无此字段。

---

## 4. 参考序列文件(离线,由「离线端」产出)

路径约定:`reference/<danceId>.json`

```jsonc
{
  "schema": "dance-sequence/v1",
  "danceId": "mixamo-hiphop-001",
  "meta": {
    "fps": 30,               // 采样率
    "durationSec": 30.0,
    "numFrames": 900,
    "boneCount": 9,          // 必须与 §2 一致
    "source": "rokoko|mixamo|video-capture",
    "coordinateSystem": "canonical-yup",   // 恒为此值
    "danceType": "gesture",  // "full-body"(全身) | "gesture"(手势舞),决定骨骼表与是否含 hands
    "dimensions": {          // [可选] 身体尺寸(米),用于火柴人回放重建;评分不用
      "spineLen": 0.52, "shoulderWidth": 0.38, "hipWidth": 0.32,
      "upperArm": 0.28, "forearm": 0.26, "thigh": 0.44, "shin": 0.42
    },
    "beatTimesSec": [0.0, 0.5, 1.0, 1.5],  // [兼容] 节拍标记,恒等于 timing.beatTimesSec(§4.1)
    "timing": { ... },                     // §4.1 timing/v1(冻结):BPM/变速/拍号/下拍
    "audio": "audio/mixamo-hiphop-001.ogg",// [可选] 歌曲文件,路径相对本 JSON 所在目录
    "chart": { ... },                      // §4.2 chart/v1(冻结):音符轨道 + 判定窗
    "difficulty": 2          // [可选] 1-5,待定分级规则
  },
  "bones": [                 // 骨骼表(名字+端点),冗余存储便于离线端自查
    {"name":"spine","parent":"hips_center","child":"shoulders_center"},
    {"name":"upper_arm_l","parent":"left_shoulder","child":"left_elbow"}
    // ... 共 9 条
  ],
  "frames": [ { /* §3 的帧对象 */ }, ... ]   // 长度 = numFrames
}
```

生成流程(离线、每支舞只跑一次):FBX → 标准机位渲染 MP4 → MediaPipe →
归一化 → 写成本文件。运行时只读,不重算。

---

## 4.1 音频与节拍 schema(`timing/v1`)—【冻结 v1.0】

> 与音频主时钟配套的**节拍栅格**。决定「每一拍、每一下拍发生在第几秒」。
> 由离线端用 librosa/aubio 一次算好写入;运行时只读,不在浏览器里重算。
> 取代旧字段 `meta.beatTimesSec`(后者降级为兼容别名)。

### 位置与兼容

- 权威位置:`meta.timing`(对象)。
- **兼容字段**:`meta.beatTimesSec`(旧)仍被现有代码读取。二者同时存在时**必须逐项相等**;
  新生产者应输出 `meta.timing`,并**可**保留旧字段以便老版本消费。
- `meta.timing.version` 必须为 `"timing/v1"`;不匹配则拒绝(快速失败)。

### 结构

```jsonc
"timing": {
  "version": "timing/v1",
  "bpm": 120,                       // 主 BPM(展示用参考值;数值 = tempoMap 首项 bpm)
  "offsetSec": 0.0,                 // 第一个下拍相对音频起点(歌曲 0.000s)的秒数;可为负(弱起)
  "tempoMap": [                     // 变速点,按 t 升序;首项 t 必须 = 0.0
    { "t": 0.0,  "bpm": 120.0 },
    { "t": 30.0, "bpm": 132.5 }
  ],
  "timeSignatures": [               // 拍号,按 t 升序;首项 t 必须 = 0.0;缺省等价于 4/4
    { "t": 0.0, "num": 4, "den": 4 }
  ],
  "beatTimesSec": [0.0, 0.5, 1.0, 1.5],   // 派生:每一拍时间戳(升序、严格递增)
  "downbeatsSec": [0.0, 2.0, 4.0]         // 派生:每小节第 1 拍(升序)
}
```

### 字段

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `version` | string | ✅ | `"timing/v1"` | 版本锁定 |
| `bpm` | number | ✅ | `> 0` | 主 BPM,仅展示/HUD 用 |
| `offsetSec` | number | ✅ | 任意实数 | 首个下拍相对歌曲 0.000s 的偏移;负值 = 弱起(节拍落在歌曲起点前) |
| `tempoMap` | array | ✅ | ≥1 项;`t` 升序;首项 `t===0`;`bpm>0` | 变速点;相邻两点之间 BPM 恒定 |
| `timeSignatures` | array | ❌ | 首项 `t===0`;`num` 正整数;`den` 为 2 的幂 | 拍号;缺省 `[{t:0,num:4,den:4}]` |
| `beatTimesSec` | array | 建议 | 升序、严格递增 | 派生:每拍时间戳 |
| `downbeatsSec` | array | 建议 | 升序;是 `beatTimesSec` 的子集 | 派生:每小节第 1 拍 |

### 派生规则(生产者与消费者必须逐项一致)

1. **拍栅格**:`B[0] = offsetSec`;递推 `B[n] = B[n-1] + 60 / bpmAt(B[n-1])`,
   其中 `bpmAt(t)` = `tempoMap` 中 `t` 最大且 `<= t` 的那一项的 `bpm`。重复直到越过 `durationSec`。
2. **BPM 单位**:`bpm` 恒为「拍/分钟」,且这里的「拍」= `beatTimesSec` 里的栅格单位。
   `timeSignatures.den` 不改变 BPM 数值(即 BPM 始终按「拍」计,不按附点四分音符等复合拍换算)。
3. **下拍**:`B[i]` 是下拍当且仅当 —— `i === 0`;或 `B[i]` 是某条 `timeSignatures` 变更点之后的
   第一拍;或 `B[i]` 距上一个下拍正好相隔 `num` 拍(`num` = 该拍所在拍号的分子)。
4. 常见情形(无变速、4/4):`downbeatsSec` = `beatTimesSec` 中下标 0、4、8、… 的项。

### 为什么单独成 schema

节拍是**时间维**的元数据,与 `frames[]` 是正交的两个轴。单独成 schema 后,变速歌、
变拍、弱起都能表达,评分模块可只依赖节拍(不必遍历帧)做节奏判定。

---

## 4.2 谱面 schema(`chart/v1`)—【冻结 v1.0】

> 音符轨道:在节拍栅格上标出「哪些时刻要做动作判定」。是「跟跳」升级成「音游」的
> 事件层,与 `score.js` 的连续相似度评分**正交**(连续 = 基底分,音符 = 节奏 bonus + 连击)。

### 位置

- **权威位置**:序列文件顶层的 `chart` 字段(与 `schema`/`meta`/`frames` 平级)。
- 允许存在独立 `reference/<danceId>.chart.json` 作为**编辑器交换格式**(见本节末);
  运行时以序列文件内嵌的 `chart` 为准。

### 结构

```jsonc
"chart": {
  "version": "chart/v1",
  "danceId": "mixamo-hiphop-001",      // [可选] 冗余校验:须与序列文件 danceId 一致
  "audio": "audio/mixamo-hiphop-001.ogg", // 音频文件路径(相对序列文件目录)
  "audioOffsetSec": 0.0,               // 音频里「歌曲 0.000s」对应的采样起点秒数(静音前导/延迟补偿)
  "judgeOffsetSec": 0.0,               // [可选] 本谱专用判定偏移(叠加在全局 offset 之上)
  "timingWindows": {                    // 判定窗(秒);缺省 = ±0.050 / ±0.100 / ±0.150
    "perfect": 0.050, "great": 0.100, "good": 0.150
  },
  "lanes": [                            // [可选] 轨道定义(HUD 显示)
    { "key": "left-hand",  "label": "左手", "side": "left" },
    { "key": "right-hand", "label": "右手", "side": "right" },
    { "key": "body",       "label": "全身", "side": "center" }
  ],
  "notes": [ /* Note 对象,按 t 升序 */ ]
}
```

### Note 对象

**公共字段**(所有类型必含):

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `t` | number | ✅ | 命中时刻(歌曲时间,秒),`0 <= t <= durationSec` |
| `type` | string | ✅ | `"beat"` \| `"pose"` \| `"hold"` \| `"gesture"` |
| `id` | string | ❌ | 稳定 id(编辑器/调试/去重) |
| `lane` | string | ❌ | 轨道 key,须存在于 `lanes[].key`(若有 `lanes`) |

**`beat`(节奏重音,瞬时)**:

```jsonc
{ "id": "n001", "t": 1.000, "type": "beat", "lane": "body",
  "bones": [0, 1, 2, 3, 4],   // [可选] 参与比对的骨骼子集;缺省 = 当前模式全部骨骼
  "threshold": 0.55 }         // [可选] 命中阈值,覆盖全局判定线
```

**`pose`(关键姿势)**:

```jsonc
{ "id": "n002", "t": 2.500, "type": "pose", "lane": "body",
  "refFrameIdx": 120,         // [可选] 参考帧下标;缺省 = round(t * meta.fps)
  "bones": [2, 3],            // [可选] 骨骼子集;缺省 = 全部
  "threshold": 0.7 }
```

**`hold`(保持动作)**:

```jsonc
{ "id": "n003", "t": 4.000, "type": "hold", "lane": "body",
  "endT": 5.500,              // 必填,> t
  "refFrameIdx": 180,
  "bones": [2, 3],
  "threshold": 0.55,          // 起手命中阈值
  "minHold": 0.45 }           // [可选] 持续期间最低相似度,缺省 = threshold
```

**`gesture`(手势舞)**:

```jsonc
{ "id": "n004", "t": 6.000, "type": "gesture", "hand": "right",  // "left"|"right"|"both"
  "gestureId": "victory",     // [可选] 语义标签;缺省按 hands 关键点相似度比对
  "threshold": 0.6 }
```

### 判定规则(与 `docs/audio-engine-api.md` §3.8 一致)

- 到点 `t` 进入判定窗;`judgeTime = t + 全局offset + judgeOffsetSec`;取该时刻玩家最近一帧。
- `|命中偏移|` 落窗:≤`perfect`→PERFECT,≤`great`→GREAT,≤`good`→GOOD,否则 MISS(消费该 note)。
- `beat/pose/gesture`:单次采样即结算。
- `hold`:起手窗内达标 → 进入 HOLD;之后每 tick 在 `[t, endT]` 采样,跌破 `minHold` 提前结束(GOOD);
  撑满 → 按区间均值落 tier。

### 不变量(解析时校验,违反即拒)

- `notes` 按 `t` 升序;`hold` 另有 `endT > t`,并列时按 `endT` 升序。
- 所有 `t` ∈ `[0, durationSec]`(越界警告并 clamp)。
- `refFrameIdx` ∈ `[0, numFrames-1]`;`bones` 下标 ∈ `[0, boneCount-1]`,且与 `meta.danceType` 骨骼表一致。
- `version` 必须为 `"chart/v1"`;未知版本快速失败。

### 独立 chart 文件(编辑器交换格式)

```jsonc
{
  "schema": "chart/v1",
  "danceId": "mixamo-hiphop-001",
  "sequenceFile": "mixamo-hiphop-001.json",   // 关联的 dance-sequence/v1 文件
  "audio": "audio/mixamo-hiphop-001.ogg",
  "timingWindows": { "perfect": 0.050, "great": 0.100, "good": 0.150 },
  "lanes": [ /* 同上 */ ],
  "notes": [ /* 同上 */ ]
}
```

> 导出/打包时把独立 `chart` 内容合并进序列文件的 `chart` 字段;运行时只读内嵌副本。

---

## 5. 实时帧消息(由「实时端」产出)

浏览器内每帧产生的对象,结构同 §3,多两个来源字段:

```jsonc
{
  "t": 12.345,               // 距本局开始的秒数
  "bones": [ ... ],          // 同 §3
  "rootYaw": 0.12,
  "conf": [ ... ],
  "_src": "live",            // 固定
  "_seq": 741               // 单调递增帧序号,便于调试丢帧
}
```

实时端职责边界(你的部分):
- `getUserMedia` 拿摄像头 → MediaPipe Tasks `PoseLandmarker`(Web Worker + GPU delegate)
  → 33 world landmark → 归一化(§1) → 拼 §3 帧 → **发布**。
- 发布方式二选一:`postMessage`(页面内评分模块)或 `CustomEvent`/回调。
  跨端再走 WebSocket。**v1 建议页面内直接函数调用,别引 WebSocket**。
- 用 2D canvas 画火柴人(与评分模块解耦,画布只是显示)。

---

## 6. 对接清单(联调前必须敲定)

| 项 | 负责人 | 状态 |
|---|---|---|
| §1 坐标轴标定(每轴 ±1 翻转表) | 双方 | [待定] |
| §2 骨骼表是否加 `head` | 双方 | [待定] |
| `rootYaw` 的精确定义(建议:髋线向量在 x-z 平面 atan2) | 双方 | [待定] |
| MediaPipe 模型版本(lite/full/heavy)与 `.task`/`.wasm` 文件 | 实时端 | [待定] |
| 采样率统一(fps 30?) | 双方 | [待定] |
| 参考文件放置目录与命名 | 离线端 | 建议 `reference/` |
| 评分模块如何拿到实时帧(回调签名) | 实时端 | [待定] |
| `timing/v1` schema(§4.1) | 双方 | ✅ 冻结 v1.0 |
| `chart/v1` schema(§4.2) | 双方 | ✅ 冻结 v1.0 |
| 音频文件格式/采样率(建议 ogg/44100Hz)与 `audio` 相对路径约定 | 离线端 | [待定] |
| 判定窗默认值(±50/100/150ms,§4.2) | 双方 | 建议采用 |
| 延迟补偿 `offset` 校准流程(`docs/audio-engine-api.md` §3.4) | 双方 | [待定] |

---

## 7. 最小可行验证(双方各自先能跑)

**实时端(你)**:摄像头 → 打印一帧 `bones`(9×3 单位向量),肉眼确认
"右手抬起来,`upper_arm_r` 的 y 变大"即算通过。

**离线端(队友)**:一段参考视频 → 产出一个 `reference/demo.json`,
`numFrames` 与 `fps×duration` 一致,任意两帧 `bones` 不同即算通过。

两边都能产出 §3 帧后,评分模块(第三方或后续)即可开始联调。
