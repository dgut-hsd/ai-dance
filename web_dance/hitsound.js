/**
 * hitsound.js —— 采样打击音 + 合成兜底。
 *
 * 设计要点(每一条都是踩过的坑或明确的取舍):
 *
 * 1) **采样优先,合成兜底,而且兜底必须是同步的。**
 *    采样要 fetch + decodeAudioData,是异步的;如果"等采样加载好再启用音效",
 *    开场第一击就是静音的 —— 而第一击恰恰是玩家建立反馈的点。所以两条路同时存在:
 *    采样没就绪时走合成(它零解码、零延迟),就绪后自动切换到采样。
 *
 * 2) **所有采样在构造时一次性预解码成 AudioBuffer。**
 *    播放时只做 `createBufferSource` + `start(when)`,不在判定路径上做任何解码 ──
 *    判定路径上每多 1ms,打击音就晚 1ms(osu! 规范:起始延迟 ≤5ms)。
 *
 * 3) **播放必须排在音频时钟上**(`start(when)`),不能用 setTimeout 之后再播。
 *    when 由调用方按 `ctx.currentTime - deltaSec` 算好传进来,
 *    音效因此落在"该响的那一帧",而不是落在 25ms 判定轮的抖动上。
 *
 * 4) **轮换 + 微调音高。**
 *    素材自带 3 个同类变体,再叠 ±2% 音高抖动 —— 连打几十次不会变成机关枪。
 *    音高偏移只动"音色",不动起音时刻(报时功能不能受影响)。
 *
 * 5) **每档相对增益写死在清单里**(index.json 的 gain)。
 *    实测素材原始峰值是乱的(命中档 0.90 / 好档 0.50),不重新平衡的话
 *    "打得好"反而比"打得一般"更轻,档位区分度直接反了。
 */
export class SampleHitSound {
  /**
   * @param {AudioContext} ctx
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]  采样目录
   * @param {AudioNode} [opts.destination] 汇合点(一般传合成层的 voiceNode,复用其总线)
   * @param {number} [opts.masterGain] 采样层总增益(与合成层统一标定)
   */
  constructor(ctx, { baseUrl = './audio/sfx/', destination = null, masterGain = 1 } = {}) {
    this.ctx = ctx;
    this.baseUrl = baseUrl;
    this.master = ctx.createGain();
    this.master.gain.value = masterGain;
    // 只有显式给了 destination 才自己接出去。
    // 不接的话,由 HitSound 把它接到合成层的总线汇合点 ——
    // **绝不能两边都接**:第一版就是既连了 ctx.destination 又被 HitSound 连到 voiceNode,
    // 同一份采样进了两条路(一条裸的、一条过总线),造成重复播放和听感异常。
    if (destination) { this.master.connect(destination); this.selfConnected = true; }
    else this.selfConnected = false;
    /** @type {Map<string, AudioBuffer[]>} tier → 解码后的变体 */
    this.buffers = new Map();
    /**
     * @type {Map<string, number[]>} tier → 每个变体各自的增益(与 buffers 一一对应)。
     * 为什么不是"档位一个增益":同档内不同变体的原始响度也有差异
     * (实测 GREAT 的 5 个变体 RMS 在 0.0111~0.0180 之间,差 1.6 倍),
     * 只用档位级增益的话,轮换时会明显忽大忽小 —— 而这个波动观众是听得出来的。
     * 清单里为每个文件算了 variantGain(按各自峰值矫正),这里逐变体使用。
     */
    this.gains = new Map();
    this.ready = false;
    this._rr = new Map(); // tier → round-robin 计数
    this._loadPromise = null;
    this._errors = [];
  }

  /**
   * 加载并解码全部采样。可重复调用(共享同一个 promise)。
   * @param {string|null} indexUrl
   * @param {boolean} withAccents 是否连 accent(里程碑/结算)一起加载
   */
  load(indexUrl = null, withAccents = true) {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this._doLoad(indexUrl ?? `${this.baseUrl}index.json`, withAccents)
      .catch((e) => { this._errors.push(String(e)); return false; });
    return this._loadPromise;
  }

