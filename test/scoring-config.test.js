// scoring-config 单测:默认值/钳制/交叉约束/评级/档位。localStorage 用内存桩。
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  SCORING_KNOBS, defaultConfig, loadConfig, saveConfig, resetConfig,
  enforceOrdering, gradeFor, tierMultipliers, bandsFor, formatKnob, STORAGE_KEY,
} = await import("../web_dance/scoring-config.js");

const eq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};
const ok = (v, msg) => { if (!v) throw new Error(msg); };

// 1. 默认值与面板元数据一致
const d = defaultConfig();
eq(Object.keys(d).length, Object.keys(SCORING_KNOBS).length, "默认配置应覆盖全部旋钮");
// 回归测试只绑定默认值,不绑定旋钮上限,所以上限可以放宽
eq(d.judgeWindow, 0.30, "judgeWindow 默认值仍是 0.30(回归测试依赖)");
ok(SCORING_KNOBS.judgeWindow.max > 0.30, "judgeWindow 上限应可放宽");

// 2. 空存储 → 默认值
eq(loadConfig(), d, "空存储应返回默认值");

// 3. 落盘/读回往返
const c1 = saveConfig({ ...d, judgeWindow: 0.2, gradeS: 0.9, scoreBase: 5000 });
eq(loadConfig(), c1, "落盘后应原样读回");

// 4. 越界钳制(按旋钮自身 min/max 钳,不是硬编码 0)
store.set(STORAGE_KEY, JSON.stringify({ judgeWindow: 99, gradeS: -5, poseWeight: 3, yawMode: "bogus" }));
const c3 = loadConfig();
eq(c3.judgeWindow, SCORING_KNOBS.judgeWindow.max, "judgeWindow 应钳到上限");
eq(c3.gradeS, SCORING_KNOBS.gradeS.min, "gradeS 越界应钳到旋钮下限");
eq(c3.poseWeight, SCORING_KNOBS.poseWeight.max, "poseWeight 应钳到上限");
eq(c3.yawMode, d.yawMode, "无法识别的开关值应回退默认");
// 未知键被丢弃
store.set(STORAGE_KEY, JSON.stringify({ judgeWindow: 0.2, bogusKey: 42 }));
eq(Object.keys(loadConfig()).sort(), Object.keys(SCORING_KNOBS).sort(), "未知键应被丢弃");

// 4b. 旧版字符串开关迁移:选过 none 的老用户不能被静默重置回默认
store.set(STORAGE_KEY, JSON.stringify({ yawMode: "none" }));
eq(loadConfig().yawMode, false, 'yawMode="none" 应迁移为 false');
store.set(STORAGE_KEY, JSON.stringify({ yawMode: "rootYaw" }));
eq(loadConfig().yawMode, true, 'yawMode="rootYaw" 应迁移为 true');
eq(enforceOrdering({ ...d, yawMode: "none" }).yawMode, false, "enforceOrdering 也应迁移");
eq(enforceOrdering({ ...d, yawMode: true }).yawMode, true, "布尔 true 应保持");

// 5-7. 旋钮必须彼此独立:任何一个都能拖到自己范围内的任意值(交叉钳制会让滑块卡死)
for (const [k, m] of Object.entries(SCORING_KNOBS)) {
  if (m.widget === "toggle") continue;
  for (const v of [m.min, m.max, (m.min + m.max) / 2]) {
    const got = enforceOrdering({ ...d, [k]: v })[k];
    ok(Math.abs(got - v) < 1e-9, `${k}=${v} 应原样保留,实际 ${got}`);
  }
}
// bandGood 两端都要真的能动(旧实现往右被 judgeWindow 钳、往左被 bandGreat 顶)
eq(enforceOrdering({ ...d, bandGood: 0.05 }).bandGood, SCORING_KNOBS.bandGood.min, "bandGood 拖到最小");
ok(enforceOrdering({ ...d, bandGood: 0.45 }).bandGood === 0.45, "bandGood 拖到 0.45");
ok(enforceOrdering({ ...d, bandGood: 0.60 }).bandGood === 0.60, "bandGood 拖到上限 0.60");
ok(enforceOrdering({ ...d, judgeWindow: 0.50 }).judgeWindow === 0.50, "judgeWindow 能到 0.50");
// 越界仍然钳回自身范围
ok(enforceOrdering({ ...d, bandGood: 99 }).bandGood === SCORING_KNOBS.bandGood.max, "bandGood 越界应钳到 max");
ok(enforceOrdering({ ...d, judgeWindow: 99 }).judgeWindow === SCORING_KNOBS.judgeWindow.max, "judgeWindow 越界应钳到 max");

// 7b. 档位乱序也不怕:bandsFor 负责排成单调集合,倍率跟着边界走
const bs = bandsFor({ ...d, bandPerfect: 0.30, bandGreat: 0.05, bandGood: 0.15 });
eq(bs.map((x) => x.grade), ["great", "good", "perfect", "miss"], "乱序边界应被排成单调");
ok(bs[0].edge <= bs[1].edge && bs[1].edge <= bs[2].edge, "排完必须单调不减");
ok(bs[3].edge >= bs[2].edge, "miss 边界不得小于最宽的档");
eq(bandsFor(d).map((x) => x.grade), ["perfect", "great", "good", "miss"], "默认顺序");

// 8. 评级分档(含边界:恰好等于阈值取高档)
eq(gradeFor(0.85, d), "S", "0.85 应评 S");
eq(gradeFor(0.6499, d), "B", "0.6499 应评 B");
eq(gradeFor(0.5, d), "B", "0.5 应评 B");
eq(gradeFor(0.39, d), "D", "0.39 应评 D");
eq(gradeFor(1, d), "S", "满分应评 S");
eq(gradeFor(0, d), "D", "0 分应评 D");
// 自定义档位线生效
eq(gradeFor(0.6, { ...d, gradeA: 0.6, gradeB: 0.5 }), "A", "自定义 A 线应生效");

// 9. 档位系数 / bands
eq(tierMultipliers(d), { PERFECT: 1, GREAT: 0.8, GOOD: 0.6, MISS: 0 }, "默认档位系数");
ok(tierMultipliers({ ...d, tierGreat: 0.5 }).GREAT === 0.5, "自定义 GREAT 系数");
const b = bandsFor(d);
eq(b.map((x) => x.grade), ["perfect", "great", "good", "miss"], "bands 顺序");
ok(b[3].edge === d.judgeWindow, "miss 档边界应等于采样窗");

// 10. 格式化
ok(formatKnob("judgeWindow", 0.3).startsWith("0.30"), "judgeWindow 格式");
ok(formatKnob("scoreBase", 100000) === "100000", "scoreBase 整数格式");
eq(formatKnob("yawMode", true), "开", "勾选框读数");
eq(formatKnob("yawMode", false), "关", "勾选框读数");
// 控件类型:得分基数是数字框,朝向对齐是勾选框,其余为滑块
eq(SCORING_KNOBS.scoreBase.widget, "number", "得分基数应为数字框");
eq(SCORING_KNOBS.yawMode.widget, "toggle", "朝向对齐应为勾选框");
for (const [k, m] of Object.entries(SCORING_KNOBS)) {
  if (k === "scoreBase" || k === "yawMode") continue;
  eq(m.widget, undefined, `${k} 应为滑块`);
  ok(m.min < m.max && m.step > 0, `${k} 滑块范围/step 应合法`);
}

// 11. 恢复默认
resetConfig();
eq(loadConfig(), d, "reset 后应回到默认值");

console.log("scoring-config 单测通过");
