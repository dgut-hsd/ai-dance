/**
 * studio-video-pipeline.mjs — 把一批视频按「作品工坊」的视频模式流水线批量上架进游戏。
 *
 * 走的是和 /studio 页面完全一样的六个步骤,只是用命令行把浏览器里手点的那部分自动化:
 *   ① 素材      PUT /api/drafts/:id/source            上传 mp4
 *   ② 音频      POST /api/drafts/:id/extract-audio    ffmpeg 抽 wav
 *   ③ 动作序列  无头 Chrome 跑 MediaPipe 逐帧识别 → PUT /api/drafts/:id/sequence
 *   ④ 谱面      按 BPM 每 2 拍铺一个判定点 → PUT /api/drafts/:id/chart(并内嵌进序列顶层 chart)
 *   ⑤ 判定白影  无头 Chrome 用 silhouette.js 逐判定点渲染 PNG → PUT /api/drafts/:id/lane
 *   ⑥ 出炉      POST /api/drafts/:id/publish          搬进 songs/ + videos/ + assets/lane/ 并写索引
 *
 * 为什么③⑤必须在浏览器里跑:动捕(pose_capture/*)和剪影(web_dance/silhouette.js)本来就是
 * 浏览器端模块,Node 里没有等价实现。这里用 Playwright 起真 Chrome,页面从正在运行的
 * DANCE ARENA 服务加载模块 —— 与 /studio 页面执行的是同一份代码。
 *
 * 前置:
 *   1) DANCE ARENA 服务已在运行(默认 http://127.0.0.1:8000);
 *   2) 本机有 Chrome。
 *
 * 用法:
 *   node tools/studio-video-pipeline.mjs --dir 训练视频                    # 全部
 *   node tools/studio-video-pipeline.mjs --videos 舞蹈7.mp4 --step all      # 只做一支(端到端验证)
 *   node tools/studio-video-pipeline.mjs --videos 舞蹈2.mp4,舞蹈3.mp4       # 指定几支
 *   node tools/studio-video-pipeline.mjs --step sequence                    # 只补动作序列(其余已完成)
 *   node tools/studio-video-pipeline.mjs --force --step lane                # 白影重新生成
 *
 * 断点续跑:每一步开工前先看草稿里该文件在不在,在就跳过 —— 中断后重跑不会白干。
 * 单支视频全程约 0.5s/帧(纯 CPU + 软件 WebGL),15fps 采样下一支 25s 的舞约 3~4 分钟。
 *
 * 完整说明(为什么③⑤必须在浏览器里跑、产物落在哪、实测耗时、踩过的坑):
 *   docs/studio-video-batch.md
 */
import { createReadStream, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openHarness, DEFAULT_BASE } from "./video-import-core.mjs";
import { renderLaneFromSequences } from "./silhouette-payload.mjs";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const HELP = `把视频批量走「作品工坊」视频线路上架

  --dir <dir>        视频目录(默认 <repo>/训练视频)
  --videos a.mp4,b.mp4  只处理这些文件(默认目录里全部 mp4)
  --step <name>      upload|audio|sequence|chart|lane|publish|all(默认 all;可逗号组合)
  --fps <n>          动捕采样帧率(默认 15)
  --bpm <n>          谱面 BPM,每 2 拍一个判定点(默认 120)
  --base <url>       服务地址(默认 http://127.0.0.1:8000)
  --model <url>      判定白影用的模型(默认 /models/Michelle.glb)
  --size <n>         白影画布边长(默认 256)
  --suffix <s>       danceId 后缀(默认 -video,如 dance2-video)
  --force            已存在的产物也重做
  --dry              只打印计划,不改任何东西
  --help             看这段说明
`;

