import { describe, expect, it } from "vitest";
import { BONE_COUNT, DEFAULT_BONE_WEIGHTS } from "../src/schema.js";
import { makeReference, STANDARD_BEATS } from "./helpers/synthetic.js";
import {
  mergeChartIntoSequence,
  parseChart,
  parseTimingWindows,
  serializeChart,
  toStandaloneChart
} from "../src/chartCodec.js";
import { ScoringEngine } from "../src/engine.js";

const seq = makeReference(STANDARD_BEATS); // fps 30

describe("parseTimingWindows", () => {
  it("chart/v2 timingWindows -> 引擎 bands", () => {
    const bands = parseTimingWindows({ timingWindows: { perfect: 0.06, great: 0.12, good: 0.2 } });
    expect(bands.map((b) => [b.edge, b.grade, b.value])).toEqual([
      [0.06, "perfect", 1],
      [0.12, "great", 0.8],
      [0.2, "good", 0.6],
    ]);
  });
  it("缺省/非法(fs 非升序)返回 null", () => {
    expect(parseTimingWindows({})).toBeNull();
    expect(parseTimingWindows({ timingWindows: { perfect: 0.2, great: 0.12, good: 0.05 } })).toBeNull();
    expect(parseTimingWindows(null)).toBeNull();
  });
});

describe("parseChart", () => {
  it("pose 音符解析出引擎事件,字段齐全", () => {
    const ev = parseChart(seq, {
      version: "chart/v1",
      notes: [{ id: "n0", t: 1, type: "pose", refFrameIdx: 30 }],
    });
    expect(ev).toHaveLength(1);
    expect(ev[0].t).toBe(1);
    expect(ev[0].noteType).toBe("pose");
    expect(ev[0].refFrameIdx).toBe(30);
    expect(ev[0].targetBones).toEqual(seq.frames[30].bones);
    expect(ev[0].targetT).toBe(seq.frames[30].t);
    expect(ev[0].targetYaw).toBe(seq.frames[30].rootYaw);
    expect(ev[0].window).toEqual({ early: -0.25, late: 0.25 });
    expect(ev[0].weights).toEqual(DEFAULT_BONE_WEIGHTS);
    expect(ev[0].difficulty).toBe(2);
    expect(ev[0].moveId).toBe("n0");
  });
  it("refFrameIdx 缺省 = round(t*fps);v1 谱面同样兼容解析", () => {
    const ev = parseChart(seq, {
      version: "chart/v1",
      notes: [
        { id: "p1", t: 1, type: "pose" },
        { id: "p2", t: 1.5, type: "pose" },
      ],
    });
    expect(ev[0].refFrameIdx).toBe(30);
    expect(ev[0].noteType).toBe("pose");
    expect(ev[1].refFrameIdx).toBe(45);
    expect(ev[1].noteType).toBe("pose");
  });
  it("未知版本快速失败;v2 谱面正常解析", () => {
    expect(() => parseChart(seq, { version: "chart/v3", notes: [{ t: 1, type: "pose" }] }))
      .toThrow(/chart\/v1\|chart\/v2|v[12]/);
    expect(parseChart(seq, { version: "chart/v2", notes: [{ t: 1, type: "pose" }] })).toHaveLength(1);
  });
  it("bones 子集把其余骨骼权重归零", () => {
    const ev = parseChart(seq, {
      version: "chart/v1",
      notes: [{ t: 1, type: "pose", bones: [0, 1] }],
    });
    const w = ev[0].weights;
    expect(w[0]).toBe(DEFAULT_BONE_WEIGHTS[0]);
    expect(w[1]).toBe(DEFAULT_BONE_WEIGHTS[1]);
    expect(w[2]).toBe(0);
    expect(w[9]).toBe(0);
  });
  it("全局 boneWeights 作缺省表;事件级 weights 全量覆盖", () => {
    const custom = [0.4, 0.1, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05, 0.05, 0.0];
    const perEvent = new Array(BONE_COUNT).fill(1).map((_, i) => (i % 2 === 0 ? 0.2 : 0.0));
    const ev = parseChart(seq, {
      version: "chart/v1",
      boneWeights: custom,
      notes: [
        { t: 1, type: "pose" },
        { t: 1.5, type: "pose", weights: perEvent },
      ],
    });
    expect(ev[0].weights).toEqual(custom);
    expect(ev[1].weights).toEqual(perEvent);
  });
  it("乱序 notes 按 t 升序", () => {
    const ev = parseChart(seq, {
      version: "chart/v1",
      notes: [
        { t: 2, type: "pose" },
        { t: 0, type: "pose" },
        { t: 1, type: "pose" },
      ],
    });
    expect(ev.map((e) => e.t)).toEqual([0, 1, 2]);
  });
  it("全部 gesture 被跳过 → 抛错", () => {
    expect(() =>
      parseChart(seq, { version: "chart/v2", notes: [{ t: 1, type: "gesture" }] })
    ).toThrow(/无可用事件/);
  });
  it("非法结构抛错", () => {
    expect(() => parseChart(seq, { notes: [] })).toThrow(/version|schema/);
    expect(() => parseChart(seq, { version: "chart/v2", schema: "chart/v2" })).toThrow(/notes/);
    expect(() => parseChart(seq, { version: "chart/v2", notes: [{}] })).toThrow(/合法 t/);
    expect(() =>
      parseChart(seq, { version: "chart/v2", note: "x", notes: [{ t: 1, type: "pose", weights: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }] })
    ).toThrow(/权重和须 > 0/);
  });
  it("读取参考序列内嵌 seq.chart(契约权威位置)", () => {
    const withChart = {
      ...seq,
      chart: { version: "chart/v2", notes: [{ id: "e0", t: 1, type: "pose", refFrameIdx: 30 }] },
    };
    const ev = parseChart(withChart, null);
    expect(ev).toHaveLength(1);
    expect(ev[0].moveId).toBe("e0");
  });
  it("解析独立 chart 文件(schema/sequenceFile 包装,编辑器交换格式)", () => {
    const standalone = {
      schema: "chart/v2",
      danceId: seq.danceId,
      sequenceFile: "test-dance.json",
      notes: [{ id: "s0", t: 1, type: "pose" }],
    };
    const ev = parseChart(seq, standalone);
    expect(ev).toHaveLength(1);
    expect(ev[0].refFrameIdx).toBe(30);
  });
  it("toStandaloneChart 包装 + mergeChartIntoSequence 内嵌往返", () => {
    const events = parseChart(seq, serializeChart([
      { t: 1, weights: DEFAULT_BONE_WEIGHTS, window: { early: -0.25, late: 0.25 }, difficulty: 2 },
    ], { seq }));
    const content = serializeChart(events, { seq });
    const standalone = toStandaloneChart(content, { seq });
    expect(standalone.schema).toBe("chart/v2");
    expect(standalone.sequenceFile).toBe(`${seq.danceId}.json`);
    expect(standalone.version).toBeUndefined();
    expect(parseChart(seq, standalone)).toHaveLength(1);

    const merged = mergeChartIntoSequence(seq, content);
    expect(merged.chart).toBe(content);
    expect(merged.frames).toEqual(seq.frames);
    expect(parseChart(merged, null)).toHaveLength(1);
  });
});

