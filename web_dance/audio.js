/**
 * audio.js — 音频引擎 + 节拍 + 谱面 + 音符判定(方案冻结稿 v1.0)。
 *
 * 设计见 docs/audio-engine-api.md;数据 schema 见 docs/interface-contract.md §4.1/§4.2。
 *
 * 单一时钟原则:一切音乐逻辑只认 AudioContext.currentTime 派生的 songTime;
 * performance.now() 仅用于渲染帧间隔 dt,不参与音乐逻辑。
 *
 * 除 AudioEngine 外均为纯逻辑,可脱离浏览器 / three.js 直接单测(见 test/audio.test.js)。
 */

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// 升序 number 数组中「最后一个 <= x」的下标;无则 -1(二分)
function lowerBoundIdx(arr, x) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// 升序对象数组(按 .t)中「最后一个 .t <= x」的下标;无则 -1(二分)
function lastEntryWithT(arr, x) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= x) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// ---------------------------------------------------------------------------
// LatencyModel — 延迟建模 + 校准
// ---------------------------------------------------------------------------
export class LatencyModel {
  constructor({ outputLatencySec = 0, inputLatencySec = 0, userOffsetSec = 0 } = {}) {
    this.outputLatencySec = outputLatencySec;
    this.inputLatencySec = inputLatencySec;
    this.userOffsetSec = userOffsetSec;
  }

  get totalOffsetSec() {
    return this.outputLatencySec + this.inputLatencySec + this.userOffsetSec;
  }

  judgeTimeAt(songTime) {
    return songTime + this.totalOffsetSec;
  }

  // 最小二乘:模型 actual = expected + bias,估计 bias = mean(actual - expected)
  autoCalibrate(samples) {
    if (!samples || samples.length === 0) return this.inputLatencySec;
    let sum = 0;
    for (const s of samples) sum += s.actualSec - s.expectedSec;
    const est = sum / samples.length;
    this.inputLatencySec = est;
    return est;
  }
}

// ---------------------------------------------------------------------------
// TimingMap — timing/v1 → 拍栅格 / 下拍 / BPM 查询
// ---------------------------------------------------------------------------
export class TimingMap {
  constructor(timing, durationSec) {
    if (!timing || timing.version !== "timing/v1") {
      throw new Error(`timing version must be "timing/v1", got "${timing?.version}"`);
    }
    this.timing = timing;
    this.durationSec = durationSec;
    this._tempoMap = (timing.tempoMap || []).slice().sort((a, b) => a.t - b.t);
    this._sigs = (timing.timeSignatures || [{ t: 0, num: 4, den: 4 }]).slice().sort((a, b) => a.t - b.t);
    if (!this._tempoMap.length) throw new Error("timing.tempoMap must not be empty");
    if (this._tempoMap[0].t !== 0) throw new Error("timing.tempoMap[0].t must be 0");
    if (this._sigs[0].t !== 0) throw new Error("timing.timeSignatures[0].t must be 0");

    // 拍栅格:B[0]=offsetSec;B[n]=B[n-1]+60/bpmAt(B[n-1]),直到越过 durationSec
    this.beatTimesSec = [];
    let t = timing.offsetSec ?? 0;
    const maxT = durationSec + 1e-9;
    let guard = 0;
    while (t <= maxT && guard++ < 1e6) {
      this.beatTimesSec.push(t);
      t += 60 / this._bpmAt(t);
    }

    // 下拍:i===0;或拍号变化后的第一拍;或距上一个下拍正好 num 拍
    this.downbeatsSec = [];
    let lastDown = -1;
    for (let i = 0; i < this.beatTimesSec.length; i++) {
      const bt = this.beatTimesSec[i];
      const sig = this._sigAt(bt);
      const sigPrev = i > 0 ? this._sigAt(this.beatTimesSec[i - 1]) : sig;
      const isDown =
        i === 0 ||
        sig.num !== sigPrev.num || sig.den !== sigPrev.den ||
        (i - lastDown) === sig.num;
      if (isDown) { this.downbeatsSec.push(bt); lastDown = i; }
    }
  }

