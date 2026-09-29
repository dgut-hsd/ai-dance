# 动作优化测试计划：手臂弯曲 × 身体转身

> 版本：v0.1
> 日期：2026-09-28
> 目的：验证近期「手臂无法弯曲」「身体无法转身」两类修复是否真正生效、有无回归、是否满足量化阈值。
> 依据：`docs/motion-beat-optimization.md` §10（根因 + 已实施改动）与以下源码：
> `pose_capture/export.js`、`pose_capture/contract.js`、`pose_capture/playback.js`、
> `pose_capture/filters.js`、`web_dance/retarget.js`、`web_dance/ik.js`。

---

## 0. 范围与非目标

**范围内**：动捕 → 契约帧 → 重定向这条链路上，与「手臂弯曲」「身体转身」「学习完整性」相关的修复点。

**非目标**：节拍识别、评分、谱面、音频（`timing/v1`/`chart/v1`）、FFmpeg 后端。这些不在本轮验证内，除非回归测试覆盖到它们。

---

## 1. 被测修复点清单

### 1.1 手臂弯曲（4 处）

| ID | 文件 | 改动/关键常量 | 期望效果 |
|---|---|---|---|
| ARM-1 | `web_dance/retarget.js` | `ARM_LIMITS = { minBend: 0.28, maxBend: π×0.985 }` | 放宽深折叠，允许「抱臂/深屈肘」，仅防完全锁死 |
| ARM-2 | `web_dance/ik.js` | `solveTwoBone(..., { limits })` 夹取目标距离 `d` | 解始终落在生理可行域，消除反折/超生理折叠/NaN |
| ARM-3 | `web_dance/ik.js` | `solveTwoBone(..., { hint })` 选「离上一帧更近」的镜像解 | 伸直/退化时肘膝弯折方向不 flip |
| ARM-4 | `pose_capture/filters.js` | `PoseSmoother` / `OneEuroFilter`（端点独立平滑为 §10.6 待做项） | 深弯曲不被低通抹平 |

### 1.2 身体转身（5 处）

| ID | 文件 | 改动/关键函数 | 期望效果 |
|---|---|---|---|
| TURN-1 | `pose_capture/contract.js` | `computeShoulderAxis` = normalize(右肩−左肩) | 统一肩轴计算，含水平偏航 + 竖直 roll 分量 |
| TURN-2 | `pose_capture/export.js` | 离线帧补写 `shoulderAxis` | 教练/学习序列与实时端数据契约一致 |
| TURN-3 | `pose_capture/playback.js` | `reconstructJoints` 消费 `frame.shoulderAxis \|\| lateral` | 肩轴不再被锁死成髋轴 |
| TURN-4 | `web_dance/retarget.js` | 身体朝向优先「肩轴水平投影」，回退 `rootYaw`；记录 `_torsoRoll` | 转身更准更稳，侧倾信息就位 |
| TURN-5 | `pose_capture/contract.js` | `computeRootYaw = atan2(hip.z, hip.x)` | 一维偏航（待解旋，见 §4.2 T-TURN-6） |

### 1.3 学习完整性（进度卡 22% 修复）

| ID | 文件 | 改动 | 期望效果 |
|---|---|---|---|
| LOAD-1 | `pose_capture/export.js` | `onProgress` 移到 `if(world)` 块外，按 `mediaTime/duration` 推进 | 检测不到人时进度不卡死 |
| LOAD-2 | `pose_capture/export.js` | `onended` 强制 `onProgress(1)` | 末帧 time 略小于 duration 时也能到 100% |

---

## 2. 测试环境与运行方式

| 层 | 命令 | 框架 | 适用 |
|---|---|---|---|
| L1 单元 | `npm test` | `node:test`（`node --test "test/*.test.js"`） | `ik.js` / `contract.js` / `playback.js` / `filters.js`（均可无 DOM 运行，`three` 已是 devDependency） |
| L3 重定向 | `npm run test:browser` | Playwright（`test/browser/*.spec.js`） | `retarget.js` 需真实 FBX 骨架 + three 场景 |
| L4 视觉 | 手工 + 录屏 A/B | 浏览器访问 `http://localhost:8000/web_dance/lab.html` | 主观自然度/卡点 |

