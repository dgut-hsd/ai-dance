/**
 * video-source.js — 参考视频的「加载时序状态机 + 故障诊断」。
 *
 * 为什么要单独一层:原来 main.js 里是
 *
 *     video.src = url;            // 异步开始加载
 *     video.pause();              // 立刻打断
 *     video.play().catch(() => {}); // 失败被吞,现场只能看到"视频不动了"
 *
 * 这三句都有坑:
 *   1. 改 src 之后再 pause,会把 <video> 的加载/播放请求打断(abort),
 *      紧接着的 play() 在 Chrome 里可能直接被 AbortError 掉,而且没有任何痕迹;
 *   2. play() 返回的 Promise 被 catch 吞掉,现场拿不到 DOMException.name;
 *   3. 未 ready 就写 currentTime 会留下一个 pending seek,再 play 时表现为
 *      "一直转圈 / 停在上一帧"。
 *
 * 本模块只做三件事:URL 变更去重、等到真的能播、把失败原因说清楚(带错误码)。
 * 纯逻辑、无 DOM 依赖(只依赖传入的 media 对象接口),所以可以在 Node 里直接单测。
 */

/** 约定支持的预加载前缀(与 HTMLMediaElement.preload 一致) */
const PRELOADS = new Set(["none", "metadata", "auto"]);

/** MediaError.code → 人话。现场排查时"哪一类"比"失败了"有用得多 */
export const MEDIA_ERROR_TEXT = {
  1: "MEDIA_ERR_ABORTED(加载被中断:通常是同一元素上又改了 src 或调了 load/pause)",
  2: "MEDIA_ERR_NETWORK(网络中断:服务器/网线/上传被截断)",
  3: "MEDIA_ERR_DECODE(解码失败:文件损坏或 H.264 profile 浏览器不支持)",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED(地址取不到或格式不支持:404/CORS/MIME 不对)",
};

export function mediaErrorText(code) {
  return MEDIA_ERROR_TEXT[code] || `MEDIA_ERR_${code ?? "UNKNOWN"}`;
}

/** 把一次失败的 play()/加载错误整理成 `Name: message` —— DOMException.name 是最关键的线索 */
export function describeError(error) {
  if (!error) return "未知错误";
  const name = error.name || error.constructor?.name || "Error";
  return `${name}: ${error.message || error}`;
}

/**
 * 读一条精简的播放健康状况。任何一处异常都给出人话结论,
 * 让现场不用猜"为什么不动"。
 */
export function videoHealth(video) {
  if (!video) return { ok: false, url: null, reason: "没有 <video> 元素" };
  const err = video.error;
  if (err) {
    return {
      ok: false,
      url: video.currentSrc || null,
      reason: mediaErrorText(err.code),
      errorCode: err.code,
      errorMessage: err.message || "",
      networkState: video.networkState,
      readyState: video.readyState,
    };
  }
  const url = video.currentSrc || null;
  const base = {
    url,
    readyState: video.readyState,
    networkState: video.networkState,
    paused: video.paused,
    ended: video.ended,
    currentTime: round(video.currentTime),
    duration: Number.isFinite(video.duration) ? round(video.duration) : null,
    readyText: READY_TEXT[video.readyState] || String(video.readyState),
  };
  if (!url) return { ...base, ok: false, reason: "还没设置 src(视频绑定可能为空)" };
  if (video.readyState === 0) {
    return { ...base, ok: false, reason: "元数据都没到(请求卡住 / 404 / 服务器没回)" };
  }
  if (video.paused && video.ended) return { ...base, ok: false, reason: "播完并停住了" };
  if (video.paused) return { ...base, ok: false, reason: "处于暂停态(没人调 play,或 play 被拒)" };
  return { ...base, ok: true, reason: "播放中" };
}

const READY_TEXT = {
  0: "HAVE_NOTHING",
  1: "HAVE_METADATA",
  2: "HAVE_CURRENT_DATA",
  3: "HAVE_FUTURE_DATA",
  4: "HAVE_ENOUGH_DATA",
};

function round(s) {
  return Number.isFinite(s) ? Math.round(s * 1000) / 1000 : null;
}

/** 事件 → 一行日志。waiting/stalled 只记状态,避免刷屏 */
function eventNote(video, type) {
  const bits = [`rs=${video.readyState}`, `ns=${video.networkState}`];
  if (Number.isFinite(video.currentTime)) bits.push(`t=${round(video.currentTime)}`);
  if (type === "error") {
    const err = video.error;
    bits.push(`code=${err?.code ?? "?"}(${mediaErrorText(err?.code)})`);
  }
  return `${type} ${bits.join(" ")}`;
}

