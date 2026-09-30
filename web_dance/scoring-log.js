// 评分监测数据采集与后台上报。
// 目标:把「跟跳挑战」每帧的实时判定数据落盘到服务端 data/scoring-logs/,
// 供分析评级/得分规则是否合理(组员普遍落 D → 调整阈值)。不影响主流程与高光录制。
// 上报静默失败:只 console.warn,不阻塞结算。
const MAX_FRAMES = 20000; // 防极端长曲把内存/body 撑爆

export function createScoringLog() {
  return { frames: [] };
}

export function recordScoringFrame(log, entry) {
  if (!log || log.frames.length >= MAX_FRAMES) return;
  log.frames.push(entry);
}

export function finalizeScoringLog(log, result, context = {}) {
  // 不含时间戳/随机值:finalize 必须可重复调用得到同一结果(regression test 校验幂等)。
  if (!log || !log.frames.length) return null;
  return { schema: "scoring-log/v1", result, context, frames: log.frames };
}

// JSON.stringify 几 MB 的数组本身就要几十上百毫秒,直接放在调用点会卡住
// 结算画面(此时正在 showResult + 起高光)。先让出一帧再做序列化。
const nextTick = (fn) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
};

export async function postScoringLog(payload) {
  if (!payload) return;
  const body = await new Promise((resolve) => nextTick(() => {
    try { resolve(JSON.stringify({ ...payload, createdAt: Date.now() })); }
    catch (e) { console.warn("[scoring-log] 序列化失败:", e.message); resolve(null); }
  }));
  if (!body) return;
  try {
    const res = await fetch("/api/scoring-log", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Device-Token": localStorage.getItem("dance-device-token") || "" },
      body,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `评分日志上报失败 (${res.status})`);
    }
  } catch (e) {
    console.warn("[scoring-log]", e.message);
  }
}