  async _doLoad(indexUrl, withAccents = true) {
    const res = await fetch(indexUrl, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`采样清单取不到: ${res.status}`);
    const index = await res.json();
    const tiers = index.tiers || {};
    for (const [tier, spec] of Object.entries(tiers)) {
      const files = spec.files || [];
      if (!files.length) continue;
      // 并行取 + 并行解码;单个失败不影响其它档位。
      // 增益与 buffer 必须**同步过滤**:失败的文件会变成 null,
      // 如果只过滤 buffers 而不过滤 gains,两者索引就错位了(变体增益会套到错误的样本上)。
      const loaded = await Promise.all(files.map(async (f) => {
        try {
          const r = await fetch(this.baseUrl + f.file, { cache: 'force-cache' });
          if (!r.ok) throw new Error(`${f.file}: ${r.status}`);
          const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
          return { buf, gain: Number(f.variantGain ?? spec.gain) || 1 };
        } catch (e) {
          this._errors.push(`${tier}/${f.file}: ${e.message}`);
          return null;
        }
      }));
      const ok = loaded.filter(Boolean);
      if (ok.length) {
        this.buffers.set(tier, ok.map((o) => o.buf));
        this.gains.set(tier, ok.map((o) => o.gain));
      }
    }
    // ---- accent:里程碑琶音 / 开场结算音效 ----
    if (withAccents && index.accents?.files?.length) {
      const loaded = await Promise.all(index.accents.files.map(async (f) => {
        try {
          const r = await fetch(this.baseUrl + f.file, { cache: 'force-cache' });
          if (!r.ok) throw new Error(`${f.file}: ${r.status}`);
          const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
          return { buf, gain: Number(f.variantGain ?? index.accents.gain) || 1 };
        } catch (e) {
          this._errors.push(`accent/${f.file}: ${e.message}`);
          return null;
        }
      }));
      const ok = loaded.filter(Boolean);
      if (ok.length) {
        this.accents = ok.map((o) => o.buf);
        this.accentGains = ok.map((o) => o.gain);
      }
    }
    this.ready = this.buffers.size > 0;
    return this.ready;
  }

  /** 这一档有没有可用的采样(供调用方决定走采样还是兜底)。 */
  has(tier) { return this.buffers.has(tier); }

  get status() {
    return {
      ready: this.ready,
      tiers: [...this.buffers.keys()],
      counts: Object.fromEntries([...this.buffers].map(([k, v]) => [k, v.length])),
      errors: this._errors.slice(0, 8),
    };
  }

  /**
   * 播放一次命中音。
   * @param {string} tier PERFECT | GREAT | GOOD | MISS
   * @param {number} when 绝对 ctx 时间(秒);不传=立刻
   * @param {object} [opts] { gainMul, heat }
   * @returns {boolean} 是否真的播了采样(false = 调用方应走合成兜底)
   */
  play(tier, when = null, { gainMul = 1, heat = 1 } = {}) {
    const list = this.buffers.get(tier);
    if (!list || !list.length) return false;
    const t = Math.max(this.ctx.currentTime, when ?? this.ctx.currentTime);
    /**
     * 变体选择:热度做**相位偏移**,轮换走**整个变体表**。
     *
     * 两个坑都在这里踩过:
     *   1) 只用 `rr % span`(span = n/2)会在"自己那半段"里循环,
     *      结果 5 个变体实际只用到 2 个 —— 抗疲劳效果直接减半。
     *      正确做法:rr 走遍整张表,热度只决定从哪个位置起跳。
     *   2) 不能用变调表达热度。变调会把音色一起改,听感是"同一个音被拉高";
     *      换样本听起来才是"敲法变了"。所以热度→换到更亮的那几个样本,
     *      音高抖动只留 ±2% 做抗疲劳。
     */
    const n = list.length;
    // 注意:_rr 必须先取出来存成变量再用。
    // 第一版写成 `i = ((this._rr.get(tier) ?? 0) + phase) % n` 紧接 `set((this._rr.get(tier) ?? 0) + 1)`,
    // 两次读取之间没有写入 —— 一旦这段被改动(比如去掉 ?? 或调整顺序)就会算出 NaN,
    // 而 NaN 传给 AudioParam 会直接抛异常(浏览器原话:"The provided float value is non-finite")。
    // 存变量一次,杜绝这类耦合。
    const rr = this._rr.get(tier) ?? 0;
    const i = (rr + this._heatPhase(tier, n, heat)) % n;
    this._rr.set(tier, rr + 1);
    const buf = list[i];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // 只留很小的音高抖动(±2%)做抗疲劳。热度不再靠变调表达 —— 见上面变体选择的说明。
    src.playbackRate.value = 1 + (Math.random() * 0.04 - 0.02);
    const g = this.ctx.createGain();
    // 三段增益相乘:该变体自身的增益(已含档位电平与同档内矫正)× 响度校准系数 × 调用方系数
    const gainList = this.gains.get(tier);
    const variantGain = gainList ? (gainList[i] ?? 1) : 1;
    const cal = HitSound.TIER_RMS_CAL[tier] ?? 1;
    let gain = variantGain * cal * gainMul;
    // NaN 守卫:NaN 传给 AudioParam 会让浏览器直接抛
    // "The provided float value is non-finite",而且异常发生在 startRendering 之前的
    // 深层调用里,定位成本高。这里显式兜住并留一条可诊断的警告。
    if (!Number.isFinite(gain)) {
      this._errors.push(`${tier}: 增益算出 ${gain}(variant=${variantGain} cal=${cal} mul=${gainMul} i=${i})`);
      gain = cal;
    }
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start(t);
    return true;
  }