export class VideoSource {
  /**
   * @param media  <video> 元素(或测试替身:src/load/play/pause/addEventListener 足够)
   * @param options.preload       期望的 preload 策略,默认 auto
   * @param options.loadTimeoutMs 等 loadedmetadata 的上限,超时抛出可读错误
   * @param options.playTimeoutMs 等 playing 的上限(超过只记录,不打断)
   * @param options.log           日志函数(默认 console.debug)
   * @param options.warn          告警函数(默认 console.warn)
   */
  constructor(media, { preload = "auto", loadTimeoutMs = 15000, playTimeoutMs = 6000, log, warn } = {}) {
    if (!media) throw new Error("VideoSource 需要一个 <video> 元素");
    this.media = media;
    this.loadTimeoutMs = loadTimeoutMs;
    this.playTimeoutMs = playTimeoutMs;
    this.log = log || ((line) => console.debug(`[video] ${line}`));
    this.warn = warn || ((line) => console.warn(`[video] ${line}`));
    this.entries = [];
    this.url = null;          // 当前 src
    this.loadedUrl = null;    // 已经成功拿到元数据的 src
    this.pending = null;      // { url, promise }
    this.playingLogged = {};  // url -> true,同一地址只报一次"开播"
    this.stallWarnedAt = 0;
    this.setPreload(preload);
    const on = (type, fn) => media.addEventListener?.(type, fn);
    on("loadedmetadata", () => this.note("loadedmetadata"));
    on("loadeddata", () => this.note("loadeddata"));
    on("canplay", () => this.note("canplay"));
    on("playing", () => this.note("playing"));
    on("pause", () => this.note("pause"));
    on("ended", () => this.note("ended"));
    on("error", () => this.note("error", "warn"));
    on("stalled", () => this.note("stalled", "warn", { throttleMs: 2000 }));
    on("waiting", () => this.note("waiting", "warn", { throttleMs: 2000 }));
    on("abort", () => this.note("abort", "warn"));
  }

  /** 滚动日志:只留最近 200 条,避免长时间跑现场把内存吃掉 */
  note(type, level = "debug", { throttleMs = 0 } = {}) {
    const text = eventNote(this.media, type);
    const last = this.entries[this.entries.length - 1];
    if (throttleMs && last?.text?.startsWith(`${type} `) && performance.now() - last.at < throttleMs) return;
    this.entries.push({ at: Math.round(performance.now()), level, text });
    if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
    if (level === "warn") this.warn(text); else this.log(text);
  }

  setPreload(preload) {
    const value = PRELOADS.has(preload) ? preload : "auto";
    try {
      this.media.preload = value;
      this.media.setAttribute?.("preload", value);
    } catch { /* 个别环境只读,忽略 */ }
  }

  /**
   * 切到某个地址(幂等:同地址不重新加载,避免打断正在播的视频)。
   * 返回一个"元数据就绪"的 Promise;调用方 await 它之后再 play 就不会踩到加载竞态。
   */
  load(url) {
    if (!url) { this.clear("调用方传了空地址"); return Promise.resolve(null); }
    const abs = new URL(url, globalThis.location?.href || "http://localhost/").href;
    if (this.url !== abs) {
      const previous = this.url;
      this.url = abs;
      this.loadedUrl = null;
      this.note(`src → ${abs}${previous ? `(原 ${previous})` : ""}`);
      try {
        this.media.src = abs;
        this.media.load?.();
      } catch (error) {
        return Promise.reject(new Error(`设置视频地址失败 ${describeError(error)}`));
      }
    }
    // 已经就绪 / 正在等同一个地址:复用结果,绝不重复 load(那会打断正在播的画面)
    if ((this.media.readyState ?? 0) >= 1) {
      this.loadedUrl = abs;
      return Promise.resolve(abs);
    }
    if (this.pending?.url === abs) return this.pending.promise;
    const promise = this.waitForMetadata(abs);
    this.pending = { url: abs, promise };
    return promise;
  }

