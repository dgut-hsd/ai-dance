/**
 * test/pose-lane.test.js — 右下角判定轨道(姿势提示卡)的纯逻辑测试。
 *
 * 目的:把「之前描述的细节」逐条变成可执行的断言,判断它们到底是坑还是错觉。
 * 被测模块:web_dance/pose-lane.js(main.js 只负责把它的计划落到 DOM)。
 * 运行:npm test  或  node --test test/pose-lane.test.js
 *
 * 结论速查(细节 → 判定):
 *   坑1 标签 off-by-one   → 真坑(首个音符 t>0 的谱面:标签指第 2 个动作、进度条卡 0)→ 已修:标签跟 events[0],
 *                          进度条改用 2.4s 入场窗口
 *   坑2 moveId 是机器串   → 真坑(体验问题),编辑器不给改 id → 卡片上永远显示 hiphop-3000 / m-1790…(未修:要产品决定)
 *   坑3 空事件仍显示卡片 → 真坑但只有序列完全没有 frames 时才可达 → 未修(main.js 行为需要产品决定)
 *   坑4 小屏 CSS 与常量漂移 → 真坑(剪影压到 78.9%、箭头越界)→ 已修:画布/映射/箭头全按量出来的真实盒子
 *   坑5 同 t 事件撞 key   → 机制上存在,曲库无重复时刻 → 低风险(未修)
 *   坑6 箭头角度镜像      → 真坑:上举画成向下箭头、下蹲画成向上箭头 → 已修:atan2(dx, -dy)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import {
  ARROW_CLAMP_INSET, ARROW_CLAMP_MIN_Y, ARROW_PUSH_PX, LANE_FALLBACK_STEP_SEC, LANE_FIG_H, LANE_FIG_W,
  LANE_LEAD_SEC, LANE_MOTION_MIN, LANE_STAGE_LIFT_MAX,
  activePoseSource, arrowFacing, beatDurFor, computePoseEvents, fallbackPoseEvents,
  frameAtTime, laneArrowSpec, laneCanvasSize, laneEventKey, laneFigureBox, laneFigTranslateX,
  laneFigX, laneJointToPixel, laneLabelState, lanePxPerSec, laneStageLift, planPoseLaneFrame,
  poseLaneGate, shouldWriteProgress, shouldWriteStageLift,
} from "../web_dance/pose-lane.js";
import { parseChart } from "../scoring/src/chartCodec.js";
import { makeReference, STANDARD_BEATS } from "../scoring/tests/helpers/synthetic.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 真实曲库里的参考序列(frames + chart),index.json 与独立 .chart.json 自动排除 */
function songs() {
  const dir = join(ROOT, "songs");
  const out = [];
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    if (!statSync(sub).isDirectory()) continue;
    for (const file of readdirSync(sub)) {
      if (!file.endsWith(".json") || file.endsWith(".chart.json")) continue;
      const seq = JSON.parse(readFileSync(join(sub, file), "utf8"));
      if (seq?.frames?.length && seq?.chart?.notes?.length) out.push({ id: `${name}/${file}`, seq });
    }
  }
  assert.ok(out.length >= 3, "至少要能读到 3 支真实舞曲");
  return out;
}

/** 一份最小合法谱面事件(等同 parseChart 的产物形状) */
function ev(t, moveId = `m${t}`) {
  return { t, moveId, targetT: t };
}

const plan = (events, t, extra = {}) =>
  planPoseLaneFrame({ events, t, trackW: 396, beatDur: 0.5, hasSource: true, hasTrack: true, ...extra });

/** 一具站着的人形关节(canonical 坐标:y 向上) */
function figure({ wrist = [0, 1.5, 0], hips = [0, 1.0, 0], ankleY = 0.1 } = {}) {
  return {
    hips_center: hips,
    shoulders_center: [0, 1.55, 0],
    nose: [0, 1.75, 0],
    left_shoulder: [-0.2, 1.55, 0], right_shoulder: [0.2, 1.55, 0],
    left_elbow: [-0.25, 1.3, 0], right_elbow: [0.25, 1.3, 0],
    left_wrist: wrist, right_wrist: [0.25, 1.1, 0],
    left_hip: [-0.15, 1.0, 0], right_hip: [0.15, 1.0, 0],
    left_knee: [-0.15, 0.6, 0], right_knee: [0.15, 0.6, 0],
    left_ankle: [-0.15, ankleY, 0], right_ankle: [0.15, ankleY, 0],
  };
}

/** 用「动作点前一个姿势」造箭头 spec */
function arrowFor({ from, to, figW = LANE_FIG_W, figH = LANE_FIG_H }) {
  const now = figure({ wrist: to });
  return laneArrowSpec({
    nodeT: 1, jointsNow: now, figW, figH,
    jointsAt: (t) => (t < 1 ? figure({ wrist: from }) : now),
  });
}

const deg2 = (d) => Math.round(d * 100) / 100;
const deg3 = (d) => Math.round(d * 1000) / 1000;

// ---------------------------------------------------------------------------
// 1. 门控:什么时候出现
// ---------------------------------------------------------------------------

