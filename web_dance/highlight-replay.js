export class HighlightReplayController {
  constructor({ video, onSegmentChange = null, onComplete = null } = {}) {
    if (!video) throw new Error("HighlightReplayController requires a video element");
    this.video = video;
    this.onSegmentChange = onSegmentChange;
    this.onComplete = onComplete;
    this.segments = [];
    this.index = -1;
    this.active = false;
    this._onTimeUpdate = () => this._advanceIfNeeded();
    this.video.addEventListener("timeupdate", this._onTimeUpdate);
  }

  start(url, segments) {
    this.stop();
    this.segments = (segments || []).filter((s) => s && s.end > s.start);
    if (!url || !this.segments.length) return Promise.resolve(false);
    this.active = true;
    this.video.controls = false;
    this.video.src = url;
    return new Promise((resolve) => {
      let begun = false;
      const begin = async () => {
        if (begun) return;
        begun = true;
        if (!this.active) { resolve(false); return; }
        await this._playSegment(0);
        resolve(true);
      };
      this.video.addEventListener("loadedmetadata", begin, { once: true });
      if (this.video.readyState >= 1) void begin();
    });
  }

  async _playSegment(index) {
    const segment = this.segments[index];
    if (!this.active || !segment) return;
    this.index = index;
    this.video.currentTime = segment.start;
    this.onSegmentChange?.(segment, index, this.segments.length);
    await this.video.play().catch(() => {});
  }

  _advanceIfNeeded() {
    if (!this.active || this.index < 0) return;
    const segment = this.segments[this.index];
    if (!segment || this.video.currentTime < segment.end) return;
    const next = this.index + 1;
    if (next < this.segments.length) {
      void this._playSegment(next);
      return;
    }
    this.video.pause();
    this.active = false;
    this.onComplete?.();
  }

  stop() {
    this.active = false;
    this.index = -1;
    this.segments = [];
    this.video.pause();
  }

  dispose() {
    this.stop();
    this.video.removeEventListener("timeupdate", this._onTimeUpdate);
  }
}

