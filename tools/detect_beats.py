#!/usr/bin/env python3
"""
detect_beats.py — 离线节拍检测:音频 → timing/v1(可选 chart/v1)。

依赖 numpy;WAV 用标准库读取,mp3/ogg/flac/m4a 用 miniaudio(pip install miniaudio)。
算法(无 librosa/aubio/scipy):
  1. 谱通量(spectral flux)onset 包络;
  2. 自相关估 BPM(含八度校正,偏好 70–175);
  3. 低频起音相位搜索求 offsetSec(第一个下拍);
  4. 生成 beatTimesSec / downbeatsSec(默认 4/4)。

用法(把 song.mp3 换成你的真实音频文件):
  python tools/detect_beats.py song.mp3
  python tools/detect_beats.py song.mp3 --out timing.json --chart chart.json --audio-path audio/song.mp3
"""
import argparse
import json
import sys
import wave

import numpy as np


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, dtype=np.int16)
    elif sw == 3:
        # 24-bit PCM(少见)
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        x = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        x = np.where(x >= 0x800000, x - 0x1000000, x)
    else:
        raise ValueError(f"unsupported sample width {sw}")
    x = x.astype(np.float32)
    if nch > 1:
        x = x.reshape(-1, nch).mean(axis=1)
    x /= (1 << (sw * 8 - 1))
    return x, sr


def read_audio(path):
    """读取音频 → (float32 单声道, sr)。WAV 走标准库,其余走 miniaudio。"""
    import os
    if not os.path.exists(path):
        raise FileNotFoundError(f"音频文件不存在: {path}")
    ext = os.path.splitext(path)[1].lower()
    if ext == ".wav":
        return read_wav(path)
    try:
        import miniaudio
    except ImportError:
        raise RuntimeError(
            f"不支持 '{ext}' 格式:请先 `pip install miniaudio`,或把歌曲转成 WAV 后重试。"
        )
    d = miniaudio.decode_file(path, output_format=miniaudio.SampleFormat.FLOAT32)
    x = np.asarray(d.samples, dtype=np.float32)
    if d.nchannels > 1:
        x = x.reshape(-1, d.nchannels).mean(axis=1)
    return x, d.sample_rate


