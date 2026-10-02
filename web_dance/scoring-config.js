/**
 * scoring-config.js — 评分规则调参中心(实时旋钮的唯一真相源)
 *
 * 设置页渲染旋钮,游戏页/评分引擎读取生效。两端同源 localStorage 共享:
 * 设置页写入后广播 storage 事件,正在进行的对局立即热更新 opts。
 *
 * 两组:
 *   一、判定与手感(judgeWindow / bands / minPoseScore / poseWeight / yawMode …)
 *   二、评级与得分(grade lines / scoreBase / TIER_MULT / combo / pose 档位线)
 *
 * judgeWindow 上限 0.50:该约束只绑定"默认值 0.30",不是旋钮上限 ——
 * 回归测试 test/scoring-regression.test.js 里 ScoringAdapter 走 loadConfig(),
 * Node 无 localStorage 时取默认值,所以把上限放宽不会影响该测试。
 */

const STORAGE_KEY = "dance-scoring-config";

// 旧版本把开关存成字符串选项,这里映射成布尔,避免老用户选过"朝向对齐 = none"
// 之后被静默重置回默认。
const LEGACY_TOGGLE = { yawMode: { rootYaw: true, none: false } };

// 评级线:自上而下第一个达标的档位胜出(末项 D 兜底,值为 0)。
const GRADE_ORDER = ["S", "A", "B", "C", "D"];

export const SCORING_KNOBS = {
  // ---- 一、判定与手感 ----
  judgeWindow: {
    label: "判定采样窗", unit: "s", def: 0.30, min: 0.10, max: 0.50, step: 0.01,
    group: "judge", hint: "音符前后可采样的时间范围。放宽更易命中但判定变松。",
  },
  bandPerfect: {
    label: "PERFECT 时机", unit: "s", def: 0.10, min: 0.03, max: 0.25, step: 0.01,
    group: "judge", hint: "与判定点误差在此以内记 perfect。",
  },
  bandGreat: {
    label: "GREAT 时机", unit: "s", def: 0.18, min: 0.05, max: 0.30, step: 0.01,
    group: "judge", hint: "需大于 PERFECT 档,超出记 great。",
  },
  bandGood: {
    label: "GOOD 时机", unit: "s", def: 0.26, min: 0.05, max: 0.60, step: 0.01,
    group: "judge", hint: "需大于 GREAT 档,超出记 good。",
  },
  minPoseScore: {
    label: "最低姿态分", def: 0.40, min: 0, max: 0.9, step: 0.01,
    group: "judge", hint: "窗内最佳姿态分低于此值仍判 miss。调低可避免遮挡导致的静默 miss。",
  },
  minCompleteness: {
    label: "最低可见度", def: 0.50, min: 0, max: 0.9, step: 0.01,
    group: "judge", hint: "加权骨骼置信度低于此值判 miss。",
  },
  poseWeight: {
    label: "姿态权重", def: 0.65, min: 0, max: 1, step: 0.05,
    group: "judge", hint: "事件分 = 姿态权重×姿态分 + (1−姿态权重)×时机分。",
  },
  yawMode: {
    label: "朝向对齐", def: true, widget: "toggle",
    group: "judge",
    hint: "勾选=按胯轴朝向(rootYaw)旋转玩家骨骼后再比姿态,适合玩家站位/朝向与教练不完全一致;不勾=直接比,适合固定机位。",
  },

  // ---- 二、评级与得分 ----
  gradeS: { label: "S 线", def: 0.85, min: 0.5, max: 1, step: 0.01, group: "grade", hint: "结算质量 ≥ 此值评 S。" },
  gradeA: { label: "A 线", def: 0.65, min: 0.4, max: 1, step: 0.01, group: "grade", hint: "结算质量 ≥ 此值评 A。" },
  gradeB: { label: "B 线", def: 0.50, min: 0.3, max: 1, step: 0.01, group: "grade", hint: "结算质量 ≥ 此值评 B。" },
  gradeC: { label: "C 线", def: 0.40, min: 0.1, max: 1, step: 0.01, group: "grade", hint: "低于此值评 D。" },
  scoreBase: {
    label: "得分基数", def: 100000, min: 100, max: 1000000, step: 1000, widget: "number",
    group: "score",
    hint: "单事件得分 = 事件分 × 本值 × 连击倍率 × 档位系数。",
  },
  tierPerfect: { label: "PERFECT 系数", def: 1.00, min: 0, max: 1, step: 0.05, group: "score", hint: "档位得分系数。" },
  tierGreat: { label: "GREAT 系数", def: 0.80, min: 0, max: 1, step: 0.05, group: "score", hint: "档位得分系数。" },
  tierGood: { label: "GOOD 系数", def: 0.60, min: 0, max: 1, step: 0.05, group: "score", hint: "档位得分系数。" },
  comboStep: {
    label: "连击加成/连", def: 0.010, min: 0, max: 0.05, step: 0.005, group: "score",
    hint: "每连击提升的得分倍率,封顶见「连击封顶」。",
  },
  comboCap: { label: "连击封顶", def: 50, min: 0, max: 200, step: 5, group: "score", hint: "连击加成按此连数封顶。" },
  monitorLog: {
    label: "落盘监测", def: false, widget: "toggle", group: "monitor",
    hint: "勾选后每帧额外算一次逐骨相似度并落盘到 data/scoring-logs/,供分析评级是否合理。"
      + "关闭时该开销完全为零(连逐骨计算都不做)。开启后结算瞬间会有一次序列化卡顿,介意就保持关闭。",
  },
  posePerfect: {
    label: "姿态 PERFECT", def: 0.80, min: 0.3, max: 1, step: 0.01, group: "score",
    hint: "窗内最佳姿态分 ≥ 此值才有 PERFECT 姿态档(与时机档取更严者)。",
  },
  poseGreat: {
    label: "姿态 GREAT", def: 0.65, min: 0.2, max: 1, step: 0.01, group: "score",
    hint: "需小于姿态 PERFECT 线,低于此值姿态档记 good。",
  },
};