  waitForMetadata(abs) {
    return new Promise((resolve, reject) => {
      const media = this.media;
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("loadedmetadata", ok);
        this.off("error", bad);
        fn(value);
      };
      const ok = () => { this.loadedUrl = abs; done(resolve, abs); };
      const bad = () => {
        const err = media.error;
        done(reject, new Error(`视频加载失败 ${mediaErrorText(err?.code)} (src=${abs})`));
      };
      const timer = setTimeout(() => {
        const state = videoHealth(media);
        done(reject, new Error(`视频加载超时 ${this.loadTimeoutMs}ms(${state.reason}; src=${abs})`));
      }, this.loadTimeoutMs);
      this.on("loadedmetadata", ok);
      this.on("error", bad);
      // 已经就绪的(缓存命中 / 上一轮加载完了)直接放行
      if ((media.readyState ?? 0) >= 1) ok();
    });
  }

  on(type, fn) { this.media.addEventListener?.(type, fn); }
  off(type, fn) { this.media.removeEventListener?.(type, fn); }

  /**
   * 播放。restart=true 时先回到 0 再播,并且**等 seek 落定**再 play
   * (未 ready 就写 currentTime 正是"视频卡死不报错"的常见成因)。
   */
  async play({ restart = false, loop = true } = {}) {
    const url = this.url;
    if (!url) return { ok: false, reason: "没有可播的地址" };
    await this.load(url);
    const media = this.media;
    media.muted = true;               // 参考视频永远静音:不会被自动播放策略拦
    media.loop = loop;
    media.playsInline = true;
    if (restart && (media.currentTime ?? 0) > 0.05) {
      await this.seek(0);
    }
    if (!media.paused && !media.ended) return { ok: true, alreadyPlaying: true };
    try {
      await media.play();
      if (!this.playingLogged[url]) {
        this.playingLogged[url] = true;
        this.note("play() 成功");
      }
      return { ok: true };
    } catch (error) {
      const reason = describeError(error);
      // NotAllowedError 才会因为"没有用户手势"出现;但我们 muted,理论上不该有。
      this.warn(`play() 被拒 ${reason}(${videoHealth(media).reason})`);
      return { ok: false, reason, state: videoHealth(media) };
    }
  }

  /**
   * 等一次 seek 落定。
   * 注意:即使 currentTime 恰好已经等于目标值,规范也仍会异步补发 seeked,
   * 所以不能"看值相等就提前放行" —— 那正是 seek 与 play 抢跑、画面停住的成因。
   */
  seek(time, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const media = this.media;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("seeked", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.on("seeked", finish);
      try {
        media.currentTime = time;
      } catch (error) {
        this.warn(`seek 失败 ${describeError(error)}`);
        return finish();
      }
    });
  }

  /**
   * 自检:本该在播却没在播就返回 false,并给出一条可直接贴到问题单里的结论。
   * 看门狗用它来决定"要不要补一次 play"。
   */
  ensurePlaying({ restart = false } = {}) {
    const health = videoHealth(this.media);
    if (health.ok) return true;
    if (this.stallWarnedAt && performance.now() - this.stallWarnedAt < 4000) return false;
    this.stallWarnedAt = performance.now();
    this.warn(`本该在播却没有:${health.reason} → 补一次 play()`);
    void this.play({ restart });
    return false;
  }

  pause() {
    try {
      if (!this.media.paused) this.media.pause();
    } catch { /* 已经没了就算了 */ }
  }

  /** 把地址摘掉并复位。切模式/停局时用,避免继续占着解码器 */
  clear(reason = "") {
    this.url = null;
    this.loadedUrl = null;
    this.pending = null;
    this.playingLogged = {};
    if (reason) this.note(`清空地址(${reason})`);
    try {
      this.media.removeAttribute?.("src");
      this.media.load?.();
    } catch { /* 忽略 */ }
  }

  health() { return videoHealth(this.media); }

  /** 现场可直接贴进问题单的快照 */
  report(label = "") {
    return {
      label,
      at: new Date().toISOString(),
      url: this.url,
      loadedUrl: this.loadedUrl,
      health: this.health(),
      log: this.entries.slice(-60),
    };
  }

  /** 控制台一键导出:`__danceVideo.export()` */
  exportText(label = "") {
    const payload = this.report(label);
    return JSON.stringify({ ...payload, errors: videoErrorSummary(payload) }, null, 2);
  }
}

/** 给报告补一句"最可能的原因",让不熟代码的人也能读懂 */
export function videoErrorSummary(report) {
  const health = report?.health || {};
  if (health.ok) return "视频正常播放中";
  if (health.errorCode) return health.reason;
  const log = report?.log || [];
  if (log.some((l) => l.text.startsWith("abort") || l.text.includes("MEDIA_ERR_ABORTED")))
    return "加载/播放请求被中途打断(同一元素上改了 src 或调了 pause/load),检查是否重复切源";
  if (log.some((l) => l.text.startsWith("stalled") || l.text.startsWith("waiting")))
    return "等待数据(stalled/waiting):解码或带宽被抢占,看是不是同时在跑录制/推理";
  if (!report?.url) return "没有绑定视频地址(后台「右侧画面」未给这支舞绑定视频)";
  return health.reason || "未知";
}
