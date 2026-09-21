# audio.js — 音频引擎接口设计(方案冻结稿)

> 版本:v1.0(与 `interface-contract.md` §4.1 `timing/v1`、§4.2 `chart/v1` 同时冻结)
> 状态:接口设计稿 —— 只定义类/方法签名与契约,**不含实现代码**(遵循「暂不改代码」)。
> 目标文件:`web_dance/audio.js`(ES module,浏览器端)。
> 选型:**`AudioBufferSourceNode`**(整曲解码)+ **`AudioContext.currentTime` 作唯一主时钟**。

---

## 0. 设计目标(硬性要求)

1. **单一时钟**:音频、教练、节拍、谱面、评分全部只认由 `AudioContext.currentTime` 派生的
   `songTime`。`performance.now()` 仅用于渲染帧间隔 `dt`,不参与音乐逻辑。
2. **绝对时间调度**:倒计时、节拍脉冲、音符判定全部按**绝对 ctx 时间**排程,禁用 `setTimeout` 猜时间。
3. **延迟可建模可校准**:输出延迟 + 输入(动捕)延迟 + 用户微调,三者合成一个 `totalOffsetSec`。
4. **事件判定与连续判定正交**:保留 `score.js` 逐帧相似度作基底分;新增 `NoteJudge` 作音符事件层。
5. **惰性 + 幂等 + 可销毁**:`AudioContext` 必须在用户手势内惰性创建;所有入口幂等;页面卸载可 `dispose()`。

---

## 1. 模块总览

```
SongSession (门面,main.js 唯一入口)
 ├─ AudioEngine       AudioContext + 解码 + 播放/暂停/seek
 ├─ Scheduler         lookahead 调度器(绝对时间事件队列)
 ├─ LatencyModel      output + input + user 三延迟 → totalOffsetSec
 ├─ TimingMap         timing/v1 → 拍栅格 / 下拍 / BPM 查询
 ├─ NoteChart         chart/v1  → notes 列表 + 时间窗查询
 ├─ PlayerPoseBuffer  环形帧缓冲(供延迟补偿采样)
 └─ NoteJudge         音符事件判定(复用 DanceScorer 相似度)
```

---

## 2. 类型定义(TS 风格,仅签名)

```ts
type SongState = "idle" | "loading" | "ready" | "playing" | "paused" | "ended";

// 契约帧(interface-contract §3)
interface ContractFrame {
  t: number;
  bones: number[][];        // 9 组单位向量
  rootYaw?: number;
  rootPos?: number[];
  conf?: number[];
  hands?: unknown;          // 手势舞
}

// timing/v1(interface-contract §4.1)
interface TimingV1 {
  version: "timing/v1";
  bpm: number;
  offsetSec: number;
  tempoMap: { t: number; bpm: number }[];
  timeSignatures?: { t: number; num: number; den: number }[];
  beatTimesSec?: number[];
  downbeatsSec?: number[];
}

// chart/v1(interface-contract §4.2)
interface ChartV1 {
  version: "chart/v1";
  danceId?: string;
  audio?: string;
  audioOffsetSec?: number;
  judgeOffsetSec?: number;
  timingWindows?: { perfect: number; great: number; good: number };
  lanes?: { key: string; label?: string; side?: string }[];
  notes: NoteV1[];
}

type NoteV1 =
  | { id?: string; t: number; type: "beat";    lane?: string; bones?: number[]; threshold?: number }
  | { id?: string; t: number; type: "pose";    lane?: string; refFrameIdx?: number; bones?: number[]; threshold?: number }
  | { id?: string; t: number; type: "hold";    lane?: string; endT: number; refFrameIdx?: number; bones?: number[]; threshold?: number; minHold?: number }
  | { id?: string; t: number; type: "gesture"; lane?: string; hand: "left" | "right" | "both"; gestureId?: string; threshold?: number };

type JudgeTier = "PERFECT" | "GREAT" | "GOOD" | "MISS";

// NoteJudge 只依赖这一项相似度计算(即 score.js / simple-score.js 的 _similarity)
type SimilarityFn = (ref: ContractFrame, player: ContractFrame, boneDefs?: unknown) => number;

// dance-sequence/v1 顶层(引用 interface-contract §4)
interface DanceSequenceV1 {
  schema: "dance-sequence/v1";
  danceId: string;
  meta: { fps: number; durationSec: number; numFrames: number; boneCount: number;
          danceType: string; timing?: TimingV1; [k: string]: unknown };
  bones: { name: string; parent: string; child: string }[];
  frames: ContractFrame[];
  chart?: ChartV1;
  [k: string]: unknown;
}
```

---

## 3. 核心类签名