function parseArgs(argv) {
  const a = {
    dir: path.join(ROOT, "训练视频"), videos: null, steps: ["all"], fps: 15, bpm: 120,
    base: DEFAULT_BASE, model: "/models/Michelle.glb", size: 256, suffix: "-video",
    force: false, dry: false, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--dir") a.dir = v();
    else if (k === "--videos") a.videos = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--step") a.steps = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--fps") a.fps = Number(v());
    else if (k === "--bpm") a.bpm = Number(v());
    else if (k === "--base") a.base = v();
    else if (k === "--model") a.model = v();
    else if (k === "--size") a.size = Number(v());
    else if (k === "--suffix") a.suffix = v();
    else if (k === "--force") a.force = true;
    else if (k === "--dry") a.dry = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`未知参数: ${k}`);
  }
  return a;
}

// ---------------------------------------------------------------------------
// 视频时长(ffmpeg -i 的 stderr 里读,不依赖 ffprobe)
// ---------------------------------------------------------------------------
function probeSeconds(file) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ["-hide_banner", "-i", file], { timeout: 30000 }, (err, _stdout, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ""));
      if (!m) return reject(new Error("读不到时长"));
      resolve((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
    });
  });
}

// ---------------------------------------------------------------------------
// 中文标题 → 稳定的 ASCII danceId
// ---------------------------------------------------------------------------
const PINYIN = {
  舞蹈: "dance", 闪身步: "shanshenbu", 训练: "training", 开场: "intro",
  一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10",
};

/** 「舞蹈2.mp4」→「dance2」;「闪身步.mp4」→「shanshenbu」。认不出来的中文一律丢掉,别让非法字符进 danceId。 */
function asciiStem(filename) {
  const stem = String(filename).replace(/\.[^.]+$/, "");
  let out = stem;
  // 汉字换成拼音(前后补空格,让"舞蹈2"断成两块),再把每块里不肯定的字符删掉、小写、拼回去。
  // 直接拼而不是用连字符:舞名要是 dance2 这种紧凑形式,才和已有的 dance1-video 是一套命名。
  for (const [zh, en] of Object.entries(PINYIN)) out = out.split(zh).join(` ${en} `);
  const kept = out
    .split(/[^a-zA-Z0-9_-]+/)
    .map((s) => s.replace(/-/g, "").toLowerCase())
    .filter(Boolean);
  return kept.join("") || "clip";
}

// 动态 import 一下上面这段的同一份逻辑做自检(改坏了立刻能发现,不用等到跑完动捕)
if (process.env.STUDIO_ID_SELFTEST) {
  for (const n of ["舞蹈2.mp4", "舞蹈7.mp4", "闪身步.mp4", "舞蹈1.mp4"]) console.log(n, "->", asciiStem(n));
}

function danceIdFor(filename, suffix) {
  const id = `${asciiStem(filename)}${suffix}`.replace(/[^a-z0-9_-]/g, "");
  return id.replace(/^[^a-z0-9]+/, "").slice(0, 64);
}

