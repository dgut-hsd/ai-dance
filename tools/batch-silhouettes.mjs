/**
 * batch-silhouettes.mjs — 独立批量生成「3D 舞者白影剪影」PNG。
 *
 * 与 tools/gen-silhouettes.mjs 共用同一套渲染核心(web_dance/silhouette.js +
 * tools/silhouette-core.mjs),区别是这里带完整参数,适合一次产很多张。
 *
 * 前置:DANCE ARENA 服务已运行(npm start),且能访问 jsdelivr CDN。
 *
 * 用法示例:
 *   # 每支舞各 1 张招牌动作(默认,输出到 web_dance/assets/silhouettes)
 *   node tools/batch-silhouettes.mjs
 *
 *   # 每支舞 5 张、1024px、写到 build/sil,并记录清单
 *   node tools/batch-silhouettes.mjs --per-dance 5 --size 1024 --out build/sil --manifest build/sil/index.json
 *
 *   # 只要 hiphop / salsa,指定时刻,前缀 sil_
 *   node tools/batch-silhouettes.mjs --dances hiphop,salsa --times 0.5,2,4 --prefix sil_
 *
 *   # 换模型
 *   node tools/batch-silhouettes.mjs --model /models/MyAvatar.glb --size 768
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSilhouetteBatch, DEFAULT_BASE } from "./silhouette-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const a = {
    out: "web_dance/assets/silhouettes",
    dances: null,         // null = 歌单里全部
    perDance: 1,
    times: null,
    size: 512,
    color: "#ffffff",
    model: "/models/Michelle.glb",
    base: DEFAULT_BASE,
    prefix: "",
    manifest: null,
    free: false,          // 额外出一张「自由舞」招牌剪影(free.png)
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--out") a.out = v();
    else if (k === "--dances") a.dances = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--all") a.dances = null;
    else if (k === "--per-dance") a.perDance = Math.max(1, Number(v()));
    else if (k === "--times") a.times = v().split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    else if (k === "--size") a.size = Math.max(64, Number(v()));
    else if (k === "--color") a.color = v();
    else if (k === "--model") a.model = v();
    else if (k === "--base") a.base = v();
    else if (k === "--prefix") a.prefix = v();
    else if (k === "--manifest") a.manifest = v();
    else if (k === "--free") a.free = true;
    else if (k === "--help" || k === "-h") { a.help = true; }
    else throw new Error(`未知参数: ${k}`);
  }
  return a;
}

const HELP = `批量生成舞者剪影 PNG

  --out <dir>        输出目录(默认 web_dance/assets/silhouettes)
  --dances a,b,c     只处理这些舞曲 id(默认歌单全部)
  --per-dance N      每支舞生成 N 张(默认 1,自动挑最展开的招牌动作)
  --times 0.5,2,4    指定时刻(秒),覆盖 --per-dance
  --size 512         画布边长
  --color "#ffffff"  剪影颜色
  --model <url>      模型路径(默认 /models/Michelle.glb)
  --base <url>       服务地址(默认 http://127.0.0.1:8000)
  --prefix sil_      文件名前缀
  --manifest <file>  额外写一份 JSON 清单(文件名/舞曲/时刻/尺寸)
  --free             额外输出一张「自由舞」剪影 free.png
  --help             看这段说明
`;

function hexToInt(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  return m ? parseInt(m[1], 16) : 0xffffff;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const outDir = resolve(ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const colorInt = hexToInt(args.color);

  // 歌单元数据(从 songs/index.json 读,与服务同源)
  const meta = await getDanceMeta(args);
  let list = meta;
  if (args.dances) {
    const want = new Set(args.dances);
    list = meta.filter((d) => want.has(d.id) || want.has(d.danceId));
    const missing = [...want].filter((id) => !meta.some((d) => d.id === id || d.danceId === id));
    if (missing.length) throw new Error(`歌单里没有这些舞曲: ${missing.join(", ")}`);
  }
  if (!list.length) throw new Error("没有可处理的舞曲");

  const jobs = list.map((d) => ({
    name: d.id,
    danceId: d.danceId,
    ...(args.times ? { times: args.times } : { count: args.perDance }),
  }));
  if (args.free) jobs.push({ name: "free", danceId: list[0].danceId, times: [0.5] });

  const { shots, failures } = await renderSilhouetteBatch(jobs, {
    base: args.base, model: args.model, size: args.size, color: colorInt,
  });

  // 一个 name 出多张时补序号后缀
  const perName = new Map();
  for (const s of shots) perName.set(s.name, (perName.get(s.name) || 0) + 1);

  const manifest = [];
  const seen = new Map();
  for (const shot of shots) {
    const total = perName.get(shot.name) || 1;
    const k = (seen.get(shot.name) || 0) + 1;
    seen.set(shot.name, k);
    const base = total > 1 ? `${shot.name}-${k}` : shot.name;
    const file = join(outDir, `${args.prefix}${base}.png`);
    writeFileSync(file, shot.buffer);
    manifest.push({ file: file.replace(ROOT + "\\", "").replace(/\\/g, "/"), danceId: shot.danceId, t: shot.t, width: shot.width, height: shot.height });
    console.log(`saved ${base}.png  (${shot.width}x${shot.height})  dance=${shot.danceId} t=${shot.t}s`);
  }
  if (args.manifest) {
    const mf = resolve(ROOT, args.manifest);
    mkdirSync(dirname(mf), { recursive: true });
    writeFileSync(mf, JSON.stringify({ generatedAt: new Date().toISOString(), model: args.model, size: args.size, color: args.color, silhouettes: manifest }, null, 2));
    console.log("manifest ->", mf);
  }
  console.log(`DONE: ${shots.length} 张 → ${outDir}`);
  if (failures.length) process.exit(1);
}

// 单独拎出来:空任务那次跑只为了拿歌单(harness 里 window.__dances)
async function getDanceMeta(args) {
  const { launchChrome } = await import("./silhouette-core.mjs");
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    await page.route("**/silhouette-harness", (r) =>
      r.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><script type="module">
import { loadSongIndex, dances } from "/web_dance/song-library.js";
await loadSongIndex();
window.__dances = dances().map(d => ({ id: d.id, danceId: d.danceId, label: d.label }));
window.__ready = true;
</script>` }));
    await page.goto(`${args.base}/silhouette-harness`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
    return await page.evaluate(() => window.__dances);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