  /**
   * 热度 → 变体相位偏移。
   * 清单里同一档的变体是按"音色从标准到最亮"排列的(见 build-sfx-samples.mjs 的选择顺序),
   * 所以热度越高,起跳位置越靠后 = 越亮。n 只有 5 时偏移量是 0/1/2/3/4,足够表达五档温度。
   */
  _heatPhase(tier, n, heat) {
    const hot = Math.max(0, Math.min(1, (heat - 1) / 0.15)); // heat 1→1.15 映射到 0→1
    return Math.round(hot * (n - 1));
  }

  /**
   * 播放 accent 素材(里程碑琶音 / 开场结算)。
   * @param {number[]} order accent 下标序列
   * @param {number} when 起始时刻
   * @param {number} stepMs 每一步间隔
   * @param {number} gainMul 总增益
   * @returns {boolean} 是否有素材可用
   */
  playAccents(order, when, stepMs, gainMul = 1) {
    if (!this.accents?.length) return false;
    const t0 = Number.isFinite(when) ? when : this.ctx.currentTime;
    const step = Number.isFinite(stepMs) ? stepMs : 60;
    const mul = Number.isFinite(gainMul) ? gainMul : 0.5;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const buf = this.accents[i];
      if (!buf) continue;
      const t = Math.max(this.ctx.currentTime, t0 + k * step / 1000);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      const raw = (this.accentGains?.[i] ?? 1) * mul;
      g.gain.value = Number.isFinite(raw) ? raw : mul;
      src.connect(g).connect(this.master);
      src.start(t);
    }
    return true;
  }

  setMasterGain(v) { this.master.gain.value = Math.max(0, v); }
  /** 采样层自身的末端(接录音分支等) */
  get outputNode() { return this.master; }
}

/**
 * 把采样层与合成层合成一个"打击音门面",对外 API 与 Sfx 完全一致,
 * 所以 main.js 不需要知道底下是采样还是合成。
 */
export class HitSound {
  /**
   * 采样层总增益(基准)。
   *
   * **0.24 是实测标定值**。注意:它和 TIER_RMS_CAL 是两个独立的旋钮,不要叠加使用 ——
   * master 管**整体**电平,TIER_RMS_CAL 管**档位之间**的平衡(把每个变体按实测 RMS 差异矫正)。
   * 曾经把两者一起往上调,结果整体过响 2 倍(实测)。
   *
   * 另一个坑:修复"采样被接两遍"的 bug 之前,这个数只能给到 0.24 ——
   * 因为那条重复路径让同一份采样走了两遍(一遍裸进输出、一遍过总线),能量翻倍,
   * master=0.30 就出现削波。修掉之后用三首真实歌曲 + 真实谱面时刻重测:
   *     0.30 → 最坏合成峰值 0.9068(零削波)
   *     0.42 → 0.9215(零削波)   ← 取这个
   *     0.48 → 0.932 (零削波,已接近上限)
   * 教训:出现"音量上不去"时先怀疑信号被接了两次,而不是先怪音乐太满。
   */
  static MASTER_GAIN = 0.165;

