/**
 * export-songs-cli.js — 把离线舞曲构建源一次性落盘为 songs/ 免编程目录。
 *
 * 每曲一个自包含文件夹(平铺,不分子目录):
 *   songs/<danceId>/<danceId>.json        dance-sequence/v1 参考序列(内嵌 chart/v2 + timing/v1)
 *   songs/<danceId>/<danceId>.chart.json  chart/v2 独立谱面(编辑器交换格式, sequenceFile 指向同目录序列)
 *   songs/<danceId>/<audio>.wav           本曲音频(平铺)
 *   songs/<danceId>/<danceId>.fbx         [fbx 曲]原始 Mixamo 动作源(自包含)
 *   songs/index.json                      歌曲索引(启动时导入)
 *
 * 各曲数据来源(复刻浏览器原有运行行为):
 *   demo   → buildDemoSequence() 合成 + 每 2s 一个 pose 谱音符(与 demo-beat bpm120 对齐)
 *   hiphop → songs/hiphop/hiphop.fbx(Mixamo 原始源)+ pop-demo(bpm120)
 *   salsa  → songs/salsa/salsa.fbx(Mixamo 原始源)+ samba-demo(bpm100)
 *
 * 音频与 FBX 源都从 songs/<danceId>/ 原地取(幂等);web_dance/audio 与仓库根 fbx/ 已废弃。
 *
 * 用法:
 *   npm run export-songs [-- --out <dir>]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { SONGS, CHALLENGE_DANCES, FBX_DANCES, buildDemoSequence, fbxClipToSequence, parseFbxFile } from "./song-sources.js";
import { assertValidSequence } from "../src/contractValidate.js";
import { toStandaloneChart } from "../src/chartCodec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", ".."); // scoring/examples ← 仓库根
const SONGS_DIR = join(REPO_ROOT, "songs");
const DEFAULT_OUT = join(REPO_ROOT, "songs");

// 从 songs/<danceId>/ 里找同名音频(音频源已随 songs/ 落盘;找不到说明目录被误删)
function findSongAsset(file) {
  if (!existsSync(SONGS_DIR)) return null;
  for (const d of readdirSync(SONGS_DIR)) {
    const p = join(SONGS_DIR, d, file);
    if (existsSync(p)) return p;
  }
  return null;
}

// demo 参考无内嵌 chart,这里补一个「每 2s 一个 pose 音符」的谱面(等价原挑战页行为)
function embedDemoChart(seq, song) {
  const notes = [];
  for (let t = 0; t <= seq.meta.durationSec - 2; t += 2) {
    notes.push({ id: `downbeat-${t}`, t, type: "pose" });
  }
  seq.chart = { version: "chart/v2", audio: song.file, notes };
  seq.meta.timing = { version: "timing/v1", bpm: song.bpm, offsetSec: 0, tempoMap: [{ t: 0, bpm: song.bpm }] };
  const beat = 60 / song.bpm;
  const beats = [];
  for (let t = 0; t <= seq.meta.durationSec; t += beat) beats.push(+t.toFixed(3));
  seq.meta.beatTimesSec = beats;
  return seq;
}

function songOf(id) {
  const s = SONGS.find((x) => x.id === id);
  if (!s) throw new Error(`未知歌曲 ${id}`);
  return s;
}

async function fbxSources(fbxId, danceId) {
  const fbxName = FBX_DANCES.find((x) => x.id === fbxId)?.fbx;
  if (!fbxName) throw new Error(`未知 FBX ${fbxId}`);
  const src = join(SONGS_DIR, danceId, `${danceId}.fbx`); // 原始 Mixamo 源随 songs/ 落盘
  if (!existsSync(src)) throw new Error(`缺少原始 FBX 源:${src}(应先放一份到 songs/${danceId}/)`);
  const buf = readFileSync(src);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { root: parseFbxFile(ab), fbxName };
}

async function main() {
  const out = process.argv[2] === "--out" ? process.argv[3] : DEFAULT_OUT;
  const indexDances = [];
  const indexSongs = SONGS.map((s) => ({ id: s.id, label: s.label, file: s.file, bpm: s.bpm }));

  for (const d of CHALLENGE_DANCES) {
    const song = songOf(d.defaultSongId);
    let seq;
    let fbxFile = null;

    if (d.kind === "demo") {
      seq = embedDemoChart(buildDemoSequence(), song);
    } else {
      const { root } = await fbxSources(d.fbxId, d.danceId);
      const clip = (root.animations || [])[0];
      if (!clip) throw new Error(`${d.label} FBX 里没有动画片段`);
      seq = fbxClipToSequence(clip, root, { bpm: song.bpm, audio: song.file, danceId: d.danceId });
      fbxFile = `${d.danceId}.fbx`;
    }

    assertValidSequence(seq);

    const dir = join(out, d.danceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${d.danceId}.json`), JSON.stringify(seq, null, 2));
    // 独立谱面(编辑器交换格式,sequenceFile 指向本曲参考序列)
    const standalone = toStandaloneChart(seq.chart, { sequenceFile: `${d.danceId}.json` });
    writeFileSync(join(dir, `${d.danceId}.chart.json`), JSON.stringify(standalone, null, 2));
    // 音频平铺(源仍在本曲 songs/<danceId>/ 内,即写目标自身时无需复制)
    const audioSrc = findSongAsset(song.file);
    if (!audioSrc) throw new Error(`找不到音频源 ${song.file}(应已放在 songs/<danceId>/ 下)`);
    const audioDst = join(dir, song.file);
    if (audioSrc !== audioDst) copyFileSync(audioSrc, audioDst);
    // fbx 源与目标同文件(已在 songs/<danceId>/<danceId>.fbx),无需再复制

    indexDances.push({
      id: d.id,
      label: d.label,
      danceId: d.danceId,
      defaultSongId: d.defaultSongId,
      chartFile: `${d.danceId}.chart.json`,
      musicFile: song.file,
      fbxFile,
    });

    console.log(
      `  ${d.id} → ${d.danceId}/ (序列 ${seq.frames.length} 帧, 谱面 ${seq.chart.notes.length} 音符, 音频 ${song.file}${fbxFile ? ", " + fbxFile : ""})`,
    );
  }

  const index = {
    schema: "songs/index/v1",
    dances: indexDances,
    songs: indexSongs,
  };
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2));
  console.log(`songs/index.json: dances=${indexDances.length} songs=${indexSongs.length}`);
  console.log("export-songs done.");
}

main().catch((e) => {
  console.error("export-songs failed:", e.stack || e.message);
  process.exit(1);
});