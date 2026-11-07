// wa-content.js — anime (.waifu .neko), AI (.chatgpt .gemini .aitts), search (.img .bing .yts) and .play.
// Loaded by wa-extras.js. Same reply style as the rest of the bot (box + typewriter font).
//
// Environment variables (AI commands are owner-only because they use your API quota):
//   OPENAI_API_KEY (+ OPENAI_MODEL)   → .chatgpt
//   GEMINI_API_KEY (+ GEMINI_MODEL)   → .gemini
//   ELEVENLABS_API_KEY                → .aitts

import { box } from './wa-menu.js';
import { isPublicHttps, youtubeId } from './wa-more.js';

const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const MAX_IMAGES = 10;
const PLAY_TTL_MS = 3 * 60_000;

const cut = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const decodeHtml = (t) =>
  String(t)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const stripTags = (t) => decodeHtml(String(t).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function createContent({ sock, send, log = () => {}, fetchImpl = globalThis.fetch, P, helpers = {} }) {
  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});
  const { downloadMediaMessage, normalizeMessageContent } = helpers;
  const norm = (x) => (normalizeMessageContent ? normalizeMessageContent(x) : null) || x;

  const jget = async (url, { ms = 30_000, headers = {} } = {}) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  };
  const jpost = async (url, body, { ms = 60_000, headers = {}, raw = false } = {}) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(ms),
      headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let why = `http ${res.status}`;
      try {
        const d = await res.json();
        why = d?.error?.message || d?.detail?.message || d?.detail || why;
      } catch { /* keep the status */ }
      throw new Error(typeof why === 'string' ? why : `http ${res.status}`);
    }
    return raw ? res : res.json();
  };

  /** Text of the replied-to message, if any. */
  const quotedText = (content) => {
    const q = content?.extendedTextMessage?.contextInfo?.quotedMessage;
    return q ? String(q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || '').trim() : '';
  };

  /** Image in the message itself or in the replied-to message (for .gemini). */
  async function findImage({ jid, m, content }) {
    let node = content?.imageMessage || null;
    let msgLike = m;
    if (!node) {
      const ci = content?.extendedTextMessage?.contextInfo;
      const q = ci?.quotedMessage ? norm(ci.quotedMessage) : null;
      node = q?.imageMessage || null;
      msgLike = { key: { remoteJid: jid, id: ci?.stanzaId, participant: ci?.participant, fromMe: false }, message: q };
    }
    if (!node || !downloadMediaMessage) return null;
    const buffer = await downloadMediaMessage(msgLike, 'buffer', {}, { logger: helpers.logger, reuploadRequest: sock.updateMediaMessage });
    return { buffer, mime: node.mimetype || 'image/jpeg' };
  }

  /* ───────── anime ───────── */
  const anime = (kind, emoji) => async ({ jid, m, reply }) => {
    react(jid, m, emoji);
    try {
      const d = await jget(`https://api.waifu.pics/sfw/${kind}`, { ms: 20_000 });
      if (!d?.url || !isPublicHttps(d.url)) throw new Error('no image');
      await send(jid, { image: { url: d.url }, caption: `${emoji} *${kind}*` }, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', `anime ${kind} failed`, { why: String(e?.message || '').slice(0, 50) });
      react(jid, m, '❌');
      return reply(box('❌ ANIME', [`Could not fetch a ${kind} image. Try again.`]));
    }
    return null;
  };

  /* ───────── AI ───────── */
  const AI_MAX = 3800;

  async function chatgpt({ q, jid, m, content, reply }) {
    const prompt = [String(q || '').trim(), quotedText(content)].filter(Boolean).join('\n\n');
    if (!prompt) return reply(box('🤖 CHATGPT', [`Usage : *${P()}chatgpt <question>*`, `Example : *${P()}chatgpt create a simple html page*`]));
    const key = process.env.OPENAI_API_KEY;
    if (!key) return reply(box('❌ CHATGPT', ['OPENAI_API_KEY is missing on the server.']));
    react(jid, m, '🤖');
    try {
      const d = await jpost('https://api.openai.com/v1/chat/completions', {
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt.slice(0, 8000) }],
      }, { headers: { authorization: `Bearer ${key}` } });
      const text = String(d?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('empty answer');
      await send(jid, `🤖 *CHATGPT*\n\n${text.slice(0, AI_MAX)}`, m, true);
      react(jid, m, '✅');
    } catch (e) {
      react(jid, m, '❌');
      return reply(box('❌ CHATGPT', [cut(e?.message || 'Failed', 120)]));
    }
    return null;
  }

  async function gemini({ q, jid, m, content, reply }) {
    const prompt = [String(q || '').trim(), quotedText(content)].filter(Boolean).join('\n\n');
    let image = null;
    try {
      image = await findImage({ jid, m, content });
    } catch {
      /* no image */
    }
    if (!prompt && !image) {
      return reply(box('✨ GEMINI', [`Usage : *${P()}gemini <question>*`, `Example : *${P()}gemini who is iron man?*`, 'With an image: reply to it and add a question.']));
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) return reply(box('❌ GEMINI', ['GEMINI_API_KEY is missing on the server.']));
    react(jid, m, '✨');
    try {
      const parts = [{ text: (prompt || 'Describe this image.').slice(0, 8000) }];
      if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.buffer.toString('base64') } });
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      const d = await jpost(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { contents: [{ parts }] }, { headers: { 'x-goog-api-key': key } });
      const text = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (!text) throw new Error('empty answer');
      await send(jid, `✨ *GEMINI*\n\n${text.slice(0, AI_MAX)}`, m, true);
      react(jid, m, '✅');
    } catch (e) {
      react(jid, m, '❌');
      return reply(box('❌ GEMINI', [cut(e?.message || 'Failed', 120)]));
    }
    return null;
  }

  // ElevenLabs voices (names are read from the API, cached one hour)
  let voices = { at: 0, list: [] };
  async function getVoices(key) {
    if (Date.now() - voices.at < 3_600_000 && voices.list.length) return voices.list;
    const d = await jget('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    voices = { at: Date.now(), list: (d?.voices || []).map((v) => ({ id: v.voice_id, name: String(v.name || '').trim() })).filter((v) => v.id && v.name) };
    return voices.list;
  }

  async function aitts({ q, jid, m, reply }) {
    const key = process.env.ELEVENLABS_API_KEY;
    const text0 = String(q || '').trim();
    if (!text0) {
      return reply(box('🎙️ AI VOICE', [`Usage : *${P()}aitts <text>, <voice>*`, `Example : *${P()}aitts hello my friend, adam*`, `Voices : *${P()}aitts list*`]));
    }
    if (!key) return reply(box('❌ AI VOICE', ['ELEVENLABS_API_KEY is missing on the server.']));
    react(jid, m, '🎙️');
    try {
      const list = await getVoices(key);
      if (!list.length) throw new Error('no voice available');
      if (/^list$/i.test(text0)) {
        react(jid, m, '✅');
        return reply(box('🎙️ AI VOICES', list.slice(0, 40).map((v, i) => `${i + 1}. ${cut(v.name.split(/[-–]/)[0], 30)}`)));
      }
      // "text, voice" → the last comma part is the voice when it matches a voice name
      const cut_ = text0.lastIndexOf(',');
      let text = text0;
      let voice = null;
      if (cut_ > 0) {
        const wanted = text0.slice(cut_ + 1).trim().toLowerCase();
        const hit = list.find((v) => v.name.toLowerCase() === wanted || v.name.toLowerCase().startsWith(`${wanted} `) || v.name.toLowerCase().startsWith(`${wanted}-`));
        if (hit) {
          voice = hit;
          text = text0.slice(0, cut_).trim();
        }
      }
      voice ||= list.find((v) => /^adam/i.test(v.name)) || list[0];
      if (!text) throw new Error('empty text');
      const res = await jpost(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=mp3_44100_128`, {
        text: text.slice(0, 600),
        model_id: 'eleven_multilingual_v2',
      }, { headers: { 'xi-api-key': key, accept: 'audio/mpeg' }, raw: true, ms: 90_000 });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error('empty audio');
      await send(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, m, true);
      react(jid, m, '✅');
    } catch (e) {
      react(jid, m, '❌');
      return reply(box('❌ AI VOICE', [cut(e?.message || 'Failed', 120)]));
    }
    return null;
  }

  /* ───────── search ───────── */
  // .img <query>[, count] — Bing images (safe search on)
  async function img({ q, jid, m, reply }) {
    const [queryRaw, countRaw] = String(q || '').split(',').map((x) => x.trim());
    const query = cut(queryRaw, 100);
    if (!query) return reply(box('🖼️ IMAGES', [`Usage : *${P()}img <query>, <count>*`, `Example : *${P()}img ironman, 5*`]));
    const want = Math.min(MAX_IMAGES, Math.max(1, Number.parseInt(countRaw, 10) || 5));
    react(jid, m, '🔍');
    let urls = [];
    try {
      const res = await fetchImpl(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&adlt=strict&safeSearch=strict`, {
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const html = await res.text();
      const found = new Set();
      for (const mm of html.matchAll(/murl(?:&quot;|")\s*:\s*(?:&quot;|")(https?:\/\/.*?)(?:&quot;|")/g)) {
        const u = decodeHtml(mm[1]);
        if (isPublicHttps(u, true) && !found.has(u)) found.add(u);
        if (found.size >= want * 3) break;
      }
      urls = [...found];
    } catch (e) {
      log('warn', 'img search failed', { why: String(e?.message || '').slice(0, 50) });
    }
    if (!urls.length) {
      react(jid, m, '❌');
      return reply(box('❌ IMAGES', ['No image found.']));
    }
    let sent = 0;
    for (const u of urls) {
      if (sent >= want) break;
      try {
        await send(jid, { image: { url: u }, caption: sent === 0 ? `🖼️ *${query}*` : '' }, m, true);
        sent++;
        await new Promise((r) => setTimeout(r, 800));
      } catch {
        /* dead link: try the next one */
      }
    }
    react(jid, m, sent ? '✅' : '❌');
    return sent ? null : reply(box('❌ IMAGES', ['Could not send the images.']));
  }

  // Bing result links are sometimes redirects (…/ck/a?…&u=a1<base64url>)
  const realLink = (href) => {
    try {
      const u = new URL(decodeHtml(href));
      if (/bing\.com$/i.test(u.hostname) && u.pathname.startsWith('/ck/')) {
        const enc = u.searchParams.get('u') || '';
        if (enc.startsWith('a1')) return Buffer.from(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      }
      return u.href;
    } catch {
      return null;
    }
  };

  // .bing <query> — top Bing results
  async function bing({ q, jid, m, reply }) {
    const query = cut(q, 150);
    if (!query) return reply(box('🔎 BING', [`Usage : *${P()}bing <query>*`, `Example : *${P()}bing who is iron man*`]));
    react(jid, m, '🔍');
    try {
      const res = await fetchImpl(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const html = await res.text();
      const results = [];
      for (const block of html.split(/<li class="b_algo"/).slice(1)) {
        const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!a) continue;
        const link = realLink(a[1]);
        if (!link || !/^https?:\/\//i.test(link)) continue;
        const d = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        results.push({ title: cut(stripTags(a[2]), 90), desc: cut(d ? stripTags(d[1]) : '', 160), link });
        if (results.length >= 5) break;
      }
      if (!results.length) {
        react(jid, m, '❌');
        return reply(box('❌ BING', ["Can't find, try again with more info."]));
      }
      const lines = results.flatMap((r, i) => [`*${i + 1}. ${r.title}*`, ...(r.desc ? [r.desc] : []), r.link, '']);
      await send(jid, `🔎 *BING* · ${query}\n\n${lines.join('\n').trim()}`, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'bing failed', { why: String(e?.message || '').slice(0, 50) });
      react(jid, m, '❌');
      return reply(box('❌ BING', ['Search failed. Try again.']));
    }
    return null;
  }

  const loadYts = async () => {
    try {
      const mod = await import('yt-search');
      return mod.default || mod;
    } catch {
      return null;
    }
  };
  const views = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(v);
  };

  // .yts <query | YouTube link> — YouTube search
  async function yts({ q, jid, m, reply }) {
    const query = cut(q, 120);
    if (!query) return reply(box('🔎 YOUTUBE SEARCH', [`Usage : *${P()}yts <query>*`, `Example : *${P()}yts alan walker faded*`]));
    const lib = await loadYts();
    if (!lib) return reply(box('❌ YOUTUBE SEARCH', ['The yt-search module is not installed on the server.']));
    react(jid, m, '🔍');
    try {
      const id = youtubeId(query);
      const list = id ? [await lib({ videoId: id })] : ((await lib(query)).videos || []).slice(0, 8);
      if (!list.length || !list[0]) {
        react(jid, m, '❌');
        return reply(box('❌ YOUTUBE SEARCH', ['No result.']));
      }
      const lines = list.flatMap((v, i) => [
        `*${i + 1}. ${cut(v.title, 80)}*`,
        `👤 ${cut(v.author?.name || 'Unknown', 40)} · ⏱ ${v.timestamp || '—'} · 👁 ${views(v.views)}`,
        v.url,
        '',
      ]);
      await send(jid, `🔎 *YOUTUBE* · ${query}\n\n${lines.join('\n').trim()}\n\n${P()}play <name> → audio / video`, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'yts failed', { why: String(e?.message || '').slice(0, 50) });
      react(jid, m, '❌');
      return reply(box('❌ YOUTUBE SEARCH', ['Search failed. Try again.']));
    }
    return null;
  }

  /* ───────── .play : thumbnail + "reply 1 = audio, 2 = video" ───────── */
  const pending = new Map(); // "jid|who" -> { video, until }
  const whoOf = (jid, m) => (m?.key?.fromMe ? 'me' : m?.key?.participant || jid);

  async function play({ q, jid, m, reply }) {
    const query = cut(q, 120);
    if (!query) return reply(box('🎵 PLAY', [`Usage : *${P()}play <song name>*`, `Example : *${P()}play faded alan walker*`]));
    const lib = await loadYts();
    if (!lib) return reply(box('❌ PLAY', ['The yt-search module is not installed on the server.']));
    react(jid, m, '🔍');
    try {
      const id = youtubeId(query);
      const v = id ? await lib({ videoId: id }) : (await lib(query)).videos?.[0];
      if (!v) {
        react(jid, m, '❌');
        return reply(box('❌ PLAY', ['Nothing found.']));
      }
      pending.set(`${jid}|${whoOf(jid, m)}`, { video: { url: v.url, title: v.title }, until: Date.now() + PLAY_TTL_MS });
      if (pending.size > 200) pending.delete(pending.keys().next().value);
      const caption = box('🎵 PLAY', [`Title : *${cut(v.title, 80)}*`, `Author : *${cut(v.author?.name || 'Unknown', 40)}*`, `Duration : *${v.timestamp || '—'}*`, 'Reply *1* = 🎧 audio', 'Reply *2* = 🎬 video']);
      if (v.thumbnail && isPublicHttps(v.thumbnail)) await send(jid, { image: { url: v.thumbnail }, caption }, m, true);
      else await send(jid, caption, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'play failed', { why: String(e?.message || '').slice(0, 50) });
      react(jid, m, '❌');
      return reply(box('❌ PLAY', ['Search failed. Try again.']));
    }
    return null;
  }

  /** "1" / "2" sent after .play → { name: 'song' | 'video', video } (once), or null. */
  function takePlayChoice(text, jid, m) {
    const t = String(text || '').trim();
    if (t !== '1' && t !== '2') return null;
    const key = `${jid}|${whoOf(jid, m)}`;
    const p = pending.get(key);
    if (!p) return null;
    pending.delete(key);
    if (Date.now() > p.until) return null;
    return { name: t === '1' ? 'song' : 'video', video: p.video };
  }

  return {
    handlers: {
      waifu: anime('waifu', '🌸'),
      neko: anime('neko', '🐱'),
      chatgpt,
      gemini,
      aitts,
      img,
      bing,
      yts,
      play,
    },
    takePlayChoice,
  };
}