> 关键前提（见 `docs/motion-beat-optimization.md` §10 与项目 memory 约束）：
> 必须用 `npm start`（Express）访问，禁止 `file://` 或 `python -m http.server`（`.mjs` MIME 会错）。
> 缓存若仍报 `vision_bundle.mjs` 加载失败，先清浏览器缓存（服务器已对 `.mjs/.wasm/.task` 设 no-store）。

---

## 3. 测试分层策略

```
L1 单元(纯函数,快,确定性) ── 覆盖 ik/contract/playback/filters 的几何与数值
   │  最大覆盖、可 CI
   ▼
L2 契约/数据(离线产物) ── 导出序列的 shoulderAxis 完整性、帧时间戳单调、进度回调
   ▼
L3 重定向(需真实骨架,Playwright) ── retarget 消费 shoulderAxis、肘膝关节角度落入限位
   ▼
L4 视觉 A/B(主观) ── 「像不像真人」「转身顺不顺」「深弯曲还原没」
```

原则：**L1 优先且最重**（纯函数最能锁定数值正确性）；L3/L4 作为「效果级」验收，不做 CI 硬断言。

---

## 4. 具体用例

### 4.1 手臂弯曲（L1 主战场，`node:test`）

> 肘/膝夹角定义（与 `ik.js` 注释一致）：γ = 中间关节处夹角，π = 完全伸直，0 = 完全折叠。
> 由余弦定理：`cos γ = (l1² + l2² − d²) / (2·l1·l2)`，其中 `d = |p0 − p2|`。
> 测试中可直接从 `solveTwoBone` 返回的 `upperDir`/`lowerDir` 算 γ：
> `γ = acos(clamp(-upperDir · lowerDir, -1, 1))`。

**T-ARM-1 关节限位：任意目标距离下解合法、不 NaN**
- 构造：固定 `p0=(0,0,0)`、`l1=l2=0.3`；令 `p2` 扫过一维范围（含「目标过近 d<0.05」「目标过远 d>0.6」「d≈0」等退化输入）。
- 断言：
  - `solveTwoBone` 始终返回有限数值（无 `NaN/Infinity`）；
  - `γ = acos(clamp(-upperDir·lowerDir,-1,1))` 恒落在 `[minBend, maxBend]`；
  - `|upperDir|≈1`、`|lowerDir|≈1`、`|p1 − p0|≈l1`、`|p2 − p1|≈l2`（骨长守恒）。

**T-ARM-2 深折叠允许到 <50°（回归 `minBend 0.40→0.28`）**
- 构造：让末端目标足够近，使折叠角逼近下限。
- 断言：`minBend = 0.28 rad ≈ 16°` 下，γ 可下探到 `< 50°`（≈0.87 rad）且仍不 NaN；用 `minBend=0.40`（旧值）跑同一输入会得到更浅的 γ，以证「放宽确实增加了可达折叠深度」。

**T-ARM-3 解连续性：屈 → 伸 → 屈，弯折方向不 flip**
- 构造：`p0` 固定，`p2` 依次取「可弯折目标 → 近似共线（伸直）→ 回到弯折」，并把上一帧 `p1` 作为 `hint` 传入。
- 断言：相邻两帧的 `p1` 世界位置差 < 阈值（弯折方向无「啪」的跳变）；`p1` 到 `hint` 比到镜像解更近。

**T-ARM-4 伸直态退化不跳变**
- 构造：`p2` 与 `p0` 共线且 `d ≈ l1+l2`（伸直）；`pole` 与 `dir` 平行（退化）。
- 断言：不抛异常、不 NaN；弯折偏移量 `off` 极小，`upperDir` ≈ `lowerDir` ≈ 同向。

**T-ARM-5 腿限位独立（膝盖不反折、可锁直）**
- 构造：复用 T-ARM-1 的扫参，`limits = LEG_LIMITS = { minBend: 0.55, maxBend: π }`。
- 断言：γ ∈ `[0.55, π]`；膝盖可到完全伸直（γ = π），但不会反折（γ 不会 < 0.55）。

**T-ARM-6 平滑器深弯曲不被抹平（ARM-4，回归基础）**
- 构造：`PoseSmoother` 喂一段「快速屈肘」的关节序列（末端 y 快速变化）。
- 断言：输出对输入的峰值/变幅衰减可控（当前默认参数只验证「不冻结可见关节」，端点独立平滑落地后再补「深弯曲还原率」断言，见 §7 P1）。

---

### 4.2 身体转身（L1 + L2 + L3）

