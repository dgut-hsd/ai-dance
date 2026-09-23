# 评分引擎设计说明（模块C）

> 状态：**DRAFT v0.3** — 依据组长《关于评分引擎的建议.md》与 `scoring/` 现行实现汇总。
> v0.3 更新：**10 骨升级已落地**（schema/权重/校验/序列校验/3.json 回放全部完成，54 用例通过）、
> 仓库已接 GitHub `ai-dance`（组长 `docs/interface-contract.md` v1.0 冻结：10 骨、`chart/v1`、`timing/v1`、
> 判定窗 ±0.050/0.100/0.150）、事件 `targetYaw` 机制已加、3.json hip-line 退化发现（见 §4/§9）。
> 标 `[待组长]` 的项在联调前由组长拍板并回填本文档。

---

## 0. 模块职责与边界

评分引擎（模块C）负责把**两个同构帧序列**对齐到同一时刻、逐骨骼算相似度、按判定事件出「单事件判定 + 结算单」。

- **输入**（两侧链路产出，契约见 `interface-contract.md`）：
  - 参考序列（离线）：`frames[]`，每帧 `{t, bones, rootYaw, conf}`；
  - 实时帧（玩家）：同构 `{t, bones, rootYaw, conf[, _src, _seq]}`。
- **输出**：`ingest(帧) → EventScore[]`（实时流式判定）+ `close() → 结算单`（`DanceResult`）。
- **不做**（边界）：不做 MediaPipe 检测、不做 FBX 渲染、不做相机/UI 渲染；判定界面只消费引擎输出 + 参考侧视觉数据（见 §8）。

核心一句话：**把两个同构帧序列对齐到同一时刻，逐骨骼算相似度，窗口内取最优，聚合成事件分。**

---

## 1. 已定的评分方案（S2，加性事件分）

### 1.1 帧输入与骨骼单元（与契约一致）

- `bones` 为**单位向量**（尺度/平移不变，等价 2 自由度关节角），顺序固定见契约 §2。
- `conf` 为每骨骼置信度，评分时降权；缺省视为全 1。

### 1.2 姿态分（每事件姿态质量）

单帧姿态分 = 加权余弦相似度的 conf 加权平均：

```
S_pose = Σ( w_i × conf_i × max(0, cos_i) ) / Σ( w_i × conf_i )
cos_i  = 参考方向 · 玩家方向    （同向=1，正交=0，反向被 max(0,·) 钳到 0 不倒扣）
```

### 1.3 骨骼权重（已实现 10 骨，`DEFAULT_BONE_WEIGHTS`）

| 分组 | 骨骼 | 权重 | 合计 | 来源 |
|---|---|---|---|---|
| 躯干 | spine | 0.285 | 0.285 | 组长建议：手臂、脊柱最重（原 0.30 按 0.95 等比缩放） |
| 臂 | upper_arm×2 / forearm×2 | 0.095×4 | 0.38 | 舞蹈表现力主体（原 0.10） |
| 腿 | thigh×2 / shin×2 | 0.07125×4 | 0.285 | 次重；踝最噪故 shin 不再放权（原 0.075） |
| 头 | head | 0.05 | 0.05 | 第 10 骨新增（0.95 缩放后归属） |

权重数组：`[0.285, 0.095, 0.095, 0.095, 0.095, 0.07125, 0.07125, 0.07125, 0.07125, 0.05]`（合计 = 1.0）。
head 具体数值仍待组长拍板（§9 #4），实现按上表。9 骨旧权重 `[0.3, 0.1×4, 0.075×4]` 已退役，校验不再接受 9 骨帧。

### 1.4 时机分（每事件节奏质量）

事件窗口 `[t − 0.25, t + 0.25]s` 内逐帧比对，取**姿态分最高帧**：
- 姿态分 = `best.poseScore`；
- 时机偏移 = `Δt = best.t − event.t`；
- 判档（`GAME_BANDS`，缺省）：