### 3.1 `AudioEngine`(音源 + 主时钟)

```ts
interface AudioEngineOptions {
  latencyHint?: AudioContextLatencyCategory;   // 默认 "interactive"
  onStateChange?: (s: SongState) => void;
  onEnded?: () => void;
}

class AudioEngine implements SongClock {
  constructor(opts?: AudioEngineOptions);
  readonly ctx: AudioContext;        // 惰性创建:必须发生在用户手势调用栈内
  get state(): SongState;
  get durationSec(): number;         // 解码后有效;未就绪为 0
  get songTime(): number;            // 主时钟:ctx.currentTime - startAt,clamp 到 [0, durationSec]
  get outputLatencySec(): number;    // (ctx.baseLatency + ctx.outputLatency),不支持则为 0
  get loop(): boolean;               // 循环播放(表演模式用)
  set loop(v: boolean): void;

  async load(source: string | ArrayBuffer): Promise<void>;   // fetch → decodeAudioData
  async play(whenSec?: number): Promise<void>;               // whenSec=绝对 ctx 时间;缺省 ctx.currentTime + 0.06
  pause(): number;                    // 暂停并返回此刻 songTime(不释放 buffer)
  async resume(): Promise<void>;      // 从暂停点重建 source 继续
  async seek(songTimeSec: number): Promise<void>;
  stop(): void;                       // 停表回 ready,释放当前 source,保留 buffer
  async dispose(): Promise<void>;     // ctx.close()
}
```

语义要点:

- `load()` 幂等:重复调用先释放旧 buffer。
- `play()` / `resume()` 内部处理 `ctx.state === "suspended"` → `await ctx.resume()`(自动播放策略)。
- `pause()` 后 `songTime` 冻结;`resume()` 从冻结点继续,**不重解码**。
- `seek()` 播放中时 = `stop() + 重建 source + start(新的 ctx 起始时间)`。
- `songTime` 用 `double` 秒、绝对差值,禁止 `+dt` 累加。

### 3.2 `SongClock`(时钟接口)

```ts
interface SongClock {
  readonly songTime: number;   // 秒,double
}
```

`AudioEngine` 实现之;`Scheduler` / `NoteJudge` / `TimingMap` 只依赖此接口,便于注入假时钟做测试。

### 3.3 `Scheduler`(lookahead 调度器)

```ts
interface SchedulerOptions {
  tickIntervalSec?: number;   // 默认 0.025(25ms)
  lookaheadSec?: number;      // 默认 0.150
}
type SchedulerId = number;

class Scheduler {
  constructor(clock: SongClock, opts?: SchedulerOptions);
  schedule(atSongTime: number, fn: (songTime: number) => void): SchedulerId;                    // 单次
  scheduleEvery(fromSongTime: number, everySec: number, fn: (songTime: number) => void): SchedulerId; // 周期(节拍)
  cancel(id: SchedulerId): void;
  start(): void;   // 启动内部 setInterval 循环
  stop(): void;    // 停表并清空队列
}
```

实现约束:v1 核心按「到点」派发 —— 内部循环每 `tickIntervalSec` 读 `clock.songTime`,派发
`next <= 当前时刻` 的事件;`lookaheadSec` 保留给后续「提前准备(如音符视觉提前出场)」。
周期事件用 `next = max(prev + everySec, from)` 计算下一拍,并用「快进跳过已错过周期」避免 seek 后堆积。

### 3.4 `LatencyModel`(延迟建模 + 校准)

```ts
interface LatencyModelOptions {
  outputLatencySec?: number;   // 由 AudioEngine.outputLatencySec 注入
  inputLatencySec?: number;    // 摄像头 + MediaPipe + 平滑,默认 0(校准后回填)
  userOffsetSec?: number;      // 用户微调,默认 0
}
class LatencyModel {
  constructor(opts?: LatencyModelOptions);
  get totalOffsetSec(): number;                       // 三者和
  judgeTimeAt(songTime: number): number;              // songTime + totalOffsetSec
  // 最小二乘估计 inputLatencySec:给定「期望时间」与「实际敲击时间」样本
  autoCalibrate(samples: { expectedSec: number; actualSec: number }[]): number;
}
```

### 3.5 `TimingMap`(节拍查询)

```ts
class TimingMap {
  constructor(timing: TimingV1, durationSec: number);
  readonly beatTimesSec: number[];
  readonly downbeatsSec: number[];
  bpmAt(t: number): number;
  beatIndexAt(t: number): number;                          // 浮点拍号(前奏可为负)
  nearestBeat(t: number): { index: number; time: number; deltaSec: number };
  nextBeatTime(t: number): number | null;                  // 严格 > t 的下一拍
  prevBeatTime(t: number): number | null;
  barIndexAt(t: number): number;
  isDownbeatTime(t: number): boolean;
  timeAtBeat(index: number): number;
}
```

