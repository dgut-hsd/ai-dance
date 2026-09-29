/**
 * wav-peaks.js — 纯数据解析:直接从 PCM WAV 的 ArrayBuffer 计算每桶 min/max 峰值。
 * 不依赖 WebAudio/decodeAudioData,因此不会因浏览器解码器卡住而失败。
 * 返回 { min: Float32Array, max: Float32Array, rate } 与 chart-editor 的 buildPeaks 同构。
 * 非 PCM WAV(如 RIFF 内的 mp3/ADPCM)返回 null,由调用方回退到 decodeAudioData。
 */

const ID_RIFF = 0x46464952; // "RIFF"
const ID_WAVE = 0x45564157; // "WAVE"
const ID_FMT = 0x20746d66;  // "fmt "
const ID_DATA = 0x61746164; // "data"

export function wavPeaks(ab, maxBins = 40000) {
  const view = toDataView(ab);
  if (!view || view.byteLength < 12) return null;
  if (view.getUint32(0, true) !== ID_RIFF || view.getUint32(8, true) !== ID_WAVE) return null;

  let fmt = -1, dataOff = -1, dataLen = 0;
  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = view.getUint32(off, true);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === ID_FMT) fmt = body;
    else if (id === ID_DATA) { dataOff = body; dataLen = size; }
    const step = 8 + size + (size & 1);
    if (step <= 0) break;
    off += step;
  }
  if (fmt < 0 || dataOff < 0 || dataLen <= 0) return null;

  const audioFormat = view.getUint16(fmt, true);   // 1=PCM, 3=IEEE float
  const channels = view.getUint16(fmt + 2, true);
  const sampleRate = view.getUint32(fmt + 4, true);
  const bits = view.getUint16(fmt + 14, true);
  if (!channels || !sampleRate) return null;
  if (audioFormat !== 1 && audioFormat !== 3) return null;
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null;

  const bytesPerSample = bits / 8;
  const block = bytesPerSample * channels;
  const totalFrames = Math.min(Math.floor(dataLen / block), Math.floor((view.byteLength - dataOff) / block));
  if (totalFrames <= 0) return null;

  const durationSec = totalFrames / sampleRate;
  const targetBuckets = Math.max(2, Math.min(maxBins, Math.ceil(durationSec * 200)));
  const framesPerBin = Math.max(1, Math.floor(totalFrames / targetBuckets));
  const n = Math.max(2, Math.ceil(totalFrames / framesPerBin));
  const mn = new Float32Array(n);
  const mx = new Float32Array(n);

  const read = (frame, chan) => {
    const p = dataOff + (frame * channels + chan) * bytesPerSample;
    if (audioFormat === 3) return view.getFloat32(p, true);
    if (bits === 8) return (view.getUint8(p) - 128) / 127;
    if (bits === 16) return view.getInt16(p, true) / 32768;
    if (bits === 24) {
      const v = view.getUint8(p) + view.getUint8(p + 1) * 256 + view.getUint8(p + 2) * 65536;
      return (v >= 0x800000 ? v - 0x1000000 : v) / 8388608;
    }
    return view.getInt32(p, true) / 2147483648;
  };

  for (let i = 0; i < n; i++) {
    const s = i * framesPerBin;
    const e = Math.min(totalFrames, s + framesPerBin);
    let lo = 1, hi = -1;
    for (let f = s; f < e; f++) {
      for (let c = 0; c < channels; c++) {
        const v = read(f, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    mn[i] = lo;
    mx[i] = hi;
  }
  return { min: mn, max: mx, rate: n / Math.max(1, durationSec) };
}

function toDataView(ab) {
  if (ab instanceof DataView) return ab;
  if (ab instanceof ArrayBuffer) return new DataView(ab);
  const u8 = ab?.buffer ? ab : new Uint8Array(ab);
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}