test("门控: 只有 challenge/pk 且 running 才给出判定数据源", () => {
  assert.equal(activePoseSource({ mode: "free", challenge: { running: true, seq: {} } }), null);
  assert.equal(activePoseSource({ mode: "performance", challenge: { running: true, seq: {} } }), null);
  assert.equal(activePoseSource({ mode: "challenge", challenge: { running: false, seq: {} } }), null);
  assert.equal(activePoseSource({ mode: "challenge", challenge: { running: true } }), null, "没有谱面序列就不显示");
  assert.deepEqual(
    activePoseSource({ mode: "challenge", challenge: { running: true, seq: "S", session: { songTime: 3.5 } } }),
    { seq: "S", t: 3.5 },
  );
  assert.deepEqual(
    activePoseSource({ mode: "pk", challenge: { running: true, seq: "S" } }),
    { seq: "S", t: 0 },
    "pk 模式也显示;songTime 缺省算 0",
  );
  assert.equal(activePoseSource(undefined), null);
});

test("门控: 四个开关(?nohint / 视频模式 / 没有轨道 DOM / 没有数据源)任一关闭都隐藏并清空", () => {
  const base = { events: [ev(1)], t: 0, hasSource: true, hasTrack: true };
  for (const patch of [{ disabled: true }, { videoSide: true }, { hasTrack: false }, { hasSource: false }]) {
    const p = planPoseLaneFrame({ ...base, ...patch });
    assert.equal(p.hidden, true, JSON.stringify(patch));
    assert.equal(p.clear, true, JSON.stringify(patch));
    assert.deepEqual(p.figs, []);
    assert.equal(p.label, null);
  }
  assert.equal(poseLaneGate({ hasSource: true, hasTrack: true }), true);
  assert.equal(planPoseLaneFrame(base).hidden, false);
});

// ---------------------------------------------------------------------------
// 2. 几何:提前量 / 入场 / 抵达 / 高亮
// ---------------------------------------------------------------------------

test("几何: 提前量 2.4s,轨道右端入场、平台中心(x=46)抵达", () => {
  const trackW = 396;
  const pxPerSec = lanePxPerSec(trackW);
  assert.equal(pxPerSec, (trackW - 46) / LANE_LEAD_SEC);
  assert.equal(laneFigX(LANE_LEAD_SEC, pxPerSec), trackW, "入场瞬间剪影中心正好在轨道右边缘");
  assert.equal(laneFigX(0, pxPerSec), 46, "抵达瞬间剪影中心在判定平台中心");
  assert.equal(lanePxPerSec(0), (396 - 46) / LANE_LEAD_SEC, "clientWidth 读不到时兜底 396");
  assert.ok(lanePxPerSec(10) >= 1, "极窄轨道也不会出现 0/负速度");
});

test("几何: 只渲染 [t-0.05, t+2.4] 的事件;过期未画的不补画,画了的会收尾", () => {
  const events = [ev(0.5, "a"), ev(5, "b"), ev(12, "c")];
  const p = plan(events, 3);
  assert.deepEqual(p.figs.map((f) => f.key), ["5.000"], "过期的 a 不补画,超前的 c 还没入场");
  const tracked = plan(events, 3, { trackedKeys: ["0.500"] });
  assert.deepEqual(tracked.figs.map((f) => f.key), ["0.500", "5.000"]);
  assert.equal(tracked.figs[0].arrive, true, "跳帧/切后台后过期元素会被判为已抵达 → 淡出移除,不会永久挂在轨道上");
  const orphan = plan(events, 3, { trackedKeys: ["0.500", "99.000"] });
  assert.deepEqual(orphan.remove, ["99.000"], "不在视野里的 key 会被回收");
});

test("几何: 抵达阈值 dt<=0、高亮阈值 dt<=0.45,且越早的动作越靠左", () => {
  const events = [ev(10, "a")];
  const at = (t) => plan(events, t, { trackedKeys: t > 10 ? ["10.000"] : [] }).figs[0];
  assert.equal(at(7.61).arrive, false, "dt=2.39 刚入场,还没到平台");
  assert.equal(at(9.5).near, false, "dt=0.5 还不高亮");
  assert.equal(at(9.55).near, true, "dt≈0.45 进入高亮");
  assert.equal(at(10).arrive, true);
  assert.equal(at(10).x, 46);
  // 边界本身是浮点敏感的(10-7.6 = 2.4000000000000004 > 2.4 → 这一帧不画),只影响 1 帧,无实害
  assert.equal(at(7.6), undefined);
  assert.equal(plan(events, 7.6 + 1e-6).figs.length, 1);
  const two = plan([ev(1, "a"), ev(2, "b")], 0);
  assert.ok(two.figs[0].x < two.figs[1].x, "越早的动作越靠左(更接近平台)");
});

// ---------------------------------------------------------------------------
// 3. 坑1(已修):第一个动作之前的标签 / 进度条
// ---------------------------------------------------------------------------

test("坑1 已修复: 首个动作之前标签指向 events[0],进度条用 2.4s 入场窗口走满", () => {
  const events = [ev(4, "A"), ev(5, "B"), ev(6, "C")];
  const t = 2.0;
  const p = plan(events, t);
  assert.deepEqual(p.figs.map((f) => f.ev.moveId), ["A"], "轨道上正在飞来的是 A");
  assert.equal(p.label.moveId, "A", "标签必须跟着轨道上飞来的那个动作");
  assert.equal(p.label.text, "A · 2.0s");
  // 进度条:1 - remain/2.4 → 剩 2.4s 时 0%,抵达时 100%
  assert.equal(deg3(p.progress), deg3(1 - 2 / LANE_LEAD_SEC));
  const lab = laneLabelState(events, t);
  assert.equal(lab.beforeFirst, true);
  assert.equal(lab.cur, null, "第一个动作之前没有「上一个节点」");
  assert.equal(lab.next, events[0]);
  assert.equal(lab.up, events[0]);
  // 单调递增,到点正好走满
  let last = -1;
  for (let tt = 0; tt < 4; tt += 0.1) {
    const q = laneLabelState(events, tt).progress;
    assert.ok(q >= last - 1e-9, `进度条在 t=${tt.toFixed(1)} 倒退了`);
    last = q;
  }
  assert.equal(deg3(last), deg3(1 - 0.1 / LANE_LEAD_SEC));
});

