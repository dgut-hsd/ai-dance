# 谱面事件流格式（模块C · chart/v1 扩展已落地）

> 状态：**实现于 `scoring/src/chartCodec.js`，13 条单测已绿**。
> 结论先行：**不新造独立 events 文件**，直接复用组长冻结的 `chart/v1`（`interface-contract.md` §4.2），
> 由 `parseChart(seq, chart)` 把 notes 解析成引擎判定事件；`serializeChart(events)` 反向导回 chart/v1 供人工校谱。
> 人工制作 spec 文件 → 程序读取 → 播放，闭环已通（web_dance「加载谱面 JSON」）。

---

## 1. 设计原则（更新）

1. **权威位置 = 参考序列内嵌 `seq.chart`**（契约 §4.2）：运行时只读内嵌副本；`parseChart(seq, chart)` 中 `chart` 缺省回退 `seq.chart`。
2. **独立 chart 文件 = 编辑器交换格式**（契约 §4.2 末）：`{ "schema":"chart/v1", "sequenceFile":..., ...内容 }`；`toStandaloneChart` 产出、`toStandaloneChart` CLI `--standalone`(缺省) 模式写出；`--inline` 模式经 `mergeChartIntoSequence` 把 chart 合并进参考文件顶层。
3. **事件是"标注层"**：`parseChart` 用 `refFrameIdx` 指向参考序列一帧，快照成事件 `targetBones`——同一帧格式，两处复用。
4. **窗口判定**：玩家帧在 `[t + window.early, t + window.late]` 逐帧比对取最优姿态分 + 时机偏移判档。
5. **自动生成 + 人工校谱**：无谱面时 `chartBuilder` 自动抽样；`serializeChart` 导回、人工改、读回。

## 2. chart/v1 扩展字段（模块C 提案，均在 `scoring/src/chartCodec.js` 校验；**待组长确认**）

| 位置 | 字段 | 说明 | 缺省 |
|---|---|---|---|
| 顶层 | `boneWeights` | 全局骨骼权重表 `[10]`（合计 1.0） | `DEFAULT_BONE_WEIGHTS`（spine .285 / 臂 .095×4 / 腿 .07125×4 / head .05） |
| 顶层 | `judgeWindow` | 采样窗 `{early, late}`（秒） | `±0.25` |
| 顶层 | `difficulty` | 全局难度（总分加权） | `seq.meta.difficulty ?? 2` |
| 顶层 | `timingWindows` | 判定档位 `{perfect,great,good}`，**引擎 bands 以谱面为准**（契约字段，非扩展） | `±0.05 / 0.10 / 0.15` |
| note | `refFrameIdx` | 参考帧下标（契约字段，非扩展） | `round(t * seq.meta.fps)` |
| note | `bones` | 骨骼子集：不在子集内的骨骼权重归零（判局部动作） | 全部 |
| note | `weights` | 事件级全量权重覆盖 `[10]` | 全局表 |
| note | `difficulty` | 事件级难度 | 全局 |
| note | `window` | 事件级采样窗 | `judgeWindow` |

> `hold` 视为起始姿态事件（v1）；`beat` 自动取 `round(t*fps)` 参考帧，判"该节奏点的姿态+时机"；
> `gesture` 因引擎暂无手部模型，解析时跳过并 console.warn（若全跳过则抛错）。

## 3. 待确认清单（回填）

| # | 项 | 结论 | 状态 |
|---|---|---|---|
| 1 | 事件流是否独立成 `reference/<danceId>.events.json` | 否。**权威=参考序列内嵌 `seq.chart`**；独立 chart 文件按契约 §4.2 `{schema:"chart/v1", sequenceFile,...}` 作编辑器交换格式 | ✅ 已对齐 |
| 2 | 缺省 weights：躯干 .285 / 臂 .095×4 / 腿 .07125×4 / 头 .05 | 按实现 | ✅ |
| 3 | 判定档位以谱面 `timingWindows` 覆盖（`parseTimingWindows`） | 按冻结 | ✅ 已实现 |
| 4 | 采样窗缺省 ±0.25；可经 `judgeWindow`/note.window 覆盖 | 是 | ✅ 已实现 |
| 5 | head 第 10 骨骼（9→10） | 已加 | ✅ |
| 6 | 采样率统一（30 vs 23） | 判定按秒不受影响 | [待拍板] |
| 7 | §2 扩展字段（boneWeights/judgeWindow/difficulty、note weights/bones/window）纳入契约 | 模块C 提案 | [待组长确认后回填 `interface-contract.md`] |

## 4. 模块 C 交互方式（供组长对接）

- **读取**：`parseChart(sequence, chart)`（`chart` 缺省取 `sequence.chart`）→ `[{ t, refFrameIdx, targetBones, targetT, targetYaw, window, weights, difficulty, moveId }]`（升序），喂给 `ScoringEngine`。
- **导出**：`serializeChart(events, { seq, source })` → chart/v1 内容对象（子集权重自动表达为 `note.bones`，全量覆盖表达为 `note.weights`）。
- **独立文件**：`toStandaloneChart(content, { seq })` → `{ schema:"chart/v1", sequenceFile, ... }`（编辑器交换格式）。
- **合并**：`mergeChartIntoSequence(seq, chart)` → `seq.chart` 内嵌（运行时权威位置）。
- **CLI**：`npm run export-chart`（demo）│ `-- <ref.json> [--out x.json] [--step 8]`（独立格式）│ `--inline`（合并进参考文件）。
- **前端**：web_dance 挑战模式「加载谱面 JSON」(独立编辑器格式, danceId 匹配才覆盖内嵌) / 「导出谱面 JSON」；`ScoringAdapter` 优先 `seq.chart`,无则 `--inline` 产物或自动 `buildChart` 兜底。
- **判定档位**：谱面 `timingWindows` 优先，缺省冻结 `±0.050/0.100/0.150`；`windowEdge` 取末档 `good.edge`。