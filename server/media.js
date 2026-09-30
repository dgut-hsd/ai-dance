import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import ffmpegStatic from 'ffmpeg-static';

export const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic;
export function runFFmpeg(args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-8000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('视频处理超时')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`视频处理失败: ${stderr.slice(-1500)}`)); });
  });
}

export const THUMB_WIDTH = 480;

// 缩略图取「第一个高光片段的中点」:既避开片头(片头前几秒是品牌动画,不是人),
// 又最可能是人站得正、表情好的一帧。
// 注意 clip.introDuration 是否存在,恰好标记了这条成片有没有片头(老版本 makeVideo 不加片头),
// 所以缺省是 0 而不是默认片头时长 —— 实测缺省时抽第 2 秒拿到的是正片,不是片头。
export function thumbTimestamp(story = {}) {
  const intro = Number.isFinite(story?.introDuration) ? story.introDuration : 0;
  const duration = Number.isFinite(story?.duration) ? story.duration : null;
  // 夹在正片范围内,避免越过正片末尾抽到成绩卡。
  const within = (at) => duration == null ? at : Math.min(at, intro + Math.max(0, duration - .1));
  const first = Array.isArray(story?.segments) ? story.segments[0] : null;
  if (first && Number.isFinite(first.peak) && Number.isFinite(first.start))
    return within(intro + Math.max(0, first.peak - first.start));
  // 老任务只有 {start, duration}(整段窗口) → 退回片头之后 2 秒。
  return within(intro + 2);
}

// 抽帧参数:转码时(从 output)与老任务按需补图(从 highlight.mp4)共用,保证两条路出来的是同一张图。
export const thumbArgs = (source, destination, story) => [
  '-ss', thumbTimestamp(story).toFixed(3), '-i', source,
  '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, '-q:v', '4', destination,
];

export async function makeVideo(input, output, poster, card, story, intro, thumb) {
  // Restrict input protocols: uploaded media must never fetch remote URLs or local playlists.
  // Canvas-generated card avoids host font dependencies. Phase 2 joins the three marked
  // moments with short white-flash beat cuts, then appends the 2-second result card.
  const segments = story.segments || [{
    start: story.start,
    end: story.start + story.duration,
  }];
  const transition = story.transitionDuration ?? .12;
  const cardDuration = story.cardDuration ?? 2;
  const introDuration = story.introDuration ?? 3.6;
  const filters = [];
  const concatInputs = [];
  segments.forEach((segment, index) => {
    const duration = segment.end - segment.start;
    const fadeOut = Math.max(0, duration - transition);
    filters.push(
      `[0:v]trim=start=${segment.start}:duration=${duration},setpts=PTS-STARTPTS,` +
      'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,' +
      `fps=60,setsar=1,format=yuv420p,fade=t=in:st=0:d=${transition}:color=white,` +
      `fade=t=out:st=${fadeOut}:d=${transition}:color=white[v${index}]`,
      `[0:a]atrim=start=${segment.start}:duration=${duration},asetpts=PTS-STARTPTS,` +
      `aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.06,` +
      `afade=t=out:st=${fadeOut}:d=${transition}[a${index}]`,
    );
    concatInputs.push(`[v${index}][a${index}]`);
  });
  filters.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=1[storyv][storya]`);
  filters.push(`[1:v]trim=duration=${introDuration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,` +
    'pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=60,setsar=1,format=yuv420p[introv]');
  filters.push(`[1:a]atrim=duration=${introDuration},asetpts=PTS-STARTPTS,aresample=48000,` +
    'aformat=channel_layouts=stereo,volume=1.25,alimiter=limit=.95[introa]');
  filters.push(`[2:v]trim=duration=${cardDuration},setpts=PTS-STARTPTS,scale=1080:1920,setsar=1,format=yuv420p[c]`);
  filters.push(`[3:a]atrim=duration=${cardDuration},asetpts=PTS-STARTPTS[s]`);
  filters.push('[introv][introa][storyv][storya][c][s]concat=n=3:v=1:a=1[outv][outa]');
  const footageDuration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
  await runFFmpeg(['-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2', '-i', input,
    '-i', intro,
    '-loop', '1', '-framerate', '60', '-i', card,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', filters.join(';'),
    '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', String(introDuration + footageDuration + cardDuration), output]);
  await runFFmpeg(['-i', output, '-frames:v', '1', '-q:v', '3', poster]);
  // 缩略图非关键产物:失败不能影响成片交付,所以单独 try。
  if (thumb) {
    try { await runFFmpeg(thumbArgs(output, thumb, story), 60000); }
    catch { await rm(thumb, { force: true }).catch(() => {}); }
  }
}

// 完整纪念版保留整段真人录像；片头与成绩卡沿用传播高光的包装，播放器状态彼此独立。
export async function makeFullVideo(input, output, card, story, intro) {
  const sourceDuration = story.sourceDuration;
  const introDuration = story.introDuration ?? 3.6;
  const cardDuration = story.cardDuration ?? 2;
  if (!(Number.isFinite(sourceDuration) && sourceDuration > 0)) throw new Error('缺少完整录像时长');
  const filters = [
    `[0:v]trim=duration=${sourceDuration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,` +
      'pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=60,setsar=1,format=yuv420p[fullv]',
    `[0:a]atrim=duration=${sourceDuration},asetpts=PTS-STARTPTS,aresample=48000,` +
      'aformat=channel_layouts=stereo[fulla]',
    `[1:v]trim=duration=${introDuration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,` +
      'pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=60,setsar=1,format=yuv420p[introv]',
    `[1:a]atrim=duration=${introDuration},asetpts=PTS-STARTPTS,aresample=48000,` +
      'aformat=channel_layouts=stereo,volume=1.25,alimiter=limit=.95[introa]',
    `[2:v]trim=duration=${cardDuration},setpts=PTS-STARTPTS,scale=1080:1920,setsar=1,format=yuv420p[cardv]`,
    `[3:a]atrim=duration=${cardDuration},asetpts=PTS-STARTPTS[cards]`,
    '[introv][introa][fullv][fulla][cardv][cards]concat=n=3:v=1:a=1[outv][outa]',
  ];
  await runFFmpeg(['-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2', '-i', input,
    '-i', intro, '-loop', '1', '-framerate', '60', '-i', card,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', '-t', String(introDuration + sourceDuration + cardDuration), output]);
}

export async function validPng(path) {
  const b = await readFile(path);
  return b.length > 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    b.readUInt32BE(16) === 1080 && b.readUInt32BE(20) === 1920;
}