实现按 `interface-contract.md` §4.1 派生规则;查询一律二分,复杂度 O(log n),单帧可多次调用。

### 3.6 `NoteChart`(谱面查询)

```ts
class NoteChart {
  constructor(chart: ChartV1, durationSec?: number);  // durationSec 用于越界 clamp 校验,缺省 Infinity
  readonly notes: NoteV1[];      // 构造时已按 t 升序校验
  readonly noteCount: number;
  readonly windowsMs: { perfect: number; great: number; good: number }; // 默认 50/100/150
  notesInWindow(from: number, to: number): NoteV1[];   // [from, to) 二分
  nextNoteAfter(t: number): NoteV1 | null;
}
```

### 3.7 `PlayerPoseBuffer`(环形帧缓冲)

```ts
class PlayerPoseBuffer {
  constructor(capacity?: number, maxAgeSec?: number);   // 默认 120 帧 / 1.0s
  push(frame: ContractFrame, songTime?: number): void;  // songTime 缺省 = frame.t(打点入队)
  framesInRange(from: number, to: number): { frame: ContractFrame; t: number }[]; // [from,to] 闭区间
  sample(songTime: number): ContractFrame | null;       // 最近邻(过期帧跳过)
  sampleNearest(songTime: number, maxDeltaSec: number): { frame: ContractFrame; deltaSec: number } | null;
  clear(): void;
}
```

作用:玩家动捕有延迟,判定某 note 时到缓冲里按 `judgeTime` 取**最近一帧**,而非「当前帧」,
消除「拍子到了但动作还没进」的错判。环形数组,固定容量,零 GC 压力。

### 3.8 `NoteJudge`(音符事件判定)

```ts
interface JudgeResult {
  noteId?: string;
  noteType: NoteV1["type"];
  tier: JudgeTier;
  acc: number;            // 0..1 相似度(hold 为区间均值)
  deltaSec: number;       // 命中相对 note.t 的偏移(正 = 偏晚)
  combo: number;          // 更新后连击
  score: number;          // 本次加分
  ongoing?: boolean;      // hold 进行中(仅 hold 中途 tick 返回)
}
interface NoteJudgeOptions {
  latency?: LatencyModel;
  refAt?: (t: number, note: NoteV1) => ContractFrame | null;  // 参考帧提供者(判定必需)
  durationSec?: number;               // 越界 clamp 校验
  defaultThreshold?: number;          // 缺省 0.55
  windowsMs?: { perfect: number; great: number; good: number }; // 覆盖谱面判定窗
  bufferCapacity?: number;            // 缺省 120
  bufferMaxAgeSec?: number;           // 缺省 1.0
  onJudgement?: (r: JudgeResult) => void;
}

class NoteJudge {
  constructor(chart: ChartV1, similarity: SimilarityFn, opts?: NoteJudgeOptions);
  reset(): void;
  feed(songTime: number, frame: ContractFrame): void;  // 每帧喂入(内部 push 缓冲)
  tick(songTime: number): JudgeResult[];                // 由 Scheduler 到点调用,返回本 tick 新判定
  get combo(): number;
  finalize(): { maxCombo: number; notesHit: number; totalNotes: number;
                perfect: number; great: number; good: number; miss: number };
}
```

判定规则(与 `interface-contract.md` §4.2 一致):

- 到点 `t` 进入判定窗;`judgeTime = latency.judgeTimeAt(t)`;到缓冲 `sampleNearest(judgeTime)`。
- `|deltaSec|` 落窗:≤perfect→PERFECT,≤great→GREAT,≤good→GOOD,否则 MISS(消费该 note)。
- `beat / pose / gesture`:单次采样即结算。
- `hold`:起手窗内达标 → 进入 HOLD;此后每 tick 在 `[t, endT]` 采样,跌破 `minHold` 提前结束(GOOD);
  撑满 → 按区间均值落 tier。
- 命中后该 note 标记 consumed,避免重复结算。

### 3.9 `SongSession`(门面,main.js 唯一入口)