**T-TURN-1 `computeShoulderAxis` 正确性（L1）**
- 构造：人为给定左右肩 3D 坐标。
  - 面朝相机、无侧倾：`left=[-0.2,1.4,0]`, `right=[0.2,1.4,0]` → 肩轴 `≈(1,0,0)`（水平、无 roll）。
  - 侧倾 30°：右肩比左肩低 → `shoulderAxis.y` 显著非零，`atan2(sa.y, hypot(sa.x,sa.z))` ≈ 侧倾角。
  - 转身 90°：肩轴水平投影从 `(1,0,0)` 转到 `(0,0,±1)`。
- 断言：`computeShoulderAxis` 返回单位向量（`norm≈1`）；偏航 = `atan2(sa.z, sa.x)` 与构造一致；roll = `atan2(sa.y, hypot(sa.x,sa.z))` 与构造一致。

**T-TURN-2 离线导出序列每帧带 `shoulderAxis`（L2，回归 TURN-2 + LOAD）**
- 方法：`exportVideoToSequence` 跑一段含转身的短视频（可在 Playwright 里 `page.evaluate` 调用，或离线用现有导出脚本），拿到 `sequence`。
- 断言：
  - `sequence.frames` 非空且 `>=` 视频时长×fps 的下限估计；
  - 每一帧 `frame.shoulderAxis` 为长度为 3 的数组且 `norm≈1`；
  - 每一帧 `frame.t` 单调递增；
  - `onProgress` 全程递增到 `1`（验证 LOAD-1 / LOAD-2）。

**T-TURN-3 `reconstructJoints` 消费肩轴（L1，回归 TURN-3）**
- 构造：一帧 `frame.shoulderAxis = (0,0,1)`（转身 90°）、`rootYaw` 故意给旧值（如 0）。
- 断言：`left_shoulder`/`right_shoulder` 的连线方向与该 `shoulderAxis` 一致（横向不再回退到髋轴的 `lateral`）。
- 反向：不传 `shoulderAxis` 的旧帧，肩轴回退 `lateral`（由 `rootYaw` 得出），保证向后兼容。

**T-TURN-4 重定向优先肩轴、回退 rootYaw（L3）**
- 方法：Playwright 加载 `lab.html` 后，用两个同构帧（一个带 `shoulderAxis`、一个只有 `rootYaw`）分别 `applyFrame`。
- 断言：带肩轴帧的 `hips` 世界四元数偏航由肩轴决定；无肩轴帧由 rootYaw 决定；二者在「肩轴与髋轴一致」的构造下结果一致。

**T-TURN-5 `_torsoRoll` 记录（L3）**
- 构造：一帧 `shoulderAxis.y` 显著非零（侧倾）。
- 断言：`applyFrame` 后 `retargeter._torsoRoll ≠ 0`，符号随左右侧倾翻转。（当前「仅记录未消费」，见 §7 P1 的 roll 应用落地后再补渲染侧断言。）

**T-TURN-6 `rootYaw` 时序解旋（待做项，先登记）**
- 目标：转身过 ±π 处 `atan2` 跳变 → `bodyYaw` 抽搐。
- 计划断言（解旋落地后启用）：连续帧的 `bodyYaw` 角度差 `unwrap` 后无 ±2π 跳变；转身序列「流畅无抽搐」。

---

### 4.3 学习完整性（进度 22% 修复，L2/E2E）

**T-LOAD-1 进度与「是否检测到人」解耦（E2E）**
- 方法：用一段「前 30% 有人、中间无人、后段恢复有人」的视频（或 mock `engine.detect` 在特定时间返回 `world=null`、`metadata.mediaTime` 仍推进）。
- 断言：`onProgress` 在「无人」段仍持续递增，不会停在某个 <1 的值。

**T-LOAD-2 结束强制 100%（E2E）**
- 断言：`onended` 触发后 `onProgress` 最后一次回调值为 `1`。

---

## 5. 指标与阈值汇总