  _bpmAt(t) {
    const i = lastEntryWithT(this._tempoMap, t);
    return this._tempoMap[i < 0 ? 0 : i].bpm;
  }

  _sigAt(t) {
    const i = lastEntryWithT(this._sigs, t);
    return this._sigs[i < 0 ? 0 : i];
  }

  bpmAt(t) { return this._bpmAt(t); }

  // 浮点拍号(前奏/弱起可为负)
  beatIndexAt(t) {
    const b = this.beatTimesSec;
    if (!b.length) return 0;
    if (t <= b[0]) {
      const gap = b.length > 1 ? (b[1] - b[0]) : (60 / this._bpmAt(b[0]));
      return (t - b[0]) / gap;
    }
    const i = lowerBoundIdx(b, t);
    if (i >= b.length - 1) return i;
    return i + (t - b[i]) / (b[i + 1] - b[i]);
  }

  nearestBeat(t) {
    const b = this.beatTimesSec;
    if (!b.length) return null;
    const i = lowerBoundIdx(b, t);
    if (i < 0) return { index: 0, time: b[0], deltaSec: t - b[0] };
    if (i >= b.length - 1) return { index: i, time: b[i], deltaSec: t - b[i] };
    const d0 = t - b[i];
    const d1 = b[i + 1] - t;
    return d0 <= d1
      ? { index: i, time: b[i], deltaSec: d0 }
      : { index: i + 1, time: b[i + 1], deltaSec: -d1 };
  }

  nextBeatTime(t) {
    const b = this.beatTimesSec;
    let lo = 0, hi = b.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m] > t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans < 0 ? null : b[ans];
  }

  prevBeatTime(t) {
    const b = this.beatTimesSec;
    let lo = 0, hi = b.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m] < t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? null : b[ans];
  }

  // 0-based 小节号(前奏前可为 -1)
  barIndexAt(t) {
    return lowerBoundIdx(this.downbeatsSec, t);
  }

  isDownbeatTime(t) {
    const i = lowerBoundIdx(this.downbeatsSec, t);
    return i >= 0 && Math.abs(this.downbeatsSec[i] - t) < 1e-6;
  }

  // 拍号的逆(整数或浮点拍号 → 时间)
  timeAtBeat(index) {
    const b = this.beatTimesSec;
    if (!b.length) return 0;
    const i = Math.floor(index);
    const f = index - i;
    if (i >= b.length - 1) return b[b.length - 1] + f * (60 / this._bpmAt(b[b.length - 1]));
    const ci = clamp(i, 0, b.length - 1);
    return b[ci] + f * (b[ci + 1] - b[ci]);
  }
}

// ---------------------------------------------------------------------------
// NoteChart — chart/v1 谱面解析 + 时间窗查询
// ---------------------------------------------------------------------------
export const DEFAULT_WINDOWS_MS = Object.freeze({ perfect: 50, great: 100, good: 150 });

