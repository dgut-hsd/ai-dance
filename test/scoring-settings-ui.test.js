// 真浏览器验证设置页评分旋钮:控件类型、滑块可拖动(不复现"拉不动"bug)、落盘与热更新。
// 用法:先起 server(PORT=8931),再 node test/scoring-settings-ui.test.js
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:8931";
const eq = (a, b, msg) => {
  if (String(a) !== String(b)) throw new Error(`${msg}: ${a} != ${b}`);
};
const ok = (v, msg) => { if (!v) throw new Error(msg); };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".scoring-knob input", { timeout: 5000 });

// 面板在页面最下方
const lastPanelClass = await page.evaluate(() => {
  const panels = [...document.querySelectorAll(".camera-panel,.model-panel,.side-panel,.scoring-panel")];
  return panels[panels.length - 1].className;
});
ok(lastPanelClass.includes("scoring-panel"), `评分面板应在最下方,实际末位是 ${lastPanelClass}`);
ok((await page.locator("#scoring-knobs .scoring-group").count()) === 4, "应有 4 组旋钮");

// 控件类型:朝向对齐/落盘监测=勾选框,得分基数=数字框,其余=滑块
ok((await page.locator('.scoring-knob input[type=checkbox]').count()) === 2, "朝向对齐与落盘监测应为勾选框");
ok((await page.locator('.scoring-knob input[type=number]').count()) === 1, "得分基数应为数字框");
const rangeCount = await page.locator('.scoring-knob input[type=range]').count();
ok(rangeCount >= 15, `其余应为滑块,实际 ${rangeCount}`);

// 落盘监测:默认不勾(避免每帧额外计算 + 结算卡顿)
const monitorCb = page.locator('.scoring-knob', { has: page.locator('span:text-is("落盘监测")') }).first().locator('input[type=checkbox]');
ok(!(await monitorCb.isChecked()), "落盘监测默认应不勾选");
await monitorCb.setChecked(true);
ok(await monitorCb.isChecked(), "落盘监测应可勾选");
const savedOn = await page.evaluate(() => JSON.parse(localStorage.getItem("dance-scoring-config")).monitorLog);
eq(savedOn, true, "落盘监测开启状态应落盘");

// 关键回归:bandGood 滑块必须真的能拖动(旧实现 commit 后重建 DOM,元素被换掉→卡死)
const goodRow = page.locator('.scoring-knob', { has: page.locator('span:text-is("GOOD 时机")') }).first();
const goodInput = goodRow.locator('input[type=range]');
const nodeBefore = await goodInput.evaluate((el) => el);
await goodInput.fill("0.45");
await goodInput.dispatchEvent("change");
const goodVal = await goodInput.evaluate((el) => el.value);
eq(goodVal, "0.45", "bandGood 应能拉到 0.45");
// 节点未被替换 —— 这正是"拉不动"的根因
const nodeAfter = await goodInput.evaluate((el) => el);
ok(nodeBefore === nodeAfter, "bandGood 的 input 节点不应被重建(重建=松手后拉不动)");
// 再往回拖,确认另一端也能动
await goodInput.fill("0.08");
await goodInput.dispatchEvent("change");
eq(await goodInput.evaluate((el) => el.value), "0.08", "bandGood 应能往回拖到 0.08");

// judgeWindow 放宽到 0.50(用户反馈 0.30 太抠)
const winInput = page.locator('.scoring-knob', { has: page.locator('span:text-is("判定采样窗")') }).first().locator('input[type=range]');
eq(await winInput.getAttribute("max"), "0.5", "judgeWindow 上限应放宽到 0.50");
await winInput.fill("0.45");
await winInput.dispatchEvent("change");
eq(await winInput.evaluate((el) => el.value), "0.45", "judgeWindow 应能拉到 0.45");

// 勾选框可切换
const yawCb = page.locator('.scoring-knob input[type=checkbox]').first();
const yawBefore = await yawCb.isChecked();
await yawCb.setChecked(!yawBefore);
eq(await yawCb.isChecked(), String(!yawBefore), "朝向对齐勾选框应可切换");

// 数字框接受输入
const baseInput = page.locator('.scoring-knob input[type=number]').first();
await baseInput.fill("250000");
await baseInput.dispatchEvent("change");
eq(await baseInput.evaluate((el) => el.value), "250000", "得分基数应能填 250000");

// 落盘内容:滑块值原样保存,不被交叉钳制篡改
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("dance-scoring-config")));
eq(saved.bandGood, 0.08, "bandGood 应原样落盘");
eq(saved.judgeWindow, 0.45, "judgeWindow 应原样落盘");
eq(saved.scoreBase, 250000, "得分基数应落盘");
eq(saved.yawMode, !yawBefore, "朝向对齐应落盘为布尔");

// 恢复默认后回填
await page.locator("#scoring-reset").click();
await goodInput.dispatchEvent("change");
eq(await goodInput.evaluate((el) => el.value), "0.26", "恢复默认后 bandGood 应回 0.26");
eq(await page.locator(".scoring-knob input[type=checkbox]").first().isChecked(), true, "恢复默认后朝向对齐应为勾选");

// 跨标签页同步:另一页改 storage,设置页读数应跟着变
await page.evaluate(() => {
  localStorage.setItem("dance-scoring-config", JSON.stringify({ ...JSON.parse(localStorage.getItem("dance-scoring-config")), bandGood: 0.55 }));
});
await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "dance-scoring-config" })));
eq(await goodInput.evaluate((el) => el.value), "0.55", "外部修改应同步到滑块");

ok(errors.length === 0, `页面报错: ${errors.join(" | ")}`);
await browser.close();
console.log("设置页评分旋钮浏览器验证通过");
