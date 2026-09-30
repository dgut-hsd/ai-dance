/**
 * 下载 CC0 打击音素材并整理成本项目可用的 wav。
 *
 * 设计原则:
 *   1) **只下 CC0**。页面自己的许可声明会被抓下来存成 LICENSE.txt,和素材一起进仓库 ——
 *      以后有人问"这些音频哪来的、能不能商用",答案在仓库里,不用再查网。
 *   2) **必须转成 16bit PCM WAV**。osu! 的规范明确要求 hitsound 只用 wav(mp3 有 0~20ms
 *      解码/循环间隙),而且浏览器 decodeAudioData 对 ogg/mp3 的起音处理不如 wav 干脆。
 *   3) 原始素材采样率各异(44.1k/48k),统一重采样到 48kHz、单声道 ——
 *      单声道能省一半体积,打击音本身也不需要立体声宽度(宽度交给混响层做)。
 *
 * 用法:
 *   node tools/fetch-sfx-samples.mjs --probe     只列出压缩包里有什么,不下载文件内容
 *   node tools/fetch-sfx-samples.mjs             下载并转换
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(root, 'tmp', 'sfx-src');
const outDir = path.join(root, 'web_dance', 'audio', 'sfx');
const ffmpeg = path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

/** Kenney 的音频包:全部 CC0,下载地址从资产页渲染后的 HTML 里直接取。 */
const PACKS = [
  {
    id: 'interface',
    page: 'https://kenney.nl/assets/interface-sounds',
    zip: 'https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip',
    license: 'CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)',
  },
  {
    id: 'impact',
    page: 'https://kenney.nl/assets/impact-sounds',
    zip: null, // 运行时从资产页解析
    license: 'CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)',
  },
];

const PROBE = process.argv.includes('--probe');

async function fetchText(url) {
  const { stdout } = await run('curl.exe', ['-sL', '--max-time', '60', url], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** 从资产页解析 zip 下载地址(页面把真实地址放在 #donate-text 的 href 上)。 */
async function resolveZipUrl(pack) {
  const html = await fetchText(pack.page);
  const m = html.match(/href='(https:\/\/kenney\.nl\/media\/pages\/assets\/[^']+\.zip)'/);
  if (!m) throw new Error(`解析不到 zip 地址: ${pack.page}`);
  return m[1];
}

/**
 * 极简 zip 解包:只支持 store(0) 与 deflate(8) 两种方法 —— 素材包都是这两种。
 *
 * 为什么自己写而不用 Expand-Archive / unzip:这个环境里 spawn pwsh 会 ENOENT,
 * 而 zip 的中央目录结构足够简单,自己解析反而更可控、没有外部依赖。
 */
async function unzipTo(zipPath, destDir) {
  const buf = await readFile(zipPath);
  // 1) 从尾部找 End of Central Directory (0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip(EOCD 未找到)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const written = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`中央目录项 ${n} 校验失败`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // 2) 跳到本地头之后的真实数据起点
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`不支持的压缩方法 ${method} (${name})`);
    const outPath = path.join(destDir, name);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, data);
    written.push(outPath);
  }
  return written;
}

/** 用浏览器同款的 DecompressionStream('deflate-raw') 解压 —— Node 18+ 内置,零依赖。 */
async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function main() {
  await mkdir(tmpDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const manifest = [];
  for (const pack of PACKS) {
    const zipUrl = pack.zip ?? await resolveZipUrl(pack);
    console.log(`\n=== ${pack.id} ===\n  ${zipUrl}`);
    const zipPath = path.join(tmpDir, `${pack.id}.zip`);
    if (!existsSync(zipPath)) {
      await run('curl.exe', ['-sL', '--max-time', '300', '-o', zipPath, zipUrl], { maxBuffer: 1024 * 1024 });
    }
    const size = (await stat(zipPath)).size;
    console.log(`  已下载 ${(size / 1024 / 1024).toFixed(2)} MB`);

    // 解包(自己解析 zip,不依赖 Expand-Archive / unzip)
    const extractDir = path.join(tmpDir, pack.id);
    if (!existsSync(extractDir)) {
      await unzipTo(zipPath, extractDir);
    }
    const files = await listFiles(extractDir);
    const audio = files.filter((f) => /\.(ogg|wav|mp3|flac)$/i.test(f));
    console.log(`  压缩包内音频文件 ${audio.length} 个`);
    for (const f of audio.slice(0, 80)) console.log(`    ${path.relative(extractDir, f)}`);
    if (audio.length > 80) console.log(`    …还有 ${audio.length - 80} 个`);

    // 许可声明存进仓库:以后不用再查网
    const licenseFile = path.join(outDir, `LICENSE-${pack.id}.txt`);
    await writeFile(licenseFile,
      `${pack.id} —— 打击音素材来源与许可\n\n` +
      `来源页面: ${pack.page}\n` +
      `下载地址: ${zipUrl}\n` +
      `许可: ${pack.license}\n` +
      `抓取时间: ${new Date().toISOString()}\n\n` +
      `CC0 1.0 意为作者放弃全部著作权,可商用、可修改、无需署名。\n` +
      `(署名非必需,但我们仍然在这里注明来源。)\n`, 'utf8');

    if (PROBE) continue;
    manifest.push({ pack: pack.id, audio, extractDir });
  }

  if (PROBE) {
    console.log('\n(--probe 模式:未转换)');
    return;
  }
  console.log(`\n共 ${manifest.reduce((s, m) => s + m.audio.length, 0)} 个候选素材,下一步需要挑选并转换。`);
  console.log('转换命令模板:ffmpeg -i <in> -ac 1 -ar 48000 -c:a pcm_s16le <out>');
}

async function listFiles(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = path.join(dir, name);
    const s = await stat(p);
    if (s.isDirectory()) out.push(...await listFiles(p));
    else out.push(p);
  }
  return out;
}

await main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