export class NoteChart {
  constructor(chart, durationSec = Infinity) {
    if (!chart || chart.version !== "chart/v1") {
      throw new Error(`chart version must be "chart/v1", got "${chart?.version}"`);
    }
    this.chart = chart;
    this.durationSec = durationSec;
    this.audioOffsetSec = chart.audioOffsetSec ?? 0;   // 音频前导(秒),播放时跳过
    this.judgeOffsetSec = chart.judgeOffsetSec ?? 0;   // 谱面级判定偏移(叠加在全局 latency 上)

    const w = chart.timingWindows || {};
    this.windowsMs = {
      perfect: (w.perfect ?? 0.050) * 1000,
      great: (w.great ?? 0.100) * 1000,
      good: (w.good ?? 0.150) * 1000,
    };

    this.notes = (chart.notes || []).map((n) => ({ ...n }));
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (typeof n.t !== "number") throw new Error("note.t must be a number");
      if (i > 0 && n.t < this.notes[i - 1].t) {
        throw new Error("chart/v1 notes must be sorted ascending by t");
      }
      if (n.type === "hold" && !(n.endT > n.t)) {
        throw new Error("hold note endT must be > t");
      }
      // 越界:警告 + clamp(不破坏排序)
      if (n.t < 0 || n.t > durationSec) {
        console.warn(`chart/v1 note t=${n.t} out of [0, ${durationSec}], clamped`);
        n.t = clamp(n.t, 0, durationSec);
      }
    }
    this.noteCount = this.notes.length;
  }

  // [from, to) 区间内的 note(按 t)
  notesInWindow(from, to) {
    const lo = this._firstIdxAtLeast(from);
    const out = [];
    for (let i = lo; i < this.notes.length && this.notes[i].t < to; i++) out.push(this.notes[i]);
    return out;
  }

  nextNoteAfter(t) {
    const i = this._firstIdxGreater(t);
    return i < 0 ? null : this.notes[i];
  }

  _firstIdxAtLeast(x) {
    let lo = 0, hi = this.notes.length - 1, ans = this.notes.length;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.notes[m].t >= x) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  }

  _firstIdxGreater(x) {
    let lo = 0, hi = this.notes.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.notes[m].t > x) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  }
}

// ---------------------------------------------------------------------------
// PlayerPoseBuffer — 环形帧缓冲(供延迟补偿采样)
// ---------------------------------------------------------------------------
export class PlayerPoseBuffer {
  constructor(capacity = 120, maxAgeSec = 1.0) {
    this.capacity = capacity;
    this.maxAgeSec = maxAgeSec;
    this.buf = new Array(capacity);
    this.head = 0;
    this.count = 0;
  }

  get size() { return this.count; }

  // frame 按 songTime 打点入队;缺省取 frame.t
  push(frame, songTime = frame?.t ?? 0) {
    const idx = (this.head + this.count) % this.capacity;
    this.buf[idx] = { frame, t: songTime };
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity; // 淘汰最旧
  }

  forEach(fn) {
    for (let k = 0; k < this.count; k++) {
      fn(this.buf[(this.head + k) % this.capacity]);
    }
  }

  // [from, to] 闭区间,按时间升序
  framesInRange(from, to) {
    const out = [];
    this.forEach((e) => { if (e.t >= from && e.t <= to) out.push(e); });
    return out;
  }

  // 最近邻(过期帧跳过),返回 frame 本身
  sample(songTime) {
    let best = null;
    let bestD = Infinity;
    this.forEach((e) => {
      if (this.maxAgeSec >= 0 && songTime - e.t > this.maxAgeSec) return;
      const d = Math.abs(songTime - e.t);
      if (d < bestD) { bestD = d; best = e.frame; }
    });
    return best;
  }

  // 最近邻 + 时间差约束;deltaSec = frameTime - songTime(正 = 帧晚于请求时刻)
  sampleNearest(songTime, maxDeltaSec) {
    let best = null;
    let bestD = Infinity;
    this.forEach((e) => {
      if (this.maxAgeSec >= 0 && songTime - e.t > this.maxAgeSec) return;
      const d = Math.abs(songTime - e.t);
      if (d <= maxDeltaSec && d < bestD) {
        bestD = d;
        best = { frame: e.frame, deltaSec: e.t - songTime };
      }
    });
    return best;
  }

  clear() { this.head = 0; this.count = 0; }
}

