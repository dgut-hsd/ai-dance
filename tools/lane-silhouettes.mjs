/**
 * lane-silhouettes.mjs — 生成「右下判定轨道」逐判定点的 3D 舞者白影 PNG + 清单。
 *
 * 与选曲卡那 4 张(source: tools/gen-silhouettes.mjs)是同一套流水线,区别只在"拍哪几帧":
 *   - 选曲卡:每支舞 1 张「最展开的招牌动作」
 *   - 判定轨道:每个判定点 1 张(谱面 notes[].t 对应的那一帧),因为卡片上每个动作的剪影都不一样
 *
 * 产物(默认写到 web_dance/assets/lane/):
 *   <danceId>/<key>.png     固定取景、不裁剪的透明白影(key = 判定点时刻 toFixed(3))
 *   index.json              manifest/lane-silhouettes/v1:文件名 + 关节像素锚点(箭头用)
 *
 * 前置:
 *   1) npm start(默认 http://127.0.0.1:8000)—— 生成脚本借服务加载 fbx/序列/模型;
 *   2) 能访问 jsdelivr CDN(harness 从 CDN 取 three.js);
 *   3) 本机有 Chrome(Playwright 用 channel:'chrome',找不到会退回常见安装路径)。
 *
 * 用法:
 *   node tools/lane-silhouettes.mjs                         # 歌单里全部舞曲
 *   node tools/lane-silhouettes.mjs --dances hiphop,salsa    # 只做这两支
 *   node tools/lane-silhouettes.mjs --size 320 --model /models/Michelle.glb
 *   node tools/lane-silhouettes.mjs --out web_dance/assets/lane
 *
 * 跑完在游戏里点「开始挑战」,判定轨道的剪影就是这套白影;没跑过的舞曲会自动退回 2D 剪影。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BASE, fetchDanceMeta, renderSilhouetteBatch } from "./silhouette-core.mjs";
import { buildLaneManifest } from "../web_dance/lane-assets.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `逐判定点生成判定轨道的 3D 白影 PNG + 清单

  --out <dir>        输出目录(默认 web_dance/assets/lane)
  --dances a,b,c     只处理这些舞曲 id(默认歌单全部)
  --size 256         画布边长(固定取景不裁剪)
  --color "#ffffff"  剪影颜色
  --model <url>      模型路径(默认 /models/Michelle.glb)
  --base <url>       服务地址(默认 http://127.0.0.1:8000)
  --help             看这段说明
`;

function parseArgs(argv) {
  const a = {
    out: "web_dance/assets/lane", dances: null, size: 256,
    color: "#ffffff", model: "/models/Michelle.glb", base: DEFAULT_BASE,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--out") a.out = v();
    else if (k === "--dances") a.dances = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "--size") a.size = Math.max(64, Number(v()));
    else if (k === "--color") a.color = v();
    else if (k === "--model") a.model = v();
    else if (k === "--base") a.base = v();
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`未知参数: ${k}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const outDir = resolve(ROOT, args.out);
  mkdirSync(outDir, { recursive: true });

  let list = await fetchDanceMeta({ base: args.base });
  if (args.dances) {
    const want = new Set(args.dances);
    const missing = [...want].filter((id) => !list.some((d) => d.id === id || d.danceId === id));
    if (missing.length) throw new Error(`歌单里没有这些舞曲: ${missing.join(", ")}`);
    list = list.filter((d) => want.has(d.id) || want.has(d.danceId));
  }
  if (!list.length) throw new Error("没有可处理的舞曲");
  console.log("待生成:", list.map((d) => d.danceId).join(", "));

  const jobs = list.map((d) => ({ name: d.danceId, danceId: d.danceId, notes: true }));
  const { shots, failures } = await renderSilhouetteBatch(jobs, {
    base: args.base, model: args.model, size: args.size, color: hexToInt(args.color),
  });

  const byDance = new Map();
  for (const shot of shots) {
    const key = shot.key ?? Number(shot.t).toFixed(3);
    const rel = `${shot.danceId}/${key}.png`;
    const file = join(outDir, shot.danceId, `${key}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, shot.buffer);
    if (!byDance.has(shot.danceId)) byDance.set(shot.danceId, { danceId: shot.danceId, crop: shot.crop ?? null, notes: [] });
    byDance.get(shot.danceId).notes.push({
      t: shot.t, key, file: rel, w: shot.width, h: shot.height, joints: shot.joints ?? {},
    });
    console.log(`  ${rel}  ${shot.width}x${shot.height}  t=${shot.t}s  关节锚点 ${Object.keys(shot.joints ?? {}).length} 个`);
  }
  for (const d of byDance.values()) d.notes.sort((a, b) => a.t - b.t);

  const manifestPath = join(outDir, "index.json");

  // 只渲染部分曲目(--dances)时,把清单里其它曲目**原样保留**。
  // 否则 index.json 会被改写成只含本次这几支舞,其它曲目的条目消失 → 判定轨道退回 2D 兜底。
  let danceList = [...byDance.values()];
  const subset = Array.isArray(args.dances) && args.dances.length > 0;
  if (subset && existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, "utf8"));
      const regenerated = new Set(danceList.map((d) => d.danceId));
      const kept = Object.values(prev.dances ?? {}).filter((d) => d?.danceId && !regenerated.has(d.danceId));
      if (kept.length) {
        console.log(`保留清单里未渲染的 ${kept.length} 支舞:${kept.map((d) => d.danceId).join(", ")}`);
        if (prev.model !== args.model || prev.size !== args.size || prev.color !== args.color) {
          console.warn(
            `  注意:这些旧条目是用 model=${prev.model} size=${prev.size} color=${prev.color} 生成的,` +
            `与本次(${args.model}/${args.size}/${args.color})不同;要统一就整跑一次(不带 --dances)。`,
          );
        }
      }
      danceList = [...danceList, ...kept];
    } catch (e) {
      console.warn(`已有清单读取失败(${e.message}),按只含本次渲染的曲目写出`);
    }
  }

  const manifest = buildLaneManifest({
    model: args.model,
    size: args.size,
    color: args.color,
    dances: danceList,
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const total = Object.values(manifest.dances).reduce((n, d) => n + d.notes.length, 0);
  console.log(`manifest → ${manifestPath}(${Object.keys(manifest.dances).length} 支舞 / ${total} 张)`);

  if (failures.length) {
    console.error(`有 ${failures.length} 项渲染失败(其余已落盘):`);
    for (const f of failures) console.error(`  - ${f.name} (${f.danceId}): ${f.error}`);
    process.exit(1);
  }
  console.log("DONE");
}

function hexToInt(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  return m ? parseInt(m[1], 16) : 0xffffff;
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