| 指标 | 定义 | 目标阈值 | 对应用例 |
|---|---|---|---|
| 肘/膝夹角合法率 | γ ∈ [minBend, maxBend] 的帧占比 | 100%（无 NaN、无反折） | T-ARM-1/5 |
| 深折叠可达深度 | 允许的最小肘夹角 | ≤ 50°（≈0.87 rad） | T-ARM-2 |
| 弯折方向翻转次数 | 相邻帧肘/膝 `p1` 跳边次数 | 0 | T-ARM-3/4 |
| 肩轴单位性 | `‖shoulderAxis‖` 偏离 1 的量 | < 1e-3 | T-TURN-1/2 |
| 转身角度误差 | 重建偏航 vs 构造真值 | 偏差可忽略（单测构造真值） | T-TURN-1/3/4 |
| 离线序列完整性 | `shoulderAxis` 覆盖帧占比；`t` 单调 | 100%；无倒序 | T-TURN-2 |
| 学习进度推进 | `onProgress` 是否恒递增到 1 | 恒递增，终值 = 1 | T-LOAD-1/2 |
| 主观自然度 | 手臂弯曲/转身 A/B 评分（1–5） | 本轮修复后 ≥ 修复前（人工） | §4.4 L4 |

---

## 6. 验收标准（通过/失败判定）

1. **L1 全绿**：T-ARM-1~6、T-TURN-1/3 在 `npm test` 下通过，无跳过（`skip`）。
2. **L2 数据达标**：T-TURN-2 导出序列每帧带单位 `shoulderAxis` 且 `t` 单调，进度终值 = 1。
3. **L3 重定向正确**：T-TURN-4/5 在 Playwright 下通过，`retarget` 确实消费肩轴。
4. **无回归**：`scoring` 与既有 `test/*.test.js` 全部保持通过（手臂/转身改动不应影响评分与根运动）。
5. **L4 主观通过**：人工对照「修复前录屏 vs 修复后」，手臂深弯曲、转身流畅度有肉眼可见改善，且无「反折/抽搐/锁死」新增问题。

> 任一 L1/L2/L3 硬断言失败 = 测试不通过，回退定位；L4 主观项不通过但客观指标达标时，记录「表现层仍需优化」并转 §7 的 P1 项。

---

## 7. 执行顺序与依赖

| 阶段 | 内容 | 依赖 | 说明 |
|---|---|---|---|
| P0（立即） | L1：T-ARM-1~5、T-TURN-1/3 | 无 | 纯函数，最快锁定数值正确性 |
| P0（立即） | L2：T-TURN-2、T-LOAD-1/2 | Playwright | 需要真实视频或 `engine.detect` 的 mock |
| P1（短期） | L3：T-TURN-4/5 | 真实 FBX 骨架 | 依赖 `test/browser` 已有的 Playwright 基建 |
| P1（短期） | 落地 §10.6 剩余项后补测：端点独立平滑(T-ARM-6)、躯干 roll 应用(T-TURN-5 渲染侧)、`rootYaw` 解旋(T-TURN-6) | P0 | 各对应「待做项」落地后启用对应断言 |
| P2（回归） | 全量 `npm test` + `npm run test:browser` | P0/P1 | 确认无回归 |

---

## 8. 风险与已知边界

1. **`retarget.js` 依赖真实人形骨架**：L3 无法在纯 `node:test` 跑，必须走 Playwright 或注入 mock 骨架。若 mock 成本高，可先把 L3 降级为「手工 lab.html 验收」+ 只留 T-TURN-3（`reconstructJoints`）做 L1 硬断言。
2. **`exportVideoToSequence` 依赖 `createImageBitmap`/`engine.detect`** 的浏览器 API：L2 无法纯 node 跑；用 `page.evaluate` 在 Playwright 页内执行，或对 `engine.detect` 注入 stub。
3. **单目深度歧义是根**（§10.5 结论）：本测试验证的是「现有 BlazePose + 数据/重定向修复是否到位」，**不验证**换成 MeTRAbs/SMPL 后的精度——那是中期离线换模型阶段单独验收。
4. **主观项不可 CI**：L4 依赖真人对照，仅作发布前 checklist，不做自动化断言。

---

## 附：文件索引

| 关注点 | 文件 |
|---|---|
| 待测源（修复点） | `web_dance/retarget.js`、`web_dance/ik.js`、`pose_capture/contract.js`、`pose_capture/playback.js`、`pose_capture/filters.js`、`pose_capture/export.js` |
| 根因与改动依据 | `docs/motion-beat-optimization.md` §10 |
| L1 单测参考范例 | `test/root-motion.test.js`（`node:test` + `assert/strict` 写法） |
| L3 浏览器测试基建 | `test/browser/*.spec.js`、`package.json` 的 `test:browser` |
| 主观验收页面 | `web_dance/lab.html`（`npm start` 后访问） |