// ---------------------------------------------------------------------------
// Scheduler — lookahead 绝对时间调度器
// ---------------------------------------------------------------------------
export class Scheduler {
  constructor(clock, { tickIntervalSec = 0.025, lookaheadSec = 0.150 } = {}) {
    if (!clock || typeof clock.songTime !== "number") {
      throw new Error("Scheduler needs a SongClock with numeric songTime");
    }
    this.clock = clock;
    this.tickIntervalSec = tickIntervalSec;
    this.lookaheadSec = lookaheadSec; // v1 保留:核心按「到点」派发
    this._queue = []; // { id, next, every, fn }
    this._nextId = 1;
    this._timer = null;
  }

  get pendingCount() { return this._queue.length; }

  schedule(atSongTime, fn) { return this._add(atSongTime, 0, fn); }

  scheduleEvery(fromSongTime, everySec, fn) {
    if (!(everySec > 0)) throw new Error("scheduleEvery everySec must be > 0");
    return this._add(fromSongTime, everySec, fn);
  }

  _add(next, every, fn) {
    const id = this._nextId++;
    const e = { id, next, every, fn };
    this._insert(e);
    return id;
  }

  _insert(e) {
    let i = 0;
    while (i < this._queue.length && this._queue[i].next <= e.next) i++;
    this._queue.splice(i, 0, e);
  }

  cancel(id) {
    const i = this._queue.findIndex((e) => e.id === id);
    if (i >= 0) this._queue.splice(i, 1);
  }

  start() {
    if (this._timer) return;
    const t = setInterval(() => this._poll(), Math.max(1, this.tickIntervalSec * 1000));
    t.unref?.(); // Node 下不阻止进程退出
    this._timer = t;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._queue.length = 0;
  }

  _poll() { this.tick(this.clock.songTime); }