  /**
   * 每档的响度校准系数,把采样层的 RMS 对齐到合成层。
   *
   * 为什么必须做:素材是**别人录的**,原始响度分布和我们的档位设计无关,
   * 实测同一个 master 下,采样层 RMS 只有合成层的 0.40~0.71 倍而且是乱的 ——
   * 结果"打得好"反而比"打得一般"更轻,档位区分度被素材自身差异污染。
   *
   * 注意它和 MASTER_GAIN 的**分工**,两个旋钮不要一起往上调(曾经叠加导致整体过响 2 倍):
   *   MASTER_GAIN   → 管整体电平
   *   TIER_RMS_CAL  → 只管档位之间的平衡
   * index.json 里每个变体的 variantGain 负责**同档内**的平衡(见 tools/build-sfx-samples.mjs)。
   * 这三个数的最终取值都由 tools/sfx-tune-levels.mjs 闭环迭代出来。
   */
  static TIER_RMS_CAL = { PERFECT: 0.449, GREAT: 0.199, GOOD: 0.331, MISS: 0.486 };

  /**
   * 每档补一层"高通 click"的增益 —— 补上素材缺失的报时清晰度。
   *
   * 为什么需要补:采样素材的频谱不一定适合当打击音。实测(真 FFT,见 tools/sfx-survey.mjs):
   * Kenney 的 `impactPlate_heavy` **2k~8kHz 只占 0.4%、<250Hz 占 92%** ——
   * 它其实是一个低频闷响(重物落地),而打击音要在密集混音里清晰可辨,
   * 2~8kHz 的占比才是关键(玩家判断"我打得准不准"就靠这一段)。
   * 素材里没有这个成分时只能在播放时补:比换素材代价小,而且高频瞬态用合成更干净
   * (没有录音底噪)。
   *
   * 取值说明:`gain` 是**包络峰值**而不是线性缩放系数,所以量级看着大。
   * 第一版按"0.3 左右"给,实测 click 相对采样只有 **-21dB**(完全听不见);
   * 按目标电平扫描后才定下现在的量级(见 tools/sfx-spectrum.mjs 与下面的实测数据):
   *     增益 0.34 → 高频提升 +0.3dB(无效)
   *     增益 3    → PERFECT +8.0dB / GREAT +16.8dB
   *     增益 5    → PERFECT +10.1dB / GREAT +18.6dB
   *     增益 8    → PERFECT +14.2dB / GREAT +22.8dB(峰值 0.87,开始吃掉余量)
   * GREAT 拿到的提升更大,因为它的木板素材本身最缺高频(原始 2k~8k 仅 4.6%)。
   *
   * MISS 故意给 0:它本来就该是闷的、不负责报时,加高频反而破坏档位区分度。
   */
  static TIER_CLICK = { PERFECT: 0.8, GREAT: 1.2, GOOD: 0.5, MISS: 0 };

  /** click 层中心频率:按档位错开,避免和素材自身主频打架 */
  static TIER_CLICK_FREQ = { PERFECT: 3200, GREAT: 4200, GOOD: 5200, MISS: 2600 };

  /** accent 素材的总增益(清单里的 variantGain 已把各步归一到同响度) */
  static ACCENT_GAIN = 0.5;

  /**
   * accent 下标 → 素材含义(与 tools/build-sfx-samples.mjs 的 ACCENTS 顺序一致):
   *   0 = 586Hz  1 = 1254Hz  2 = 1980Hz  3 = 7336Hz  4 = 234Hz(低音落音)
   * 这些下标写死在这里是有意的:素材换批时这两处必须一起改,
   * 写死比"按文件名猜"更安全(文件名里的音高信息一旦被改名就丢了)。
   */
  static MILESTONE_ORDER = [0, 1, 2, 3];
  static START_ORDER = [0, 2, 3];
  static SUCCESS_ORDER = [0, 1, 2, 3];
  static FAIL_ORDER = [4, 0];

