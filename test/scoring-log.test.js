// 冒烟测试:验证帧级采集 + finalizeScoringLog 结构(无浏览器依赖)。
// localStorage 用内存桩:scoring-config 的 saveConfig/loadConfig 要读写它。
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
import { createScoringLog, recordScoringFrame, finalizeScoringLog } from '../web_dance/scoring-log.js';

const log = createScoringLog();
if (!log || !Array.isArray(log.frames)) throw new Error('createScoringLog 结构错误');

for (let i = 0; i < 100; i++) {
  recordScoringFrame(log, {
    t: i * 0.033,
    acc: 0.7 + Math.sin(i) * 0.2,
    conf: 0.9,
    bones: new Array(32).fill(0.7),
  });
}
if (log.frames.length !== 100) throw new Error(`帧数不对: ${log.frames.length}`);

const payload = finalizeScoringLog(log, { score: 123, grade: 'A' }, { dance: 'hiphop', song: 'pop-demo' });
if (!payload || payload.schema !== 'scoring-log/v1') throw new Error('schema 不对');
if (payload.frames.length !== 100) throw new Error('payload 帧数不对');
if (payload.result.grade !== 'A') throw new Error('result 不对');
if (payload.context.dance !== 'hiphop') throw new Error('context 不对');
if (!Number.isFinite(payload.frames[50].t) || payload.frames[50].bones.length !== 32) throw new Error('帧字段不对');

// 空 log 应返回 null(不产生空文件)
if (finalizeScoringLog(createScoringLog(), {}, {}) !== null) throw new Error('空 log 应为 null');

// 开关行为:关闭时不得有任何采集开销,也不得产出 log(否则会上报几 MB)。
// 逐骨计算是每帧 map+归一化,是最贵的一段,所以断言它一次都不被调用。
const { ScoringAdapter } = await import('../web_dance/scoring-adapter.js');
const { defaultConfig, saveConfig, loadConfig } = await import('../web_dance/scoring-config.js');

const BONES = 10;
const bone = (v) => new Array(BONES).fill(0).map((_, k) => (k === 0 ? [0, v, 0] : [0, 0, v]));
const seq = {
  meta: { fps: 30 },
  frames: Array.from({ length: 60 }, (_, i) => ({ t: i / 30, bones: bone(1), conf: new Array(BONES).fill(0.9) })),
};
const chart = { notes: [{ moveId: 'm1', t: 0.5 }] };

// 默认必须关闭
if (defaultConfig().monitorLog !== false) throw new Error('落盘监测应默认关闭');
let a = new ScoringAdapter(seq, chart);
if (a.log !== null) throw new Error('关闭时 adapter 不应创建采集缓冲');
// 逐骨计算一次都不许跑
let boneCalls = 0;
const orig = a._boneSims.bind(a);
a._boneSims = (...args) => { boneCalls++; return orig(...args); };
for (let i = 0; i < 60; i++) a.judge(i / 30, seq.frames[i]);
a.advance(2);
if (boneCalls !== 0) throw new Error(`关闭时仍算了 ${boneCalls} 次逐骨相似度`);
// main.js 用 if (r.log) 判假值,所以 null / undefined 都算"不上报"
if (a.finalize().log) throw new Error('关闭时 finalize 不应带 log(否则会误上报)');

// 打开后恢复采集
saveConfig({ ...loadConfig(), monitorLog: true });
a = new ScoringAdapter(seq, chart);
if (!a.log) throw new Error('开启后应创建采集缓冲');
for (let i = 0; i < 60; i++) a.judge(i / 30, seq.frames[i]);
a.advance(2);
const onLog = a.finalize().log;
if (!onLog || onLog.frames.length !== 60) throw new Error('开启后应采集到帧');
if (onLog.frames[10].bones.length !== BONES) throw new Error('逐骨数据长度不对');

// 对局中途关掉应丢弃缓冲
a = new ScoringAdapter(seq, chart);
a.applyConfig({ ...loadConfig(), monitorLog: false });
if (a.log !== null) throw new Error('中途关闭应丢弃采集缓冲');
// 中途打开应开始采集
a = new ScoringAdapter(seq, { ...chart });
a.applyConfig({ ...loadConfig(), monitorLog: true });
if (!a.log) throw new Error('中途开启应新建缓冲');

saveConfig(defaultConfig());
console.log('scoring-log 冒烟测试通过');
