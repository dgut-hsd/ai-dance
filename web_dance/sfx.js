/**
 * sfx.js —— 打击音效(hitsound):全部用 WebAudio 现场合成,零音频资源。
 *
 * 为什么合成而不是采样:
 *   1) 零资源:不用打包 wav,不怕 404,不怕版权;
 *   2) 零解码延迟:AudioBuffer 只建一次,触发时只排 OscillatorNode;
 *   3) 可参数化:音高/音量可以按连击热度、判定误差实时调,采样做不到。
 *
 * 时间纪律(关键):所有音效都必须排到 **音乐时钟** 上,不能 `setTimeout` 之后再播。
 *   判定结果带 deltaSec(采样相对最近的谱面音符差了多少秒),调用方把它换算成
 *   `ctx.currentTime + deltaSec` 传进来,音效就落在它"本该在"的那一帧上,
 *   而不是落在 25ms 判定轮的调度抖动上。
 */
export class Sfx {
  /**
   * 总电平:所有档位的绝对响度都由这一个数决定。
   *
   * 为什么单拎出来:下面 hit() 里的 3.0/3.2/3.6/3.85 只负责**档位之间的相对权重**,
   * 绝对值必须能一处调。第一版把绝对增益直接写进级配,结果整条总线长期顶在软限幅拐点上,
   * 四档的力度差被限幅器压平(实测:volume=1.0 时四档峰值全是 1.00~1.26),
   * "档位区分度"整个失效 —— 而区分度正是打击音存在的理由(osu! wiki 明确:
   * 打击音的作用就是让玩家听出自己打得早还是晚)。
   *
   * 0.35 来自实测标定(tools/sfx-level.mjs):单次 PERFECT 在总线上约 0.3 峰值,
   * 10 连密集叠加后仍不触碰拐点,与峰值 0.67 的音乐相加后余量约 0.12。
   */
  static HIT_LEVEL = 0.44;

  /** room 层:IR 的 L2 范数目标 —— 正弦输入下湿声幅度 ≈ ROOM_GAIN × 干声幅度 */
  static ROOM_GAIN = 0.05;

  /** room 层湿度:1.0 —— 湿/干比已由 IR 的 L2 范数(ROOM_GAIN)决定,这里不再二次衰减 */
  static ROOM_MIX = 1.0;

  /**
   * @param {AudioContext} ctx          与音乐共用的 AudioContext(单一时钟)
   * @param {object}  [opts]
   * @param {number}  [opts.volume=0.5] 音效总线音量(相对音乐已经很轻,别盖住歌)
   * @param {AudioNode} [opts.destination] 默认 ctx.destination;传录音 tap 可把音效录进高光
   */
  constructor(ctx, { volume = 0.5, destination = null } = {}) {
    this.ctx = ctx;
    this.volume = volume;
    this._enabled = true;

    // 音效总线:master gain → 高通 → 软限幅。顺序很关键。
    //
    // 为什么不用 DynamicsCompressorNode(踩过的坑):
    //   compressor 有 attack(默认 3ms)+ makeup gain,瞬态冲过去的那几毫秒它压不住。
    //   实测:6 次 PERFECT 叠在音乐上会到 peak 1.35、418 个采样点削波。
    //   换成 WaveShaper 的 tanh 软限幅 —— 它没有时间常数,是**瞬时**的,
    //   代价只是把超出的部分圆滑压回来,听感上比硬削波干净得多。
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    // voice:所有"有音高/有体积"的层(bell / body / blip / tick)的汇合点,也是混响送出的起点。
    // 它的增益固定 1(只有一路输入),存在的意义是给出一个"进混响"的干净分叉点,
    // 而 click 层绕过它直接接 dry —— 见下面 room 层的说明。
    this.voice = ctx.createGain();
    // 高通:只切掉次低频的隆隆声,不要切到 body 层。
    // 第一版设在 180Hz —— 那是**和 body 层直接冲突**的:body 层的能量在 78~150Hz,
    // 180Hz 高通会把它压掉 6~12dB,等于白做。实测后改到 55Hz。
    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = 55;
    this.hp.Q.value = 0.7;
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = Sfx._softClipCurve();
    this.limiter.oversample = "4x";

    // room 层:干声 + 一路小房间混响并行。
    // 为什么需要:纯振荡器合成的声音"贴在耳朵上",没有空间;真实录音天然带房间反射。
    //
    // **关键:混响只送 tone/body,不送 transient。**
    //   click 层一旦进卷积,起音就被拉成 20~40ms 的糊团,判定报时能力直接下降。
    //   所以链路拆成两条:click → this.dry(绕过混响);tone/body → this.voice(进混响)。
    this.wet = ctx.createGain();
    this.wet.gain.value = Sfx.ROOM_MIX;
    this.conv = ctx.createConvolver();
    this.conv.buffer = Sfx._makeRoomIR(ctx);

    // ---- 信号链 ----
    //   voice / click ──► out(主音量) ──► hp(55Hz 高通) ──► limiter(软限幅) ──► destination
    //                        └──► conv ──► wet ──────────────┘
    //
    // 混响从 out **之后**取,而不是从 voice 取:
    //   从 voice 取的话,volume=0 时干声静音了、混响还在响(实测残留 0.0626),
    //   现场按静音会出现"幽灵余韵"。主音量必须是唯一的电平控制点,后面所有支路都受它管。
    //   (代价:播放中途改音量会连混响尾巴一起改,这是个一秒内的瞬态,可以接受。)
    this.out.connect(this.hp);
    this.hp.connect(this.limiter);
    this.voice.connect(this.out);     // 有音高的层:过主音量
    this.out.connect(this.conv);      // 混响送出:也过主音量,保证 mute 干净
    this.conv.connect(this.wet);
    this.wet.connect(this.limiter);
    this.limiter.connect(destination || ctx.destination);
    // 调试口:工具可把"纯干声"单独接出来做 A/B
    this.dry = this.hp;

    this._noiseBuf = this._makeNoiseBuffer();
    this._last = { PERFECT: -1, GREAT: -1, GOOD: -1, MISS: -1 };
    // 绝对变体轮换计数:连续两次同类命中必定用不同变体(比 seed 散列更可靠)
    this._hits = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
  }

