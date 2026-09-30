import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { highlightLayout } from "../web_dance/highlight-layout.js";
import { resultCopyFor } from "../web_dance/result-copy.js";

test("高光构图以真人为全屏主画面，3D 教练缩在右上角", () => {
  const layout = highlightLayout(720, 1280);
  assert.deepEqual(layout.camera, { x: 0, y: 0, w: 720, h: 1280 });
  assert.ok(layout.coach.w >= 210 && layout.coach.w <= 220);
  assert.ok(layout.coach.h >= 310 && layout.coach.h <= 320);
  assert.ok(layout.coach.x > 720 / 2);
  assert.ok(layout.coach.y < 1280 / 3);
  assert.equal(layout.coach.fit, "cover");
  assert.ok(layout.coach.zoom >= 1.2);
});

test("高光画布不再声明旧烧入文字区域", () => {
  const layout = highlightLayout(720, 1280);
  assert.equal("topBar" in layout, false);
  assert.equal("bottomBar" in layout, false);
  assert.equal("score" in layout, false);
  assert.equal("combo" in layout, false);
});

test("录制画布不再烧入旧口号、得分、连击和评级文案", async () => {
  const source = await readFile(new URL("../web_dance/highlights.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fillText\(`得分|fillText\(`连击|overlay\.topTitle|overlay\.tiers/);
});

test("结算称号使用年轻化短句而不是旧称号", () => {
  assert.deepEqual(resultCopyFor("S"), { title: "这把封神", tagline: "高光不是偶然" });
  assert.deepEqual(resultCopyFor("A"), { title: "全场焦点", tagline: "状态已经拉满" });
  assert.deepEqual(resultCopyFor("D"), { title: "敢跳就很酷", tagline: "下一把继续上头" });
});

test("回放主标题使用独立高光标识而不是普通文本", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("../web_dance/dance.html", import.meta.url), "utf8"),
    readFile(new URL("../web_dance/style.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /replay-title-lockup/);
  assert.match(html, /HIGHLIGHT REPLAY/);
  assert.match(css, /#replay-title::after/);
  assert.match(css, /linear-gradient\(180deg, #fff6d8/);
});

test("回放提供明确的结束入口并恢复结算页", async () => {
  const [html, main] = await Promise.all([
    readFile(new URL("../web_dance/dance.html", import.meta.url), "utf8"),
    readFile(new URL("../web_dance/main.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="replay-close"[^>]*>结束回放</);
  assert.match(main, /result"\)\.classList\.remove\("result-mini"\)/);
  assert.match(main, /replayClose\.addEventListener\("click", closeReplay\)/);
});
