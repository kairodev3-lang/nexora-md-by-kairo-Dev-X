// wa-content.js — anime (.waifu .neko), AI (.chatgpt .gemini .aitts), search (.img .bing .yts) and .play.
// Loaded by wa-extras.js. Same reply style as the rest of the bot (box + typewriter font).
//
// Environment variables (AI commands are owner-only because they use your API quota):
//   OPENAI_API_KEY (+ OPENAI_MODEL)   → .chatgpt
//   GEMINI_API_KEY (+ GEMINI_MODEL)   → .gemini (text + photos) and .aitts (voice, when there is no ELEVENLABS_API_KEY)
//   GEMINI_TTS_MODEL                  → optional, model used by .aitts
//   ELEVENLABS_API_KEY                → .aitts with ElevenLabs voices (optional)
// Set the keys as Railway variables (Variables tab). Quotes and spaces around the value are ignored.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { box } from './wa-menu.js';
import { runFfmpeg } from './media.js';
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
  /** Gemini key from the Railway variables (quotes / spaces / line breaks pasted by mistake are removed). */
  const gemKey = () =>
    String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY || '')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
  /** Keys starting with "AQ." come from Vertex AI (express mode); "AIza…" keys come from Google AI Studio. */
  const genUrl = (key, model) =>
    /^AQ\./.test(key)
      ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const MODEL_RETRY = /not found|404|overload|unavailable|503|429|quota|exhausted|rate|deprecated|no longer|abort|timeout|timed out|fetch failed|thinking|invalid argument|unsupported/i;

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

  const GEM_SYSTEM = 'You are NEXORA MD, a friendly WhatsApp assistant. Answer in the same language as the user (Haitian Creole, French, English, Spanish...). Be clear and concise. When an image is given, describe or analyse it and answer the question about it.';

  /** Calls generateContent, trying the next model when one is unknown / overloaded / out of quota. */
  async function geminiCall(key, body, models, { ms = 30_000, fast = false } = {}) {
    let last;
    for (const model of models) {
      try {
        // 2.5-flash "thinks" before answering, which can take very long: a chat answer does not need it
        const b = fast && /^gemini-2\.5-flash/.test(model) && !/tts|image/.test(model)
          ? { ...body, generationConfig: { ...(body.generationConfig || {}), thinkingConfig: { thinkingBudget: 0 } } }
          : body;
        return await jpost(genUrl(key, model), b, { headers: { 'x-goog-api-key': key }, ms });
      } catch (e) {
        last = e;
        if (!MODEL_RETRY.test(String(e?.message || ''))) throw e; // wrong key, blocked prompt…: another model will not help
      }
    }
    // every model name is unknown / retired: ask Google which models this key can use and try those
    if (last && !/^AQ\./.test(key) && /not found|404|deprecated|no longer/i.test(String(last.message || ''))) {
      try {
        const wantTts = models.some((x) => /tts/i.test(x));
        const list = await jget('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, ms: 20_000 });
        const found = (list?.models || [])
          .filter((x) => (x.supportedGenerationMethods || []).includes('generateContent'))
          .map((x) => String(x.name || '').replace(/^models\//, ''))
          .filter((n) => (wantTts ? /tts/i.test(n) : /flash/i.test(n) && !/tts|image|live|embed|thinking|lite|robotics|computer/i.test(n)))
          .filter((n) => !models.includes(n))
          .slice(0, 3);
        for (const model of found) {
          try {
            return await jpost(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, body, { headers: { 'x-goog-api-key': key }, ms: 90_000 });
          } catch (e) {
            last = e;
          }
        }
      } catch (e) {
        last = e;
      }
    }
    throw last || new Error('Gemini unavailable');
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
      return reply(box('✨ GEMINI', [`Usage : *${P()}gemini <question>*`, `Example : *${P()}gemini who is iron man?*`, 'Photo: send it with the caption *' + P() + 'gemini <question>* or reply to it.']));
    }
    const key = gemKey();
    if (!key) return reply(box('❌ GEMINI', ['GEMINI_API_KEY is missing.', 'Railway → your service → Variables → add GEMINI_API_KEY, then redeploy.']));
    react(jid, m, '✨');
    try {
      const parts = [{ text: (prompt || 'Describe this image in detail.').slice(0, 8000) }];
      if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.buffer.toString('base64') } });
      const models = [...new Set([process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'].filter(Boolean))];
      const d = await geminiCall(key, { systemInstruction: { parts: [{ text: GEM_SYSTEM }] }, contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: 1500 } }, models, { ms: 30_000, fast: true });
      const text = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (!text) throw new Error(d?.promptFeedback?.blockReason ? `Blocked: ${d.promptFeedback.blockReason}` : 'empty answer');
      await send(jid, `✨ *GEMINI*\n\n${text.slice(0, AI_MAX)}`, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'gemini failed', { why: String(e?.message || '').slice(0, 100) });
      react(jid, m, '❌');
      return reply(box('❌ GEMINI', [cut(e?.message || 'Failed', 140)]));
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

  const GEM_VOICES = ['Kore', 'Puck', 'Charon', 'Zephyr', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

  /** PCM 16-bit 24 kHz mono (what Gemini TTS returns) → mp3 with ffmpeg, or a plain WAV when ffmpeg is not usable. */
  async function pcmToAudio(pcm) {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tts-'));
    try {
      const inP = path.join(tmp, 'in.pcm');
      const outP = path.join(tmp, 'out.mp3');
      await fsp.writeFile(inP, pcm);
      await runFfmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', inP, '-c:a', 'libmp3lame', '-b:a', '96k', outP], 60_000);
      return { buffer: await fsp.readFile(outP), mimetype: 'audio/mpeg' };
    } catch {
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24);
      h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
      return { buffer: Buffer.concat([h, pcm]), mimetype: 'audio/wav' };
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function aittsGemini({ text0, jid, m, reply }) {
    const key = gemKey();
    if (!key) return reply(box('❌ AI VOICE', ['GEMINI_API_KEY is missing.', 'Railway → Variables → add GEMINI_API_KEY, then redeploy.']));
    if (/^list$/i.test(text0)) return reply(box('🎙️ AI VOICES', GEM_VOICES.map((v, i) => `${i + 1}. ${v}`)));
    react(jid, m, '🎙️');
    try {
      // "text, voice" → the last comma part is the voice when it is a known voice name
      const c = text0.lastIndexOf(',');
      let text = text0;
      let voice = 'Kore';
      if (c > 0) {
        const wanted = text0.slice(c + 1).trim().toLowerCase();
        const hit = GEM_VOICES.find((v) => v.toLowerCase() === wanted);
        if (hit) {
          voice = hit;
          text = text0.slice(0, c).trim();
        }
      }
      if (!text) throw new Error('empty text');
      const models = [...new Set([process.env.GEMINI_TTS_MODEL, 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts', 'gemini-2.5-pro-preview-tts'].filter(Boolean))];
      const body = {
        contents: [{ parts: [{ text: text.slice(0, 1500) }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      };
      const d = await geminiCall(key, body, models, { ms: 60_000 });
      const inline = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.inlineData || p.inline_data).find((x) => x?.data);
      if (!inline) throw new Error('Gemini returned no audio');
      const pcm = Buffer.from(inline.data, 'base64');
      if (pcm.length < 1000) throw new Error('empty audio');
      const out = await pcmToAudio(pcm);
      await send(jid, { audio: out.buffer, mimetype: out.mimetype, ptt: false }, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'aitts gemini failed', { why: String(e?.message || '').slice(0, 100) });
      react(jid, m, '❌');
      return reply(box('❌ AI VOICE', [cut(e?.message || 'Failed', 140)]));
    }
    return null;
  }

  async function aitts({ q, jid, m, content, reply }) {
    const key = process.env.ELEVENLABS_API_KEY;
    // no text given but a message is replied to (for example the answer of .gemini) → that text is read aloud
    const quoted = quotedText(content).replace(/^✨\s*\*?GEMINI\*?\s*/i, '').trim();
    const text0 = String(q || '').trim() || quoted;
    if (!key && gemKey() && text0) return aittsGemini({ text0, jid, m, reply });
    if (!text0) {
      return reply(box('🎙️ AI VOICE', [`Usage : *${P()}aitts <text>, <voice>*`, `Example : *${P()}aitts hello my friend, ${key ? 'adam' : 'Kore'}*`, `Voices : *${P()}aitts list*`]));
    }
    if (!key) return reply(box('❌ AI VOICE', ['No key found.', 'Add GEMINI_API_KEY (or ELEVENLABS_API_KEY) in the Railway variables.']));
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
  // .img couplepp → two matching profile pictures (one for him, one for her)
  const COUPLE_URL = process.env.COUPLEPP_URL || 'https://gist.githubusercontent.com/AbhishekSuresh2/78ca46a7a13e37de5a722d008ee224a0/raw/couplepp.json';
  let coupleCache = { at: 0, list: [] };
  async function couplepp({ jid, m, reply }) {
    react(jid, m, '💞');
    try {
      if (Date.now() - coupleCache.at > 30 * 60_000 || !coupleCache.list.length) {
        const raw = await jget(COUPLE_URL, { ms: 25_000 });
        const arr = (Array.isArray(raw) ? raw : raw?.results || raw?.data || []).filter((x) => x?.male && x?.female);
        if (!arr.length) throw new Error('empty list');
        coupleCache = { at: Date.now(), list: arr };
      }
      const pairs = coupleCache.list;
      for (let tries = 0; tries < 4; tries++) {
        const p = pairs[Math.floor(Math.random() * pairs.length)];
        const male = typeof p.male === 'string' ? p.male : p.male?.url;
        const female = typeof p.female === 'string' ? p.female : p.female?.url;
        if (!isPublicHttps(male, true) || !isPublicHttps(female, true)) continue;
        try {
          await send(jid, { image: { url: male }, caption: '💞 *Couple PP* — 👦 for him' }, m, true);
          await new Promise((r) => setTimeout(r, 700));
          await send(jid, { image: { url: female }, caption: '💞 *Couple PP* — 👧 for her' }, m, true);
          react(jid, m, '✅');
          return null;
        } catch { /* dead link: another pair */ }
      }
      throw new Error('no working pair');
    } catch (e) {
      log('warn', 'couplepp failed', { why: String(e?.message || '').slice(0, 60) });
      // the list is unreachable: fall back to an image search for matching couple pictures (2 images)
      try {
        return await img({ q: 'matching couple pfp aesthetic, 2', jid, m, reply });
      } catch {
        react(jid, m, '❌');
        return reply(box('❌ COUPLE PP', ['Could not fetch a couple picture. Try again.']));
      }
    }
  }

  async function img({ q, jid, m, reply }) {
    if (/^\s*(couple\s*-?\s*pp|couplepp|cpp|couple)\s*$/i.test(String(q || ''))) return couplepp({ jid, m, reply });
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