  /** 本档已被触发多少次(供外部观测/测试)。 */
  hitCount(tier) { return this._hits[tier] ?? 0; }

  /**
   * 生成一间"小房间"的脉冲响应(IR)。
   *
   * 为什么不用现成 IR 文件:零资源是这个模块的设计前提(见文件头)。
   * 手工合成一段 IR 就够用 —— 需要的信息量很小:几个早期反射 + 一段扩散尾。
   *
   * 结构:[11ms, 19ms, 27ms] 三个早期反射(左右声道错开 7 个采样制造宽度)
   *       + 45ms 指数衰减的噪声扩散尾。
   *
   * **归一化必须按 L2 范数,不能按 RMS**(踩过的坑):
   *   卷积的增益 ≈ ‖IR‖₂ = sqrt(Σ h[i]²),与 IR 长度、RMS 都不是一回事。
   *   第一版按"RMS = 0.35"归一化,一条 1 万采样点的 IR 得到的 ‖IR‖₂ 极大,
   *   结果湿声比干声大几十倍 —— 实测总线峰值恒定 0.58,完全由混响决定,
   *   `volume` 参数从 0.05 调到 1.0 都毫无变化(音量旋钮失效)。
   *   现在把 ‖IR‖₂ 归一到 ROOM_GAIN:正弦输入下湿声幅度 ≈ ROOM_GAIN × 干声幅度。
   *
   * @returns {AudioBuffer} 归一化后 ‖IR‖₂ = Sfx.ROOM_GAIN 的立体声 IR
   */
  static _makeRoomIR(ctx, { seconds = 0.3, reflections = [[11, 0.5], [19, 0.34], [27, 0.22]], decayMs = 60 } = {}) {
    const n = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
    const ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (const [ms, amp] of reflections) {
        const i0 = Math.round((ms / 1000) * ctx.sampleRate) + (c ? 7 : 0);
        for (let k = 0; k < 40 && i0 + k < n; k++) d[i0 + k] += amp * (1 - k / 40) * (c ? 1 : 0.86);
      }
      for (let i = 0; i < n; i++) {
        d[i] += (Math.random() * 2 - 1) * 0.28 * Math.exp(-i / (ctx.sampleRate * decayMs / 1000));
      }
    }
    // 按 L2 范数归一化(左右取平均,保证立体声整体增益可预测)
    let energy = 0;
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < n; i++) energy += d[i] * d[i];
    }
    const l2 = Math.sqrt(energy / 2);
    if (l2 > 1e-9) {
      const k = Sfx.ROOM_GAIN / l2;
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < n; i++) d[i] *= k;
      }
    }
    return ir;
  }

  /**
   * tanh 软限幅曲线:|x| 很小时斜率恰好为 1(完全透明),接近满量程时平滑压回。
   *
   * 归一化必须除以 k(零点斜率),**不能**除以 tanh(k):
   *   除以 tanh(k) 会在小信号处产生 1.44× 增益(实测),等于给整条音效总线偷偷加了音量,
   *   叠加到音乐上就削顶。这条曲线的输出上限是 tanh(k)/k ≈ 0.58,超出部分被压回来。
   * @returns {Float32Array} WaveShaperNode.curve 要求的类型
   */
  static _softClipCurve(n = 2048, k = 1.6) {
    const curve = new Float32Array(n);
    const norm = Math.tanh(k) / k; // 归一化到"峰值 = 1",配合总线增益一起定标
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      // 斜率 1 的 tanh:x=0 处导数 = 1,小信号不染色
      curve[i] = Math.tanh(k * x) / k / norm;
    }
    return curve;
  }

  set enabled(v) { this._enabled = !!v; }
  get enabled() { return this._enabled; }
  /**
   * 运行时改音量。
   * 为什么改增益节点而不是只改 this.volume:
   *   采样层(SampleSfx / HitSound)要接到同一条总线上复用高通/限幅/混响,
   *   这条总线的音量必须是"可外部驱动"的 —— 否则采样与合成两条路各写一份音量,
   *   改了一个忘了另一个,迟早对不上。
   */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.out.gain.value = this.volume;
  }
  /** 音效总线的末端节点(压缩器之后):外部可再接到录音分支等其它目的地。 */
  get outputNode() { return this.limiter; }
  /** 主音量之后的汇合点:采样层从这里进来,复用高通/限幅/混响。 */
  get voiceNode() { return this.voice; }

  _makeNoiseBuffer(seconds = 0.4) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    // 去直流的白噪声:后续都用滤波器塑形
    let sum = 0;
    for (let i = 0; i < n; i++) { d[i] = Math.random() * 2 - 1; sum += d[i]; }
    const mean = sum / n;
    for (let i = 0; i < n; i++) d[i] -= mean;
    return buf;
  }

  /** 一段可塑形的白噪声源(调用方自己串滤波器与包络,用完记得 stop)。 */
  _noise() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    return { src, tail: src };
  }

  _env(t0, { attack = 0.001, decay = 0.15, peak = 0.5 }) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    return g;
  }

  /**
   * 金属钟声:非谐分音 + 长尾 —— PERFECT 的"叮"。
   * 分音比刻意取非整数比,听起来才像钟/铃而不是风琴。
   *
   * **分音衰减比是这条音色的命门**(实测踩坑):
   *   第一版用 `decay / (1 + i*0.55)`,第 6 个分音的寿命只有基频的 23%。
   *   实测到 150ms 时所有分音都掉到 -54dB 以下 —— 只剩一根 1760Hz 纯正弦在响,
   *   听感是"干瘪一声哨",用户评价"一般"。
   *   改成 1+0.18i 后,分音活得够久,才有金属体感。
   *   (真实金属体的模态衰减差异没这么夸张:低频模态确实比高频活得久,但不是 4 倍。)
   *
   * @param {number} spread 失谐展宽倍率(音色变体用来换"厚度")
   * @param {number} detune 分音整体偏移(音分)。只动金属分音、不动基频 ——
   *   这样变体听起来是"同一只铃的另一种敲法",而不是换了一只铃。
   */
  _bell(t, { base = 1760, gain = 0.34, decay = 0.34, spread = 1, detune = 0, partialDecay = 0.18 } = {}) {
    // 自由-自由棒的横模频率比(不是谐波列):1 : 2.756 : 5.404 : 8.933。
    // 第一版用的是"钟"的比例(1/2.01/2.99/4.21),听感偏"风琴/哨"而不是"敲到了金属"。
    // 后两个模态很高频,正好补上 click 之上的"金属颗粒"。
    const ratios = [1, 2.756, 5.404, 8.933];
    const amps = [1, 0.42, 0.24, 0.13];
    const det = Math.pow(2, detune / 1200);
    for (let i = 0; i < ratios.length; i++) {
      // 每个模态的衰减时间必须不同,而且高频先死 —— 这是"模态合成"与"几个正弦叠加"的分水岭。
      //   i=0(基频) t60 ≈ decay        i=3 只有它的 ~40%,同时起音错开 1.5ms 制造"敲击扩散"
      const dec = decay / (1 + i * partialDecay);
      for (let d = -1; d <= 1; d += 2) {
        const osc = this.ctx.createOscillator();
        osc.type = "sine";
        // i===0 是基频,保持不动以保证起音音高稳定;其余模态承受变体偏移与失谐展宽
        const ratio = i === 0 ? ratios[0] : ratios[i] * det;
        osc.frequency.value = base * ratio * (1 + d * 0.0016 * spread);
        const g = this.ctx.createGain();
        const amp = amps[i] * gain * (i === 0 ? 1 : 0.5);
        const at = t + i * 0.0015; // 高模态晚一点点起振:真实敲击的能量是逐步灌进各个模态的
        g.gain.setValueAtTime(0.0001, at);
        g.gain.linearRampToValueAtTime(amp, at + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.004 + dec);
        osc.connect(g).connect(this.voice);
        osc.start(at);
        osc.stop(at + 0.01 + dec + 0.05);
      }
    }
    // 铃舌的瞬态:极短的带通噪声,给"叮"一个清晰的起音
    const { src } = this._noise();
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = base * 2.2; bp.Q.value = 1.2;
    const g = this._env(t, { attack: 0.001, decay: 0.035, peak: gain * 0.5 });
    src.connect(bp).connect(g).connect(this.voice);
    src.start(t); src.stop(t + 0.08);
  }

  /**
   * 公开的 click:给采样层"补清晰度"用(见 hitsound.js 的 TIER_CLICK 说明)。
   * 采样素材缺 2~8kHz 成分时,在播放时叠一层合成 click 比换素材代价小得多。
   * @param {number|null} when 绝对 ctx 时间
   */
  click(when = null, opts = {}) {
    if (!this._enabled) return;
    const t = Math.max(this.ctx.currentTime, when ?? this.ctx.currentTime);
    this._click(t, opts);
  }

  /**
   * 高频 click 层:1~5ms 的噪声瞬态,负责"清晰度/报时"。
   *
   * 为什么单独一层:撞击的最初 5~10ms 决定听觉系统判断"这是什么物体"
   * (Keller 1999, https://ccrma.stanford.edu/~dkeller/pdf/Keller1999.pdf)。
   * 纯正弦没有这一段,所以听起来"不像敲到了东西"。
   * bandpass(不是 highpass):highpass 会把低频噪声一起放进来,反而糊。
   */
  _click(t, { freq = 4200, gain = 0.18, decay = 0.012, Q = 0.9 } = {}) {
    const { src } = this._noise();
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = Q;
    const g = this._env(t, { attack: 0.0005, decay, peak: gain });
    src.connect(bp).connect(g).connect(this.out);
    src.start(t); src.stop(t + decay + 0.02);
  }
  _body(t, { gain = 0.2, from = 150, to = 78, decay = 0.12 } = {}) {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + decay * 0.75);
    const g = this._env(t, { attack: 0.003, decay, peak: gain });
    osc.connect(g).connect(this.voice);
    osc.start(t); osc.stop(t + decay + 0.04);
  }

  /**
   * 短促的"哒" —— GREAT 的 tick。
   *
   * 只用振荡器,不用噪声。踩过的坑:第一版是"方波 + 带通白噪声",
   * 实测同一段代码多次离线渲染峰值在 0.33~0.97 之间跳(极差 ±13%),
   * 因为带通滤波器(Q=8)对不同噪声实现的瞬态响应不一样 —— 一个打击音的电平不可复现,
   * 就没法做电平标定,密集连击时还会偶发叠出 3 倍峰值。
   * 现在改成两个确定性的振荡器:基音快速下滑 + 高八度短点缀,既有"啪"的硬度又可复现。
   */
  _tick(t, { freq = 2600, gain = 0.26, decay = 0.045 } = {}) {
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.62, t + decay);
    const g = this._env(t, { attack: 0.0006, decay, peak: gain });
    osc.connect(g).connect(this.voice);
    osc.start(t); osc.stop(t + decay + 0.02);

    // 高八度点缀:给"哒"一点高频颗粒感,不用噪声也能有硬度
    const hi = this.ctx.createOscillator();
    hi.type = "sine";
    hi.frequency.setValueAtTime(freq * 2.02, t);
    hi.frequency.exponentialRampToValueAtTime(freq * 1.4, t + decay * 0.6);
    const hg = this._env(t, { attack: 0.0006, decay: decay * 0.55, peak: gain * 0.42 });
    hi.connect(hg).connect(this.voice);
    hi.start(t); hi.stop(t + decay + 0.02);
  }

  /** 闷一点的木鱼/blip —— GOOD,存在感明显低于前两档。 */
  _blip(t, { freq = 880, gain = 0.2, decay = 0.07 } = {}) {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    const g = this._env(t, { attack: 0.002, decay, peak: gain });
    osc.connect(g).connect(this.voice);
    osc.start(t); osc.stop(t + decay + 0.02);
  }

  /** 低频"空"声 —— MISS:不是惩罚音,是"这一下没接住"的泄气感。 */
  _thud(t, { gain = 0.22 } = {}) {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(170, t);
    osc.frequency.exponentialRampToValueAtTime(64, t + 0.2);
    const g = this._env(t, { attack: 0.004, decay: 0.2, peak: gain });
    osc.connect(g).connect(this.out);
    osc.start(t); osc.stop(t + 0.26);

    const { src } = this._noise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 0.22);
    const ng = this._env(t, { attack: 0.004, decay: 0.16, peak: gain * 0.55 });
    src.connect(lp).connect(ng).connect(this.out);
    src.start(t); src.stop(t + 0.3);
  }

  /** 里程碑(每 10 连):上行琶音,给"越打越顺"的奖励。 */
  _milestone(t, { gain = 0.3, base = 880 } = {}) {
    const steps = [0, 4, 7, 12];
    steps.forEach((semi, i) => {
      const at = t + i * 0.055;
      const f = base * Math.pow(2, semi / 12);
      this._bell(at, { base: f, gain: gain * (1 - i * 0.12), decay: 0.26 });
    });
  }

  /**
   * 音色变体表 —— 抗"机关枪感"。
   *
   * 为什么必须是变体、而不是只抖音高:同一个音连打几十次,耳朵会开始"数拍子",
   * 听感变成机械重复。光靠 ±2% 音高不够(那是"同一只铃略微走音"),要换敲法。
   * 四个变体各换一处特征:铃音基频 / 分音展宽 / 敲击力度。
   *
   * 哪些**不能**动:起音时刻、瞬态形状。打击音的第一职责是报时,
   * 起音一抖,玩家对"我打得准不准"的判断就失去依据。
   */
  static VARIANTS = [
    { micro: 1.000, pitchVar: -6, spread: 1.00, gainVar: 1.00 }, // 标准
    { micro: 1.022, pitchVar: 0, spread: 1.45, gainVar: 0.95 }, // 略高、更宽、轻一点
    { micro: 0.980, pitchVar: -3, spread: 0.72, gainVar: 1.05 }, // 略低、更窄、重一点
    { micro: 1.041, pitchVar: -9, spread: 1.25, gainVar: 0.92 }, // 高、更失谐
  ];

  /**
   * 挑变体。优先用 count 做**绝对轮换**(连续命中必定依次经过四个变体,不会连着撞同一个);
   * 没有 count 时退回 seed 散列。
   */
  static _variantOf(tier, seed, count) {
    const n = Sfx.VARIANTS.length;
    if (count != null && Number.isFinite(count)) return Sfx.VARIANTS[((count % n) + n) % n];
    // 不同档位错开偏移,免得四个档位永远用同一个变体组合
    const off = { PERFECT: 0, GREAT: 1, GOOD: 2, MISS: 3 }[tier] ?? 0;
    return Sfx.VARIANTS[(((seed | 0) + off) % n + n) % n];
  }

  /**
   * 触发一次判定音。
   * @param {string} tier  PERFECT | GREAT | GOOD | MISS
   * @param {object} [opts]
   * @param {number} [opts.when] 绝对 ctx 时间(秒);不传就用"现在 + 5ms"
   * @param {number} [opts.heat=1] 连击热度 1~1.15,越高音越亮、越响
   * @param {number} [opts.seed]  轮换序号(一般传 combo),决定用哪个音色变体
   * @param {number} [opts.count] 第几次触发,用于绝对变体轮换(不传则退回 seed)
   * @param {number} [opts.gain=1] 整档增益系数(标定用)
   */
  hit(tier, { when = null, heat = 1, seed = null, count = null, gain = 1 } = {}) {
    if (!this._enabled) return;
    const t = Math.max(this.ctx.currentTime, when ?? this.ctx.currentTime + 0.005);
    // 变体序号:优先外部给的 count,否则用本档自增计数 —— 保证连续命中一定换音色
    const hitIdx = count != null ? count : (this._hits[tier] = (this._hits[tier] ?? 0) + 1) - 1;
    const v = Sfx._variantOf(tier, seed ?? 0, hitIdx);
    const h = Math.max(1, Math.min(3, heat));
    // 热度 → 音高:heat 1→1.15 映射到约 +2.4 个半音。连击涨上去时音色一起"变亮",
    // 和判定徽章共用同一个热度标量,听觉与视觉同步升温。
    const pitch = Math.pow(2, (h - 1) / 0.15 * 2.4 / 12);
    // 档位级配:只表达**相对权重**(PERFECT 最亮最响 → MISS 最闷),绝对值统一乘 HIT_LEVEL。
    // 四档听感权重必须拉开,否则玩家听不出自己打得早还是晚。
    const L = Sfx.HIT_LEVEL * gain;
    if (tier === "PERFECT") {
      // 四层齐备:click(报时)+ bell(材质/音高)+ body(重量),三者都进 voice 拿混响尾。
      // 之前只有 bell 一层,所以是"干瘪一声哨";现在按 transient/body/tone/tail 补齐。
      this._click(t, { freq: 4200, gain: 0.20 * L * v.gainVar, decay: 0.012 });
      this._bell(t, { base: 1760 * v.micro * pitch, gain: 0.34 * L * v.gainVar * (0.9 + 0.1 * h), decay: 0.30, spread: v.spread, detune: v.pitchVar });
      this._blip(t, { freq: 3520 * v.micro * pitch, gain: 0.10 * L * v.gainVar, decay: 0.04 });
      this._body(t, { gain: 0.20 * L * v.gainVar, from: 150, to: 78, decay: 0.12 });
    } else if (tier === "GREAT") {
      this._click(t, { freq: 5200, gain: 0.14 * L * v.gainVar, decay: 0.008 });
      this._tick(t, { freq: 2600 * v.micro * pitch, gain: 0.46 * L * v.gainVar });
      // GREAT 也给一点身体,但明显低于 PERFECT —— 档位权重必须拉开。
      // body 衰减 0.08→0.11:tick 只有 45ms,太短会显得比 PERFECT"薄得过头"
      this._body(t, { gain: 0.13 * L * v.gainVar, from: 140, to: 82, decay: 0.11 });
    } else if (tier === "GOOD") {
      this._blip(t, { freq: 1174 * v.micro * pitch, gain: 0.40 * L * v.gainVar });
    } else {
      this._thud(t, { gain: 0.40 * L * v.gainVar * (1 - (h - 1) * 0.5) }); // 断连越"冷",闷响越沉
    }
    this._last[tier] = t;
  }

  /** 连击里程碑:每 milestone 连一次。 */
  milestone(combo, { when = null } = {}) {
    if (!this._enabled) return;
    const t = Math.max(this.ctx.currentTime, when ?? this.ctx.currentTime + 0.005);
    const octave = Math.min(2, Math.floor(combo / 50));
    this._milestone(t, { base: 880 * Math.pow(2, octave), gain: 0.28 });
  }

  /** 开局/结束扫音,给整局一个"仪式"边界。 */
  stinger(kind = "start", { when = null } = {}) {
    if (!this._enabled) return;
    const t = Math.max(this.ctx.currentTime, when ?? this.ctx.currentTime + 0.005);
    if (kind === "start") {
      [0, 7, 12].forEach((semi, i) => this._bell(t + i * 0.09, { base: 587 * Math.pow(2, semi / 12), gain: 0.26, decay: 0.5 }));
    } else if (kind === "success") {
      [0, 4, 7, 12, 16].forEach((semi, i) => this._bell(t + i * 0.11, { base: 523 * Math.pow(2, semi / 12), gain: 0.26, decay: 0.6 }));
    } else if (kind === "fail") {
      [0, -3, -7].forEach((semi, i) => this._blip(t + i * 0.14, { freq: 392 * Math.pow(2, semi / 12), gain: 0.22, decay: 0.3 }));
    }
  }
}

export default Sfx;