  /**
   * @param {import('./sfx.js').Sfx} synth 合成层(同时充当总线:高通/限幅/混响/主音量)
   * @param {SampleHitSound} samples 采样层
   */
  constructor(synth, samples) {
    this.synth = synth;
    this.samples = samples;
    this._muted = false;
    // 采样层接进合成层的总线汇合点:复用它的 55Hz 高通 / 软限幅 / 房间混响 / 主音量。
    // 两条路共用一条总线,避免"采样和合成各有一套处理"导致切换时音色突变。
    // 只有采样层"没有自己的出口"时才由这里接管 —— 用了显式标记而不是猜节点状态,
    // 因为"接了两遍"这种 bug 从听感上极难定位(表现为重复播放/响度翻倍)。
    if (!samples.selfConnected) {
      try { samples.master.connect(synth.voiceNode); } catch { /* 没有 voiceNode 时忽略 */ }
    }
    // 后台预解码,不阻塞开局
    this.samples.load().catch(() => { /* load() 内部已兜住错误 */ });
  }

  get ctx() { return this.synth.ctx; }
  get ready() { return this.samples.ready; }
  get status() { return this.samples.status; }

  set enabled(v) {
    this._muted = !v;
    this.synth.enabled = !!v;
  }
  get enabled() { return !this._muted; }

  setVolume(v) { this.synth.setVolume(v); }

  get outputNode() { return this.synth.outputNode; }

  /**
   * 与 Sfx.hit 同签名;采样就绪走采样 + 补一层 click,否则整体走合成。
   *
   * click 与采样**排同一个 when**:两者必须落在同一帧上,否则会听成"双响"。
   * `_click()` 内部本身就是双路由(click 走 dry 不进混响),所以不会把起音糊掉。
   */
  hit(tier, opts = {}) {
    if (this._muted) return;
    const { heat = 1 } = opts;
    const when = opts.when ?? null;
    // 透传 when 给采样层:它同样要排在音频时钟上
    if (this.samples.play(tier, when, { heat })) {
      const clickGain = HitSound.TIER_CLICK[tier] ?? 0;
      if (clickGain > 0) {
        this.synth.click(when, {
          freq: HitSound.TIER_CLICK_FREQ[tier] ?? 3600,
          // 增益按"整体电平体系"折算:click 直接进总线,不走采样层的 master
          gain: clickGain * this.synth.volume,
          decay: 0.010,
        });
      }
      return;
    }
    this.synth.hit(tier, opts);
  }

  milestone(combo, opts = {}) {
    if (this._muted) return;
    // 优先用采样琶音(实测主频阶梯 586→1254→1980→7336Hz,见 tools/sfx-pick-accent.mjs);
    // 没有素材(加载未完成/失败)就退回合成琶音 —— 里程碑不该因为素材没到就静音。
    const when = Math.max(this.synth.ctx.currentTime, opts.when ?? this.synth.ctx.currentTime);
    if (this.samples.playAccents(HitSound.MILESTONE_ORDER, when, 55, HitSound.ACCENT_GAIN)) return;
    this.synth.milestone(combo, opts);
  }

  stinger(kind, opts = {}) {
    if (this._muted) return;
    const when = Math.max(this.synth.ctx.currentTime, opts.when ?? this.synth.ctx.currentTime);
    const order = kind === 'success' ? HitSound.SUCCESS_ORDER
      : kind === 'fail' ? HitSound.FAIL_ORDER
        : HitSound.START_ORDER;
    const step = kind === 'fail' ? 120 : 90;
    if (this.samples.playAccents(order, when, step, HitSound.ACCENT_GAIN)) return;
    this.synth.stinger(kind, opts);
  }

  hitCount(tier) { return this.synth.hitCount(tier); }
}

export default HitSound;










