/**
 * video-meta.test.js — 视频比例识别。
 *
 * 背景:游戏右侧画面以前是固定 55vw × 100vh + object-fit: cover,9:16 的训练视频会被左右
 * 各裁掉约 41%。修法是把比例当成素材属性识别出来写进 videos/index.json,页面据此摆容器。
 * 这里钉死识别规则 —— 尤其是容差:实测有 720×1282 这种比 9:16 差 0.1% 的录制文件,
 * 判成"其他"就会退回兜底显示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ratioClassOf, ratioMatches, videoFileMeta, ratioLabel, RATIO_TOLERANCE } from '../server/videoMeta.js';

test('T-VM-1 仓库真实文件的档位:9:16 是主干,3:4 与横屏各有几支', () => {
  // 逐个来自实测(解析 MP4 的 tkhd 得到),不是假设
  assert.equal(ratioClassOf(720, 1280), 'portrait-9x16');   // 舞蹈3/5/7、copyDance1、开场…
  assert.equal(ratioClassOf(540, 960), 'portrait-9x16');    // rokoko 开场
  assert.equal(ratioClassOf(720, 1282), 'portrait-9x16');   // Copydance2 / dance3:差 0.1%,必须在容差内
  assert.equal(ratioClassOf(832, 1108), 'portrait-3x4');    // videos/舞蹈1.mp4
  assert.equal(ratioClassOf(1080, 1440), 'portrait-3x4');   // 舞蹈8/9 的源文件(3:4,不是 9:16)
  assert.equal(ratioClassOf(768, 576), 'landscape');        // 训练视频/闪身步.mp4
  assert.equal(ratioClassOf(1920, 1080), 'landscape');      // 将来可能导入的
});

test('T-VM-2 容差边界:±2% 内算同类,超出就算别的', () => {
  assert.equal(RATIO_TOLERANCE, 0.02);
  // 9:16 = 0.5625。±2% 的区间是 0.55125 … 0.57375;取高 1000 时对应宽 551.25…573.75,
  // 所以 551(Δ=2.04%)与 574(Δ=2.04%)都在区间外,552…573 才在内。
  assert.equal(ratioClassOf(573, 1000), 'portrait-9x16');   // +1.87%
  assert.equal(ratioClassOf(574, 1000), 'landscape');       // +2.04%,刚出界
  assert.equal(ratioClassOf(551, 1000), 'landscape');       // -2.04%,刚出界
  assert.equal(ratioClassOf(552, 1000), 'portrait-9x16');   // -1.87%
  assert.equal(ratioMatches(0.5625, 9 / 16), true);
  assert.equal(ratioMatches(0.57, 9 / 16), true);
  assert.equal(ratioMatches(0.6, 9 / 16), false);
});

test('T-VM-3 垃圾输入不崩、不误判:返回 null 让页面走兜底', () => {
  for (const [w, h] of [[null, null], [0, 0], [720, null], [null, 1280], [-720, 1280], ['a', 'b'], [NaN, 1280]]) {
    assert.equal(ratioClassOf(w, h), null, `(${w}, ${h}) 应判为未知`);
  }
});

test('T-VM-4 videoFileMeta:保留宽高、算出比例,探测失败给全 null', () => {
  assert.deepEqual(videoFileMeta({ width: 720, height: 1280, duration: 30.4 }), {
    width: 720, height: 1280, ratio: 0.5625, ratioClass: 'portrait-9x16', duration: 30,
  });
  assert.deepEqual(videoFileMeta({ width: 768, height: 576, duration: 9 }), {
    width: 768, height: 576, ratio: 1.3333, ratioClass: 'landscape', duration: 9,
  });
  // ffmpeg 认不出这个文件 → 不能瞎填比例,页面会按兜底(不裁剪)显示
  assert.deepEqual(videoFileMeta(null), { width: null, height: null, ratio: null, ratioClass: null, duration: null });
  assert.deepEqual(videoFileMeta({}), { width: null, height: null, ratio: null, ratioClass: null, duration: null });
});

test('T-VM-5 后台文案:人能一眼看出横竖与分辨率,认不出来时说人话', () => {
  assert.equal(ratioLabel(720, 1280), '9:16 竖屏 · 720×1280');
  assert.equal(ratioLabel(832, 1108), '3:4 竖屏 · 832×1108');
  assert.equal(ratioLabel(768, 576), '横屏 · 768×576');
  assert.equal(ratioLabel(null, null), '比例未知');
});