test("坑1 已修复: 任何时刻的标签都指向「下一个待做动作」,进度条起点不落在未来", () => {
  const cases = [
    [ev(4, "A"), ev(5, "B"), ev(6, "C")],   // 首个音符 > 0(旧实现错位)
    [ev(0, "A"), ev(1, "B")],               // 与真实曲库同形
    [ev(0, "A")],                           // 只有一个动作点
  ];
  for (const events of cases) {
    const end = events.at(-1).t + 1;
    for (let t = 0; t <= end; t += 0.05) {
      const lab = laneLabelState(events, t);
      const upcoming = events.find((e) => e.t > t);
      assert.equal(lab.up.moveId, (upcoming ?? events.at(-1)).moveId,
        `t=${t.toFixed(2)}: 标签应指向下一个待做动作`);
      assert.ok(lab.cur === null || lab.cur.t <= t + 1e-9, `t=${t.toFixed(2)}: 进度条起点在未来`);
      assert.equal(lab.cur === null, t < events[0].t, `t=${t.toFixed(2)}: beforeFirst 与 cur 应一致`);
      assert.ok(lab.progress >= 0 && lab.progress <= 1);
    }
  }
});

test("坑1 数据核查: 曲库三支舞的首个动作都在 t=0(修复前后行为一致,不会改变现有手感)", () => {
  // 作品工坊里铺点的新舞曲可以故意留前奏(songs/dance 前 3s 是给玩家的缓冲,
  // 开局不该就进判定),那种歌走 beforeFirst 分支是预期行为。所以"首个动作在 0"
  // 只对下面这几支断言 —— 否则每加一支带前奏的新舞曲都会误报。
  const NO_LEAD_IN = new Set([
    "hiphop", "salsa", "demo-arena-loop", "copydance1", "dance3-mixamo", "dance1-video",
  ]);
  for (const { id, seq } of songs()) {
    if (!NO_LEAD_IN.has(id.split("/")[0])) continue;
    const t0 = seq.chart.notes[0].t;
    assert.equal(t0, 0, `${id} 首个音符 t=${t0}`);
    const events = parseChart(seq, seq.chart);
    for (let t = 0; t <= events.at(-1).t; t += 0.25) {
      const lab = laneLabelState(events, t);
      assert.equal(lab.beforeFirst, false, `${id}: 首个音符在 0,不该走 beforeFirst 分支`);
      assert.ok(lab.cur.t <= t + 1e-9, `${id} t=${t.toFixed(2)}: 进度条起点落在未来`);
    }
  }
});

// ---------------------------------------------------------------------------
// 参考帧寻址不变量:判定音符的时间必须落在它所绑定的那一帧上
// ---------------------------------------------------------------------------

test("不变量: 每个判定音符的参考帧时间与 note.t 相差 <= 0.05s", () => {
  // 这条守的是「帧下标怎么算」。帧自带 t,按 t 找最近帧即可;
  // 一旦有人用 t*fps 反推下标,遇到抽帧不均匀的序列(视频工坊导入的 VFR 源)
  // 下标会随时间线性漂移 —— songs/dance 曾整体偏早 3.2s,中位 2.0s,
  // 玩家等于在跟三秒前的姿态比对,但运行时没有任何异常,只能靠肉眼看分数不对。
  // 阈值 0.05s:现有曲库实测最大 0.0333s(末音符越界钳位所致),留约 50% 余量。
  const TOLERANCE_SEC = 0.05;
  for (const { id, seq } of songs()) {
    for (const e of parseChart(seq, seq.chart)) {
      const frame = seq.frames[e.refFrameIdx];
      assert.ok(frame, `${id}: t=${e.t} 的 refFrameIdx=${e.refFrameIdx} 越界`);
      const drift = Math.abs(e.t - frame.t);
      assert.ok(
        drift <= TOLERANCE_SEC,
        `${id}: t=${e.t} 的参考帧在 ${frame.t.toFixed(3)}s,偏 ${drift.toFixed(3)}s —— ` +
        `refFrameIdx 绑错了帧(阈值 ${TOLERANCE_SEC}s)`,
      );
    }
  }
});

test("不变量: 无 refFrameIdx 的谱面按最近帧解析,不按 t*fps 反推", () => {
  // 抽帧不均匀的序列:meta.fps 是个骗人的标量,只有帧自己的 t 可信。
  const frames = [
    { t: 0, bones: ["a0"] },
    { t: 0.033, bones: ["a1"] },
    { t: 0.067, bones: ["a2"] },
    { t: 0.5, bones: ["b0"] },   // 这里丢了一堆帧,间隔 0.43s
    { t: 0.533, bones: ["b1"] },
  ];
  const seq = { frames, meta: { fps: 30 } };
  const chart = { version: "chart/v2", notes: [{ t: 0.52 }] };
  // t*fps 反推会得到 round(0.52*30)=16 -> 越界;按 t 查最近帧应命中 t=0.533
  assert.equal(parseChart(seq, chart)[0].refFrameIdx, 4);
  assert.equal(parseChart(seq, chart)[0].targetBones[0], "b1");
});

