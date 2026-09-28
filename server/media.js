import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

export async function makeVideo(input, output, poster, card, clip) {
  // Restrict input protocols: uploaded media must never fetch remote URLs or local playlists.
  // Canvas-generated card avoids host font dependencies, and appends a 2-second score screen.
  await runFFmpeg(['-max_alloc', '268435456', '-protocol_whitelist', 'file,pipe',
    '-format_whitelist', 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2', '-i', input,
    '-loop', '1', '-framerate', '60', '-i', card,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    `[0:v]trim=start=${clip.start}:duration=${clip.duration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=60,setsar=1,format=yuv420p[v];` +
    `[0:a]atrim=start=${clip.start}:duration=${clip.duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${clip.duration}[a];` +
    '[1:v]trim=duration=2,setpts=PTS-STARTPTS,scale=1080:1920,setsar=1,format=yuv420p[c];' +
    '[2:a]atrim=duration=2,asetpts=PTS-STARTPTS[s];[v][a][c][s]concat=n=2:v=1:a=1[outv][outa]',
    '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-t', String(clip.duration + 2), output]);
  await runFFmpeg(['-i', output, '-frames:v', '1', '-q:v', '3', poster]);
}

export async function validPng(path) {
  const b = await readFile(path);
  return b.length > 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    b.readUInt32BE(16) === 1080 && b.readUInt32BE(20) === 1920;
}
