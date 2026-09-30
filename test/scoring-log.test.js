// 冒烟测试:验证帧级采集 + finalizeScoringLog 结构(无浏览器依赖)。
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

console.log('scoring-log 冒烟测试通过');
