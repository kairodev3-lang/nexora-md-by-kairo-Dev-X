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

export function createSocial({ sock, send, log = () => {} }) {
  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});
  const processed = new Set();

  /* ───────── .tiktok <link> ───────── */
  async function tiktok({ q, jid, m, reply }) {
    const url = String(q || '').trim();
    if (!/tiktok\.com/i.test(url)) {
      return reply(box('🎵 TIKTOK', ['Usage : *.tiktok <link>*', 'Example : *.tiktok https://vt.tiktok.com/xxxx*']));
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
      return reply(box('❌ TIKTOK', ['Could not get this video from any source.', 'It may be private or removed.']));
    }

    const caption = box('🎵 TIKTOK DOWNLOAD', [
      `📌 Title   : *${String(title).replace(/\s+/g, ' ').slice(0, 100)}*`,
      ...(author ? [`👤 Creator : *${String(author).slice(0, 40)}*`] : []),
    ]);
    await send(jid, { video: { url: videoUrl }, mimetype: 'video/mp4', caption }, m);
    react(jid, m, '✅');
    return null;
  }

  /* ───────── .facebook <link> ───────── */
  async function facebook({ q, jid, m, reply }) {
    const url = String(q || '').trim();
    if (!url) {
      return reply(box('📘 FACEBOOK', ['Usage : *.facebook <link>*', 'Example : *.facebook https://www.facebook.com/share/r/xxxx*']));
    }
    const lower = url.toLowerCase();
    if (!lower.includes('facebook.com') && !lower.includes('fb.watch') && !lower.includes('fb.com')) {
      return reply(box('❌ FACEBOOK', ['That is not a valid Facebook link.']));
    }
    react(jid, m, '🔄');

    const res = await getJson(`https://tele-social.vercel.app/down?url=${encodeURIComponent(url)}`);
    if (res.status < 200 || res.status >= 300) {
      react(jid, m, '❌');
      return reply(box('❌ FACEBOOK', [`API error (HTTP ${res.status}).`, 'Try again in a moment.']));
    }
    const root = res.data;
    if (!root || root.status !== true || !root.data) {
      react(jid, m, '❌');
      return reply(box('❌ FACEBOOK', ['Could not fetch this video.', 'It may be private or the link is invalid.']));
    }
    const media = root.data.media || {};
    const videoUrl = safeMedia(media.download) || safeMedia(media.video);
    if (!videoUrl) {
      react(jid, m, '❌');
      return reply(box('❌ FACEBOOK', ['No downloadable video link found.']));
    }
    const platform = String(root.platform || 'Facebook').toUpperCase().slice(0, 20);
    const thumbBuf = await fetchThumb(root.data.thumbnail);
    const caption = box(`📘 ${platform} DOWNLOAD`, ['✅ Download successful', `🖼️ Thumbnail : ${thumbBuf ? 'OK' : 'N/A'}`]);
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
      return reply(box('📸 INSTAGRAM', ['Usage : *.instagram <link>*', 'Works with posts, reels and videos.']));
    }
    if (!/https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\//i.test(text)) {
      return reply(box('❌ INSTAGRAM', ['That is not a valid Instagram link (post, reel or video).']));
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
      return reply(box('❌ INSTAGRAM', ['No media found.', 'The post may be private or the link invalid.']));
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

  return { tiktok, facebook, instagram };
}