test("坑2(确认): 标签文字就是 note.id;缺 id 时回退成 type-下标(不是人类可读动作名)", () => {
  const seq = makeReference(STANDARD_BEATS, "unit", 30);
  const chart = { version: "chart/v2", notes: [{ t: 0, id: "举手" }, { t: 1 }] };
  const withIds = { ...seq, chart };
  assert.deepEqual(parseChart(withIds, chart).map((e) => e.moveId), ["举手", "pose-1"]);
  // gesture 型会被跳过,但下标仍是 notes 数组的下标 → 序号会跳号
  const gchart = { version: "chart/v2", notes: [{ t: 0, type: "gesture" }, { t: 1 }] };
  assert.deepEqual(parseChart({ ...seq, chart: gchart }, gchart).map((e) => e.moveId), ["pose-1"]);
  // 标签只做字符串拼接,谱面没写 id 时"名字"就是这些机器串
  assert.equal(laneLabelState([{ t: 0, moveId: "pose-1" }, ev(1, "pose-2")], 0.4).text, "pose-2 · 0.6s");
});

test("坑2 数据核查: 老谱面 note.id 仍是机器串(编辑器之后新做的舞曲用可读名)", () => {
  // 编辑器支持「给判定点起名字」之前就在曲库里的这几支:note.id 是机器串,且不该被顺手迁移过。
  // 之后在工坊里新做的舞曲(铺点/动捕出来的)用可读名是预期行为,所以"必须是机器串"
  // 这条只对老曲库断言 —— 否则每加一支新舞曲都会误报。
  const LEGACY = new Set(["hiphop", "salsa", "demo-arena-loop", "copydance1"]);
  for (const { id, seq } of songs()) {
    const isLegacy = LEGACY.has(id.split("/")[0]);
    for (const n of seq.chart.notes) {
      assert.equal(typeof n.id, "string", `${id}: note.id 应为字符串`);
      assert.ok(n.id.length > 0, `${id}: note.id 不应为空`);
      if (!isLegacy) continue;
      assert.ok(
        !/[\u4e00-\u9fa5]/.test(n.id),
        `${id}: ${n.id} 居然是可读中文?那这条"老谱面 id 是机器串"的结论要更新`,
      );
    }
  }
  const editor = read("web_dance", "chart-editor.js");
  // 已修:新增判定点/自动铺点的默认名可读,属性面板提供「动作名」输入框 → 写进 note.id
  assert.match(editor, /id: `动作 \$\{state\.notes\.length \+ 1\}`, t: \+t\.toFixed\(3\)/, "手放判定点默认给可读名");
  assert.match(editor, /id: `动作 \$\{i \+ 1\}`/, "自动铺点默认给可读名");
  assert.match(editor, /id="pName"/, "属性面板有动作名输入框");
  assert.match(editor, /n\.id = v; else delete n\.id/, "清空动作名则回退成 pose-N");
  assert.ok(!/id: `m-\$\{Date\.now\(\)\}`/.test(editor), "不该再默认生成 m-<时间戳> 这种机器名");
});

// ---------------------------------------------------------------------------
// 5. 坑3:事件为空时卡片仍然可见(空轨道)
// ---------------------------------------------------------------------------

test("坑3(确认): 事件为空时卡片不隐藏也不清空 —— 留下一条空轨道", () => {
  const p = planPoseLaneFrame({ events: [], t: 0, hasSource: true, hasTrack: true });
  assert.equal(p.hidden, false, "main.js 会 remove('hidden') → 卡片显示出来");
  assert.equal(p.empty, true, "靠 empty 早退");
  assert.equal(p.clear, false, "轨道上已有的元素不会被清掉");
  assert.equal(p.label, null, "标签/进度条/平台都不更新,保持上一帧或初始空态");
});

test("坑3 可达性: 只有序列完全没有 frames 才会事件为空(谱面坏掉会静默降级,不会空)", () => {
  assert.deepEqual(computePoseEvents({ frames: [] }), []);
  assert.deepEqual(computePoseEvents(null), []);
  const seq = makeReference(STANDARD_BEATS, "unit", 30);
  const broken = { ...seq, chart: { version: "chart/v2", notes: [{ t: 0, type: "gesture" }, { t: 1, type: "gesture" }] } };
  const events = computePoseEvents(broken);
  assert.ok(events.length > 0, "全 gesture 谱面会解析失败 → 静默回退成 0.5s 采样,玩家看不到任何报错");
  assert.equal(events.length, fallbackPoseEvents(broken).length);
  for (const { id, seq: real } of songs()) {
    assert.ok(real.frames.length > 0, `${id} 没有 frames(空轨道可达!)`);
    assert.ok(computePoseEvents(real).length > 0, `${id} 事件为空`);
  }
});

test("回退采样: 无谱面时每 0.5s 一个动作点(fps 30 → 每 15 帧)", () => {
  const seq = makeReference(STANDARD_BEATS, "unit", 30); // 0..3s,91 帧
  const events = fallbackPoseEvents(seq);
  assert.equal(events.length, Math.ceil(seq.frames.length / 15));
  assert.deepEqual(events.slice(0, 3).map((e) => e.t), [0, 0.5, 1]);
  assert.deepEqual(fallbackPoseEvents({ frames: [] }), []);
});

