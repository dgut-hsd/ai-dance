#!/usr/bin/env node
/**
 * extract-video-audio.mjs — 把舞曲视频里的音轨抽成 WAV,并接线到这条舞曲的所有引用处。
 *
 * 为什么需要它:作品工坊里「从视频提取音频」只对视频模式(素材本身就是 mp4)开放;
 * 3D 模式的素材是 FBX,没有视频可选,所以 3D 作品的音乐只能手工上传/用脚本补。
 * 这个脚本就是那条脚本通道:直接用 ffmpeg 抽音轨,然后把 songs/index.json、
 * 独立谱面、序列内嵌谱面、以及对应草稿里的音频引用一次性改到位。
 *
 * 用法(在仓库根执行):
 *   node tools/extract-video-audio.mjs --dance dance3-mixamo --video "videos/rokoko导入视频/dance3.mp4"
 *   node tools/extract-video-audio.mjs --dance dance3-mixamo --video <mp4> --name dance3.wav --song-label "Dance3 原声"
 *   node tools/extract-video-audio.mjs --dance dance3-mixamo --video <mp4> --dry-run
 *
 * 选项:
 *   --dance <danceId>    舞曲 id(songs/index.json 里 dances[].danceId 或 .id)
 *   --video <路径>       视频文件,相对仓库根或绝对路径
 *   --name <x.wav>       目标音频文件名(默认 = 视频文件名换成 .wav)
 *   --song-label <文字>   顺带改歌单里这首歌的显示名
 *   --bpm <数值>         顺带改歌单里这首歌的 BPM(默认不动)
 *   --keep-old           不删除被替换下来的旧音频
 *   --dry-run            只抽到临时目录做校验 + 打印改动清单,不写仓库
 *   --root <目录>        仓库根(默认脚本所在目录的上一级)
 *
 * 安全约束:旧音频只有在「仓库里没有别的索引条目引用它」时才会被删掉。
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const ffmpeg = process.env.FFMPEG_PATH || ffmpegStatic;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 小工具
const log = (msg) => console.log(msg);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);

function parseArgs(argv) {
  const out = { keepOld: false, dryRun: false, root: path.resolve(HERE, '..') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 缺少取值`);
      return v;
    };
    if (a === '--dance') out.dance = next();
    else if (a === '--video') out.video = next();
    else if (a === '--name') out.name = next();
    else if (a === '--song-label') out.songLabel = next();
    else if (a === '--bpm') out.bpm = Number(next());
    else if (a === '--root') out.root = path.resolve(next());
    else if (a === '--keep-old') out.keepOld = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`未知参数: ${a}`);
  }
  return out;
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

function runFFmpeg(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', windowsHide: true });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (r.error) throw r.error;
  return { status: r.status, stdout, stderr };
}

/** 用 ffmpeg stderr 探测时长(秒)。 */
function probeDuration(file) {
  const { stderr } = runFFmpeg(['-i', file]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Math.round(((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) * 1000) / 1000;
}

/** 解码成同一种 PCM 后的 md5 —— 两处一致即证明波形逐样本相同。 */
function pcmMd5(file) {
  const { stdout } = runFFmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', '-f', 'md5', '-']);
  const m = /MD5=([0-9a-f]{32})/i.exec(stdout);
  return m ? m[1] : null;
}

function hasAudioStream(file) {
  const { stderr } = runFFmpeg(['-i', file]);
  return /Stream #\d+:\d+.*: Audio:/.test(stderr);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** 只替换 JSON 文本里 audio 字段的值,保留原文件格式(大文件不重排)。 */
async function rewriteAudioRef(file, oldName, newName) {
  if (!(await exists(file))) return false;
  const text = await readFile(file, 'utf8');
  const re = new RegExp(`("audio"\\s*:\\s*)"${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
  const hits = text.match(re);
  if (!hits) return false;
  await writeFile(file, text.replace(re, `$1"${newName}"`));
  return hits.length;
}

// ---------------------------------------------------------------- 主流程
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`参数错误: ${e.message}`); process.exit(2); }
  if (args.help || !args.dance || !args.video) {
    log('用法: node tools/extract-video-audio.mjs --dance <danceId> --video <视频> [--name x.wav] [--song-label 文字] [--bpm 数值] [--keep-old] [--dry-run]');
    process.exit(args.help ? 0 : 2);
  }

  const root = args.root;
  const songsDir = path.join(root, 'songs');
  const draftsDir = path.join(root, '.drafts');
  const video = path.isAbsolute(args.video) ? args.video : path.resolve(root, args.video);
  if (!(await exists(video))) { console.error(`✗ 视频不存在: ${video}`); process.exit(1); }
  if (!/\.(mp4|mov|webm|mkv)$/i.test(video)) { console.error(`✗ 不是视频文件: ${video}`); process.exit(1); }
  if (!hasAudioStream(video)) { console.error(`✗ 这条视频没有音轨,无法抽取: ${video}`); process.exit(1); }

  const indexPath = path.join(songsDir, 'index.json');
  const index = await readJson(indexPath);
  const dance = (index.dances || []).find((d) => d.danceId === args.dance || d.id === args.dance);
  if (!dance) { console.error(`✗ songs/index.json 里没有舞曲 ${args.dance}`); process.exit(1); }
  const danceId = dance.danceId || dance.id;
  const songDir = path.join(songsDir, danceId);
  const wavName = args.name || `${path.basename(video).replace(/\.[^.]+$/, '')}.wav`;
  if (!/^[^\\/:*?"<>|]+\.wav$/i.test(wavName)) { console.error(`✗ 音频名非法: ${wavName}`); process.exit(1); }
  const oldAudio = dance.musicFile || '';
  const song = (index.songs || []).find((s) => s.id === (dance.defaultSongId || dance.id));
  /**
   * 旧音频在「本舞曲目录」里还有没有别的引用(决定能不能删这个文件)。
   * musicFile / songs[].file 都是相对本舞曲目录解析的(songs/<danceId>/<file>),
   * 所以别支舞曲用的同名文件是它自己目录里的另一份,不算引用。
   */
  const othersRefOld = () => {
    const hits = [];
    for (const d of index.dances || []) {
      if (d === dance) continue;
      if ((d.danceId || d.id) === danceId && d.musicFile === oldAudio) hits.push(`dances[${d.danceId || d.id}]`);
    }
    for (const s of index.songs || []) {
      if (s === song) continue;
      if (dance.defaultSongId === s.id && s.file === oldAudio) hits.push(`songs[${s.id}]`);
    }
    return hits;
  };

  log(`舞曲      : ${danceId} (${dance.label || ''})`);
  log(`源视频    : ${path.relative(root, video)}`);
  log(`目标音频  : songs/${danceId}/${wavName}${oldAudio && oldAudio !== wavName ? `  (替换 ${oldAudio})` : ''}`);

  // 1) 抽音轨到临时文件,先校验,再落盘
  const tempDir = await mkdtemp(path.join(tmpdir(), 'extract-video-audio-'));
  const tempWav = path.join(tempDir, wavName);
  try {
    const r = runFFmpeg(['-y', '-i', video, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', tempWav]);
    if (r.status !== 0 || !(await exists(tempWav))) {
      throw new Error(`ffmpeg 抽音频失败(status=${r.status}):\n${(r.stderr || '').split('\n').slice(-6).join('\n')}`);
    }
    const srcMd5 = pcmMd5(video);
    const outMd5 = pcmMd5(tempWav);
    const srcDur = probeDuration(video);
    const outDur = probeDuration(tempWav);
    log(`音轨校验  : 时长 ${outDur}s(源视频 ${srcDur}s), PCM md5 ${outMd5}`);
    if (!srcMd5 || srcMd5 !== outMd5) throw new Error(`抽取出的音频与视频音轨不一致(源 ${srcMd5} / 出 ${outMd5})`);
    ok('抽取结果与视频音轨逐样本一致(解码后 md5 相同)');
    if (srcDur && outDur && Math.abs(srcDur - outDur) > 0.15) warn(`时长差 ${(srcDur - outDur).toFixed(3)}s,请留意`);

    // 序列时长(游戏时钟以它为准):音频更短的话尾部是静音
    const seqFile = path.join(songDir, `${danceId}.json`);
    if (await exists(seqFile)) {
      const seq = await readJson(seqFile);
      const seqDur = seq?.meta?.durationSec;
      if (seqDur && outDur && outDur < seqDur - 0.05) {
        warn(`音频 ${outDur}s 比动作序列 ${seqDur}s 短 ${(seqDur - outDur).toFixed(3)}s:游戏时钟按序列时长跑,尾部判定在静音里进行`);
      }
    }

    // 2) 改动清单(先算,再决定写不写)
    const plan = [];
    if (oldAudio && oldAudio !== wavName) {
      const others = othersRefOld();
      const oldPath = path.join(songDir, oldAudio);
      if (args.keepOld) plan.push(`保留旧音频 songs/${danceId}/${oldAudio}`);
      else if (others.length) plan.push(`保留旧音频 ${oldAudio}(还被 ${others.join(', ')} 引用)`);
      else if (await exists(oldPath)) plan.push(`删除旧音频 songs/${danceId}/${oldAudio}`);
      plan.push(`songs/${danceId}/${wavName} ← 新音频`);
    } else {
      plan.push(`songs/${danceId}/${wavName} ← 新音频`);
    }
    plan.push(`songs/index.json: dances[${danceId}].musicFile = ${wavName}`);
    if (song) {
      plan.push(`songs/index.json: songs[${song.id}].file = ${wavName}${args.songLabel ? `, label = ${args.songLabel}` : ''}${Number.isFinite(args.bpm) ? `, bpm = ${args.bpm}` : ''}`);
    } else {
      warn(`songs/index.json 里没有 id=${dance.defaultSongId || dance.id} 的歌曲条目,只改 dances[]`);
    }
    if (dance.chartFile) plan.push(`songs/${danceId}/${dance.chartFile}: audio = ${wavName}`);
    plan.push(`songs/${danceId}/${danceId}.json: 内嵌 chart.audio = ${wavName}`);

    const draftIds = [];
    if (await exists(draftsDir)) {
      for (const name of await readdir(draftsDir)) {
        const f = path.join(draftsDir, name, 'draft.json');
        if (!(await exists(f))) continue;
        const d = await readJson(f);
        if ((d.danceId || '') === danceId) draftIds.push({ id: name, draft: d });
      }
    }
    for (const { id, draft } of draftIds) {
      const old = draft.files?.audio || '';
      plan.push(`.drafts/${id}/draft.json: files.audio = ${wavName}${old && old !== wavName ? `  (替换 ${old})` : ''}`);
      if (old && old !== wavName && (await exists(path.join(draftsDir, id, old)))) plan.push(`.drafts/${id}/${old} → ${wavName}(同步拷贝,旧文件清掉)`);
      else plan.push(`.drafts/${id}/${wavName} ← 新音频`);
      if (draft.files?.chart) plan.push(`.drafts/${id}/${draft.files.chart}: audio = ${wavName}`);
    }

    log(args.dryRun ? '\n[dry-run] 将要做的改动:' : '\n将要做的改动:');
    plan.forEach((p) => log(`  • ${p}`));
    if (!draftIds.length) warn('没有找到对应草稿,只改 songs/ 里的上架产物');

    if (args.dryRun) { log('\n[dry-run] 未写入任何文件。'); return; }

    // 3) 落盘:音频 → 索引 → 谱面/序列 → 草稿
    await mkdir(songDir, { recursive: true });
    const songWav = path.join(songDir, wavName);
    const staged = `${songWav}.tmp.wav`;
    await copyFile(tempWav, staged);
    await rename(staged, songWav);
    ok(`写入 songs/${danceId}/${wavName}`);

    dance.musicFile = wavName;
    if (song) {
      song.file = wavName;
      if (args.songLabel) song.label = args.songLabel;
      if (Number.isFinite(args.bpm)) song.bpm = args.bpm;
    }
    const indexTmp = `${indexPath}.tmp`;
    await writeFile(indexTmp, JSON.stringify(index, null, 2));
    await rename(indexTmp, indexPath);
    ok('更新 songs/index.json');

    if (dance.chartFile && (await rewriteAudioRef(path.join(songDir, dance.chartFile), oldAudio, wavName))) {
      ok(`更新 songs/${danceId}/${dance.chartFile} 的 audio 字段`);
    }
    if (await rewriteAudioRef(path.join(songDir, `${danceId}.json`), oldAudio, wavName)) {
      ok(`更新 songs/${danceId}/${danceId}.json 内嵌谱面的 audio 字段`);
    }

    for (const { id, draft } of draftIds) {
      const dir = path.join(draftsDir, id);
      const old = draft.files?.audio || '';
      await copyFile(songWav, path.join(dir, wavName));
      if (old && old !== wavName) {
        const oldPath = path.resolve(dir, old);
        if (oldPath.startsWith(path.resolve(dir) + path.sep) && (await exists(oldPath))) await rm(oldPath, { force: true });
      }
      draft.files = draft.files || {};
      draft.files.audio = wavName;
      const draftTmp = path.join(dir, 'draft.json.tmp');
      await writeFile(draftTmp, JSON.stringify(draft, null, 2));
      await rename(draftTmp, path.join(dir, 'draft.json'));
      if (draft.files.chart) await rewriteAudioRef(path.join(dir, draft.files.chart), oldAudio, wavName);
      if (draft.files.sequence) await rewriteAudioRef(path.join(dir, draft.files.sequence), oldAudio, wavName);
      ok(`更新草稿 .drafts/${id}(音频 + 谱面引用)`);
    }

    if (oldAudio && oldAudio !== wavName && !args.keepOld) {
      const others = othersRefOld();
      const oldPath = path.join(songDir, oldAudio);
      if (!others.length && (await exists(oldPath))) {
        await rm(oldPath, { force: true });
        ok(`删除不再被引用的旧音频 songs/${danceId}/${oldAudio}`);
      }
    }

    log('\n完成。游戏侧读的是 songs/index.json + songs/<danceId>/<danceId>.json,刷新页面即可听到新音乐。');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