export const KNOB_GROUPS = [
  { id: "judge", title: "判定与手感", desc: "影响命中宽容度与事件分构成" },
  { id: "grade", title: "评级分档", desc: "结算质量 → S/A/B/C/D" },
  { id: "score", title: "得分计算", desc: "分数量级、档位系数与连击加成" },
  { id: "monitor", title: "监测", desc: "诊断用采集,只落盘数据,不改判定与得分" },
];

export function defaultConfig() {
  const c = {};
  for (const [k, m] of Object.entries(SCORING_KNOBS)) c[k] = m.def;
  return c;
}

// 读盘并逐项规整:未知键丢弃、越界钳回、枚举值校验。不合法的存储内容不应让引擎崩。
export function loadConfig() {
  const cfg = defaultConfig();
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { raw = null; }
  if (!raw || typeof raw !== "object") return cfg;
  for (const [k, m] of Object.entries(SCORING_KNOBS)) {
    const v = raw[k];
    if (m.widget === "toggle") {
      if (typeof v === "boolean") cfg[k] = v;
      else if (LEGACY_TOGGLE[k] && v in LEGACY_TOGGLE[k]) cfg[k] = LEGACY_TOGGLE[k][v];
    } else if (typeof v === "number" && Number.isFinite(v)) {
      cfg[k] = Math.min(m.max, Math.max(m.min, v));
    }
  }
  return enforceOrdering(cfg);
}

// 交叉约束:档位必须单调递增,否则评分会自相矛盾(如 good 比 great 宽 → great 永不出现)。
// 只把每个旋钮钳回它自己的 [min, max],不改任何旋钮之间的关系。
//
// 早期版本在这里做交叉钳制(bandGood = min(judgeWindow, …) / max(bandGreat, …)),
// 结果是旋钮两头都被别的旋钮顶住:bandGood 往右被采样窗拉回、往左被 great 档顶回,
// 表现为"怎么拉都不动"。档位之间的先后关系改在消费时推导(bandsFor 排序),
// gradeFor 本来就自上而下扫描,顺序无关。
export function enforceOrdering(cfg) {
  for (const [k, m] of Object.entries(SCORING_KNOBS)) {
    if (m.widget === "toggle") {
      // 朝向对齐:旧版本存的是 "rootYaw"/"none" 字符串,迁移为布尔。
      if (cfg[k] === "rootYaw") cfg[k] = true;
      else if (cfg[k] === "none") cfg[k] = false;
      cfg[k] = cfg[k] !== false;
    } else {
      const n = Number(cfg[k]);
      cfg[k] = Number.isFinite(n) ? Math.min(m.max, Math.max(m.min, n)) : m.def;
    }
  }
  return cfg;
}

export function saveConfig(cfg) {
  const clean = enforceOrdering({ ...cfg });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch { /* 隐私模式等 */ }
  return clean;
}

export function resetConfig() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  return defaultConfig();
}

export function gradeFor(quality, cfg) {
  const g = cfg || defaultConfig();
  if (quality >= g.gradeS) return "S";
  if (quality >= g.gradeA) return "A";
  if (quality >= g.gradeB) return "B";
  if (quality >= g.gradeC) return "C";
  return "D";
}

export function tierMultipliers(cfg) {
  const c = cfg || defaultConfig();
  return { PERFECT: c.tierPerfect, GREAT: c.tierGreat, GOOD: c.tierGood, MISS: 0 };
}

// 三个时机档的边界排序后才是合法的单调集合。因为旋钮现在完全独立,用户可能把
// great 拖得比 perfect 宽;这里按边界升序排,谁窄谁拿更高的档位系数。
// miss 档的边界取 max(good, judgeWindow):采样窗才是"还可能命中"的硬边界,
// 采样窗比 good 窄时以它为准,多出来的 good 边界自然命中不到。
export function bandsFor(cfg) {
  const c = cfg || defaultConfig();
  const tiers = [
    { edge: c.bandPerfect, grade: "perfect", value: 1 },
    { edge: c.bandGreat, grade: "great", value: 0.8 },
    { edge: c.bandGood, grade: "good", value: 0.6 },
  ].sort((a, b) => a.edge - b.edge);
  return [...tiers, { edge: Math.max(tiers[2].edge, c.judgeWindow), grade: "miss", value: 0 }];
}

export function formatKnob(key, value) {
  const m = SCORING_KNOBS[key];
  if (!m) return String(value);
  if (m.widget === "toggle") return value ? "开" : "关";
  const digits = m.step >= 1 ? 0 : m.step >= 0.01 ? 2 : 3;
  return Number(value).toFixed(digits) + (m.unit || "");
}

export { STORAGE_KEY, GRADE_ORDER };
