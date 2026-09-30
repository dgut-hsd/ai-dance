/**
 * test/lane-assets.test.js — 判定轨道「逐点 3D 白影」资源的契约测试。
 *
 * 覆盖:
 *   - 生成器与消费端必须对同一个 key(判定点时刻 toFixed(3))达成一致;
 *   - manifest 校验(坏数据要吵,而不是悄悄变成空白车道);
 *   - 缺失/损坏一律返回 null,游戏退回 2D 剪影;
 *   - 关节像素锚点换算(箭头贴到正确位置);
 *   - 资源接线:lane.css 抽出、main.js / 编辑器共用 lane-view + lane-figure。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import {
  LANE_ASSET_DIR, LANE_ASSET_SCHEMA, LANE_JOINT_KEYS, LANE_MANIFEST_URL,
  buildLaneManifest, laneAssetBox, laneAssetFor, laneAssetJointPixels, laneAssetUrl,
  laneNoteTimes, loadLaneManifest, validateLaneManifest,
} from "../web_dance/lane-assets.js";
import { laneEventKey } from "../web_dance/pose-lane.js";
import { parseChart } from "../scoring/src/chartCodec.js";
import { makeReference, STANDARD_BEATS } from "../scoring/tests/helpers/synthetic.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

/** 一支带谱面的参考序列(2 个判定点:t=0 / t=1) */
function fixtureSeq(notes = [{ t: 0, id: "动作 1" }, { t: 1, id: "动作 2" }]) {
  const seq = makeReference(STANDARD_BEATS, "unit", 30);
  seq.chart = { version: "chart/v2", notes: notes.map((n) => ({ type: "pose", ...n })) };
  return seq;
}

/** 造一份"生成器会写出来"的 manifest */
function fixtureManifest(seq, { size = 256, joints = true } = {}) {
  const notes = laneNoteTimes(seq).map((n) => ({
    t: n.t, key: n.key, file: `unit/${n.key}.png`, w: size, h: size,
    joints: joints ? {
      left_wrist: [100.5, 80.25], right_wrist: [150, 82],
      hips_center: [128, 150], nose: [128, 30],
    } : {},
  }));
  return buildLaneManifest({ model: "/models/Michelle.glb", size, color: "#ffffff", dances: [{ danceId: "unit", notes }] });
}

// ---------------------------------------------------------------------------
// 1. 判定点时刻(生成器与车道 key 的单一来源)
// ---------------------------------------------------------------------------

test("laneNoteTimes: 取谱面判定点,去重升序,key 与车道 laneEventKey 一致", () => {
  const seq = fixtureSeq([{ t: 1, id: "b" }, { t: 0, id: "a" }, { t: 1, id: "dup" }]);
  const times = laneNoteTimes(seq);
  assert.deepEqual(times.map((n) => n.key), [laneEventKey(0), laneEventKey(1)]);
  assert.deepEqual(times.map((n) => n.moveId), ["a", "b"], "同 t 只留第一个");
  for (const n of times) assert.equal(n.key, n.t.toFixed(3));
});

test("laneNoteTimes: 没有谱面时用 0.5s 采样兜底(仍升序、key 一致)", () => {
  const seq = makeReference(STANDARD_BEATS, "unit", 30); // 0..3s,91 帧,无 chart
  const times = laneNoteTimes(seq);
  assert.ok(times.length >= 6);
  assert.deepEqual(times.slice(0, 3).map((n) => n.t), [0, 0.5, 1]);
  assert.deepEqual(times.map((n) => n.key), times.map((n) => n.t.toFixed(3)));
  for (let i = 1; i < times.length; i++) assert.ok(times[i].t > times[i - 1].t);
  assert.equal(times[0].moveId, null, "兜底事件没有名字");
});

test("真实曲库:生成器会为每个判定点各出一张图(数量 = 谱面音符数)", () => {
  for (const id of ["hiphop", "salsa", "demo-arena-loop"]) {
    const seq = JSON.parse(read("songs", id, `${id}.json`));
    const events = parseChart(seq, seq.chart);
    const times = laneNoteTimes(seq);
    const unique = new Set(events.map((e) => laneEventKey(e.t))).size;
    assert.equal(times.length, unique, `${id}: 判定点数与去重后的事件数应一致`);
  }
});

// ---------------------------------------------------------------------------
// 2. 查找 / 换算
// ---------------------------------------------------------------------------