| 档位 | \|Δt\| 区间 | 时机分 | 事件分 = 0.65·pose + 0.35·timing |
|---|---|---|---|
| perfect | ≤ 0.05s | 1.0 | 满分 |
| great | ≤ 0.12s | 0.8 | — |
| good | ≤ 0.20s | 0.6 | — |
| miss | ≤ 0.25s | 0.0 | 事件分归零 |
| 窗口外 | > 0.25s | — | 整事件记 miss（挂 0） |

- 教学模式（可选）：`timingFn="exponential"`，时机分 = `exp(−|Δt|/0.2)`，pose/time 权重切 0.8/0.2。
- 事件分 = `clamp(0.65·pose + 0.35·timing, 0..1)`。

### 1.5 朝向对齐（yaw）

| 模式 | 取值 | 用途 |
|---|---|---|
| `none` | 不比 | 面朝镜头的简单编舞 |
| `rootYaw` | 帧自带 `rootYaw` | 面部转向（经转正后比） |
| `hip-line` | `atan2` 自算两股 XZ 和 | 无 rootYaw 时回退 |

`alignPlayer = rotateYaw(玩家骨骼, playerYaw − refYaw)`，只绕竖直 y 轴转玩家；roll/pitch 不做（v1）。
v0.3 起 `refYaw` 缺省取**事件级 `targetYaw`**（`ChartEvent.targetYaw`，由 `chartBuilder` 从目标帧 `rootYaw` 自动嵌入），
替代原全局常量，避免参考序列自身转角被错误补偿。

> ⚠️ **[待组长]** 组长文档公式为 `Δyaw = 参考rootYaw − 玩家rootYaw`（与我们符号相反）；`rootYaw` 精确定义契约仍未回填。
> 在符号联调完成前，rootYaw 对齐只保证「自比一致」（玩家与参考完全同世界朝向时 diff=0 不误转），不保证转体补偿方向正确。

### 1.6 结算单（`DanceResult`）

`perEvent[]`（每条含 moveId / t / deltaT / grade / poseScore / timingValue / eventScore / completeness / inWindow）+ 汇总：
- `tallies`（四档计数）、`poseAccuracy`、`rhythmScore`、`completeness`（基于 conf 的完整度）、
- `total = Σ(eventScore·difficulty) / Σ(difficulty)`。

---

## 2. 引擎架构（`scoring/` 包）

```
scoring/
  src/
    schema.js           # BONE_COUNT=9, BONE_DEFS, BONES 索引, DEFAULT_BONE_WEIGHTS
    contractValidate.js # 帧校验 + resolveConf（当前严格要求骨骼数=9）
    poseScore.js        # 姿态分/完整度/单帧打分（§1.2/1.3）
    timing.js           # 判档 bands + exp 时机值（§1.4）
    yawAlign.js         # rotateYaw + 3 模式 yaw（§1.5）
    eventScorer.js      # 事件扫描（scanEvent 窗口 argmax）+ 事件结算（scoreEvent）
    engine.js           # ScoringEngine：流式 ingest/close（§2.1）
    chartBuilder.js     # 参考序列 → 事件（uniform/extrema 两模式；§6 建议加 bars）
    metrics.js          # summarize → DanceResult（§1.6）
    replay.js           # 离线一键回放（§2.2）
    index.js            # 导出面（纯 JS，无编译步骤；浏览器可直接 import）
  tests/                # 9 个 vitest 用例文件 + synthetic 合成序列生成器
  examples/replay-cli.js# npm run replay 演示
```

### 2.1 流式判定协议（实时）

`engine.ingest(帧)`：帧按 `t` 单调进入；对处于 `[早, 晚]` 窗口内的待判事件累计最优帧；窗口闭合（`t ≥ 事件.t + window.late`）即出 `EventScore`。未来帧不可见，满足实时约束。`close()` 结算剩余未闭事件。

### 2.2 验证

- `npm test`：54 用例全绿（vitest，纯 JS 无编译步骤）。
- `npm run replay`：5 类玩家场景（perfect≈1.0 / 整体慢 0.1s 只掉节奏 / 前臂扰动只掉姿态 / 腿部遮挡完整度≈0.7 / 转体 0.9rad 对齐后恢复）。
- 已记录的设计现象：演示中前臂扰动场景 `rhythm=0.571`——姿态扰动会连带移动窗口 argmax 影响时机分，属**窗口判定的固有耦合**（非 bug），验收按此锁定行为。

