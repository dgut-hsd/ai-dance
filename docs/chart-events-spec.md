# 谱面事件流格式（模块C 起草 · 待组长/组员2确认）

> 状态：**DRAFT v0.1** — 需组长确认后回填。
> 依据：`interface-contract.md` 定义了密集参考序列 `reference/<danceId>.json`（§4），但**未定义"稀疏判定事件"**。
> 模块C 的窗口判定（文档《体感音舞项目技术上下文.md》§3.4/§4）需要事件流，本文件是 C 侧提案：
> 事件 = 参考序列某一帧的骨骼快照 + 判定窗口 + 权重 + 难度。**结构已冻结，字段待双方联调补齐。**

---

## 1. 设计原则

1. **事件是"标注层"，不是新数据源**。`targetBones` 直接拷自参考序列的某一帧（`targetT` 指明来源），
   不引入第二套骨骼表示，与契约 §0"同一帧格式，两处复用"一致。
2. **窗口判定依赖事件**：玩家帧在 `[t - early, t + late]` 内逐帧比对，取最优姿态分 + 时机偏移判档（Perfect/Great/Good/Miss）。
3. **自动生成 + 人工校谱**：C 侧 `chartBuilder` 可从参考序列自动抽样（均匀/运动极值）出 v1 事件，
   **联调前必须人工校谱**（文档 §3.5：密集连拍处判定点会堆积）。

## 2. 事件 JSON 结构（提案）

```jsonc
{
  "events": [
    {
      "t": 12.48,                // 秒，音乐时间轴基准，与 reference 帧 t 同域
      "targetBones": [           // 10 条骨骼单位向量，顺序与契约 §2 一致
        [0.0, 0.92, 0.38],
        // ... 共 10 组（末条为 head）
      ],
      "targetT": 12.46,          // 该快照取自参考序列的哪一帧（调试/联调用）
      "targetYaw": 0.187,        // [可选] 目标帧 rootYaw，rootYaw 对齐模式下的参考值（替代全局 refYaw）
      "window": { "early": -0.25, "late": 0.25 },
      "weights": [0.285, 0.095, 0.095, 0.095, 0.095, 0.07125, 0.07125, 0.07125, 0.07125, 0.05],
      "difficulty": 2,           // 总分加权
      "moveId": "body_roll"      // [可选] 动作本体库 / 语义标签（教学用）
    }
  ],
  "meta": {
    "danceId": "mixamo-hiphop-001",
    "source": "synthetic|annotated",   // synthetic=C 自动生成; annotated=人工标注
    "builtFromReference": "reference/mixamo-hiphop-001.json"
  }
}
```

**返回结构（结算单，模块C 产出，供组长确认展示字段）**：

```jsonc
{
  "perEvent": [
    {
      "moveId": "body_roll",
      "t": 12.48,
      "deltaT": 0.05,          // 最优姿态帧 - 事件时刻（秒）
      "grade": "great",        // perfect | great | good | miss
      "poseScore": 0.91,       // 0..1
      "timingValue": 0.8,
      "eventScore": 0.872,     // 0.65*pose + 0.35*timing（缺省）
      "completeness": 0.95     // 基于 conf 的完整度
    }
  ],
  "tallies": { "perfect": 12, "great": 8, "good": 3, "miss": 1 },
  "poseAccuracy": 0.88,
  "rhythmScore": 0.87,
  "completeness": 0.94,
  "total": 0.89                // Σ(eventScore*difficulty)/Σ(difficulty)
}
```

## 3. 待确认清单（回填后合并进 interface-contract.md 或独立成文）

| # | 项 | 提案 | 状态 |
|---|---|---|---|
| 1 | 事件流是否独立成文件 `reference/<danceId>.events.json` | 是 | [待定] |
| 2 | `weights` 缺省：躯干0.285 / 臂0.095×4 / 腿0.07125×4 / 头0.05（合计1.0，10 骨已落地） | 按实现 | ✅ |
| 3 | 判定档位：组长 `chart/v1` 已冻结 Perfect≤0.050/Great≤0.100/Good≤0.150（窗外Miss）；模块C `GAME_BANDS` 保留 0.05/0.12/0.20/0.25 作内部默认，接入时以谱面 `timingWindows` 覆盖 | 对齐冻结 | [待拍板] |
| 4 | 窗口缺省 ±0.25s；教学模式可切 exp 连续衰减（ατ=0.2s，pose/time=0.8/0.2） | 是 | 实现 |
| 5 | `head` 第 10 骨骼（boneCount 9→10，权重重归一化） | **已加** | ✅ |
| 6 | 采样率统一（组长冻结契约注释 30；`3.json` 实测 23；判定按秒不受影响） | 23 实证 | [待拍板] |

## 4. 模块 C 交互方式（供组长对接）

评分引擎是**流式的**，实时端每帧调用 `engine.ingest(frame)`，返回"刚结束判定窗口"的事件结果；`engine.close()` 结算剩余。无需未来帧，满足实时约束。V1 先跑离线回放（`npm run replay` 见 `scoring/examples/replay-cli.ts`）。