test("laneAssetFor: 按 (danceId, t) 精确命中;键按 toFixed(3) 归一", () => {
  const manifest = fixtureManifest(fixtureSeq());
  const hit = laneAssetFor(manifest, "unit", 1);
  assert.equal(hit.file, "unit/1.000.png");
  assert.equal(laneAssetFor(manifest, "unit", 1.0004)?.file, "unit/1.000.png", "亚毫秒差归一到同一个 key");
  assert.equal(laneAssetFor(manifest, "unit", 0.42), null, "没有这个判定点 → null(走 2D 兜底)");
  assert.equal(laneAssetFor(manifest, "nope", 1), null);
  assert.equal(laneAssetFor(null, "unit", 1), null);
  assert.equal(laneAssetFor(manifest, "unit", NaN), null);
  assert.equal(laneAssetUrl(hit), `${LANE_ASSET_DIR}unit/1.000.png`);
  assert.equal(laneAssetUrl(null), null);
});

test("laneAssetJointPixels: 按显示比例换算,坏坐标/未知关节被丢掉", () => {
  const entry = { joints: { left_wrist: [100, 50], hips_center: [10, 20], nose: "x", bogus: [1, 1] } };
  assert.deepEqual(laneAssetJointPixels(entry, 2), { left_wrist: [200, 100], hips_center: [20, 40] });
  assert.deepEqual(laneAssetJointPixels(entry, 1), { left_wrist: [100, 50], hips_center: [10, 20] });
  assert.deepEqual(laneAssetJointPixels({ joints: {} }, 3), {});
  assert.deepEqual(laneAssetJointPixels(null, 2), {});
  // 非法 scale 退回 1,而不是把箭头甩到天外
  assert.deepEqual(laneAssetJointPixels({ joints: { nose: [1, 2] } }, 0), { nose: [1, 2] });
});

test("laneAssetBox: 高度跟车道盒子,宽度按图片纵横比(不拉伸)", () => {
  assert.deepEqual(laneAssetBox({ w: 256, h: 256 }, 142), { w: 142, h: 142 });
  assert.deepEqual(laneAssetBox({ w: 128, h: 256 }, 142), { w: 71, h: 142 });
  assert.deepEqual(laneAssetBox({ w: 256, h: 128 }, 112), { w: 224, h: 112 });
  assert.deepEqual(laneAssetBox({}, 142), { w: 142, h: 142 }, "缺 w/h 时退回正方形");
  assert.deepEqual(laneAssetBox({ w: 0, h: 0 }, 0), { w: 142, h: 142 }, "高度非法时用默认 142");
});

// ---------------------------------------------------------------------------
// 3. 校验与加载
// ---------------------------------------------------------------------------

test("validateLaneManifest: 合法清单通过;坏数据一律抛错(不静默变空白)", () => {
  const good = fixtureManifest(fixtureSeq());
  assert.equal(validateLaneManifest(good), good);
  const mutate = (fn) => {
    const m = JSON.parse(JSON.stringify(good));
    fn(m);
    return m;
  };
  assert.throws(() => validateLaneManifest(null), /非法/);
  assert.throws(() => validateLaneManifest({ schema: "x", dances: {} }), /schema/);
  assert.throws(() => validateLaneManifest({ schema: LANE_ASSET_SCHEMA }), /dances/);
  assert.throws(() => validateLaneManifest(mutate((m) => { m.dances.unit.notes = "x"; })), /notes/);
  assert.throws(() => validateLaneManifest(mutate((m) => { m.dances.unit.notes[0].t = "abc"; })), /t/);
  assert.throws(() => validateLaneManifest(mutate((m) => { delete m.dances.unit.notes[0].file; })), /file/);
  assert.throws(() => validateLaneManifest(mutate((m) => { m.dances.unit.notes[0].w = 0; })), /w\/h/);
  assert.throws(() => validateLaneManifest(mutate((m) => { m.dances.unit.notes[0].joints = []; })), /joints/);
  assert.throws(() => validateLaneManifest(mutate((m) => { m.dances.unit.notes[0].joints.bogus = [1, 2]; })), /未知关节/);
  assert.throws(() => validateLaneManifest(mutate((m) => { m.dances.unit.notes[0].joints.nose = [1]; })), /坐标/);
});

