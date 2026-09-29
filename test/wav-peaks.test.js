import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavPeaks } from '../web_dance/wav-peaks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SONGS = path.join(root, 'songs');

const FILES = [
  [path.join(SONGS, 'demo-arena-loop', 'demo-beat.wav'), 'demo'],
  [path.join(SONGS, 'hiphop', 'pop-demo.wav'), 'hiphop'],
  [path.join(SONGS, 'salsa', 'samba-demo.wav'), 'salsa'],
];

test('wavPeaks: 真实音频文件都能直接算出行波峰值', async () => {
  for (const [file] of FILES) {
    const buf = await readFile(file);
    const peaks = wavPeaks(buf);
    assert.ok(peaks, `${file} 应能解析出波形`);
    assert.ok(peaks.rate > 50 && peaks.rate < 1000, `${file} rate=${peaks.rate}`);
    assert.equal(peaks.min.length, peaks.max.length, `${file} min/max 桶数一致`);
    assert.ok(peaks.min.length >= 100, `${file} 桶数=${peaks.min.length}`);
    let loud = -1;
    for (let i = 0; i < peaks.max.length; i++) loud = Math.max(loud, peaks.max[i]);
    let low = 1;
    for (let i = 0; i < peaks.min.length; i++) low = Math.min(low, peaks.min[i]);
    assert.ok(loud > 0.4 && low < -0.4, `${file} 应有明显的响度摆动(max=${loud.toFixed(2)} min=${low.toFixed(2)})`);
  }
});

test('wavPeaks: 非 WAV/空数据返回 null', () => {
  assert.equal(wavPeaks(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.equal(wavPeaks(new ArrayBuffer(0)), null);
  const fake = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(wavPeaks(fake), null);
});