---

## 3. 与组长建议文档的对照结论

组长《关于评分引擎的建议.md》与现实现**同源**（姿态公式、窗口 argmax、yaw 思想、四档平级一致）。

### 3.1 一致（已实现，无需改）

| 项 | 组长 | 现实现 |
|---|---|---|
| 输入帧 | 同构 {t,bones,rootYaw,conf}，单位向量 | `SkeletonFrame` 一致 |
| 姿态分 | Σ(w·conf·cos)/Σ(w·conf) | `framePoseScore` 同式（+max(0,·) 防反向倒扣） |
| 权重分级 | 手臂、脊柱＞大腿＞小腿＞头 | 0.3 / 0.1 / 0.075×4 相符（尚缺 head） |
| 时间对齐 | 窗口内逐帧比取最大帧 | `scanEvent`/`ingest` 同法（窗口 ±0.25s，其示例 ±5帧更窄） |
| 分数分解 | 姿态 / 节奏 / 部位 / 平级 | `DanceResult` 含四者（缺「部位分 / 连击」，见 §7） |

### 3.2 差异（待处理）

| # | 差异 | 处置 |
|---|---|---|
| 1 | **事件驱动 vs 全程滑窗**：组长 V1 主时钟 T 全程滑窗、无需谱面；现实现依赖谱面事件 | 见 §6，倾向 DC 式事件策略，事件间距由难度决定 |
| 2 | `head` 第 10 骨：`3.json` 实测 boneCount=10 | **必须升级**（§4/§5），组长已用实际数据应答 |
| 3 | 权重数值 / head 权重未定 | §1.3 提案待回填 |
| 4 | 档位阈值未定（组长只列平级名） | §1.4 提案待回填 |
| 5 | yaw 符号相反 + refYaw 粒度（现为全局常量，组长用参考帧自身 rootYaw） | §1.5 联调项；事件宜带 `targetYaw` |
| 6 | 缺「部位分 / 连击」 | §7 待加（肢体级反馈用） |
| 7 | 未提谱面文件 | chart-events-spec 改为模块C内部产出，不再依赖组长 |

---

## 4. 组长实测数据 `3.json` 的发现

组长从视频提取的参考序列 `3.json`（schema `dance-sequence/v1`，17.4s，392 帧）：

- **`boneCount: 10`**，第 10 骨 = `head`（shoulders_center → nose），顺序与我们契约 §2「head 为可选第 10 条」一致 —— **以实测为准：加 head**。
- `meta.fps = 23`（帧间隔 ≈ 44.3ms），**不是契约草稿假设的 30fps**。
- 新增契约未定义的 `meta.dimensions`（spineLen / shoulderWidth / … 真实骨长 8 项）——`ReferenceMeta.dimensions?` 已补入类型。
- 每帧 `t / bones[10] / rootYaw / conf[10]` 全带（契约说 conf 可省略，实际给了，更好）。
- `coordinateSystem: "canonical-yup"` 与契约一致；**rootYaw 精确公式与符号仍未回填**。

> ✅ **已落地**（v0.3）：`contractValidate` 已升级为 10 骨，新增 `validateSequence`（骨序/长度/帧合法性整条校验），
> `3.json` 全部 392 帧通过校验；`replay-cli` 可直接读文件跑 5 场景验收。

**v0.3 实测新发现（3.json 回放）**：
- 完美回放 `total=1.000`，但 `completeness=0.857` —— 来自视频导入自身的 conf（加权均值 ≈0.92），符合「conf 降权」语义，非 bug。
- 平移 +0.1s 只掉节奏（rhythm=0.800，全 great），姿态保持 1.000 —— 验证「shift 不牵连姿态」。
- **hip-line 对齐在 3.json 上退化**：yawed 0.9 rad 只恢复到 ~0.6（合成数据上 >0.97）。原因：3.json 的股骨多近垂直下落，髋线 X/Z 分量趋零、投影退化 → yaw 估不到。结论：真实数据应优先用 rootYaw 对齐（3.json 自带），hip-line 仅作双腿张开时的回退。