test("buildLaneManifest: 按 t 升序、schema 正确、自身通过校验(生成器与消费端同一份契约)", () => {
  const seq = fixtureSeq();
  const notes = laneNoteTimes(seq).map((n) => ({ t: n.t, file: `unit/${n.key}.png`, w: 256, h: 256, joints: {} }));
  notes.reverse();
  const manifest = buildLaneManifest({ model: "/models/Michelle.glb", size: 256, dances: [{ danceId: "unit", notes }] });
  assert.equal(manifest.schema, LANE_ASSET_SCHEMA);
  assert.deepEqual(manifest.dances.unit.notes.map((n) => n.t), [0, 1]);
  assert.equal(validateLaneManifest(manifest), manifest);
  // 生成器写出来的每个判定点都能被消费端查到
  for (const n of laneNoteTimes(seq)) assert.ok(laneAssetFor(manifest, "unit", n.t), `t=${n.t} 查不到`);
});

test("loadLaneManifest: 成功返回清单;404/坏 JSON/网络异常都返回 null(游戏照常跑)", async () => {
  const good = fixtureManifest(fixtureSeq());
  const ok = await loadLaneManifest(LANE_MANIFEST_URL, async () => ({ ok: true, json: async () => good }));
  assert.equal(ok.schema, LANE_ASSET_SCHEMA);
  assert.equal(await loadLaneManifest("x", async () => ({ ok: false, status: 404 })), null);
  assert.equal(await loadLaneManifest("x", async () => ({ ok: true, json: async () => ({ schema: "bad" }) })), null);
  assert.equal(await loadLaneManifest("x", async () => { throw new Error("offline"); }), null);
  assert.equal(await loadLaneManifest("x", null), null, "没有 fetch 时也要安全返回");
});

// ---------------------------------------------------------------------------
// 4. 资源接线:样式抽出 + 游戏页/编辑器共用实现
// ---------------------------------------------------------------------------