describe("serializeChart -> parseChart 往返", () => {
  it("事件导出为 chart/v2 后回读,事件等价", () => {
    const events = [
      { t: 0.5, noteType: "pose", refFrameIdx: 15, weights: DEFAULT_BONE_WEIGHTS, difficulty: 2, window: { early: -0.25, late: 0.25 }, moveId: "a" },
      { t: 1.25, noteType: "pose", refFrameIdx: 38, weights: DEFAULT_BONE_WEIGHTS, difficulty: 3, window: { early: -0.25, late: 0.25 }, moveId: "b" },
    ];
    const chart = serializeChart(events, { seq, source: "annotated" });
    expect(chart.version).toBe("chart/v2");
    const back = parseChart(seq, chart);
    expect(back).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(back[i].t).toBe(events[i].t);
      expect(back[i].refFrameIdx).toBe(events[i].refFrameIdx);
      expect(back[i].noteType).toBe(events[i].noteType);
      expect(back[i].difficulty).toBe(events[i].difficulty);
      expect(back[i].weights).toEqual(events[i].weights);
      expect(back[i].targetBones).toEqual(seq.frames[events[i].refFrameIdx].bones);
    }
  });
  it("子集权重导出为 bones,完整覆盖导出为 weights", () => {
    const candidate = DEFAULT_BONE_WEIGHTS;
    const subsetW = candidate.map((v, i) => (i >= 5 ? 0 : v));
    const overrideW = candidate.map((v, i) => (i === 9 ? 0 : v)).map((v) => (v === 0.285 ? 0.3 : v));
    const notes = serializeChart(
      [
        { t: 1, weights: subsetW, window: { early: -0.25, late: 0.25 } },
        { t: 2, weights: overrideW, window: { early: -0.25, late: 0.25 } },
      ],
      { seq, boneWeights: candidate }
    ).notes;
    expect(notes[0].bones).toEqual([0, 1, 2, 3, 4]);
    expect(notes[0].weights).toBeUndefined();
    expect(notes[1].bones).toBeUndefined();
    expect(notes[1].weights).toEqual(overrideW);
  });
});

describe("引擎消费 parseChart 输出", () => {
  it("沉默帧命中目标 → perfect", () => {
    const chart = {
      version: "chart/v2",
      notes: [{ t: 1, type: "pose", refFrameIdx: 30, window: { early: -0.2, late: 0.25 } }],
    };
    const events = parseChart(seq, chart);
    const eng = new ScoringEngine(events, {
      bands: [
        { edge: 0.05, grade: "perfect", value: 1 },
        { edge: 0.1, grade: "great", value: 0.8 },
        { edge: 0.15, grade: "good", value: 0.6 },
      ],
      windowEdge: 0.15,
    });
    const player = { t: 1, bones: seq.frames[30].bones };
    eng.ingest(player);
    const released = eng.ingest({ t: 1.3, bones: seq.frames[0].bones });
    expect(released).toHaveLength(1);
    expect(released[0].grade).toBe("perfect");
    expect(released[0].deltaT).toBeCloseTo(0, 5);
  });
  it("窗口外玩家帧 → miss(事件在 ingest 时刻即结算)", () => {
    const chart = {
      version: "chart/v2",
      notes: [{ t: 1, type: "pose", refFrameIdx: 30 }],
    };
    const events = parseChart(seq, chart);
    const eng = new ScoringEngine(events, {
      bands: [{ edge: 0.15, grade: "good", value: 0.6 }],
      windowEdge: 0.15,
    });
    const released = eng.ingest({ t: 1.3, bones: seq.frames[30].bones });
    expect(released).toHaveLength(1);
    expect(released[0].grade).toBe("miss");
  });
});