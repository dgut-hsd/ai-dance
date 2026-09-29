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

function openDownload(id) {
  $("download-qr").src = `/api/highlights/${id}/qr-download`;
  $("download-link").href = `/api/highlights/${id}/media?download=1`;
  $("download-modal").classList.remove("hidden");
}
function closeModals() {
  $("download-modal").classList.add("hidden");
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
      const dl = el("button", "btn ghost", "下载");
      dl.onclick = () => openDownload(j.id);
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
