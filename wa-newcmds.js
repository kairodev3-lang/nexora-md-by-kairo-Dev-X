// wa-newcmds.js — new commands (loaded by wa-extras.js)
//
//   ANIME     .mywaifu  — 8 waifu pictures as an album (waifu.im)
//   GAME      .dungeon .tekateki .dinorun .pinzo .pixzo .xozo  (see wa-games.js)
//   DOWNLOAD  .dl <link>  — video from (almost) any site: TikTok, Instagram, Facebook, X, YouTube, Pinterest, Reddit…
//
// Environment variables (all optional):
//   ARSLAN_API       base URL of the downloader API        (default https://arslan-apis-v2.vercel.app)
//   ARSLAN_DL_PATHS  comma separated endpoint paths to try  (default: see DEFAULT_PATHS below)
//
// Same reply style as the rest of the bot (box + typewriter font). Every media URL returned by a third-party API is
// checked with isPublicHttps() so it can never point to an internal network.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { box } from './wa-menu.js';
import { imageToWebp, videoToWebp, addStickerMeta } from './media.js';
import { isPublicHttps } from './wa-more.js';
import { createGames } from './wa-games.js';

const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/* ───────── ANIME (.mywaifu) ───────── */
export const ANIME_NAMES = ['mywaifu'];
export const ANIME_ALIASES = { waifu: 'mywaifu', waifuim: 'mywaifu', waifus: 'mywaifu' };

/* ───────── GROUP / SUDO / TOOLS ───────── */
export const GROUP_NAMES = ['delete', 'hidetag', 'promote', 'demote', 'sondaj'];
export const SUDO_NAMES = ['sudo', 'delsudo', 'deploy'];
export const TOOL_NAMES = ['remini'];
export const NEW_ALIASES = { ...ANIME_ALIASES, del: 'delete', ht: 'hidetag', rmsudo: 'delsudo', upscale: 'remini', vercel: 'deploy', poll: 'sondaj', vote: 'sondaj', hd: 'remini', url: 'tourl' };
const RECENT_PER_CHAT = 60;
const MAX_UPLOAD = 50 * 1024 * 1024;

/* ───────── GAMES (see wa-games.js) ───────── */
export { GAME_NAMES, GAME_ALIASES } from './wa-games.js';

/* ───────── DOWNLOADER ───────── */
export const DL_NAMES = ['dl'];
export const DL_ALIASES = { download: 'dl', alldl: 'dl', videodl: 'dl', getvideo: 'dl' };
const DEFAULT_PATHS = [
  '/download/alldl', '/download/aio', '/download/allinone', '/download/video', '/download/ytmp4',
  '/api/download/alldl', '/api/alldl', '/alldl', '/aio',
];
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // sent as a video
const MAX_DOC_BYTES = 100 * 1024 * 1024; // sent as a document
const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v)(\?|#|$)/i;
const NOT_VIDEO_RE = /\.(jpe?g|png|webp|gif|mp3|m4a|opus|ogg|aac|wav|vtt|srt|json|html?)(\?|#|$)/i;
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const BAD_KEY_RE = /thumb|cover|poster|image|avatar|audio|music|photo|icon|preview/i;
const GOOD_KEY_RE = /^(hd|video|nowm|no_?wm|download|dl|play|url|link|sd|mp4|src)$/i;

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cut = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Walks any JSON answer and returns the best video URL (and a title when there is one). */
export function extractMedia(data) {
  const found = [];
  let title = '';
  const walk = (node, key, depth) => {
    if (node == null || depth > 7) return;
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node)) found.push({ url: node.trim(), key: String(key || '') });
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 60).forEach((x) => walk(x, key, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      if (!title && typeof node.title === 'string') title = node.title;
      for (const [k, v] of Object.entries(node)) walk(v, k, depth + 1);
    }
  };
  walk(data, '', 0);
  let best = null;
  for (const f of found) {
    if (NOT_VIDEO_RE.test(f.url) && !VIDEO_RE.test(f.url)) continue;
    let score = 0;
    if (VIDEO_RE.test(f.url)) score += 10;
    if (GOOD_KEY_RE.test(f.key)) score += 3;
    if (/hd/i.test(f.key)) score += 1;
    if (BAD_KEY_RE.test(f.key)) score -= 8;
    if (/googlevideo|video|mp4|download|cdn/i.test(f.url)) score += 1;
    if (!best || score > best.score) best = { ...f, score };
  }
  return best && best.score > -5 ? { url: best.url, title: cut(title, 90) } : null;
}

