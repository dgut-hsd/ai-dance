/**
 * 选曲页专用试听播放器。
 * 独占 AudioEngine / AudioContext,避免与表演模式或正式挑战互相抢状态。
 */
export class SelectionPreviewAudio {
  constructor({ AudioEngine, debounceMs = 180 } = {}) {
    if (!AudioEngine) throw new Error("SelectionPreviewAudio requires AudioEngine");
    this.AudioEngine = AudioEngine;
    this.debounceMs = debounceMs;
    this.engine = null;
    this.loadedUrl = null;
    this.pendingUrl = null;
    this.timer = null;
    this.generation = 0;
  }

  _ensureEngine() {
    if (!this.engine) {
      const AudioCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.engine = new this.AudioEngine({ audioContext: AudioCtor ? new AudioCtor() : null });
      this.engine.loop = true;
    }
    return this.engine;
  }

  /** 快速滚动卡片时只播放最后停留的歌曲。 */
  request(url, { onPlaying } = {}) {
    if (!url) return;
    const token = ++this.generation;
    this.pendingUrl = url;
    clearTimeout(this.timer);

    // 在用户手势调用栈里创建/恢复 AudioContext,后续异步加载不会被自动播放策略拦住。
    const engine = this._ensureEngine();
    if (engine.ctx.state === "suspended") engine.ctx.resume().catch(() => {});

    this.timer = setTimeout(async () => {
      try {
        if (this.loadedUrl !== url) {
          engine.stop();
          await engine.load(url);
          if (token !== this.generation) return;
          this.loadedUrl = url;
        } else {
          engine.stop();
        }
        if (token !== this.generation) return;
        engine.loop = true;
        await engine.play();
        if (token === this.generation) onPlaying?.();
      } catch (error) {
        if (token === this.generation) console.warn("选曲试听失败:", error);
      }
    }, this.debounceMs);
  }

  stop() {
    this.generation++;
    this.pendingUrl = null;
    clearTimeout(this.timer);
    this.timer = null;
    this.engine?.stop();
  }

  async dispose() {
    this.stop();
    await this.engine?.dispose();
    this.engine = null;
    this.loadedUrl = null;
  }
}