// ---------------------------------------------------------------------------
// 6. 坑5:同一时刻的事件撞 key
// ---------------------------------------------------------------------------

test("坑5(机制存在 / 低风险): 同 t 与亚毫秒差的事件共用 key,laneFigs 里会互相覆盖", () => {
  assert.equal(laneEventKey(1.0001), laneEventKey(1.0004), "toFixed(3) 把亚毫秒差抹平");
  const p = plan([ev(1, "a"), ev(1, "b")], 0.5);
  assert.equal(p.figs.length, 2);
  assert.equal(p.figs[0].key, p.figs[1].key, "两个剪影抢同一个 Map 键 → 只会留下一个");
  const near = plan([ev(1.0004, "a"), ev(1.0001, "b")], 0.5);
  assert.equal(near.figs[0].key, near.figs[1].key);
});

test("坑5 数据核查: 曲库没有重复时刻、也没有亚毫秒撞键的动作点", () => {
  for (const { id, seq } of songs()) {
    const keys = seq.chart.notes.map((n) => laneEventKey(n.t));
    assert.equal(new Set(keys).size, keys.length, `${id} 有动作点撞键`);
  }
});

// ---------------------------------------------------------------------------
// 7. 坑6(已修):箭头角度竖直镜像
// ---------------------------------------------------------------------------

test("坑6 已修复: 箭头真正指向运动方向(上举朝上、落下朝下、横甩朝外)", () => {
  const up = arrowFor({ from: [0, 1.0, 0], to: [0, 1.6, 0] });   // 手腕抬起
  const down = arrowFor({ from: [0, 1.6, 0], to: [0, 1.0, 0] }); // 手腕落下
  const right = arrowFor({ from: [0.25, 1.4, 0], to: [0.62, 1.4, 0] }); // 横向甩出

  // 位置偏移的符号(屏幕坐标 y 向下)与角度必须一致
  assert.ok(up.dy < -0.9, `上举的 dy 应为屏幕向上,实际 ${up.dy}`);
  assert.ok(down.dy > 0.9, `落下的 dy 应为屏幕向下,实际 ${down.dy}`);
  // 屏幕上真正的指向 = (sinθ, -cosθ),要和运动方向同向(dot > 0.9)
  const dot = (spec, mx, my) => {
    const f = arrowFacing(spec.deg);
    return f.x * mx + f.y * my;
  };
  assert.ok(dot(up, 0, -1) > 0.9, `上举的箭头方向不对(deg=${deg2(up.deg)})`);
  assert.ok(dot(down, 0, 1) > 0.9, `落下的箭头方向不对(deg=${deg2(down.deg)})`);
  assert.ok(arrowFacing(right.deg).x > 0.5, `横向动作的箭头方向不对(deg=${deg2(right.deg)})`);
  assert.equal(deg2(up.deg), 0, "上举 → 0°(基准箭头朝上)");
  assert.equal(deg2(down.deg), 180, "落下 → 180°");
});

test("坑6 回归锁: pose-lane.js 只能写 atan2(dx, -dy)", () => {
  const src = read("web_dance", "pose-lane.js");
  assert.match(src, /Math\.atan2\(dx, -dy\)/);
  assert.doesNotMatch(src, /Math\.atan2\(dx, dy\)/, "别再把屏幕方向的 y 喂给「基准朝上」的旋转公式");
  assert.doesNotMatch(src, /atan2\(dx, uy\)/);
});

test("箭头: 定住造型不标箭头;首个动作没有过去姿势时,用往后 0.4s 的起手方向", () => {
  const still = figure({ wrist: [0, 1.4, 0] });
  assert.equal(laneArrowSpec({ nodeT: 1, jointsNow: still, jointsAt: () => still }), null);
  const now = figure({ wrist: [0, 1.4, 0] });
  const later = figure({ wrist: [0, 1.7, 0] });
  const spec = laneArrowSpec({
    nodeT: 0, firstT: 0, jointsNow: now, jointsAt: (t) => (t > 0 ? later : now),
  });
  assert.equal(spec.joint, "left_wrist");
  assert.ok(spec.mag >= LANE_MOTION_MIN);
  // 慢舞:0.4s 窗口位移不足时自动拉长到 0.8s
  const slowFrom = figure({ wrist: [0, 1.30, 0] }); // 0.4s 前只差 0.04 → 不足阈值
  const slowNow = figure({ wrist: [0, 1.40, 0] });
  const slow = laneArrowSpec({
    nodeT: 1, firstT: -10, jointsNow: slowNow,
    jointsAt: (t) => (t > 1 - 0.6 ? slowFrom : slowNow),
  });
  assert.ok(slow && slow.joint === "left_wrist", "0.8s 回溯窗口把慢动作也标出来");
});