export function createNewCmds({ sock, send, log = () => {}, fetchImpl = globalThis.fetch, P, helpers = {}, isSelf = () => false, settings = {}, persist = async () => {} }) {
  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});

  const jget = async (url, { ms = 20_000 } = {}) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('not json');
    }
  };

  /* ═════════════ ANIME (.mywaifu) ═════════════ */
  const games = createGames({ sock, send, P, log });
  const WAIFU_COUNT = 8;

  async function waifuUrls() {
    try {
      const params = new URLSearchParams({ isNsfw: 'false', orderBy: 'Random', page: '1', pageSize: String(WAIFU_COUNT) });
      const data = await jget(`https://api.waifu.im/images?${params}`, { ms: 20_000 });
      const urls = (data?.items || []).map((x) => x?.url).filter((u) => u && isPublicHttps(u, true));
      if (urls.length) return urls;
    } catch (e) {
      log('warn', 'waifu.im failed', { why: String(e?.message || '').slice(0, 60) });
    }
    // backup: waifu.pics (one picture per call)
    const out = await Promise.allSettled(Array.from({ length: WAIFU_COUNT }, () => jget('https://api.waifu.pics/sfw/waifu', { ms: 15_000 })));
    return out.map((r) => (r.status === 'fulfilled' ? r.value?.url : null)).filter((u) => u && isPublicHttps(u, true));
  }

  const mywaifu = async ({ args, jid, m, reply }) => {
    if (/^n(sfw|ude)/i.test(String(args[0] || ''))) return reply(box('🌸 MYWAIFU', ['Only safe (SFW) pictures are available.', `Use : *${P()}mywaifu*`]));
    react(jid, m, '🕕');
    try {
      const urls = (await waifuUrls()).slice(0, WAIFU_COUNT);
      if (!urls.length) throw new Error('no picture');
      await send(jid, box('🌸 MYWAIFU', [`${urls.length} waifu pictures for you ✨`]), m, true);
      let album = false;
      try {
        const { generateWAMessageFromContent, generateWAMessage, jidNormalizedUser } = await import('@whiskeysockets/baileys');
        const { randomBytes } = await import('node:crypto');
        const opener = generateWAMessageFromContent(jid, {
          messageContextInfo: { messageSecret: randomBytes(32) },
          albumMessage: { expectedImageCount: urls.length, expectedVideoCount: 0 },
        }, { userJid: jidNormalizedUser(sock.user.id), quoted: m, upload: sock.waUploadToServer });
        await sock.relayMessage(opener.key.remoteJid, opener.message, { messageId: opener.key.id });
        for (const url of urls) {
          const msg = await generateWAMessage(opener.key.remoteJid, { image: { url } }, { upload: sock.waUploadToServer });
          msg.message.messageContextInfo = { messageSecret: randomBytes(32), messageAssociation: { associationType: 1, parentMessageKey: opener.key } };
          await sock.relayMessage(msg.key.remoteJid, msg.message, { messageId: msg.key.id });
        }
        album = true;
      } catch (e) {
        log('warn', 'waifu album failed, sending one by one', { why: String(e?.message || '').slice(0, 60) });
      }
      if (!album) for (const url of urls.slice(0, 5)) await send(jid, { image: { url } }, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'mywaifu failed', { why: String(e?.message || '').slice(0, 60) });
      react(jid, m, '❌');
      return reply(box('❌ MYWAIFU', ['Could not get pictures right now. Try again in a minute.']));
    }
    return null;
  };

  /* ═════════════ DOWNLOADER ═════════════ */
  const apiBase = () => String(process.env.ARSLAN_API || 'https://arslan-apis-v2.vercel.app').replace(/\/+$/, '');
  const apiPaths = () =>
    (process.env.ARSLAN_DL_PATHS ? process.env.ARSLAN_DL_PATHS.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_PATHS);

  /** Tries every endpoint at the same time, the first one that returns a real video link wins. */
  async function fromArslan(link) {
    const base = apiBase();
    const tries = apiPaths().map(async (p) => {
      const path = p.startsWith('/') ? p : `/${p}`;
      const data = await jget(`${base}${path}?url=${encodeURIComponent(link)}`, { ms: 25_000 });
      const hit = extractMedia(data);
      if (!hit || !isPublicHttps(hit.url, true)) throw new Error('no video');
      return { ...hit, source: path };
    });
    return Promise.any(tries);
  }

  /** Backup sources already used elsewhere in the bot. */
  async function fromBackups(link) {
    const backups = [
      async () => extractMedia(await jget(`https://tele-social.vercel.app/down?url=${encodeURIComponent(link)}`, { ms: 20_000 })),
      async () => {
        if (!/tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(link)) return null;
        const res = await fetchImpl('https://www.tikwm.com/api/', {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': UA },
          body: new URLSearchParams({ url: link }).toString(),
        });
        const d = (await res.json())?.data;
        return d?.play ? { url: d.play, title: cut(d.title, 90) } : null;
      },
    ];
    for (const b of backups) {
      try {
        const hit = await b();
        if (hit?.url && isPublicHttps(hit.url, true)) return { ...hit, source: 'backup' };
      } catch (e) {
        log('warn', 'dl backup failed', { why: String(e?.message || '').slice(0, 50) });
      }
    }
    return null;
  }

  async function remoteSize(url) {
    try {
      const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': UA }, redirect: 'follow' });
      const n = Number(res.headers.get('content-length'));
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  const quotedLink = (content) => {
    const q = content?.extendedTextMessage?.contextInfo?.quotedMessage;
    const t = q ? String(q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || '') : '';
    return t.match(URL_RE)?.[0] || '';
  };

  const dl = async ({ q, content, jid, m, reply }) => {
    const link = (String(q || '').match(URL_RE)?.[0] || quotedLink(content)).trim();
    if (!link) {
      return reply(box('📥 VIDEO DOWNLOADER', [`Usage : *${P()}dl <video link>*`, 'Works with TikTok, Instagram, Facebook, X, YouTube, Pinterest, Reddit…', 'You can also reply to a message that contains a link.']));
    }
    if (!isPublicHttps(link, true)) return reply(box('❌ DOWNLOAD', ['Invalid link.']));
    react(jid, m, '⏳');
    let hit = null;
    try {
      hit = await fromArslan(link);
    } catch (e) {
      log('warn', 'dl api failed', { why: String(e?.errors?.[0]?.message || e?.message || '').slice(0, 60) });
    }
    if (!hit) hit = await fromBackups(link);
    if (!hit) {
      react(jid, m, '❌');
      return reply(box('❌ DOWNLOAD', ['No downloadable video found.', 'The post may be private, or the link is not supported.']));
    }
    const size = await remoteSize(hit.url);
    const caption = box('📥 VIDEO', [hit.title ? `Title : *${hit.title}*` : 'Downloaded ✅']);
    try {
      if (size > MAX_DOC_BYTES) {
        react(jid, m, '⚠️');
        return reply(box('⚠️ VIDEO TOO BIG', ['The file is bigger than 100 MB.', `Direct link : ${hit.url}`]));
      }
      if (size > MAX_VIDEO_BYTES) {
        await send(jid, { document: { url: hit.url }, mimetype: 'video/mp4', fileName: `${hit.title || 'video'}.mp4`.replace(/[\\/:*?"<>|]/g, ''), caption }, m, true);
      } else {
        await send(jid, { video: { url: hit.url }, mimetype: 'video/mp4', caption }, m, true);
      }
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'dl send failed', { why: String(e?.message || '').slice(0, 60) });
      react(jid, m, '❌');
      return reply(box('❌ DOWNLOAD', ['The video could not be sent.', `Direct link : ${hit.url}`]));
    }
    return null;
  };

  /* ═════════════ GROUP (delete / hidetag / promote / demote) ═════════════ */
  const jn = (j) => String(j || '').split('@')[0].split(':')[0];
  const recent = new Map(); // chat -> [{ id, participant }]   (only ids, never the content)

  /** Remembers the last messages of a group so .delete <n> can remove them. */
  function track(m) {
    try {
      const jid = m?.key?.remoteJid;
      if (!jid?.endsWith('@g.us') || !m.key.id) return;
      const arr = recent.get(jid) || [];
      arr.push({ id: m.key.id, participant: m.key.participant || null, alt: m.key.participantAlt || null });
      while (arr.length > RECENT_PER_CHAT) arr.shift();
      recent.set(jid, arr);
      if (recent.size > 200) recent.delete(recent.keys().next().value);
    } catch { /* best effort */ }
  }

  const isAdminP = (p) => p.admin === 'admin' || p.admin === 'superadmin';
  async function groupInfo(jid) {
    const meta = await sock.groupMetadata(jid);
    const isMe = (p) => [p.id, p.jid, p.phoneNumber, p.lid].some((x) => x && isSelf(x));
    return { meta, botAdmin: meta.participants.some((p) => isAdminP(p) && isMe(p)) };
  }
  const groupOnly = (jid, reply) => (jid.endsWith('@g.us') ? null : reply(box('❌ GROUP', ['This command only works in a group.'])));
  const needAdmin = (reply, what) => reply(box(`❌ ${what}`, ['The bot account must be a group admin.']));

  /** Mentioned users, else the author of the replied message, else a number given as argument. */
  function targetsOf({ args, content }, meta) {
    const ci = content?.extendedTextMessage?.contextInfo;
    const out = [];
    for (const j of ci?.mentionedJid || []) out.push(j);
    if (!out.length && ci?.participant) out.push(ci.participant);
    if (!out.length) {
      for (const a of args) {
        const d = String(a).replace(/\D/g, '');
        if (d.length >= 7 && d.length <= 15) out.push(`${d}@s.whatsapp.net`);
      }
    }
    // the group may use LID ids: use the id exactly as the group lists it
    return [...new Set(out.map((j) => {
      const p = meta?.participants?.find((x) => [x.id, x.jid, x.phoneNumber, x.lid].some((y) => y && jn(y) === jn(j)));
      return p?.id || j;
    }))];
  }

  const del = async ({ args, jid, m, content, reply }) => {
    if (groupOnly(jid, reply)) return null;
    const { meta, botAdmin } = await groupInfo(jid);
    if (!botAdmin) return needAdmin(reply, 'DELETE');
    const ci = content?.extendedTextMessage?.contextInfo;
    const n = Math.min(Math.max(Number.parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 0, 0), 50);
    const targets = targetsOf({ args: [], content }, meta);
    const list = [];
    if (ci?.stanzaId) list.push({ id: ci.stanzaId, participant: ci.participant || targets[0] });
    const want = n || (list.length ? 0 : 0);
    if (!list.length && !n) {
      return reply(box('🗑️ DELETE', [`*${P()}delete 5* — last 5 messages of the group`, `*${P()}delete 3 @user* — last 3 of that user`, `*${P()}delete* (reply) — that message`]));
    }
    if (want) {
      const arr = (recent.get(jid) || []).filter((x) => x.id !== m.key.id);
      for (let i = arr.length - 1; i >= 0 && list.length < want + (ci?.stanzaId ? 1 : 0); i--) {
        const x = arr[i];
        if (list.some((l) => l.id === x.id)) continue;
        if (targets.length && !targets.some((t) => [x.participant, x.alt].some((y) => y && jn(y) === jn(t)))) continue;
        list.push({ id: x.id, participant: x.participant });
      }
    }
    if (!list.length) return reply(box('🗑️ DELETE', ['No recent message found. (The bot only remembers messages received since it started.)']));
    let done = 0;
    for (const x of list) {
      try {
        await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: x.id, participant: x.participant } });
        done++;
        await new Promise((r) => setTimeout(r, 300));
      } catch (e) {
        log('warn', 'delete failed', { why: String(e?.message || '').slice(0, 50) });
      }
    }
    react(jid, m, done ? '✅' : '❌');
    return done ? null : reply(box('❌ DELETE', ['Could not delete the messages.']));
  };

  const hidetag = async ({ q, jid, m, content, reply }) => {
    if (groupOnly(jid, reply)) return null;
    const { meta, botAdmin } = await groupInfo(jid);
    if (!botAdmin) return needAdmin(reply, 'HIDETAG');
    const everyone = meta.participants.filter((p) => !isAdminP(p)).map((p) => p.id);
    const ci = content?.extendedTextMessage?.contextInfo;
    const qm = ci?.quotedMessage ? (helpers.normalizeMessageContent?.(ci.quotedMessage) || ci.quotedMessage) : null;
    let payload;
    try {
      if (qm?.imageMessage || qm?.videoMessage || qm?.documentMessage) {
        const kind = qm.imageMessage ? 'image' : qm.videoMessage ? 'video' : 'document';
        const node = qm[`${kind}Message`];
        const msgLike = { key: { remoteJid: jid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: qm };
        const buffer = await helpers.downloadMediaMessage(msgLike, 'buffer', {}, { logger: helpers.logger, reuploadRequest: sock.updateMediaMessage });
        const caption = q || node.caption || '';
        payload = kind === 'image' ? { image: buffer, caption, mentions: everyone }
          : kind === 'video' ? { video: buffer, caption, mentions: everyone, mimetype: node.mimetype || 'video/mp4' }
            : { document: buffer, fileName: node.fileName || 'file', mimetype: node.mimetype, caption, mentions: everyone };
      } else if (qm && (qm.conversation || qm.extendedTextMessage?.text)) {
        payload = { text: q || qm.conversation || qm.extendedTextMessage.text, mentions: everyone };
      } else {
        payload = { text: q || 'Tagged members (excluding admins).', mentions: everyone };
      }
    } catch (e) {
      log('warn', 'hidetag media failed', { why: String(e?.message || '').slice(0, 50) });
      payload = { text: q || 'Tagged members (excluding admins).', mentions: everyone };
    }
    await sock.sendMessage(jid, payload); // not quoted, no visible @list: that is the point of hidetag
    return null;
  };

  const promoteDemote = (action) => async ({ args, jid, m, content, reply }) => {
    const label = action === 'promote' ? 'PROMOTE' : 'DEMOTE';
    if (groupOnly(jid, reply)) return null;
    const { meta, botAdmin } = await groupInfo(jid);
    if (!botAdmin) return needAdmin(reply, label);
    const targets = targetsOf({ args, content }, meta);
    if (!targets.length) return reply(box(`👑 ${label}`, [`Mention the user or reply to their message.`, `Example : *${P()}${action} @user*`]));
    react(jid, m, '⏳');
    try {
      await sock.groupParticipantsUpdate(jid, targets, action);
    } catch (e) {
      log('warn', `${action} failed`, { why: String(e?.message || '').slice(0, 60) });
      react(jid, m, '❌');
      return reply(box(`❌ ${label}`, [`Failed to ${action} the user(s).`, 'Check that the bot is admin and the user is in the group.']));
    }
    const who = targets.map((t) => `@${jn(t)}`);
    const by = m.key.participant || sock.user?.id || jid;
    await send(jid, {
      text: box(action === 'promote' ? '👑 GROUP PROMOTION' : '⬇️ GROUP DEMOTION', [
        `${action === 'promote' ? 'Promoted' : 'Demoted'} : ${who.join(' ')}`,
        `By : @${jn(by)}`,
        `Date : ${new Date().toLocaleString()}`,
      ]),
      mentions: [...targets, by],
    }, m, true);
    react(jid, m, '✅');
    return null;
  };

  /* ═════════════ DEPLOY (HTML → Vercel) ═════════════ */
  // .deploy <site-name>  while replying to a message that contains HTML code, or to an .html file.
  // Needs the env variable VERCEL_TOKEN (Vercel → Settings → Tokens). Real owner only (not sudo).
  const deploy = async ({ args, jid, m, content, reply }) => {
    if (!m.key?.fromMe) return reply(box('❌ DEPLOY', ['Owner only.']));
    const name = String(args[0] || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 52);
    if (!name) return reply(box('🚀 DEPLOY', ['Reply to a message with HTML code (or an .html file) and send:', `*${P()}deploy mysite*`]));
    const token = process.env.VERCEL_TOKEN;
    if (!token) return reply(box('❌ DEPLOY', ['The Vercel token is not set.', 'Add the variable *VERCEL_TOKEN* on Railway (Vercel → Settings → Tokens).']));
    const ci = content?.extendedTextMessage?.contextInfo;
    const qm = ci?.quotedMessage ? (helpers.normalizeMessageContent?.(ci.quotedMessage) || ci.quotedMessage) : null;
    if (!qm) return reply(box('❌ DEPLOY', ['HTML not found.', 'Reply to a message with HTML code, or to an .html file.']));
    let html = qm.conversation || qm.extendedTextMessage?.text || qm.imageMessage?.caption || '';
    try {
      const doc = qm.documentMessage;
      if (!html && doc && (/html/i.test(doc.mimetype || '') || /\.html?$/i.test(doc.fileName || ''))) {
        const msgLike = { key: { remoteJid: jid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: qm };
        const buffer = await helpers.downloadMediaMessage(msgLike, 'buffer', {}, { logger: helpers.logger, reuploadRequest: sock.updateMediaMessage });
        html = buffer.toString('utf8');
      }
    } catch (e) {
      log('warn', 'deploy download failed', { why: String(e?.message || '').slice(0, 60) });
    }
    if (!html) return reply(box('❌ DEPLOY', ['Unsupported message.', 'Reply to HTML text or to an .html file.']));
    if (!/<html|<!doctype html|<head|<body/i.test(html)) return reply(box('❌ DEPLOY', ['This is not valid HTML.']));
    if (html.length > 4_000_000) return reply(box('❌ DEPLOY', ['The HTML is too big (max 4 MB).']));
    react(jid, m, '🚀');
    try {
      const res = await fetchImpl('https://api.vercel.com/v13/deployments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, project: name, target: 'production', files: [{ file: 'index.html', data: html }], projectSettings: { framework: null } }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.message || `Vercel error ${res.status}`);
      let domain = `${name}.vercel.app`;
      try {
        const d = await fetchImpl(`https://api.vercel.com/v9/projects/${encodeURIComponent(name)}/domains`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
        const list = (await d.json())?.domains || [];
        domain = list.find((x) => !x.name.endsWith('.vercel.app'))?.name || list.find((x) => x.name.endsWith('.vercel.app'))?.name || domain;
      } catch { /* keep the default domain */ }
      react(jid, m, '✅');
      return reply(box('✅ DEPLOY SUCCESS', [`Name : *${name}*`, 'Platform : Vercel (static HTML)', 'Status : building (ready in a few seconds)', '', `https://${domain}`]));
    } catch (e) {
      react(jid, m, '❌');
      return reply(box('❌ DEPLOY FAILED', [String(e?.message || 'Error').slice(0, 200)]));
    }
  };

  /* ═════════════ SONDAJ (real WhatsApp poll, votes counted from the people who vote) ═════════════ */
  // .sondaj <question> | <option 1> | <option 2> | ...   → the bot posts a native poll; people vote in WhatsApp.
  // .sondaj result  → who is ahead (latest poll of this chat)      .sondaj end → final result, stop counting
  const polls = new Map(); // poll message id -> { jid, msg, name, options, votes: Map(voter -> option names[]), at }
  const lastPoll = new Map(); // chat jid -> poll message id
  const pollText = (p, final) => {
    const counts = p.options.map((o) => [o, 0]);
    for (const names of p.votes.values()) for (const n of names) { const c = counts.find((x) => x[0] === n); if (c) c[1]++; }
    const total = [...p.votes.values()].filter((v) => v.length).length;
    const top = Math.max(0, ...counts.map((c) => c[1]));
    const lines = [`❓ *${p.name}*`, ''];
    counts.forEach(([o, n], i) => {
      const pct = total ? Math.round((n / total) * 100) : 0;
      lines.push(`${i + 1}. ${o} — *${n}* (${pct}%) ${'█'.repeat(Math.round(pct / 10))}${'░'.repeat(10 - Math.round(pct / 10))}`);
    });
    lines.push('', `Voters : *${total}*`);
    const leaders = counts.filter((c) => c[1] === top && top > 0).map((c) => c[0]);
    lines.push(!leaders.length ? 'No vote yet.' : leaders.length === 1 ? `🏆 ${final ? 'Winner' : 'Leading'} : *${leaders[0]}* (${top})` : `🤝 Tie : ${leaders.map((l) => `*${l}*`).join(' / ')} (${top})`);
    return lines;
  };
  const sondaj = async ({ args, q, jid, m, reply }) => {
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'result' || sub === 'results' || sub === 'end') {
      const id = lastPoll.get(jid);
      const p = id && polls.get(id);
      if (!p) return reply(box('📊 SONDAJ', ['No poll in this chat.', `Create one : *${P()}sondaj Question? | Option 1 | Option 2*`]));
      if (sub === 'end') { polls.delete(id); lastPoll.delete(jid); }
      return reply(box(sub === 'end' ? '🏁 SONDAJ (FINAL)' : '📊 SONDAJ', pollText(p, sub === 'end')));
    }
    const parts = String(q || '').split('|').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3 || parts.length > 13) {
      return reply(box('📊 SONDAJ', [
        `Create : *${P()}sondaj Question? | Option 1 | Option 2 | …*`,
        '(2 to 12 options, separated by |)',
        `Ahead now : *${P()}sondaj result*`,
        `Final result : *${P()}sondaj end*`,
      ]));
    }
    const [name, ...options] = parts;
    const unique = [...new Set(options)];
    if (unique.length < 2) return reply(box('❌ SONDAJ', ['Give at least 2 different options.']));
    const sent = await sock.sendMessage(jid, { poll: { name: name.slice(0, 250), values: unique.map((o) => o.slice(0, 100)), selectableCount: 1 } }, { quoted: m });
    if (polls.size >= 50) polls.delete(polls.keys().next().value);
    polls.set(sent.key.id, { jid, msg: sent, name, options: unique, votes: new Map(), at: Date.now() });
    lastPoll.set(jid, sent.key.id);
    return null;
  };

  /** messages.update events: collect the votes of the polls created by this bot. */
  const onUpdates = async (updates) => {
    for (const { key, update } of updates || []) {
      try {
        if (!update?.pollUpdates?.length || !key?.id) continue;
        const p = polls.get(key.id);
        if (!p) continue;
        const { getAggregateVotesInPollMessage } = await import('@whiskeysockets/baileys');
        const agg = getAggregateVotesInPollMessage({ message: p.msg.message, pollUpdates: update.pollUpdates }, sock.user?.id);
        const voters = new Set(agg.flatMap((o) => o.voters || []));
        for (const v of voters) p.votes.set(v, agg.filter((o) => (o.voters || []).includes(v)).map((o) => o.name));
      } catch (e) {
        log('warn', 'poll update failed', { why: String(e?.message || '').slice(0, 60) });
      }
    }
  };

  /* ═════════════ SUDO ═════════════ */
  const sudoList = () => (Array.isArray(settings.sudo) ? settings.sudo : []);
  /** true when the sender of this message is a sudo user (treated like the owner). */
  const isSudo = (m) => {
    const list = sudoList();
    if (!list.length || !m?.key) return false;
    const c = [m.key.participant, m.key.participantAlt, m.key.remoteJid, m.key.remoteJidAlt].filter(Boolean).map(jn);
    return c.some((x) => list.includes(x));
  };
  const sudoTarget = ({ args, content }) => {
    const ci = content?.extendedTextMessage?.contextInfo;
    const j = ci?.mentionedJid?.[0] || ci?.participant;
    if (j) return jn(j);
    for (const a of args) {
      const d = String(a).replace(/\D/g, '');
      if (d.length >= 7 && d.length <= 15) return d;
    }
    return null;
  };
  const sudoRemove = async (num, reply) => {
    if (!sudoList().includes(num)) return reply(box('❌ SUDO', [`@${num} is not in the sudo list.`]));
    settings.sudo = sudoList().filter((x) => x !== num);
    await persist();
    return reply(box('✅ SUDO', [`Removed : *${num}*`]));
  };
  const sudo = async ({ args, m, content, reply }) => {
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'list') {
      const l = sudoList();
      return reply(box('👥 SUDO LIST', l.length ? l.map((x, i) => `${i + 1}. +${x}`) : ['No sudo users.']));
    }
    if (!['add', 'del', 'remove'].includes(sub)) {
      return reply(box('👥 SUDO', [`*${P()}sudo add <@user|number>*`, `*${P()}sudo del <@user|number>*`, `*${P()}sudo list*`]));
    }
    if (!m.key.fromMe) return reply(box('❌ SUDO', ['Only the owner can add or remove sudo users.']));
    const num = sudoTarget({ args: args.slice(1), content });
    if (!num) return reply(box('❌ SUDO', ['Mention a user, reply to their message or give a number.']));
    if (sub !== 'add') return sudoRemove(num, reply);
    if (isSelf(num)) return reply(box('❌ SUDO', ['That is the owner already.']));
    if (sudoList().includes(num)) return reply(box('✅ SUDO', [`+${num} is already sudo.`]));
    if (sudoList().length >= 30) return reply(box('❌ SUDO', ['Sudo list is full (30).']));
    settings.sudo = [...sudoList(), num];
    await persist();
    return reply(box('✅ SUDO', [`Added : *+${num}*`, 'This user can now use owner commands.']));
  };
  const delsudo = async ({ args, m, content, reply }) => {
    if (!m.key.fromMe) return reply(box('❌ SUDO', ['Only the owner can remove sudo users.']));
    const num = sudoTarget({ args, content });
    if (!num) return reply(box('❌ SUDO', [`Usage : *${P()}delsudo <@user|number>*`]));
    return sudoRemove(num, reply);
  };

  /* ═════════════ MEDIA → URL (.tourl / .url) and .remini ═════════════ */
  const KIND_EXT = { imageMessage: ['image', 'jpg'], videoMessage: ['video', 'mp4'], audioMessage: ['audio', 'mp3'], stickerMessage: ['sticker', 'webp'], documentMessage: ['document', 'bin'] };
  const norm = (x) => (helpers.normalizeMessageContent ? helpers.normalizeMessageContent(x) : null) || x;

  /** Media of the message itself or of the replied message → { buffer, ext, kind, mime } | null */
  async function getMedia({ jid, m, content }) {
    let holder = norm(content || m?.message || {});
    let msgLike = m;
    let node = Object.keys(KIND_EXT).map((k) => ({ k, n: holder?.[k] })).find((x) => x.n);
    if (!node) {
      const ci = holder?.extendedTextMessage?.contextInfo;
      const q = ci?.quotedMessage ? norm(ci.quotedMessage) : null;
      node = q ? Object.keys(KIND_EXT).map((k) => ({ k, n: q[k] })).find((x) => x.n) : null;
      if (node) msgLike = { key: { remoteJid: jid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: q };
    }
    if (!node || !helpers.downloadMediaMessage) return null;
    const size = Number(node.n.fileLength?.toNumber ? node.n.fileLength.toNumber() : node.n.fileLength) || 0;
    if (size > MAX_UPLOAD) throw new Error('File too big (max 50 MB).');
    const buffer = await helpers.downloadMediaMessage(msgLike, 'buffer', {}, { logger: helpers.logger, reuploadRequest: sock.updateMediaMessage });
    const [kind, def] = KIND_EXT[node.k];
    let ext = kind === 'document' ? String(node.n.fileName || '').split('.').pop().toLowerCase() : def;
    if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = def;
    return { buffer, ext, kind, mime: node.n.mimetype || '' };
  }

  /** Uploads to a free host (uguu → catbox → tmpfiles). Returns a public https link. */
  async function uploadBuffer(buffer, ext) {
    const name = `file.${ext}`;
    const attempts = [
      async () => {
        const fd = new FormData();
        fd.append('files[]', new Blob([buffer]), name);
        const r = await fetchImpl('https://uguu.se/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(90_000), headers: { 'user-agent': UA } });
        const j = await r.json();
        return j?.files?.[0]?.url;
      },
      async () => {
        const fd = new FormData();
        fd.append('reqtype', 'fileupload');
        fd.append('fileToUpload', new Blob([buffer]), name);
        const r = await fetchImpl('https://catbox.moe/user/api.php', { method: 'POST', body: fd, signal: AbortSignal.timeout(90_000), headers: { 'user-agent': UA } });
        return (await r.text()).trim();
      },
      async () => {
        const fd = new FormData();
        fd.append('file', new Blob([buffer]), name);
        const r = await fetchImpl('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(90_000) });
        const raw = (await r.json())?.data?.url;
        const u = raw ? new URL(raw) : null;
        return u && /(^|\.)tmpfiles\.org$/.test(u.hostname) ? `https://tmpfiles.org/dl/${u.pathname.replace(/^\/(dl\/)?/, '')}` : null;
      },
    ];
    for (const run of attempts) {
      try {
        const url = await run();
        if (url && isPublicHttps(url)) return url;
      } catch (e) {
        log('warn', 'upload host failed', { why: String(e?.message || '').slice(0, 50) });
      }
    }
    throw new Error('All upload hosts failed');
  }

  const tourl = async ({ jid, m, content, reply }) => {
    let media;
    try {
      media = await getMedia({ jid, m, content });
    } catch (e) {
      return reply(box('❌ URL', [String(e?.message || 'Failed')]));
    }
    if (!media) return reply(box('🔗 URL', [`Send or reply to a media (image, video, audio, sticker, document) with *${P()}url*`]));
    react(jid, m, '⏳');
    try {
      const url = await uploadBuffer(media.buffer, media.ext);
      react(jid, m, '✅');
      return reply(box('🔗 UPLOADER', ['Upload complete ✅', `URL : ${url}`]));
    } catch (e) {
      react(jid, m, '❌');
      return reply(box('❌ URL', ['Failed to upload the media.', 'Try again in a moment.']));
    }
  };

  const remini = async ({ args, jid, m, content, reply }) => {
    let imageUrl = String(args.join(' ')).match(URL_RE)?.[0] || '';
    try {
      if (!imageUrl) {
        const media = await getMedia({ jid, m, content });
        if (media && media.kind !== 'image' && media.kind !== 'sticker') media.bad = true;
        if (!media || media.bad) {
          return reply(box('📸 REMINI', ['Enhance a photo with AI.', `Reply to an image with *${P()}remini*`, `or *${P()}remini <image link>*`]));
        }
        react(jid, m, '⏳');
        imageUrl = await uploadBuffer(media.buffer, media.ext);
      } else {
        if (!isPublicHttps(imageUrl, true)) return reply(box('❌ REMINI', ['Invalid image link.']));
        react(jid, m, '⏳');
      }
      const key = process.env.REMINI_API_KEY || 'prince_tech_api_azfsbshfb';
      const data = await jget(`https://api.princetechn.com/api/tools/remini?apikey=${encodeURIComponent(key)}&url=${encodeURIComponent(imageUrl)}`, { ms: 60_000 });
      const out = data?.result?.image_url;
      if (!data?.success || !out || !isPublicHttps(out, true)) throw new Error(data?.result?.message || 'API returned no image');
      await send(jid, { image: { url: out }, caption: box('✨ REMINI', ['Image enhanced successfully!']) }, m, true);
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'remini failed', { why: String(e?.message || '').slice(0, 80) });
      react(jid, m, '❌');
      return reply(box('❌ REMINI', ['Failed to enhance the image.', 'Try again later or with another image.']));
    }
    return null;
  };

  const handlers = {
    mywaifu,
    ...games.handlers,
    dl,
    delete: del, hidetag, promote: promoteDemote('promote'), demote: promoteDemote('demote'),
    sudo, delsudo, deploy, sondaj,
    tourl, remini,
  };
  return { handlers, track, isSudo, gameText: games.onText, onUpdates };
}
