/**
 * export-chart-cli.js — 自动编谱起点:参考序列 → chart/v2 谱面文件。
 *
 * 用法:
 *   npm run export-chart                                     # demo → <danceId>.chart.json(独立编辑器格式)
 *   npm run export-chart -- <ref.json>                       # 独立 chart 文件(schema/sequenceFile 包装)
 *   npm run export-chart -- <ref.json> --inline              # 就地合并进阶序列文件顶层 chart(运行时权威位置)
 *   npm run export-chart -- <ref.json> --out x.json --step 8 # 自定义输出路径与采样帧距
 *
 * 产物兼容契约 §4.2:独立文件 = { schema:"chart/v2", sequenceFile, ... };内嵌 = seq.chart。
 * 模块C 扩展字段(boneWeights/judgeWindow/note difficulty/window)为可选,见 chart-events-spec.md。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildChart } from "../src/chartBuilder.js";
import { assertValidSequence } from "../src/contractValidate.js";
import {
  mergeChartIntoSequence,
  parseChart,
  serializeChart,
  toStandaloneChart
} from "../src/chartCodec.js";
import { basename } from "node:path";

function parseArgs(argv) {
  const args = { source: null, out: null, step: null, mode: "uniform", inline: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--step") args.step = Number(argv[++i]);
    else if (a === "--mode") args.mode = argv[++i];
    else if (a === "--inline") args.inline = true;
    else if (!args.source) args.source = a;
  }
  return args;
}

async function main() {
  const { source, out, step, mode, inline } = parseArgs(process.argv);
  let ref;
  let fromFile = null;
  const isDemo = !source || source === "demo" || source === "--demo";
  if (isDemo) {
    const { buildDemoSequence } = await import("./song-sources.js");
    ref = buildDemoSequence();
    fromFile = "scoring/examples/song-sources.js(buildDemoSequence)";
  } else {
    ref = JSON.parse(readFileSync(source, "utf8"));
    assertValidSequence(ref);
    fromFile = source;
  }
  const events = buildChart(ref, { mode, intervalFrames: step ?? undefined });
  const content = serializeChart(events, {
    seq: ref,
    source: "synthetic",
    builtFromReference: fromFile
  });

  if (inline && !isDemo && /\.json$/i.test(source)) {
    const merged = mergeChartIntoSequence(ref, content);
    const outPath = out ?? source;
    writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    const back = parseChart(merged, null);
    console.log(`inline-merged ${events.length} events -> ${outPath} (seq.chart 内嵌,运行时权威位置)`);
    console.log(`roundtrip parseChart(seq.chart) = ${back.length} 事件,自检通过.`);
  } else {
    if (inline) console.warn("提示:--inline 需要 <ref.json> 输入,demo 走独立格式");
    const stand = toStandaloneChart(content, {
      seq: ref,
      sequenceFile: isDemo ? undefined : basename(source)
    });
    const outPath = out ?? `${ref.danceId ?? "dance"}.chart.json`;
    writeFileSync(outPath, JSON.stringify(stand, null, 2) + "\n", "utf8");
    const back = parseChart(ref, stand);
    console.log(
      `exported ${events.length} events -> ${outPath} (danceId=${stand.danceId}, schema=chart/v2, sequenceFile=${stand.sequenceFile})`
    );
    console.log(`roundtrip parseChart(独立文件) = ${back.length} 事件,自检通过.`);
  }
}

main().catch((e) => {
  console.error("export-chart failed:", e.message);
  process.exit(1);
});