def onset_envelope(x, sr, hop=512, win=2048):
    """谱通量 onset 包络,返回 (flux 归一化, 帧率)"""
    n = len(x)
    n_frames = max(0, (n - win) // hop + 1)
    window = np.hanning(win)
    flux = np.zeros(n_frames, dtype=np.float32)
    prev = None
    for i in range(n_frames):
        seg = x[i * hop:i * hop + win] * window
        spec = np.abs(np.fft.rfft(seg))
        if prev is not None:
            flux[i] = np.sum(np.maximum(0.0, spec - prev))
        prev = spec
    if flux.size and flux.max() > 0:
        flux = flux / flux.max()
    if flux.size >= 3:
        flux = np.convolve(flux, np.ones(3) / 3.0, mode="same")
    return flux, sr / hop


def low_energy_envelope(x, sr, hop=512, win=2048, cutoff_hz=250.0):
    """低频带能量包络(底鼓/surdo 所在),用于找「拍」的相位;返回 (env 归一化, 帧率)"""
    n = len(x)
    n_frames = max(0, (n - win) // hop + 1)
    window = np.hanning(win)
    bin_hi = int(cutoff_hz * win / sr) + 1
    env = np.zeros(n_frames, dtype=np.float32)
    for i in range(n_frames):
        seg = x[i * hop:i * hop + win] * window
        spec = np.abs(np.fft.rfft(seg))
        env[i] = np.sum(spec[:bin_hi] ** 2)
    if env.size and env.max() > 0:
        env = env / env.max()
    if env.size >= 3:
        env = np.convolve(env, np.ones(3) / 3.0, mode="same")
    return env, sr / hop


def low_onset_envelope(x, sr, hop=512, win=2048, cutoff_hz=250.0):
    """低频带谱通量(只留攻击瞬态),相位更锐利;返回 (onset 归一化, 帧率)"""
    n = len(x)
    n_frames = max(0, (n - win) // hop + 1)
    window = np.hanning(win)
    bin_hi = int(cutoff_hz * win / sr) + 1
    onset = np.zeros(n_frames, dtype=np.float32)
    prev = None
    for i in range(n_frames):
        seg = x[i * hop:i * hop + win] * window
        spec = np.abs(np.fft.rfft(seg))
        band = spec[:bin_hi]
        if prev is not None:
            onset[i] = np.sum(np.maximum(0.0, band - prev))
        prev = band
    if onset.size and onset.max() > 0:
        onset = onset / onset.max()
    if onset.size >= 3:
        onset = np.convolve(onset, np.ones(3) / 3.0, mode="same")
    return onset, sr / hop


def autocorr(flux):
    x = flux - flux.mean()
    n = len(x)
    F = np.fft.rfft(x, 2 * n)
    ac = np.fft.irfft(F * np.conj(F))[:n]
    return ac / (ac[0] + 1e-9)


def estimate_bpm(flux, sr_flux):
    """自相关峰 → BPM,含基于自相关实际值的八度校正(偏好 70–175)"""
    ac = autocorr(flux)
    lo = int(0.25 * sr_flux)   # 240 BPM
    hi = int(1.2 * sr_flux)    # 50 BPM
    hi = min(hi, len(ac) - 1)
    if lo >= hi:
        return 120.0, sr_flux / 2.0
    lag = lo + int(np.argmax(ac[lo:hi + 1]))
    bpm = 60.0 * sr_flux / lag

    # 半速(太慢):若半周期处也有强相关,则翻倍(如 50→100)
    if bpm < 70.0:
        half = lag // 2
        if half >= lo and ac[half] > 0.35 * ac[lag]:
            lag = half
            bpm *= 2.0
    # 倍速(太快):若双周期处也有强相关,则减半(如 240→120)
    elif bpm > 175.0:
        dbl = lag * 2
        if dbl < len(ac) and ac[dbl] > 0.35 * ac[lag]:
            lag = dbl
            bpm /= 2.0
    return bpm, lag


def find_phase(env, bpm, sr_env):
    """相位搜索:用分数周期 + 线性插值,在 [0, period) 内找最优 offset(秒)"""
    period_frames = (60.0 / bpm) * sr_env
    n_phases = max(1, int(round(period_frames)))
    best_s = -1.0
    best_p = 0
    for p in range(n_phases):
        s = 0.0
        t = float(p)
        while t < len(env):
            i = int(t)
            f = t - i
            if i + 1 < len(env):
                s += env[i] * (1.0 - f) + env[i + 1] * f
            else:
                s += env[i]
            t += period_frames
        if s > best_s:
            best_s = s
            best_p = p
    return best_p / sr_env


def detect(path, beats_per_bar=4):
    x, sr = read_audio(path)
    duration = len(x) / sr
    flux, sr_flux = onset_envelope(x, sr)
    bpm, lag = estimate_bpm(flux, sr_flux)
    period = 60.0 / bpm
    # 用低频起音(只留攻击瞬态)找相位,锐利且贴合底鼓/surdo
    low_onset, _ = low_onset_envelope(x, sr)
    phase = find_phase(low_onset, bpm, sr_flux)

    beats = []
    t = phase
    while t <= duration + 1e-9:
        beats.append(round(t, 4))
        t += period
    downbeats = beats[::beats_per_bar]

    bpm_r = round(bpm, 2)
    timing = {
        "version": "timing/v1",
        "bpm": bpm_r,
        "offsetSec": round(phase, 4),
        "tempoMap": [{"t": 0.0, "bpm": bpm_r}],
        "timeSignatures": [{"t": 0.0, "num": beats_per_bar, "den": 4}],
        "beatTimesSec": beats,
        "downbeatsSec": downbeats,
    }
    return timing, duration, bpm_r, phase


def make_chart(audio_path, timing, notes_per_bar=1, beats_per_bar=4):
    """在每小节的下拍(可多)处埋 pose 音符"""
    notes = []
    dbs = timing["downbeatsSec"]
    period = 60.0 / timing["bpm"]
    for bar_t in dbs:
        for k in range(notes_per_bar):
            t = bar_t + k * period
            if t <= dbs[-1] + period:
                notes.append({"id": f"n-{round(t, 3)}", "t": round(t, 3), "type": "pose", "lane": "body"})
    return {"version": "chart/v1", "audio": audio_path, "notes": notes}


def selftest():
    """校验已知 WAV 的 BPM 是否恢复正确(±2)"""
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    cases = [
        (root / "web_dance/audio/demo-beat.wav", 120.0),
        (root / "web_dance/audio/samba-demo.wav", 100.0),
    ]
    ok = True
    for path, expect in cases:
        timing, _, bpm, phase = detect(str(path))
        good = abs(bpm - expect) <= 2.0
        ok = ok and good
        print(f"[{'PASS' if good else 'FAIL'}] {path.name}: bpm={bpm} offset={phase:.4f}s (expect ~{expect})")
    return 0 if ok else 1


def main(argv):
    ap = argparse.ArgumentParser(description="音频 → timing/v1(可选 chart/v1)")
    ap.add_argument("--selftest", action="store_true", help="校验内置 WAV 的 BPM 恢复")
    ap.add_argument("audio", nargs="?", help="输入 WAV 文件(selftest 时可省略)")
    ap.add_argument("--out", help="timing JSON 输出路径(缺省打印到 stdout)")
    ap.add_argument("--chart", help="chart JSON 输出路径(可选)")
    ap.add_argument("--audio-path", default=None, help="chart 里的 audio 字段(缺省=输入文件名)")
    ap.add_argument("--beats-per-bar", type=int, default=4, help="每小节拍数(默认 4)")
    ap.add_argument("--notes-per-bar", type=int, default=1, help="每小节音符数(默认 1,只下拍)")
    args = ap.parse_args(argv)

    if args.selftest:
        sys.exit(selftest())

    if not args.audio:
        ap.error("请提供输入 WAV 文件(或使用 --selftest)")

    timing, duration, bpm, phase = detect(args.audio, args.beats_per_bar)
    sys.stderr.write(f"detected: bpm={bpm} offset={phase:.4f}s duration={duration:.2f}s beats={len(timing['beatTimesSec'])}\n")

    if args.chart:
        audio_path = args.audio_path or args.audio.split("/")[-1].split("\\")[-1]
        chart = make_chart(audio_path, timing, args.notes_per_bar, args.beats_per_bar)
        with open(args.chart, "w", encoding="utf-8") as f:
            json.dump(chart, f, ensure_ascii=False, indent=2)
        sys.stderr.write(f"wrote chart -> {args.chart} ({len(chart['notes'])} notes)\n")

    text = json.dumps(timing, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        sys.stderr.write(f"wrote timing -> {args.out}\n")
    else:
        print(text)


if __name__ == "__main__":
    main(sys.argv[1:])