test("箭头锚点: 给了 manifest 的关节像素就直接用它(不再靠包围盒反推)", () => {
  const now = figure({ wrist: [0, 1.6, 0] });
  const jointsAt = (t) => (t < 1 ? figure({ wrist: [0, 1.0, 0] }) : now); // 手腕抬起 → best = left_wrist
  // 夸张地给一组"和包围盒完全不同"的像素:只有真的用了它,x 才会等于 200
  const spec = laneArrowSpec({
    nodeT: 1, jointsNow: now, jointsAt, figW: 300, figH: 400,
    jointPixels: { left_wrist: [200, 40], hips_center: [200, 120] },
  });
  assert.equal(spec.joint, "left_wrist");
  assert.equal(spec.x, 200, "x 必须来自 manifest 像素");
  assert.equal(spec.y, ARROW_CLAMP_MIN_Y, "向上推出 36px 后被夹回框内顶部");
  const bboxX = laneJointToPixel(now, "left_wrist", 1, 300, 400).x;
  assert.notEqual(spec.x, bboxX, "与包围盒映射的结果不同 → 证明走的是 manifest 锚点");
  assert.ok(spec.dy < -0.9, "方向仍是屏幕向上");

  // 只给部分关节:缺 hips_center 时 body 退回包围盒映射,不崩、方向仍对
  const partial = laneArrowSpec({
    nodeT: 1, jointsNow: now, jointsAt, figW: 98, figH: 142, jointPixels: { left_wrist: [50, 20] },
  });
  assert.ok(Math.abs(partial.x - 50) < 10, `锚点应贴近给定像素(实际 ${partial.x})`);
  assert.ok(partial.dy < -0.9);
  assert.ok(partial.y >= ARROW_CLAMP_MIN_Y);

  // 完全不给 → 与旧行为一致(包围盒映射)
  const fallback = laneArrowSpec({ nodeT: 1, jointsNow: now, jointsAt, figW: 98, figH: 142 });
  assert.equal(fallback.joint, "left_wrist");
  assert.equal(fallback.x, laneJointToPixel(now, "left_wrist", 1, 98, 142).x);
  assert.ok(ARROW_PUSH_PX > 0);
});

test("箭头: 被夹在剪影框内,不会飞出轨道被裁掉", () => {
  const spec = arrowFor({ from: [0.22, 0.9, 0], to: [0.22, 1.72, 0] });
  assert.ok(spec.x >= ARROW_CLAMP_INSET && spec.x <= LANE_FIG_W - ARROW_CLAMP_INSET, `x=${spec.x}`);
  assert.ok(spec.y >= ARROW_CLAMP_MIN_Y && spec.y <= LANE_FIG_H - ARROW_CLAMP_INSET, `y=${spec.y}`);
  // 箭头贴在"正在动的那个关节"旁边(推出 36px 后仍在框内)
  const anchor = laneJointToPixel(figure({ wrist: [0.22, 1.72, 0] }), "left_wrist", 1);
  assert.ok(anchor && Math.abs(spec.x - anchor.x) <= 36.1 && Math.abs(spec.y - anchor.y) <= 36.1);
});

// ---------------------------------------------------------------------------
// 8. 平台律动 / 拍长 / DOM 写入节流
// ---------------------------------------------------------------------------

test("律动: 拍点最高 6px、拍内衰减;拍长优先 beats,其次 bpm,最后 0.5s", () => {
  assert.equal(laneStageLift(0, 0.5), LANE_STAGE_LIFT_MAX);
  assert.ok(laneStageLift(0.25, 0.5) < laneStageLift(0.05, 0.5));
  assert.equal(beatDurFor({ meta: { beatTimesSec: [0, 0.6, 1.2] } }), 0.6);
  assert.equal(beatDurFor({ meta: { beatTimesSec: [0, 0.01] } }), 0.5, "拍栅格异常(<=0.05s)时退回兜底");
  assert.equal(beatDurFor({ meta: { timing: { bpm: 120 } } }), 0.5);
  assert.equal(beatDurFor({ meta: { bpm: 60 } }), 1);
  assert.equal(beatDurFor({}), 0.5);
  assert.equal(beatDurFor(null), 0.5);
});

test("节流: 标签 0.1s 粒度、进度条 0.5%、平台 0.2px —— 避免每帧写 DOM", () => {
  const events = [ev(0, "A"), ev(1, "B")];
  assert.equal(laneLabelState(events, 0.28).text, "B · 0.7s");
  assert.equal(laneLabelState(events, 0.34).text, "B · 0.7s", "同一 0.1s 刻度内文本不变 → 不写 DOM");
  assert.equal(laneLabelState(events, 0.2).text, "B · 0.8s");
  assert.equal(laneLabelState(events, 1).text, "B · 就是现在");
  assert.equal(laneLabelState(events, 99).text, "B · 就是现在", "曲终之后标签停在「就是现在」");
  assert.equal(shouldWriteProgress(0.5, 0.496), false);
  assert.equal(shouldWriteProgress(0.5, 0.49), true);
  assert.equal(shouldWriteProgress(0.1, 0.5), true, "倒回去(重开/跳段)一定要写");
  assert.equal(shouldWriteStageLift(1, 0.85), false);
  assert.equal(shouldWriteStageLift(1, 0.7), true);
});

test("frameAtTime: 按时间戳二分(导出缺帧也能取到最近帧)", () => {
  const frames = [{ t: 0 }, { t: 0.5 }, { t: 2 }];
  assert.equal(frameAtTime(frames, -1).t, 0);
  assert.equal(frameAtTime(frames, 0.2).t, 0);
  assert.equal(frameAtTime(frames, 0.3).t, 0.5, "等距平手时取后一帧");
  assert.equal(frameAtTime(frames, 1.9).t, 2);
  assert.equal(frameAtTime(frames, 99).t, 2);
  assert.equal(frameAtTime([], 1), null);
  assert.equal(frameAtTime(null, 1), null);
});

// ---------------------------------------------------------------------------
// 9. 真实曲库整段回放:不变量
// ---------------------------------------------------------------------------

