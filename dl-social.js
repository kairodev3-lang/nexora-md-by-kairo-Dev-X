// .tiktok / .facebook / .instagram — downloaders (several fallback sources).
// Loaded by wa-extras.js. Same reply style as the rest of the bot (box + typewriter font).
// The "POWERED BY" signature is only shown in the menu.

import axios from 'axios';
import { box } from './wa-menu.js';
import { isPublicHttps } from './wa-more.js';

const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const MAX_ITEMS = 20;

const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+/i.test(u.trim());
const cleanUrl = (u) => (isUrl(u) ? u.trim().replace(/\s+/g, '') : null);
const safeMedia = (u) => {
  const c = cleanUrl(u);
  return c && isPublicHttps(c, true) ? c : null;
};

async function getJson(url, ms = 25_000) {
  return axios.get(url, {
    timeout: ms,
    headers: { accept: 'application/json, text/plain, */*', 'user-agent': UA },
    validateStatus: () => true,
  });
}

async function fetchThumb(url) {
  const u = safeMedia(url);
  if (!u) return undefined;
  try {
    const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 15_000, headers: { 'user-agent': UA }, validateStatus: () => true });
    if (r.status >= 200 && r.status < 300 && r.data) return Buffer.from(r.data);
  } catch {
    /* no thumbnail */
  }
  return undefined;
}

function uniqueMedia(list) {
  const out = [];
  const seen = new Set();
  for (const x of list || []) {
    if (!x?.url || seen.has(x.url)) continue;
    seen.add(x.url);
    out.push(x);
  }
  return out;
}

const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm)(\?|$)/i;


/* ───────── .mediafire <link> (APK) ───────── */
const MF_MAX_BYTES = 100 * 1024 * 1024;
const MF_MAX_REDIRECTS = 5;
const MF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const APK_MIME = 'application/vnd.android.package-archive';

const mfHost = (h) => {
  const host = h.toLowerCase();
  return host === 'mediafire.com' || host.endsWith('.mediafire.com') || host === 'mfi.re' || host.endsWith('.mfi.re');
};
const isMfUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && mfHost(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
};