// ---------------------------------------------------------------------------
// 服务端 API(与 /studio 页面调的是同一批接口)
// ---------------------------------------------------------------------------
function makeApi({ base }) {
  const headers = (extra = {}) => {
    const t = process.env.DEVICE_TOKEN || "";
    return t ? { "X-Device-Token": t, ...extra } : extra;
  };
  const call = async (url, { method = "GET", body, timeoutMs = 60000, raw = false } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: headers(raw ? {} : body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      duplex: raw ? "half" : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${typeof parsed === "object" ? JSON.stringify(parsed) : parsed}`);
    return parsed;
  };
  /** 读序列/谱面文本:服务端按 text/plain 回,必须走 res.text()(上面的 call 会把它解析成字符串,再 JSON.parse 就炸)。 */
  const callText = async (url, timeoutMs = 120000) => {
    const res = await fetch(`${base}${url}`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.text();
  };
  return {
    call,
    works: () => call("/api/works"),
    createDraft: (mode, label) => call("/api/drafts", { method: "POST", body: { mode, label } }),
    draft: (id) => call(`/api/drafts/${id}`),
    putMeta: (id, meta) => call(`/api/drafts/${id}/meta`, { method: "PUT", body: meta }),
    uploadSource: (id, filePath) => call(
      `/api/drafts/${id}/source?name=${encodeURIComponent(path.basename(filePath))}`,
      { method: "PUT", body: createReadStream(filePath), raw: true, timeoutMs: 15 * 60 * 1000 },
    ),
    extractAudio: (id) => call(`/api/drafts/${id}/extract-audio`, { method: "POST", body: {}, timeoutMs: 10 * 60 * 1000 }),
    putSequence: (id, text) => call(`/api/drafts/${id}/sequence`, { method: "PUT", body: text, raw: true, timeoutMs: 10 * 60 * 1000 }),
    putChart: (id, text) => call(`/api/drafts/${id}/chart`, { method: "PUT", body: text, raw: true, timeoutMs: 60 * 1000 }),
    text: (id, kind) => callText(`/api/drafts/${id}/text/${kind}`, 120000),
    putLane: (id, payload) => call(`/api/drafts/${id}/lane`, { method: "PUT", body: JSON.stringify(payload), raw: true, timeoutMs: 10 * 60 * 1000 }),
    publish: (id, overwrite = false) => call(`/api/drafts/${id}/publish`, { method: "POST", body: { overwrite }, timeoutMs: 10 * 60 * 1000 }),
  };
}

// ---------------------------------------------------------------------------
// 谱面:每 2 拍一个判定点(与 3D 模式 FBX 采样后自动铺点的节奏一致)
//
// 两条硬约束(都由视频源的实际内容决定,不能想当然):
//   1) **判定点的 t 必须落在真采到姿态的时间范围里**。抖音下载的视频末尾通常挂一张
//      3 秒左右的片尾卡(「大家都在抖音搜索…」,画面里没有人),MediaPipe 在那里
//      一律返回 world=null,序列自然就断在片尾卡之前。按容器时长铺点会铺出一段
//      「对着空气跳舞」的判定区。
//   2) **refFrameIdx 必须按帧自带的 t 就近绑定**,不能 round(t × fps) 反推下标 ——
//      视频模式按时间对齐,序列可能抽帧不均匀,反推会随时间线性漂移。
//      回归:test/pose-lane.test.js「每个判定音符的参考帧时间与 note.t 相差 <= 0.05s」。
// 两条一起做,note.t 就等于 frames[refFrameIdx].t 本身(零偏差),画面与判定严格同步。
// ---------------------------------------------------------------------------
function buildChart({ danceId, audioFile, fps, bpm, durationSec, frames }) {
  const beat = 60 / bpm;
  const step = beat * 2;
  const lastFrameT = frames.at(-1)?.t ?? 0;
  // 判定点铺到「最后一帧」为止,再留 1 拍缓冲(不在最后一帧上打点)
  const end = Math.max(0, lastFrameT - beat);
  const notes = [];
  let worstDrift = 0;
  let skippedNotes = 0;
  // 帧时刻与判定时刻都是递增的,用单调指针就近取帧(不必每个点都从头扫一遍)
  let cursor = 0;
  for (let t = 0, i = 1; ; t += step, i++) {
    if (t > end + 1e-6) {
      // 剩下的是末尾没画面的那段时间(片尾卡):不铺点,只计数
      const nominalEnd = Math.max(0, (durationSec ?? lastFrameT) - beat);
      skippedNotes = Math.max(0, Math.floor((nominalEnd - end) / step + 1e-6));
      break;
    }
    while (cursor + 1 < frames.length && Math.abs(frames[cursor + 1].t - t) <= Math.abs(frames[cursor].t - t)) cursor++;
    const refFrameIdx = cursor;
    // 判定时刻 = 参考帧自己的时刻:评分比对的帧和玩家看到的画面严格同步(零偏差)
    const tt = +(frames[refFrameIdx]?.t ?? t).toFixed(4);
    worstDrift = Math.max(worstDrift, Math.abs(tt - t));
    notes.push({ id: `动作 ${i * 2 - 1}`, t: tt, type: "pose", refFrameIdx });
  }
  return {
    chart: {
      version: "chart/v2",
      danceId,
      audio: audioFile,
      audioOffsetSec: 0,
      judgeOffsetSec: 0,
      notes,
      meta: { source: "studio-video-pipeline", bpm, fps, stepBeats: 2 },
    },
    worstDrift,
    skippedNotes,
    lastFrameT,
    tailSec: Math.max(0, (durationSec ?? lastFrameT) - lastFrameT),
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const STEP_ORDER = ["upload", "audio", "sequence", "chart", "lane", "publish"];

function wantStep(args, step) {
  return args.steps.includes("all") || args.steps.includes(step);
}

const fmtSec = (s) => (s == null ? "?" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  if (!/^https?:\/\//.test(args.base)) throw new Error(`--base 需要是 http(s) URL,收到 ${args.base}`);
  const api = makeApi({ base: args.base });

  // 服务在不在?不在就直接说清楚,别让后面每一步各自超时
  try { await api.works(); }
  catch (e) { throw new Error(`连不上服务 ${args.base}(${e.message})。先在仓库根目录 npm start。`); }

  // ---- 收集要处理的视频 ----
  const all = (await readdir(args.dir)).filter((n) => /\.(mp4|mov|webm|mkv)$/i.test(n));
  const names = args.videos ? all.filter((n) => args.videos.includes(n)) : all;
  if (!names.length) throw new Error(`在 ${args.dir} 里没找到要处理的视频(目录里:${all.join(", ") || "空"})`);
  const missing = (args.videos || []).filter((n) => !all.includes(n));
  if (missing.length) throw new Error(`这些文件不在 ${args.dir} 里:${missing.join(", ")}`);

  // 慢的放最后:动捕按视频时长线性耗时,先出成果的作品先落地(中途中断也不至于全废)。
  // 时长用 ffmpeg 探一次(不依赖 ffprobe),探不到就按文件大小估。
  const durations = new Map();
  for (const n of names) {
    const p = path.join(args.dir, n);
    const seconds = await probeSeconds(p).catch(() => null);
    durations.set(n, seconds ?? (await stat(p)).size / 250000);
  }
  names.sort((a, b) => durations.get(a) - durations.get(b));

  console.log(`服务 ${args.base} · 采样 ${args.fps}fps · BPM ${args.bpm} · 步骤 ${args.steps.join("+")}${args.force ? " · --force" : ""}`);
  console.log(`待处理 ${names.length} 个视频(按时长从短到长):`
    + names.map((n) => `${n}(${Math.round(durations.get(n))}s)`).join(", "));

  // 已有作品(用来续跑:同一个源视频名 → 同一条草稿)
  let works = await api.works();
  const bySource = new Map();
  for (const w of works) if (w.files?.source) bySource.set(w.files.source, w);

  // 动捕 harness 只在真需要时开(开一次 Chrome 约 0.6s,但模型加载是每次 render 各一次)
  let harness = null;
  const needHarness = wantStep(args, "sequence");
  const t0All = Date.now();
  const summary = [];
  let liveLine = "";
  let t0Cur = Date.now();   // 当前这支舞动捕的起点(进度行用它算速率)

  /** 一行刷新的进度(每支舞动捕几分钟,不刷进度就只能干等) */
  const progressLine = (text) => {
    const line = `\r      ${text}`.padEnd(liveLine.length > text.length ? liveLine.length : 40);
    process.stderr.write(line);
    if (text.length > liveLine.length) liveLine = `\r      ${text}`;
  };

  try {
    if (needHarness && !args.dry) {
      harness = await openHarness({
        base: args.base,
        onLog: (m) => { if (/pageerror/i.test(m)) process.stderr.write(`\n${m}\n`); },
        onProgress: (p) => {
          if (p.phase === "loading-model") return progressLine("加载动捕模型…");
          if (p.phase !== "processing") return;
          const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
          const rate = p.current ? (Date.now() - t0Cur) / p.current : 0;
          const left = p.total ? Math.max(0, p.total - p.current) * rate : 0;
          progressLine(`${pct}% ${p.current}/${p.total} 帧 · 采到 ${p.kept} · ${rate ? (rate / 1000).toFixed(1) : "?"}s/帧 · 约剩 ${Math.ceil(left / 60000)} 分钟`);
        },
      });
    }

    for (const [idx, name] of names.entries()) {
      const src = path.join(args.dir, name);
      const bytes = (await stat(src)).size;
      const stem = name.replace(/\.[^.]+$/, "");
      const danceId = danceIdFor(name, args.suffix);
      console.log(`\n=== [${idx + 1}/${names.length}] ${name} (${(bytes / 1048576).toFixed(1)} MB) → danceId "${danceId}" ===`);

      // ---- 找到或新建草稿 ----
      let work = bySource.get(name) || null;
      if (!work && !args.dry) {
        work = await api.createDraft("video", stem);
        await api.putMeta(work.id, { danceId, videoName: name });
        work = await api.draft(work.id);
        console.log(`  新建作品 ${work.id}`);
      } else if (work) {
        console.log(`  复用已有作品 ${work.id}(status=${work.status})`);
      }
      if (args.dry) { summary.push({ name, danceId, id: work?.id ?? "(新建)", dry: true }); continue; }

      const has = (k) => Boolean(work.files?.[k]);
      const t0 = Date.now();
      t0Cur = Date.now();
      if (liveLine) { process.stderr.write("\n"); liveLine = ""; }

      // ---- ① 素材 ----
      if (wantStep(args, "upload") && (!has("source") || args.force)) {
        const r = await api.uploadSource(work.id, src);
        console.log(`  ① 素材已上传:${r.files.source}`);
      } else if (has("source")) {
        console.log(`  ① 素材已存在,跳过(${work.files.source})`);
      }

      // ---- ② 音频 ----
      if (wantStep(args, "audio") && (!has("audio") || args.force)) {
        const r = await api.extractAudio(work.id);
        console.log(`  ② 音频已抽取:${r.files.audio}`);
      } else if (has("audio")) {
        console.log(`  ② 音频已存在,跳过(${work.files.audio})`);
      }

      work = await api.draft(work.id);
      if (!work.files?.audio) throw new Error(`作品 ${work.id} 还没有音频,后面步骤做不了`);

      // ---- ③ 动作序列 ----
      let seq = null;
      const seqUrl = `/api/drafts/${work.id}/raw/source`;
      if (wantStep(args, "sequence") && (!has("sequence") || args.force)) {
        const tt = Date.now();
        const raw = await harness.page.evaluate(
          (o) => window.__render(o),
          { url: `${args.base}${seqUrl}`, fps: args.fps, mode: "full-body", name },
        );
        const stats = raw._stats || {};
        seq = raw;
        delete seq._stats;   // 统计只是给日志看的,别写进序列文件
        if (liveLine) { process.stderr.write("\n"); liveLine = ""; }
        console.log(`  ③ 动捕完成:${seq.meta.numFrames} 帧 / ${seq.meta.durationSec}s(${fmtSec((Date.now() - tt) / 1000)},`
          + ` 识别 ${(stats.detectMs / 1000).toFixed(0)}s · 定位 ${(stats.seekMs / 1000).toFixed(0)}s · 失败帧 ${stats.frameErrors})`);
        if (stats.frameErrors && stats.firstError) console.log(`     首个失败原因:${stats.firstError}`);
        if (!seq.frames?.length) throw new Error("动捕没采到帧");
      } else if (has("sequence")) {
        console.log(`  ③ 动作序列已存在,跳过(${work.files.sequence})`);
      }

      // ---- ④ 谱面 ----
      if (wantStep(args, "chart") || wantStep(args, "sequence") || wantStep(args, "lane")) {
        if (!seq) {
          const text = await api.text(work.id, "sequence");
          seq = JSON.parse(text || "{}");
        }
        if (!seq.frames?.length) throw new Error("没有可用的动作序列,先跑 --step sequence");
        const built = buildChart({
          danceId, audioFile: work.files.audio, fps: args.fps, bpm: args.bpm,
          durationSec: seq.meta?.durationSec, frames: seq.frames,
        });
        const chart = built.chart;
        if (built.tailSec > 0.5) {
          console.log(`     注:序列最后一帧在 ${built.lastFrameT.toFixed(2)}s,视频时长 ${(seq.meta?.durationSec ?? 0).toFixed(2)}s —— `
            + `末尾 ${built.tailSec.toFixed(2)}s 没采到姿态(抖音片尾卡,画面里没有人),判定点只铺到有画面为止(少铺 ${built.skippedNotes} 个)`);
        }
        if (wantStep(args, "chart") && (!has("chart") || args.force || wantStep(args, "sequence"))) {
          await api.putChart(work.id, JSON.stringify(chart));
          console.log(`  ④ 谱面已写入:${chart.notes.length} 个判定点(每 2 拍一个 @ ${args.bpm} BPM)`);
        } else if (has("chart")) {
          console.log(`  ④ 谱面已存在,跳过(${work.files.chart})`);
        }
        // 序列顶层内嵌 chart:运行时(pose-lane.js → computePoseEvents)读的是 seq.chart,
        // 谱面文件只是编辑器的交换格式。两份不同步就会出现「谱面有判定点但车道是空的」。
        if (!seq.chart || JSON.stringify(seq.chart.notes) !== JSON.stringify(chart.notes) || args.force) {
          seq.chart = chart;
          await api.putSequence(work.id, JSON.stringify(seq));
          console.log(`  ④ 序列已重新写入(内嵌 chart,${(JSON.stringify(seq).length / 1048576).toFixed(1)} MB)`);
        }
      }

      work = await api.draft(work.id);

      // ---- ⑤ 判定轨道白影 ----
      if (wantStep(args, "lane")) {
        if (!has("lane") || args.force) {
          if (!seq?.chart) throw new Error("序列里没有内嵌 chart,白影不知道要拍哪些帧");
          const tt = Date.now();
          const [res] = await renderLaneFromSequences(
            [{ danceId, seq }],
            { base: args.base, model: args.model, size: args.size, color: "#ffffff", onLog: (m) => process.stderr.write(m + "\n") },
          );
          if (res.error) throw new Error(`白影渲染失败:${res.error}`);
          const payload = {
            model: args.model, size: args.size, color: "#ffffff",
            notes: res.notes.map((n) => ({
              t: n.t, key: n.key, moveId: n.moveId, w: n.width, h: n.height,
              joints: n.joints, dataUrl: `data:image/png;base64,${n.buffer.toString("base64")}`,
            })),
          };
          const r = await api.putLane(work.id, payload);
          console.log(`  ⑤ 白影已保存:${r.notes} 张(${fmtSec((Date.now() - tt) / 1000)})`);
        } else {
          console.log(`  ⑤ 白影已存在,跳过(${work.files.lane})`);
        }
      }

      // ---- ⑥ 出炉 ----
      let published = null;
      if (wantStep(args, "publish")) {
        const cur = await api.draft(work.id);
        if (cur.status === "published" && !args.force) {
          console.log(`  ⑥ 已上架,跳过(songs/${cur.danceId}/)`);
          published = { danceId: cur.danceId, videoName: cur.videoName };
        } else {
          const r = await api.publish(work.id, false);
          published = r;
          console.log(`  ⑥ 已上架 → songs/${r.danceId}/ · videos/${r.videoName}`);
        }
      }

      summary.push({
        name, danceId, workId: work.id,
        frames: seq?.meta?.numFrames ?? null, seconds: seq?.meta?.durationSec ?? null,
        notes: seq?.chart?.notes?.length ?? null,
        published: published?.danceId ?? null,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
      });
    }
  } finally {
    await harness?.close();
  }

  console.log(`\n===== 汇总(总耗时 ${fmtSec((Date.now() - t0All) / 1000)})=====`);
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(16)} ${s.danceId.padEnd(16)} `
      + `frames=${String(s.frames ?? "-").padStart(5)} notes=${String(s.notes ?? "-").padStart(3)} `
      + `published=${s.published ?? "-"} ${s.elapsedSec}s`);
  }
  const reportFile = path.join(ROOT, "tmp", "studio-video-pipeline-report.json");
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify({ at: new Date().toISOString(), args: { ...args }, summary }, null, 2));
  console.log(`报告 → ${reportFile}`);
}

main().catch((e) => { console.error("\n失败:", e.message); process.exit(1); });