test("真实曲库整段回放(60fps): 剪影数量有界、动作点全部走完、不泄漏、标签可用", (t) => {
  for (const { id, seq } of songs()) {
    const events = computePoseEvents(seq);
    const base = events[0].t;
    const end = events.at(-1).t + LANE_LEAD_SEC + 1;
    const tracked = new Map(); // key -> { arrived, removeAt }
    let maxFigs = 0, arrived = 0, created = new Set(), labelSeen = 0;
    for (let time = base; time <= end; time += 1 / 60) {
      for (const [key, v] of [...tracked]) if (v.removeAt != null && time >= v.removeAt) tracked.delete(key);
      const p = planPoseLaneFrame({
        events, t: time, trackW: 396, beatDur: beatDurFor(seq), hasSource: true,
        trackedKeys: [...tracked.keys()],
        arrivedKeys: [...tracked].filter(([, v]) => v.arrived).map(([k]) => k),
      });
      assert.equal(p.hidden, false);
      assert.equal(p.empty, false);
      maxFigs = Math.max(maxFigs, p.figs.length);
      for (const f of p.figs) {
        created.add(f.key);
        if (f.arrive) {
          arrived += 1;
          const v = tracked.get(f.key) ?? {};
          v.arrived = true; v.removeAt = time + 0.3;
          tracked.set(f.key, v);
        } else if (!tracked.has(f.key)) tracked.set(f.key, { arrived: false });
      }
      for (const key of p.remove) {
        assert.ok(!tracked.has(key) || tracked.get(key).arrived, `${id}: 把还在轨道上的剪影回收了`);
        tracked.delete(key);
      }
      const lab = laneLabelState(events, time);
      assert.ok(!/undefined|NaN/.test(lab.text), `${id}: 标签文本异常 "${lab.text}"`);
      assert.ok(lab.cur === null || lab.cur.t <= time + 1e-9, `${id}: 进度条起点在未来`);
      labelSeen += 1;
    }
    // 每个动作点都被画过、都抵达过、片尾轨道为空
    assert.equal(created.size, events.length, `${id}: 有动作点没被渲染(created=${created.size}/${events.length})`);
    assert.equal(arrived, events.length, `${id}: 有动作点没走到平台`);
    assert.equal(tracked.size, 0, `${id}: 片尾轨道仍有 ${tracked.size} 个残留剪影`);
    assert.ok(maxFigs <= 12, `${id}: 同屏剪影 ${maxFigs} 个,超出预期上限`);
    t.diagnostic(`${id}: ${events.length} 个动作点,同屏峰值 ${maxFigs} 剪影,${labelSeen} 帧无异常`);
  }
});

// ---------------------------------------------------------------------------
// 10. 坑4(已修):几何按真实盒子走,不再和小屏 CSS 漂移
// ---------------------------------------------------------------------------

/** 取出 @media(...) 块(按大括号配对,支持嵌套规则) */
function mediaBlock(css, condition) {
  const start = css.indexOf(`@media (${condition})`);
  assert.ok(start >= 0, `CSS 里找不到 @media (${condition})`);
  let i = css.indexOf("{", start), depth = 0;
  for (let j = i; j < css.length; j++) {
    if (css[j] === "{") depth += 1;
    else if (css[j] === "}" && --depth === 0) return css.slice(i, j + 1);
  }
  throw new Error("media block 未闭合");
}

