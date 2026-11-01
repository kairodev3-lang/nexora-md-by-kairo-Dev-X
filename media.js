// Shared media helpers: ffmpeg lookup, WebP sticker conversion and WhatsApp sticker metadata.
// Used by .sticker and .telegram.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

let ffmpegPath = null;

const run = (cmd, args, { timeout = 90_000 } = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 * 10 }, (err, _out, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).split('\n').filter(Boolean).slice(-2).join(' ').trim();
        return reject(new Error(`ffmpeg: ${tail.slice(0, 160)}`));
      }
      resolve();
    });
  });

/** System ffmpeg first, then the bundled ffmpeg-static binary. Throws when neither exists. */
export async function ffmpegBin() {
  if (ffmpegPath) return ffmpegPath;
  try {
    await run('ffmpeg', ['-version'], { timeout: 5000 });
    return (ffmpegPath = 'ffmpeg');
  } catch {
    /* no system ffmpeg */
  }
  try {
    const mod = await import('ffmpeg-static');
    if (mod?.default) return (ffmpegPath = mod.default);
  } catch {
    /* module not installed */
  }
  throw new Error('ffmpeg is not installed on this server');
}

export async function runFfmpeg(args, timeout) {
  return run(await ffmpegBin(), args, { timeout });
}

const FIT = 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0';
const MAX_STICKER_BYTES = 900 * 1024;

/** Image → static 512x512 WebP. */
export async function imageToWebp(inPath, outPath) {
  await runFfmpeg(['-y', '-i', inPath, '-vf', FIT, '-c:v', 'libwebp', '-q:v', '70', '-frames:v', '1', outPath]);
}

/**
 * Video / GIF / WebM → animated 512x512 WebP kept under ~900 KB (WhatsApp limit).
 * inputArgs are placed before -i (e.g. ['-c:v','libvpx-vp9'] to keep WebM transparency).
 */
export async function videoToWebp(inPath, outPath, { seconds = 8, inputArgs = [] } = {}) {
  const attempts = [
    { q: 50, fps: 15, t: seconds },
    { q: 35, fps: 12, t: seconds },
    { q: 22, fps: 10, t: Math.min(seconds, 6) },
    { q: 12, fps: 8, t: Math.min(seconds, 5) },
  ];
  let last = 0;
  for (const { q, fps, t } of attempts) {
    await runFfmpeg([
      '-y', ...inputArgs, '-i', inPath, '-t', String(t), '-an',
      '-vf', `fps=${fps},${FIT}`,
      '-c:v', 'libwebp', '-loop', '0', '-lossless', '0', '-compression_level', '4',
      '-q:v', String(q), '-preset', 'default', '-threads', '2', outPath,
    ]);
    last = fs.statSync(outPath).size;
    if (last <= MAX_STICKER_BYTES) return;
  }
  throw new Error(`Video is too heavy for a sticker (${Math.round(last / 1024)} KB). Try a shorter one.`);
}

function exifBlock(meta) {
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const exif = Buffer.concat([head, json]);
  exif.writeUIntLE(json.length, 14, 4);
  return exif;
}

// Fallback without any library: appends an EXIF chunk to an extended (VP8X) WebP.
function rawExif(webp, exif) {
  if (webp.length < 30 || webp.toString('ascii', 12, 16) !== 'VP8X') return webp;
  const chunk = Buffer.alloc(8);
  chunk.write('EXIF', 0, 'ascii');
  chunk.writeUInt32LE(exif.length, 4);
  const pad = exif.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const out = Buffer.concat([webp, chunk, exif, pad]);
  out[20] |= 0x08; // VP8X flag: EXIF present
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** Writes the pack name / author into a WebP sticker (shown by WhatsApp when the sticker is saved). */
export async function addStickerMeta(webp, { pack, author, emoji = '🤖' }) {
  const exif = exifBlock({
    'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    emojis: [emoji],
  });
  try {
    const mod = await import('node-webpmux');
    const lib = mod.default || mod;
    const img = new lib.Image();
    await img.load(webp);
    img.exif = exif;
    return await img.save(null);
  } catch {
    return rawExif(webp, exif);
  }
}