async function mfFetch(url, accept) {
  let cur = new URL(url);
  for (let i = 0; i <= MF_MAX_REDIRECTS; i++) {
    const response = await fetch(cur, { headers: { Accept: accept, 'User-Agent': MF_UA }, redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if (response.status < 300 || response.status >= 400) return { response, url: cur };
    const location = response.headers.get('location');
    if (!location || i === MF_MAX_REDIRECTS) throw new Error('Too many redirects.');
    const next = new URL(location, cur);
    if (next.protocol !== 'https:' || next.username || next.password || !mfHost(next.hostname)) throw new Error('Unsupported redirect.');
    cur = next;
  }
  throw new Error('Too many redirects.');
}

function mfDownloadUrl(html, pageUrl) {
  for (const a of html.match(/<a\b[^>]*>/gi) || []) {
    if (!/\bid\s*=\s*["']downloadButton["']/i.test(a)) continue;
    const href = a.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) break;
    const u = new URL(href.replace(/&amp;/g, '&'), pageUrl);
    if (!isMfUrl(u.href)) throw new Error('Unsupported download link.');
    return u.href;
  }
  throw new Error('Download button not found.');
}

function mfFilename(response, url) {
  const d = response.headers.get('content-disposition') || '';
  const enc = d.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const plain = d.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
  let name = enc ? decodeURIComponent(enc) : plain;
  if (!name) name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
}

async function mfDownload(url) {
  const page = await mfFetch(url, 'text/html,application/vnd.android.package-archive,application/octet-stream,*/*');
  if (!page.response.ok) throw new Error(`MediaFire page error (${page.response.status}).`);
  let response = page.response;
  let dl = page.url;
  if ((response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'text/html') {
    const direct = mfDownloadUrl(await response.text(), page.url);
    const got = await mfFetch(direct, 'application/vnd.android.package-archive,application/octet-stream,*/*');
    response = got.response;
    dl = got.url;
  }
  if (!response.ok) throw new Error(`MediaFire download error (${response.status}).`);
  const filename = mfFilename(response, dl.href) || 'download.apk';
  const ct = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!filename.toLowerCase().endsWith('.apk') && ct !== APK_MIME) throw new Error('This link is not an APK file.');
  if (ct && ![APK_MIME, 'application/octet-stream', 'application/zip'].includes(ct)) throw new Error('Unsupported file type.');
  const len = Number(response.headers.get('content-length'));
  if (Number.isFinite(len) && len > MF_MAX_BYTES) throw new Error('APK is over 100 MB.');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MF_MAX_BYTES) throw new Error('APK is over 100 MB.');
    chunks.push(chunk);
  }
  if (!total) throw new Error('Empty file.');
  return { buffer: Buffer.concat(chunks, total), filename: filename.toLowerCase().endsWith('.apk') ? filename : `${filename}.apk` };
}

export function createSocial({ sock, send, log = () => {} }) {
  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});
  const processed = new Set();

  /* ───────── .tiktok <link> ───────── */
  async function tiktok({ q, jid, m, reply }) {
    const url = String(q || '').trim();
    if (!/tiktok\.com/i.test(url)) {
      return reply(box('🎵 TIKTOK', ['Usage : *.tt <link>*']));
    }
    react(jid, m, '🔄');

    let videoUrl = null;
    let title = 'TikTok Video';
    let author = null;

    // Source 1: Tikwm
    try {
      const res = await axios.post('https://www.tikwm.com/api/', new URLSearchParams({ url }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': UA },
        timeout: 15_000,
      });
      const d = res.data?.data;
      if (d) {
        videoUrl = safeMedia(d.play) || safeMedia(d.wmplay);
        title = d.title || title;
        author = d.author?.nickname || null;
      }
    } catch (e) {
      log('warn', 'tiktok tikwm failed', { err: e?.message });
    }

    // Source 2: GiftedTech
    if (!videoUrl) {
      try {
        const res = await getJson(`https://api.giftedtech.web.id/api/download/tiktok?apikey=gifted&url=${encodeURIComponent(url)}`, 15_000);
        const d = res.data?.result;
        if (d) {
          videoUrl = safeMedia(d.video) || safeMedia(d.hdvideo) || safeMedia(d.nowm);
          title = d.title || title;
          author = d.author || author;
        }
      } catch (e) {
        log('warn', 'tiktok gifted failed', { err: e?.message });
      }
    }

    // Source 3: Siputzx
    if (!videoUrl) {
      try {
        const res = await getJson(`https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`, 15_000);
        if (res.data?.status && res.data.data) {
          const d = res.data.data;
          videoUrl = safeMedia((d.urls && d.urls[0]) || d.video_url || d.url || d.download_url);
          title = d.metadata?.title || title;
        }
      } catch (e) {
        log('warn', 'tiktok siputzx failed', { err: e?.message });
      }
    }

    // Source 4: ruhend-scraper (optional dependency) — also handles photo slideshows
    if (!videoUrl) {
      try {
        const { ttdl } = await import('ruhend-scraper');
        const data = await ttdl(url);
        const items = uniqueMedia(data?.data).slice(0, MAX_ITEMS);
        if (items.length) {
          let sent = 0;
          for (const it of items) {
            const u = safeMedia(it.url);
            if (!u) continue;
            const isVideo = VIDEO_EXT.test(u) || it.type === 'video';
            await send(jid, isVideo ? { video: { url: u }, mimetype: 'video/mp4' } : { image: { url: u } }, m);
            sent++;
          }
          if (sent) {
            react(jid, m, '✅');
            return null;
          }
        }
      } catch (e) {
        log('warn', 'tiktok ttdl failed', { err: e?.message });
      }
    }

    if (!videoUrl) {
      react(jid, m, '❌');
      return reply(box('❌ TIKTOK', ['Video not found (private or removed?).']));
    }

    const caption = `🎵 *${String(title).replace(/\s+/g, ' ').slice(0, 80)}*${author ? `\n👤 ${String(author).slice(0, 40)}` : ''}`;
    await send(jid, { video: { url: videoUrl }, mimetype: 'video/mp4', caption }, m);
    react(jid, m, '✅');
    return null;
  }

  /* ───────── .facebook <link> ───────── */
  async function facebook({ q, jid, m, reply }) {
    const url = String(q || '').trim();
    if (!url) {
      return reply(box('📘 FACEBOOK', ['Usage : *.fc <link>*']));
    }
    const lower = url.toLowerCase();
    if (!lower.includes('facebook.com') && !lower.includes('fb.watch') && !lower.includes('fb.com')) {
      return reply(box('❌ FACEBOOK', ['Invalid Facebook link.']));
    }
    react(jid, m, '🔄');

    const res = await getJson(`https://tele-social.vercel.app/down?url=${encodeURIComponent(url)}`);
    if (res.status < 200 || res.status >= 300) {
      react(jid, m, '❌');
      return reply(box('❌ FACEBOOK', [`API error (${res.status}). Try again.`]));
    }
    const root = res.data;
    if (!root || root.status !== true || !root.data) {
      react(jid, m, '❌');
      return reply(box('❌ FACEBOOK', ['Video not found (private or bad link?).']));
    }
    const media = root.data.media || {};
    const videoUrl = safeMedia(media.download) || safeMedia(media.video);
    if (!videoUrl) {
      react(jid, m, '❌');
      return reply(box('❌ FACEBOOK', ['No downloadable video link found.']));
    }
    const platform = String(root.platform || 'Facebook').toUpperCase().slice(0, 20);
    const thumbBuf = await fetchThumb(root.data.thumbnail);
    const caption = `📘 *${platform}* ✅`;
    await send(jid, { video: { url: videoUrl }, mimetype: 'video/mp4', caption, ...(thumbBuf ? { jpegThumbnail: thumbBuf } : {}) }, m);
    react(jid, m, '✅');
    return null;
  }

  /* ───────── .instagram <link> ───────── */
  async function instagram({ q, jid, m, reply }) {
    if (m?.key?.id) {
      if (processed.has(m.key.id)) return null;
      processed.add(m.key.id);
      setTimeout(() => processed.delete(m.key.id), 5 * 60 * 1000);
    }
    const text = String(q || '').trim();
    if (!text) {
      return reply(box('📸 INSTAGRAM', ['Usage : *.ig <link>*']));
    }
    if (!/https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\//i.test(text)) {
      return reply(box('❌ INSTAGRAM', ['Invalid Instagram link.']));
    }
    react(jid, m, '🔄');

    let igdl;
    try {
      ({ igdl } = await import('ruhend-scraper'));
    } catch {
      react(jid, m, '❌');
      return reply(box('❌ INSTAGRAM', ['The Instagram module is not installed on the server.']));
    }
    const data = await igdl(text);
    const items = uniqueMedia(data?.data).slice(0, MAX_ITEMS);
    if (!items.length) {
      react(jid, m, '❌');
      return reply(box('❌ INSTAGRAM', ['No media found (private post?).']));
    }
    let sent = 0;
    for (const [i, it] of items.entries()) {
      try {
        const u = safeMedia(it.url);
        if (!u) continue;
        const isVideo = VIDEO_EXT.test(u) || it.type === 'video' || text.includes('/reel/') || text.includes('/tv/');
        await send(jid, isVideo ? { video: { url: u }, mimetype: 'video/mp4' } : { image: { url: u } }, m);
        sent++;
        if (i < items.length - 1) await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        log('warn', 'instagram item failed', { err: e?.message });
      }
    }
    react(jid, m, sent ? '✅' : '❌');
    if (!sent) return reply(box('❌ INSTAGRAM', ['No valid media could be sent.']));
    return null;
  }

  /* ───────── .mediafire <link> ───────── */
  async function mediafire({ q, jid, m, reply }) {
    const quoted = m?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const text = String(q || '').trim() || quoted?.conversation || quoted?.extendedTextMessage?.text || '';
    const url = (String(text).match(/https?:\/\/[^\s<>]+/i)?.[0] || '').replace(/[),.!?]+$/, '');
    if (!url || !isMfUrl(url)) return reply(box('📦 MEDIAFIRE', ['Usage : *.mediafire <link>*']));
    react(jid, m, '⏳');
    try {
      const apk = await mfDownload(url);
      await send(jid, { document: apk.buffer, mimetype: APK_MIME, fileName: apk.filename, caption: `📦 *${apk.filename}*` }, m);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'mediafire failed', { err: String(e?.message || e).slice(0, 80) });
      react(jid, m, '❌');
      return reply(box('❌ MEDIAFIRE', [String(e?.message || 'Download failed').replace(/https?:\/\/\S+/gi, '[link]').slice(0, 120)]));
    }
    return null;
  }

  return { tt: tiktok, fc: facebook, ig: instagram, mediafire };
}
