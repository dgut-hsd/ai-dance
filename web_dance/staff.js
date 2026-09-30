// 视频管理:管理所有录制任务,生成进度 / 二维码 / 下载 / 重试 / 删除。
// 设备密钥在「游戏设置」页配置,存 localStorage(同源共享),这里直接读取。
const $ = (id) => document.getElementById(id);
const STATUS = { uploading: '待上传', queued: '待生成', processing: '生成中', ready: '可领取', failed: '生成失败', expired: '已过期', deleted: '已删除' };

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `请求失败 (${res.status})`); e.status = res.status; throw e; }
  return body;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// 当前摊开在屏幕上的交付弹窗对应哪一条;刷新时据此自动更新。
let openJobId = null;
function openDownload(job) {
  const id = job.id;
  openJobId = id;
  $("short-qr").src = `/api/highlights/${id}/qr-short`;
  $("short-link").href = `/api/highlights/${id}/media?download=1`;
  const longReady = job.fullStatus === "ready";
  $("long-qr").hidden = !longReady;
  $("long-link").hidden = !longReady;
  $("long-waiting").hidden = longReady;
  if (longReady) {
    $("long-qr").src = `/api/highlights/${id}/qr-long`;
    $("long-link").href = `/api/highlights/${id}/full-media?download=1`;
  } else {
    $("long-qr").removeAttribute("src");
    $("long-waiting").textContent = job.fullStatus === "failed" ? "完整视频生成失败" : "完整视频生成中，就绪后二维码会自动出现";
  }
  $("download-modal").classList.remove("hidden");
}
function closeModals() {
  openJobId = null;
  $("download-modal").classList.add("hidden");
}
// 完整纪念版要在高光成片之后再转一条,现场要等几十秒。弹窗开着就跟着 4 秒刷新走:
// 工作人员不必关掉再重开,长版就绪后二维码自己出现;任务被删/过期则收起弹窗。
function syncModal(jobs) {
  if (!openJobId) return;
  const job = jobs.find(j => j.id === openJobId);
  if (!job || job.status !== "ready") { closeModals(); return; }
  openDownload(job);
}

// 缩略图:取片台要靠这张图把"站在柜台前的人"和某条视频对上号。
// 列表每 4 秒整表重建,而 /api/ 响应是 no-store,直接用 <img src> 会每 4 秒重新下载一次并闪烁。
// 所以每个任务只取一次,缓存同一个 <img> 节点跨渲染复用;appendChild 会自动把它从上一张卡片摘下来。
const thumbs = new Map();
function thumbNode(j) {
  const box = el("div", "job-thumb");
  let img = thumbs.get(j.id);
  if (img === undefined) {
    img = el("img");
    img.alt = "这一局的画面";
    img.decoding = "async";
    thumbs.set(j.id, img);
    fetch(j.thumbUrl || `/api/highlights/${j.id}/thumb`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((blob) => { img.src = URL.createObjectURL(blob); })
      .catch(() => { thumbs.set(j.id, null); });
  }
  if (img) box.appendChild(img);
  else { box.classList.add("failed"); box.appendChild(el("span", "job-thumb-note", "无缩略图")); }
  return box;
}

function render(jobs) {
  const main = $("jobs");
  main.innerHTML = "";
  if (!jobs.length) { main.appendChild(el("p", "empty", "暂无录制任务")); return; }
  for (const j of jobs) {
    const card = el("article", "job " + j.status);
    const grade = j.result ? `${j.result.grade} 级 · ${j.result.score} 分` : "—";
    const dur = j.duration ? ` · ${Math.round(j.duration)}s` : "";

    const head = el("div", "job-head");
    head.appendChild(el("span", "job-id", j.id.slice(0, 8) + "…"));
    head.appendChild(el("span", "job-time", new Date(j.createdAt).toLocaleTimeString("zh-CN")));
    card.appendChild(head);

    // 只有成片有缩略图;上传中/失败的任务没有画面可认。
    if (j.status === "ready") card.appendChild(thumbNode(j));

    const meta = el("div", "job-meta");
    meta.appendChild(el("span", "job-status", STATUS[j.status] || j.status));
    meta.appendChild(el("span", "job-info", `${grade}${dur}`));
    card.appendChild(meta);

    const actions = el("div", "job-actions");
    if (j.status === "ready") {
      // 观看 = 打开用户领取页(新标签),与用户扫码看到的一致
      const watch = el("a", "btn", "观看");
      watch.href = `/v/${j.id}`;
      watch.target = "_blank";
      watch.rel = "noopener";
      const dl = el("button", "btn ghost", "领取码");
      dl.onclick = () => openDownload(j);
      actions.append(watch, dl);
    } else if (j.status === "failed") {
      const retry = el("button", "btn", "重试生成");
      retry.onclick = async () => { await api(`/api/highlights/${j.id}/retry`, { method: "POST", headers: { "X-Owner-Token": j.ownerToken } }); refresh(); };
      actions.appendChild(retry);
    }
    const del = el("button", "btn danger", "删除");
    del.onclick = async () => {
      if (!confirm("删除后用户无法再领取，确定？")) return;
      await api(`/api/highlights/${j.id}`, { method: "DELETE", headers: { "X-Owner-Token": j.ownerToken } });
      refresh();
    };
    actions.appendChild(del);
    card.appendChild(actions);
    main.appendChild(card);
  }
}

async function refresh() {
  try {
    const jobs = await api("/api/highlights", { headers: { "X-Device-Token": localStorage.getItem("dance-device-token") || "" } });
    $("status").textContent = `共 ${jobs.length} 条 · ${new Date().toLocaleTimeString("zh-CN")}`;
    render(jobs);
    syncModal(jobs);
  } catch (e) {
    $("status").textContent = e.message;
    $("jobs").innerHTML = "";
    $("jobs").appendChild(el("p", "empty", e.message));
  }
}

$("refresh").onclick = refresh;
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
refresh();
setInterval(refresh, 4000);