---

## 5. 10 骨升级清单（v0.3 ✅ 已完成）

1. ✅ `schema.ts`：`BONE_COUNT` 9→10；`BONE_DEFS` 尾加 `head{parent: shoulders_center, child: nose}`；`BONES.HEAD=9`；`DEFAULT_BONE_WEIGHTS` 扩 10（§1.3）。
2. ✅ `contractValidate.ts`：骨骼数要求 9→10（9 骨旧帧拒绝）；新增 `validateSequence()` / `assertValidSequence()`；`ReferenceMeta.dimensions` 补入类型。
3. ✅ `types.ts`：`ReferenceMeta` 补 `danceType` / `dimensions` / `timing` / `chart`（与组长 v1.0 契约 meta 对齐）；`ChartEvent.targetYaw`。
4. ⏳ `chartBuilder.ts`：`mode:"bars"`（每小节拍点事件，DC 式）——仍待办（§6）。
5. ✅ `eventScorer.ts` / 引擎：`refYaw` 缺省取事件 `targetYaw`（yaw 符号仍待组长联调，§1.5）。
6. ✅ `replay-cli.ts`：改为读磁盘 JSON（`npm run replay -- ../3.json`），5 场景冒烟通过。
7. ⏳ 文档：`chart-events-spec.md` 回填（见其更新），`interface-contract.md` 以组长 `docs/` 冻结版为准。
8. ✅ **语言从 TS 整体改回纯 JS**（用户拍板，避免前端编译）：全部 `src/*.js` / `tests/*.test.js` / `examples/replay-cli.js` 均为剥离类型后的运行时即用 JS，删除 `tsconfig.json`，`npm run replay` 由 tsx 改 node；54 用例仍全绿。
9. ✅ **接入 `web_dance/` 前端**：新建 `web_dance/scoring-adapter.js`（SimpleScorer 同款 5 接口 + `score/hits/totalAcc` 现场字段），main.js 改 import(:16) + 构造(:296/:561)；判定窗按契约冻结 ±0.050/0.100/0.150，事件间隙用 `framePoseScore` 对最近未来事件做预览 acc（只显示不入分）；node 冒烟：demo 序列 48 事件，完美半场全 perfect/错拍半场全 miss。

---

## 6. 判定事件策略（调研结论：DC 式「每小节动作卡」）

调研三款游戏后结论：既不是逐拍（Just Dance / DDR 式），也不是人工稀疏点（Dance Evolution 式），而是 **DC 式按「动作卡 ≈ 每 4 拍（1 小节）」判定，难度同时改变事件间距与动作复杂度**。

### 6.1 三款对比

| 维度 | 逐拍（JD/DDR） | 稀疏（DE） | **DC 式（推荐参考）** |
|---|---|---|---|
| 判定单位 | 每拍一次 | 人工标注关键姿态 | 每 4 拍（1 小节）一张动作卡 |
| 难度怎么变 | 阈值不变，靠精度 | 判定点密度 | **间距 + 动作复杂度**同时变 |
| 教学性 | 每拍轰炸，分不清错哪 | 点太少，跟不上歌 | 卡间距给足反应时间，卡片有语义 |
| 谱面依赖 | 无需（拍点自动） | 需人工校谱 | 无需（小节拍点自动） |

### 6.2 DC 难度分级证据（来自官方谱面数据）

- 制作流程（Ars Technica 采访 Harmonix 编舞）：**先编 Hard 完整编舞 → 再降级出 Medium / Beginner**；Easy 不是放慢，而是另一套更简单的动作序列。
- 每曲动作总表按难度打勾：核心简单动作（如 `To The Left`、`Tell It`）四难度全出现全曲循环；进阶动作从 Medium 出现；专属难动作（如 `Tut`、`Bait & Switch`）只在 Hard。
- 密度数据：`1,2 Step`（2:29、113 BPM ≈ 281 拍）全难度总表 62 个动作；Hard 一趟接近全表 → **约每 4 拍换卡**；Easy/教学档是其子集 → **同一简单动作撑多小节**。