  // 派发所有 next <= now 的事件;周期事件快进跳过已错过周期(不堆积)
  tick(now) {
    let guard = 0;
    while (this._queue.length && this._queue[0].next <= now + 1e-9 && guard++ < 100000) {
      const e = this._queue.shift();
      if (e.every > 0) {
        const lag = now - e.next;
        const skips = Math.floor(lag / e.every);
        if (skips > 0) e.next += skips * e.every;
        e.fn(e.next);
        e.next += e.every;
        this._insert(e);
      } else {
        e.fn(e.next);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AudioEngine — AudioContext + 解码 + 播放/暂停/seek(单一时钟)
// ---------------------------------------------------------------------------
const LEAD_SEC = 0.05;

export class AudioEngine {
  constructor({ latencyHint = "interactive", durationSec = 0, audioContext = null, onStateChange = null, onEnded = null } = {}) {
    this._latencyHint = latencyHint;
    this._ctx = audioContext;
    this._ctxIsExternal = !!audioContext;
    this._buffer = null;
    this._src = null;
    this._startAt = null;
    this._offsetSec = 0;
    this._pausedAt = null;
    this._durationSec = durationSec;
    this._state = "idle";
    this._loop = false;
    this._audioOffsetSec = 0;
    this.onStateChange = onStateChange;
    this.onEnded = onEnded;
  }

  // 惰性创建:必须发生在用户手势调用栈内
  get ctx() {
    if (!this._ctx) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) throw new Error("AudioContext not available");
      this._ctx = new Ctor({ latencyHint: this._latencyHint });
    }
    return this._ctx;
  }

  get state() { return this._state; }
  get durationSec() { return this._durationSec; }
  setDurationSec(sec) { this._durationSec = sec; }

  // 主时钟:ctx.currentTime - startAt + offsetSec,clamp 到 [0, durationSec]
  get songTime() {
    if (this._startAt == null) return this._pausedAt ?? 0;
    let t = this.ctx.currentTime - this._startAt + this._offsetSec;
    if (this._durationSec > 0) t = clamp(t, 0, this._durationSec);
    return t;
  }

  get outputLatencySec() {
    try { return (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0); }
    catch { return 0; }
  }

  // 循环播放(表演模式用)
  get loop() { return this._loop; }
  set loop(v) { this._loop = !!v; }

  _setState(s) { if (s !== this._state) { this._state = s; this.onStateChange?.(s); } }

  async load(source, audioOffsetSec = 0) {
    this._setState("loading");
    try {
      let arrayBuf;
      if (typeof source === "string") {
        const res = await fetch(source);
        if (!res.ok) throw new Error(`audio fetch failed: ${res.status}`);
        arrayBuf = await res.arrayBuffer();
      } else if (source instanceof ArrayBuffer) {
        arrayBuf = source;
      } else if (ArrayBuffer.isView(source)) {
        arrayBuf = source.buffer;
      } else {
        throw new Error("load(): source must be a URL string or ArrayBuffer");
      }
      this._buffer = await this.ctx.decodeAudioData(arrayBuf);
      this._audioOffsetSec = audioOffsetSec || 0;
      if (this._buffer && this._buffer.duration > 0) {
        this._durationSec = Math.max(0, this._buffer.duration - this._audioOffsetSec);
      }
      this._setState("ready");
    } catch (e) {
      this._setState("idle");
      throw e;
    }
  }

  async play(whenSec) {
    if (this.ctx.state === "suspended") { try { await this.ctx.resume(); } catch { /* noop */ } }
    const when = whenSec ?? this.ctx.currentTime + LEAD_SEC;
    this._startSource(when, this._pausedAt ?? 0);
    this._setState("playing");
  }

  _startSource(when, offsetSec) {
    this._stopSource();
    this._startAt = when;
    this._offsetSec = offsetSec;
    this._pausedAt = null;
    if (this._buffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._buffer;
      src.connect(this.ctx.destination);
      src.loop = this._loop;
      src.onended = () => { if (this._src === src) this._handleEnded(); };
      src.start(when, offsetSec + this._audioOffsetSec);
      this._src = src;
    }
  }

  _stopSource() {
    if (this._src) {
      try { this._src.stop(); } catch { /* noop */ }
      try { this._src.onended = null; } catch { /* noop */ }
      this._src = null;
    }
  }

  _handleEnded() {
    this._src = null;
    this._startAt = null;
    this._setState("ended");
    this.onEnded?.();
  }

  pause() {
    const t = this.songTime;
    this._stopSource();
    this._startAt = null;
    this._pausedAt = t;
    this._setState("paused");
    return t;
  }

  async resume() {
    if (this._pausedAt == null) return this.play();
    await this.play(this.ctx.currentTime);
  }

  async seek(songTimeSec) {
    const t = clamp(songTimeSec, 0, this._durationSec > 0 ? this._durationSec : songTimeSec);
    if (this._state === "playing") {
      this._startSource(this.ctx.currentTime, t);
    } else {
      this._pausedAt = t;
    }
  }

  stop() {
    this._stopSource();
    this._startAt = null;
    this._pausedAt = null;
    this._setState("ready");
  }

  async dispose() {
    this._stopSource();
    if (this._ctx && !this._ctxIsExternal) { try { await this._ctx.close(); } catch { /* noop */ } }
  }
}

// ---------------------------------------------------------------------------
// NoteJudge — 音符事件判定(与 score.js 连续评分正交)
// ---------------------------------------------------------------------------
const PERFECT_ACC = 0.8;
const GREAT_ACC = 0.55;
const DEFAULT_THRESHOLD = 0.55;
const RANK = { MISS: 0, GOOD: 1, GREAT: 2, PERFECT: 3 };
const TIER_MULT = { PERFECT: 1.0, GREAT: 0.8, GOOD: 0.6, MISS: 0 };

function tierFromTiming(deltaSec, windowsMs) {
  const ms = Math.abs(deltaSec) * 1000;
  if (ms <= windowsMs.perfect + 1e-6) return "PERFECT";
  if (ms <= windowsMs.great + 1e-6) return "GREAT";
  if (ms <= windowsMs.good + 1e-6) return "GOOD";
  return "MISS";
}

function tierFromAcc(acc, threshold) {
  if (acc >= PERFECT_ACC) return "PERFECT";
  if (acc >= GREAT_ACC) return "GREAT";
  if (acc >= threshold) return "GOOD";
  return "MISS";
}

function minTier(a, b) { return RANK[a] <= RANK[b] ? a : b; }

export class NoteJudge {
  constructor(chart, similarity, opts = {}) {
    this.similarity = similarity || (() => 0);
    this.latency = opts.latency || new LatencyModel();
    this.refAt = opts.refAt || (() => null);
    this.durationSec = opts.durationSec ?? Infinity;
    this.defaultThreshold = opts.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.onJudgement = opts.onJudgement || null;
    this.buffer = new PlayerPoseBuffer(opts.bufferCapacity ?? 120, opts.bufferMaxAgeSec ?? 1.0);
    this.chart = new NoteChart(chart, this.durationSec);
    this.windowsMs = opts.windowsMs || this.chart.windowsMs;
    this.reset();
  }

  reset() {
    this.combo = 0;
    this._stats = {
      maxCombo: 0,
      notesHit: 0,
      totalNotes: this.chart.noteCount,
      perfect: 0, great: 0, good: 0, miss: 0,
    };
    this._states = new Array(this.chart.noteCount).fill(null).map(() => ({ phase: "pending" }));
    this.buffer.clear();
  }

  feed(songTime, frame) { this.buffer.push(frame, songTime); }

  // 判定时刻 = note.t + judgeOffsetSec + 全局延迟
  _judgeTimeAt(t) {
    return this.latency.judgeTimeAt(t + this.chart.judgeOffsetSec);
  }

  // 每帧(或每 tick)驱动;返回本 tick 新产生的判定(含 hold 进行中)
  tick(songTime) {
    const out = [];
    const goodSec = this.windowsMs.good / 1000;
    for (let i = 0; i < this.chart.notes.length; i++) {
      const note = this.chart.notes[i];
      const st = this._states[i];
      const judgeTime = this._judgeTimeAt(note.t);

      if (note.type === "hold") {
        const minHold = note.minHold ?? note.threshold ?? this.defaultThreshold;
        if (st.phase === "pending" && songTime >= judgeTime + goodSec) {
          const start = this._bestInWindow(note, judgeTime, goodSec);
          const th = note.threshold ?? this.defaultThreshold;
          if (!start || start.acc < th) {
            out.push(this._settle(i, note, { tier: "MISS", acc: start?.acc ?? 0, deltaSec: start?.deltaSec ?? 0 }));
          } else {
            st.phase = "active";
            st.minAcc = start.acc;
            st.startTier = tierFromTiming(start.deltaSec, this.windowsMs);
            st.broke = false;
            out.push(this._makeResult(note, st.startTier, start.acc, start.deltaSec, true));
          }
        } else if (st.phase === "active") {
          const cur = this.buffer.sampleNearest(this._judgeTimeAt(songTime), goodSec);
          if (cur) {
            const acc = this._compare(this.refAt(songTime, note), cur.frame, note);
            if (acc < st.minAcc) st.minAcc = acc;
            if (acc < minHold) st.broke = true;
          } else { st.broke = true; st.minAcc = 0; }
          if (songTime >= this._judgeTimeAt(note.endT) + goodSec) {
            let tier;
            if (st.broke) tier = "GOOD";
            else if (st.minAcc >= PERFECT_ACC) tier = "PERFECT";
            else if (st.minAcc >= GREAT_ACC) tier = "GREAT";
            else tier = "GOOD";
            tier = minTier(st.startTier, tier);
            out.push(this._settle(i, note, { tier, acc: st.minAcc, deltaSec: 0 }));
          } else {
            out.push(this._makeResult(note, tierFromAcc(st.minAcc, minHold), st.minAcc, 0, true));
          }
        }
      } else {
        if (st.phase === "pending" && songTime >= judgeTime + goodSec) {
          const best = this._bestInWindow(note, judgeTime, goodSec);
          const th = note.threshold ?? this.defaultThreshold;
          let r;
          if (!best) {
            r = this._settle(i, note, { tier: "MISS", acc: 0, deltaSec: 0 });
          } else if (best.acc < th) {
            r = this._settle(i, note, { tier: "MISS", acc: best.acc, deltaSec: best.deltaSec });
          } else {
            const tier = minTier(tierFromTiming(best.deltaSec, this.windowsMs), tierFromAcc(best.acc, th));
            r = this._settle(i, note, { tier, acc: best.acc, deltaSec: best.deltaSec });
          }
          out.push(r);
        }
      }
    }
    for (const r of out) this.onJudgement?.(r);
    return out;
  }

  // 在 [judgeTime - w, judgeTime + w] 内找相似度最高的一帧
  _bestInWindow(note, judgeTime, windowSec) {
    const ref = this.refAt(note.t, note);
    if (!ref) return null;
    const frames = this.buffer.framesInRange(judgeTime - windowSec, judgeTime + windowSec);
    let best = null;
    for (const f of frames) {
      const acc = this._compare(ref, f.frame, note);
      if (!best || acc > best.acc + 1e-6 || (Math.abs(acc - best.acc) <= 1e-6 && Math.abs(f.t - judgeTime) < Math.abs(best.deltaSec))) best = { acc, deltaSec: f.t - judgeTime };
    }
    return best;
  }

  _compare(ref, player, note) {
    if (!ref || !player) return 0;
    if (note.bones && note.bones.length) return this._subsetSimilarity(ref, player, note.bones);
    return this.similarity(ref, player, undefined);
  }

  _subsetSimilarity(ref, player, indices) {
    const rb = ref.bones || [];
    const pb = player.bones || [];
    const rc = ref.conf || [];
    const pc = player.conf || [];
    let sum = 0, wsum = 0;
    for (const i of indices) {
      const a = rb[i], b = pb[i];
      if (!a || !b) continue;
      const la = Math.hypot(a[0], a[1], a[2]);
      const lb = Math.hypot(b[0], b[1], b[2]);
      if (la < 1e-6 || lb < 1e-6) continue;
      let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
      dot = clamp(dot, -1, 1);
      const sim = Math.max(0, dot);
      const w = Math.min(rc[i] ?? 1, pc[i] ?? 1);
      sum += sim * w;
      wsum += w;
    }
    return wsum >= indices.length * .5 ? sum / wsum : 0;
  }

  _settle(i, note, { tier, acc, deltaSec }) {
    this._states[i].phase = "settled";
    let score = 0;
    if (tier !== "MISS") {
      this.combo++;
      this._stats.maxCombo = Math.max(this._stats.maxCombo, this.combo);
      this._stats.notesHit++;
      const mult = 1 + Math.min(this.combo, 50) * 0.01;
      score = Math.round(acc * 100 * mult * TIER_MULT[tier]);
    } else {
      this.combo = 0;
    }
    this._stats[tier.toLowerCase()]++;
    return { noteId: note.id, noteType: note.type, tier, acc, deltaSec, combo: this.combo, score };
  }

  _makeResult(note, tier, acc, deltaSec, ongoing) {
    return { noteId: note.id, noteType: note.type, tier, acc, deltaSec, combo: this.combo, score: 0, ongoing };
  }

  finish() {
    // Close all remaining windows, including the final note at song duration.
    this.tick(this.durationSec + this.latency.totalOffsetSec + this.chart.judgeOffsetSec + this.windowsMs.good / 1000 + .001);
    for (let i = 0; i < this._states.length; i++) {
      if (this._states[i].phase !== "settled") {
        const r = this._settle(i, this.chart.notes[i], { tier: "MISS", acc: 0, deltaSec: 0 });
        this.onJudgement?.(r);
      }
    }
  }

  finalize() {
    return { ...this._stats };
  }
}

// ---------------------------------------------------------------------------
// SongSession — 门面,main.js 唯一入口
// ---------------------------------------------------------------------------
export class SongSession {
  constructor({ sequence, similarity, audioContext = null, onJudge = null, onBeat = null, onStateChange = null, latency = null, onSongEnd = null, enableJudge = true, allowSilent = true } = {}) {
    if (!sequence) throw new Error("SongSession needs a sequence");
    this.sequence = sequence;
    this.enableJudge = enableJudge;
    this.allowSilent = allowSilent;
    this.similarity = similarity || (() => 0);
    this.onJudge = onJudge;
    this.onBeat = onBeat;
    this.onSongEnd = onSongEnd;
    this.latency = latency || new LatencyModel();
    this.engine = new AudioEngine({ audioContext, onStateChange, onEnded: () => this._handleEnded() });
    this.timing = null;
    this.chart = null;
    this.judge = null;
    this._ended = false;
    this._lastBeatIdx = null;
  }

  get songTime() { return this.engine.songTime; }
  get judgeTime() { return this.latency.judgeTimeAt(this.engine.songTime); }

  async prepare() {
    const meta = this.sequence.meta || {};
    const durationSec = meta.durationSec || 0;
    this.engine.setDurationSec(durationSec);

    if (meta.timing) this.timing = new TimingMap(meta.timing, durationSec);

    if (this.sequence.chart) {
      this.chart = new NoteChart(this.sequence.chart, durationSec);
      const fps = meta.fps || 30;
      const frames = this.sequence.frames || [];
      const refAt = (t, note) => {
        const idx = note?.refFrameIdx != null ? note.refFrameIdx : Math.round(t * fps);
        return frames[clamp(idx, 0, frames.length - 1)] ?? null;
      };
      if (this.enableJudge) this.judge = new NoteJudge(this.sequence.chart, this.similarity, {
        latency: this.latency,
        refAt,
        durationSec,
        onJudgement: (r) => this.onJudge?.(r),
      });
    }

    const audioPath = this.sequence.chart?.audio || this.sequence.meta?.audio || this.sequence.audio;
    if (audioPath) {
      const audioOffsetSec = this.sequence.chart?.audioOffsetSec ?? 0;
      try {
        await this.engine.load(audioPath, audioOffsetSec);
        if (durationSec > 0) this.engine.setDurationSec(durationSec); // meta 为准
      } catch (e) {
        if (!this.allowSilent) throw new Error("音乐加载失败，请检查网络后重试", { cause: e });
        console.warn("audio load failed, running silent:", e);
      }
    }
  }

  async start(whenSec) {
    const when = whenSec ?? this.engine.ctx.currentTime + LEAD_SEC;
    this._ended = false;
    this._lastBeatIdx = null;
    await this.engine.play(when);
  }

  feed(songTime, frame) { this.judge?.feed(songTime, frame); }

  // 每 rAF 调用一次
  update() {
    const t = this.engine.songTime;

    // 节拍脉冲:最近拍号变化
    if (this.timing) {
      const b = this.timing.nearestBeat(t);
      if (b && b.index !== this._lastBeatIdx) {
        this._lastBeatIdx = b.index;
        this.onBeat?.({ index: b.index, time: b.time, downbeat: this.timing.isDownbeatTime(b.time) });
      }
    }

    this.judge?.tick(t);

    if (!this._ended && this.engine.durationSec > 0 && t >= this.engine.durationSec) {
      this._handleEnded();
    }
  }

  _handleEnded() {
    if (this._ended) return;
    this._ended = true;
    this.onSongEnd?.();
  }

  pause() { return this.engine.pause(); }
  resume() { return this.engine.resume(); }
  seek(t) { return this.engine.seek(t); }
  stop() { this.engine.stop(); }
}