test("lane.css:判定轨道样式集中在这一份,style.css 只 @import 不再重复定义", () => {
  const lane = read("web_dance", "lane.css");
  const style = read("web_dance", "style.css");
  for (const sel of ["#pose-hint", "#judge-lane", "#judge-stage", "#judge-track", ".lane-fig", ".lane-arrow"]) {
    assert.ok(lane.includes(sel), `lane.css 缺 ${sel}`);
  }
  assert.match(style, /@import url\("lane\.css"\)/, "style.css 应 @import lane.css");
  assert.doesNotMatch(style, /#pose-hint\s*\{|#judge-lane\s*\{|\.lane-fig\s*\{|\.lane-arrow\s*\{/, "style.css 不应再定义轨道样式");
  // 小屏尺寸只在 lane.css 一处声明(JS 侧靠 laneFigureBox 量真实盒子)
  assert.match(lane, /@media \(max-width: 900px\)[\s\S]*\.lane-fig \{ height: 112px; \}/);
  assert.match(read("web_dance", "chart-editor.html"), /<link rel="stylesheet" href="\.\/lane\.css">/, "编辑器要共用同一份样式");
});

test("接线:游戏页与编辑器都走 lane-view + lane-figure + lane-assets(所见即所得)", () => {
  const main = read("web_dance", "main.js");
  const editor = read("web_dance", "chart-editor.js");
  for (const [name, src] of [["main.js", main], ["chart-editor.js", editor]]) {
    assert.match(src, /import \{ createLaneView \} from "\.\/lane-view\.js"/, `${name} 应共用 lane-view`);
    assert.match(src, /import \{ buildLaneFigure \} from "\.\/lane-figure\.js"/, `${name} 应共用 lane-figure`);
    assert.match(src, /from "\.\/lane-assets\.js"/, `${name} 应读白影资源`);
    assert.match(src, /laneView\.update\(/, `${name} 应把计划交给 lane-view 落地`);
  }
  // 具体实现只能有一份:main.js 不再自己造剪影/自己写 DOM 细节
  for (const gone of ["function buildLaneFigure", "function laneArrowElement", "laneFigTranslateX", "shouldWriteProgress", "LANE_FADE_MS"]) {
    assert.ok(!main.includes(gone), `main.js 里还留着 ${gone}`);
  }
  assert.match(read("web_dance", "lane-figure.js"), /laneAssetJointPixels\(entry, box\.h \/ entry\.h\)/, "箭头锚点应按显示比例换算");
  assert.match(read("web_dance", "lane-view.js"), /laneFigTranslateX\(f\.x, fig\.box\.w\)/);
  // 生成器:逐判定点模式 + 写 manifest 走同一份契约
  const gen = read("tools", "lane-silhouettes.mjs");
  assert.match(gen, /notes: true/);
  assert.match(gen, /buildLaneManifest\(/);
  assert.match(read("tools", "silhouette-core.mjs"), /renderSilhouetteShot\(/);
});

test("判定卡片视觉: 只有剪影 + 平台 —— 无圆环/无外框/无进度条/无文字", () => {
  const lane = read("web_dance", "lane.css");
  const code = lane.replace(/\/\*[\s\S]*?\*\//g, ""); // 注释里可以提它们"曾经有"
  const pages = ["dance.html", "chart-editor.html"];

  // ① 圆环(#judge-stage-ring)整个删掉:它是比台面圆得多的椭圆,和台面角度对不上
  assert.ok(!code.includes("judge-stage-ring"), "lane.css 不该再有黄色圆环样式");
  for (const f of pages) {
    assert.ok(!read("web_dance", f).includes("judge-stage-ring"), `${f} 里还留着圆环元素`);
  }

  // ② 不要卡片外框质感:车道没有底色渐变、没有圆角矩形、没有投影
  const bg = code.match(/#judge-lane\s*\{[\s\S]*?\}/)?.[0];
  assert.ok(bg, "lane.css 缺 #judge-lane");
  assert.doesNotMatch(bg, /background\s*:/, "#judge-lane 不该有底色(不要卡片底)");
  assert.doesNotMatch(bg, /border-radius/, "#judge-lane 不该有圆角矩形轮廓");
  assert.doesNotMatch(bg, /box-shadow/, "#judge-lane 不该有投影");
  // 台面本身还在(平台是功能件,不是外框)
  const stage = lane.match(/#judge-stage\s*\{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(stage, /border-radius: 50%/);
  assert.match(stage, /rgba\(255, 213, 74, 0\.85\)/);

  // ③ 进度条带 + 动作名文字:样式、DOM、接线全撤掉
  for (const gone of ["pose-hint-bar", "pose-hint-fill", "pose-hint-name"]) {
    assert.ok(!code.includes(gone), `lane.css 不该还有 ${gone} 样式`);
    for (const f of pages) assert.ok(!read("web_dance", f).includes(gone), `${f} 里还留着 ${gone}`);
    assert.ok(!read("web_dance", "main.js").includes(gone), `main.js 里还留着 ${gone} 接线`);
    assert.ok(!read("web_dance", "chart-editor.js").includes(gone), `编辑器里还留着 ${gone} 接线`);
  }
  // 但 lane-view 仍保留这两个可选槽位(加回只需 HTML 放回元素 + 创建时传进来)
  const view = read("web_dance", "lane-view.js");
  assert.match(view, /name && plan\.label\.text !== lastLabel/);
  assert.match(view, /shouldWriteProgress\(plan\.progress, lastProgress\)/);
  assert.match(view, /if \(fill\) fill\.style\.width/);
});

test("manifest 关节键覆盖箭头候选(生成器写什么,箭头就找得到什么)", async () => {
  const { ARROW_MOTION_JOINTS } = await import("../web_dance/pose-lane.js");
  for (const name of ARROW_MOTION_JOINTS) {
    assert.ok(LANE_JOINT_KEYS.includes(name), `manifest 未声明箭头候选关节 ${name}`);
  }
});

/**
 * 真实产物核查:web_dance/assets/lane/index.json 是 tools/lane-silhouettes.mjs 的产物,
 * 提交在仓库里。这里只做"只读核查"(不依赖 Chrome):
 *   - 清单合法、每张图都在、关节锚点落在图内;
 *   - 歌单里每支舞、每个判定点都能查到资源(否则车道会退回 2D 剪影)。
 * 如果这批资源被删掉,应当红:跑 node tools/lane-silhouettes.mjs 重新生成即可。
 */
test("真实产物: assets/lane 清单覆盖歌单全部判定点,锚点落在图内", (t) => {
  const manifestPath = join(ROOT, "web_dance", "assets", "lane", "index.json");
  assert.ok(existsSync(manifestPath), "缺少 web_dance/assets/lane/index.json —— 跑一次 node tools/lane-silhouettes.mjs");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateLaneManifest(manifest);

  let checked = 0;
  for (const dance of dancesIn(manifest)) {
    for (const note of dance.notes) {
      const file = join(ROOT, "web_dance", "assets", "lane", note.file);
      assert.ok(existsSync(file), `清单里的图不存在: ${note.file}`);
      assert.ok(note.w > 0 && note.h > 0);
      for (const [joint, p] of Object.entries(note.joints)) {
        assert.ok(p[0] >= -0.5 && p[0] <= note.w + 0.5, `${note.file} ${joint}.x=${p[0]} 超出图宽 ${note.w}`);
        assert.ok(p[1] >= -0.5 && p[1] <= note.h + 0.5, `${note.file} ${joint}.y=${p[1]} 超出图高 ${note.h}`);
      }
      assert.ok(Object.keys(note.joints).length >= 8, `${note.file} 关节锚点太少(${Object.keys(note.joints).length})`);
      checked += 1;
    }
  }
  assert.ok(checked > 0);

  // 歌单里每支舞的每个判定点都要有资源
  const indexed = new Set(dancesIn(manifest).map((d) => d.danceId));
  for (const id of ["hiphop", "salsa", "demo-arena-loop"]) {
    assert.ok(indexed.has(id), `清单里缺这支舞: ${id}`);
    const seq = JSON.parse(read("songs", id, `${id}.json`));
    for (const n of laneNoteTimes(seq)) {
      assert.ok(laneAssetFor(manifest, id, n.t), `${id} t=${n.t} 没有白影资源`);
    }
  }
  t.diagnostic(`真实产物: ${indexed.size} 支舞 / ${checked} 张白影,锚点均在图内`);
});

function dancesIn(manifest) {
  return Object.values(manifest.dances ?? {});
}

/**
 * 端到端:拿真实产物 + 真实参考序列,把"游戏每帧会做的事"跑一遍 ——
 * 查资源 → 算显示盒子 → 换算关节锚点 → 算箭头。
 */
test("端到端(真实产物 + 真实序列): 每个判定点都能算出落在图内的箭头", async (t) => {
  const { ARROW_PUSH_PX, computePoseEvents, frameAtTime, laneArrowSpec } = await import("../web_dance/pose-lane.js");
  const { reconstructJoints } = await import("../pose_capture/playback.js");
  const manifestPath = join(ROOT, "web_dance", "assets", "lane", "index.json");
  if (!existsSync(manifestPath)) return; // 资源没生成时跳过(上面的"真实产物"测试已经会红)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const seq = JSON.parse(read("songs", "hiphop", "hiphop.json"));
  const dims = seq.meta?.dimensions;
  const jointsAt = (tt) => {
    const f = frameAtTime(seq.frames, tt);
    return f ? reconstructJoints(f, dims, seq.bones) : null;
  };

  let drawn = 0, still = 0;
  for (const ev of computePoseEvents(seq)) {
    const entry = laneAssetFor(manifest, "hiphop", ev.t);
    assert.ok(entry, `t=${ev.t} 没有白影资源`);
    const box = laneAssetBox(entry, 142);                        // 车道盒子高(大屏)
    const jointPixels = laneAssetJointPixels(entry, box.h / entry.h);
    const nodeT = ev.targetT ?? ev.t;
    const jointsNow = jointsAt(nodeT);
    const spec = laneArrowSpec({
      nodeT, firstT: seq.frames[0].t, jointsNow, jointsAt, dpr: 1,
      figW: box.w, figH: box.h, jointPixels,
    });
    if (!spec) { still += 1; continue; }
    drawn += 1;
    assert.ok(spec.x >= 6 - 1e-6 && spec.x <= box.w - 6 + 1e-6, `t=${ev.t} 箭头 x=${spec.x} 超出 ${box.w}`);
    assert.ok(spec.y >= 10 - 1e-6 && spec.y <= box.h - 6 + 1e-6, `t=${ev.t} 箭头 y=${spec.y} 超出 ${box.h}`);
    const p = jointPixels[spec.joint];
    assert.ok(p, `t=${ev.t} 的方向关节 ${spec.joint} 不在 manifest 锚点里`);
    assert.ok(Math.abs(spec.x - p[0]) <= ARROW_PUSH_PX + 1e-6 && Math.abs(spec.y - p[1]) <= ARROW_PUSH_PX + 1e-6,
      `t=${ev.t} 箭头离关节太远(锚点 ${p} → 箭头 ${[spec.x, spec.y]})`);
  }
  assert.ok(drawn > 0);
  t.diagnostic(`hiphop: ${drawn} 个判定点标出箭头,${still} 个判定为「定住造型」不标`);
});
