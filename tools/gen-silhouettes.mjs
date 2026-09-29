/**
 * gen-silhouettes.mjs — 生成选曲卡片的「3D 舞者白影剪影」(默认那 4 张)。
 *
 * 逻辑与批量脚本完全共用:
 *   页面内渲染核心 → web_dance/silhouette.js
 *   Node 侧驱动     → tools/silhouette-core.mjs(Chrome 无头 + 临时 harness 页面)
 * 需要批量/自定义尺寸时刻 → 用 tools/batch-silhouettes.mjs。
 *
 * 输出:web_dance/assets/silhouettes/{demo,hiphop,salsa,free}.png
 * 前置:DANCE ARENA 服务已在运行(npm start,默认 8000),且可访问 jsdelivr CDN。
 * 用法:node tools/gen-silhouettes.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSilhouetteBatch } from "./silhouette-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "web_dance/assets/silhouettes");

// 命名沿用卡片里的引用:demo / hiphop / salsa 各取「最展开的招牌动作」,
// free 用合成舞 0.5s 处的一帧(自由舞动的示意姿势)。
const JOBS = [
  { name: "demo", danceId: "demo-arena-loop", count: 1 },
  { name: "hiphop", danceId: "hiphop", count: 1 },
  { name: "salsa", danceId: "salsa", count: 1 },
  { name: "free", danceId: "demo-arena-loop", times: [0.5] },
];

const { shots, failures } = await renderSilhouetteBatch(JOBS, { size: 512 });
mkdirSync(OUT, { recursive: true });
for (const s of shots) {
  const file = resolve(OUT, `${s.name}.png`);
  writeFileSync(file, s.buffer);
  console.log(`saved ${s.name}.png (${s.width}x${s.height}) dance=${s.danceId} t=${s.t}s -> ${file}`);
}
if (failures.length) {
  console.error(`有 ${failures.length} 张失败,详见上面的报错`);
  process.exit(1);
}
console.log("DONE");