### 6.3 落地（模块C 内部，不依赖组长）

- v1 默认：`chartBuilder.mode:"bars"` —— 事件 = **对齐小节（4 拍整数倍）的拍点**，从参考序列自动取目标帧；事件间距随难度：Hard ≈ 每 4 拍、Easy/教学 ≥ 每 8 拍（自动选简单循环帧）。
- 复杂度旋钮 = 每事件 `difficulty` / `weights`（对应 DC「专属动作只在 Hard」），已天然映射到 `eventScore·difficulty` 的结算加权。
- 引擎不改：密集/稀疏都是同一个窗口判定。DC 式「breakdown 段（少数十几秒逐拍 tap + 金卡加倍）」留作 v2 教学彩蛋。

---

## 7. 待扩展项（模块C 后续）

1. **部位分**：按臂 / 腿 / 躯干 / 头分组聚合（复用现 conf 加权逻辑），供「手很好腿没跟上」类反馈。
2. **连击**：连续非 miss 事件计数（街机爽感），随 pending 闭合维护。
3. **判定界面**（webui，见 §8）。

---

## 8. 判定界面设计取向（消费引擎输出，webui）

设计取向（参考 DE + JD + DC 混合，见 `docs/` 决策记录）：

- **目标姿态幽灵**：叠在参考视频的舞者身上（用户拍板：叠参考视频上）。参考侧是 3D FBX 编舞 → 用渲染时固定机位相机把关节投影到视频像素空间，得到贴合舞者的幽灵，**不走 MediaPipe 2D**（幽灵不参与计分，无误差同源需求，且 2D 检测抖动大）。
- **底部横排预告图标**：JD 式，即将/当前/已判事件的小姿态 icon。
- **判定浮标**：事件瞬间弹档位词 + Δt。
- 复用：同一「pose → stick-figure」渲染器生成幽灵 / 横排 icon / 判定 icon；参考侧视觉数据（投影 2D 关节）作为 chart 附带文件（依赖组长在 FBX 渲染侧导出相机参数与关节投影）。[依赖组长确认可行性]

---

## 9. 待办 / 待拍板清单

| # | 项 | 归属 | 状态 |
|---|---|---|---|
| 1 | 10 骨升级（schema/校验/权重/replay 3.json + 序列校验） | 模块C | ✅ v0.3 完成（§5） |
| 2 | `chartBuilder.mode:"bars"`（每小节拍点事件 + 难度间距） | 模块C | 待办（§6） |
| 3 | 部位分 + 连击 | 模块C | 待办（§7） |
| 4 | head 权重数值（§1.3，实现暂按 0.05） | 组长 | [待拍板] |
| 5 | 档位阈值：组长 `chart/v1` 已冻结 ±0.050/0.100/0.150（3 档，miss=窗外）；我们 `GAME_BANDS` 0.05/0.12/0.20/0.25（4 档含 miss≤0.25） | 双方 | [待拍板：按冻结值对齐或留作 per-chart 覆盖] |
| 6 | `rootYaw` 精确定义 + yaw 符号方向（事件 `targetYaw` 已加） | 双方 | [待拍板] |
| 7 | fps 统一（3.json 实测 23；leader 契约注释 30；判定按秒不受影响，仅 argmax 粒度 44ms） | 双方 | [待拍板] |
| 8 | `meta.dimensions` 并入契约（实现已兼容） | 双方 | [待拍板] |
| 9 | 判定界面的参考侧相机投影数据（FBX 相机导出） | 组长 | [待拍板] |
| 10 | 事件策略走 DC 式（每小节） | 双方 | [待拍板]（§6 推荐） |
| 11 | 引擎接入组长 `web_dance/`（新建 `scoring-adapter.js` 替换 `simple-score.js`；`SongSession` 音符判定保留） | 我方 | ✅ 已接入（main.js 仅改 import 与 2 处构造） |

---

## 10. 快速验证命令

```
cd scoring
npm test            # vitest，54 用例
npm run replay      # 5 场景离线回放演示（合成）
npm run replay -- ../3.json   # 读组长实测参考序列回放验收
```