```ts
interface SongSessionOptions {
  sequence: DanceSequenceV1;                 // dance-sequence/v1 对象(含 timing/chart/audio)
  similarity: SimilarityFn;                  // 复用 DanceScorer._similarity
  onJudge?: (r: JudgeResult) => void;        // 透传 NoteJudge
  onBeat?: (beat: { index: number; time: number; downbeat: boolean }) => void;
  onStateChange?: (s: SongState) => void;
}

class SongSession {
  constructor(opts: SongSessionOptions);
  readonly engine: AudioEngine;
  readonly timing: TimingMap;
  readonly chart: NoteChart | null;          // 无 chart 时 null(纯跟跳无音符)
  readonly judge: NoteJudge | null;
  get songTime(): number;
  get judgeTime(): number;                   // latency.judgeTimeAt(songTime)
  async prepare(): Promise<void>;            // 解码音频 + 建 TimingMap/NoteChart + 注册调度
  async start(): Promise<void>;              // GO 对齐:source.start(songStartAt) + Scheduler.start()
  pause(): number;
  resume(): Promise<void>;
  seek(t: number): Promise<void>;
  stop(): void;
  update(): void;                            // 每 rAF 调用:驱动 Scheduler.tick + 节拍/音符派发
}
```

---

## 4. 数据流与时序

```
[用户点击开始]
  → ctx = new AudioContext(); await ctx.resume()          (必须手势内)
  → session.prepare(): load(audio) → decode → TimingMap / NoteChart / NoteJudge
  → 倒计时(绝对 ctx 时间排程 3/2/1/GO,不用 setTimeout)
  → GO 时刻 songStartAt = ctx.currentTime + lead
  → source.start(songStartAt); Scheduler.start()
  → 每 rAF: session.update() → Scheduler.tick(songTime)
        ├─ 到点节拍 → onBeat → beatPulse 视觉
        └─ 到点音符 → NoteJudge.tick → onJudge → juice / HUD
  → songTime ≥ durationSec → engine.onEnded → finishChallenge()
```

关键不变式:**GO 那一点的 `songTime` 严格等于 0.000s**;歌、教练、节拍、谱面从同一点出发,
永不对齐漂移。

---

## 5. 线程模型与精度

- 所有 JS 跑主线程;`AudioContext` 内部有独立渲染线程,`currentTime` 由其维护,不受主线程卡顿影响 —— 调度稳。
- `Scheduler` 用 `setInterval`(25ms)读时钟,即使 rAF 被节流也不丢事件(与音游 lookahead 同源做法)。
- 时间全用 `double` 秒、绝对时间戳;**禁止**对 `songTime` 做 `+dt` 累加。
- MediaPipe 目前也在主线程(README 已知取舍);若卡顿,靠 `lookaheadSec` 与 `PlayerPoseBuffer` 兜底,后续再迁 Worker。

---

## 6. 生命周期与错误处理

| 场景 | 处理 |
|---|---|
| 自动播放策略(Chrome/iOS) | `ctx` 首建后常 `suspended`;在 start 手势内 `await ctx.resume()`,失败则提示用户再点一次 |
| `decodeAudioData` 失败 | `load()` reject;UI 显示「音频解码失败」,不允许进入挑战 |
| 重复 `start` | `start()` 幂等:已在 playing 则先 stop 再起 |
| seek 到结尾外 | clamp 到 `[0, durationSec]` |
| 缺 `chart`(纯跟跳) | `chart / judge = null`,跳过音符层,只走连续评分 |
| `version` 不匹配 | 构造时 throw,快速失败 |
| 页面卸载 | `dispose()` → `ctx.close()` 释放资源 |

---

## 7. 与 main.js 的集成点(改造清单 —— 只标位置,不改代码)

| 现有代码 | 变更 |
|---|---|
| `ch.startMs = performance.now()` | 删;改读 `session.songTime` |
| `renderLoop` 里 `t = (performance.now() - startMs) / 1000` | 教练/评分/进度/节拍全换 `session.songTime` |
| `countdown()` 的 `await sleep(800)` | 换 `Scheduler` 绝对时间排程 3/2/1/GO |
| `onFrame` 里 `ch.scorer.judge(t, ...)` | 保留(基底分);新增 `judge.feed(t, frame)` |
| `beatPulse(t)` 的 `floor(t / beat)` | 换 `TimingMap.beatIndexAt(t)`(支持变速) |
| `updateChallengeProgress` 的节拍灯 | 换 `TimingMap` 下拍查询 |
| `finishChallenge()` 触发点 | 由 `engine.onEnded` 驱动,而非 `t >= durationSec` |

---

## 8. 性能与边界

- 单曲全解码一次(`AudioBuffer` ≈ 40MB@4min),不重复 decode。
- 音符可视化用对象池 / `InstancedMesh`,**不**逐 note `new Mesh`(复用 ui-lab 与主页面既有做法)。
- `TimingMap` / `NoteChart` 查询一律二分 O(log n)。
- `PlayerPoseBuffer` 环形数组,固定容量,零 GC 压力。