function cssPx(source, selector, prop) {
  const sel = selector.replace(/[.#]/g, "\\$&");
  const m = source.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `CSS 里找不到 ${selector} 规则`);
  const v = m[1].match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  assert.ok(v, `${selector} 没有 ${prop} px 值`);
  return Number(v[1]);
}

test("坑4 已修复: 小屏声明 112 高的剪影不再被压扁 —— 画布/映射/箭头全按量出来的盒子", () => {
  const css = read("web_dance", "lane.css"); // 轨道样式已抽到 lane.css(游戏页与编辑器共用)
  const small = mediaBlock(css, "max-width: 900px");
  // CSS 没动(卡片尺寸保持原样),小屏剪影盒仍是 98x112
  assert.equal(cssPx(css, "#pose-hint", "width"), 420);
  assert.equal(cssPx(small, "#pose-hint", "width"), 330);
  assert.equal(cssPx(small, "#judge-lane", "height"), 132);
  assert.equal(cssPx(small, ".lane-fig", "height"), 112);
  assert.equal(LANE_FIG_W, 98);
  assert.equal(LANE_FIG_H, 142, "142 只是量不到时的兜底值");

  // 量盒子:量到就用真实值,量不到(隐藏/未布局)才退回常量
  assert.deepEqual(laneFigureBox({ offsetWidth: 98, offsetHeight: 112 }), { w: 98, h: 112 });
  assert.deepEqual(laneFigureBox({ offsetWidth: 0, offsetHeight: 0 }), { w: 98, h: 142 });
  assert.deepEqual(laneFigureBox({ clientWidth: 98, clientHeight: 112 }), { w: 98, h: 112 });
  assert.deepEqual(laneFigureBox(null), { w: 98, h: 142 });

  // canvas 内部分辨率 = 真实盒子 × dpr → 剪影按 98x112 的比例画,不再被 CSS 纵向压扁
  assert.deepEqual(laneCanvasSize({ w: 98, h: 112 }, 2), { width: 196, height: 224 });
  assert.deepEqual(laneCanvasSize(null, 1), { width: 98, height: 142 });

  // 居中按真实宽度算(否则 112 高的剪影会左右偏 7.5px)
  assert.equal(laneFigTranslateX(396, 98), 347);
  assert.equal(laneFigTranslateX(396, 83), 354.5);

  // 同一姿势在 142 框与 112 框里的映射不同,且箭头被夹在各自框内
  const joints = figure({ wrist: [0.22, 1.72, 0] });
  const big = laneJointToPixel(joints, "left_wrist", 1, 98, 142);
  const smallAnchor = laneJointToPixel(joints, "left_wrist", 1, 98, 112);
  assert.notEqual(deg3(big.y), deg3(smallAnchor.y), "映射必须跟着盒子变");
  const spec = laneArrowSpec({
    nodeT: 1, jointsNow: joints, figW: 98, figH: 112,
    jointsAt: () => figure({ wrist: [0.22, 0.9, 0] }),
  });
  assert.ok(spec.y >= ARROW_CLAMP_MIN_Y, `y=${spec.y}`);
  assert.ok(spec.y <= 112 - ARROW_CLAMP_INSET, `y=${spec.y} 越出 112 的可见框(旧实现夹到 136)`);
  assert.ok(spec.x >= ARROW_CLAMP_INSET && spec.x <= 98 - ARROW_CLAMP_INSET);
});

test("默认尺寸自洽: 轨道 168 = 剪影底 18 + 高 142 + 余量 8", () => {
  const css = read("web_dance", "lane.css");
  const laneH = cssPx(css, "#judge-lane", "height");
  const figBottom = cssPx(css, ".lane-fig", "bottom");
  assert.equal(laneH, 168);
  assert.equal(figBottom, 18);
  assert.equal(figBottom + LANE_FIG_H, 160);
  assert.ok(laneH > figBottom + LANE_FIG_H, "大屏下剪影完整落在轨道里");
});

// ---------------------------------------------------------------------------
// 11. 接线核查:main.js 不再自己算这些阈值,实现只留一份
// ---------------------------------------------------------------------------

test("接线核查: 游戏页把计划交给 lane-view 落地,阈值/构造逻辑不再散落在多处", () => {
  const main = read("web_dance", "main.js");
  const view = read("web_dance", "lane-view.js");
  const figure = read("web_dance", "lane-figure.js");
  assert.match(main, /from "\.\/pose-lane\.js"/);
  assert.match(main, /planPoseLaneFrame\(/);
  assert.match(main, /laneView\.update\(plan, \{/);
  assert.match(main, /trackedKeys: laneView\.trackedKeys\(\)/);
  // DOM 细节在小屏量真实盒子:只有 lane-view / lane-figure 里能出现
  for (const [name, src] of [["lane-view.js", view], ["lane-figure.js", figure]]) {
    assert.doesNotMatch(src, /atan2\(dx, dy\)/, `${name} 不该出现旧的箭头角度公式`);
  }
  assert.match(figure, /laneFigureBox\(el\)/);
  assert.match(figure, /laneCanvasSize\(/);
  assert.match(figure, /arrowFor\(box\.w, box\.h, laneAssetJointPixels\(entry, box\.h \/ entry\.h\)\)/);
  assert.match(view, /laneFigTranslateX\(f\.x, fig\.box\.w\)/);
  assert.match(view, /shouldWriteProgress\(plan\.progress, lastProgress\)/);
  assert.match(view, /shouldWriteStageLift\(plan\.stageLift, lastLift\)/);
  assert.match(view, /setTimeout\(\(\) => remove\(f\.key\), LANE_FADE_MS\)/);
  // 主流程不该再出现这些常量(都进了 pose-lane / lane-view / lane-figure)
  for (const leaked of [/LANE_LEAD_SEC\s*=/, /dt\s*<=\s*0\.45/, /Math\.exp\(-frac/, /atan2\(dx, dy\)/, /f\.x - LANE_FIG_W/]) {
    assert.doesNotMatch(main, leaked, `main.js 里又出现了 ${leaked}`);
  }
  // 下沉出去的实现不能在 main.js 里留下第二份
  for (const dup of ["function frameAtTime", "function activePoseSource", "function beatDurFor", "function laneMotionArrow", "function buildLaneFigure", "function laneArrowElement"]) {
    assert.ok(!main.includes(dup), `main.js 里还留着 ${dup}`);
  }
});

test("接线核查: main.js 从 pose-lane.js 导入的名字都真实存在(打字错会在这里炸)", async () => {
  const src = read("web_dance", "main.js");
  const m = src.match(/import\s*\{([^}]+)\}\s*from\s*"\.\/pose-lane\.js"/s);
  assert.ok(m, "main.js 没有从 pose-lane.js 导入任何东西");
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(names.length >= 4, `main.js 从 pose-lane.js 导入的名字太少(${names.length})`);
  const mod = await import("../web_dance/pose-lane.js");
  for (const name of names) assert.ok(name in mod, `pose-lane.js 没有导出 ${name}`);

  // 反向核查:main.js 不能引用"没导入的" pose-lane 导出名(注释、以及 main.js 自己的本地声明除外)。
  // 这类漏导入不会让 node --check 报错,只会在浏览器里变成 ReferenceError。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const local = new Set(
    [...code.matchAll(/\b(?:let|const|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((x) => x[1]),
  );
  for (const name of Object.keys(mod)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || names.includes(name) || local.has(name)) continue;
    assert.ok(!new RegExp(`\\b${name}\\b`).test(code),
      `main.js 用了 ${name},但它没有从 pose-lane.js 导入`);
  }
});
