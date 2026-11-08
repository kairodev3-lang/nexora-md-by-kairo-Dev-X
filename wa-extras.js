// WhatsApp commands that need the socket: .apk, .unblock, .save, .telegram, .tt, .fc, .ig, .mediafire, settings (.autoread, …).
// Reserved for the owner of the linked account: engine-baileys.js only calls this module for
// messages written BY the owner (other people only get the public commands in public mode).
// Settings are stored in settings.json (the user's session folder, deleted with the session).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { box } from './wa-menu.js';
import { createMore, MORE_ALIASES, MORE_NAMES, isPublicHttps, youtubeId } from './wa-more.js';
import { createNewCmds, ANIME_NAMES, GAME_NAMES, DL_NAMES, DL_ALIASES, GROUP_NAMES, SUDO_NAMES, TOOL_NAMES, NEW_ALIASES } from './wa-newcmds.js';
import { ffmpegBin, videoToWebp, addStickerMeta } from './media.js';
import { channel, inviteCode, resolveChannel, startBoost, stopBoost, campaignOf, giveBoost, lastBoostError } from './channelBoost.js';
import { createSocial } from './dl-social.js';
import { createContent } from './wa-content.js';
export { isPublicHttps };

const SETTINGS_FILE = 'settings.json';
const PREFIX_CHARS = '.!#+-$~^?&';
const MAX_APK_BYTES = 100 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_STICKERS = 100; // Telegram packs hold up to 120 stickers
const DEFAULT_STICKERS = 20;
const BLOCK_DEFAULT = 5;
const BLOCK_MAX = 600;
const BLOCK_GAP_MS = 2000; // pause between two block / unblock calls (WhatsApp rate limits)
const TG_PROGRESS_FILE = 'tg-progress.json';

export const DEFAULT_SETTINGS = Object.freeze({
  prefix: '.',
  mode: 'private', // private = owner only · public = other people can use the public commands
  autorecording: false,
  autotyping: false,
  anticall: false,
  welcome: false,
  goodbye: false,
  autoread: false,
  autoviewstatus: false,
  autolikestatus: false,
  channelreact: true,
  autoreact: 'off', // off | all | groups | dms
  autoreactstyle: 'mix',
  sudo: [], // numbers allowed to use owner commands
});
const BOOL_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'prefix' && k !== 'mode' && k !== 'autoreact' && k !== 'autoreactstyle' && k !== 'sudo');
export const REACT_SCOPES = ['off', 'all', 'groups', 'dms'];
export const REACT_STYLES = {
  love: ['❤️', '😍', '🥰', '😘', '💖', '💕', '💞', '🫶', '💘', '😻'],
  fun: ['😂', '🤣', '😹', '😜', '🤪', '😎', '🥳', '🤩', '😆', '🙃'],
  fire: ['🔥', '💯', '⚡', '💥', '🚀', '👑', '💎', '🏆', '🌟', '✨'],
  cool: ['👍', '👌', '🙌', '👏', '🤝', '💪', '✌️', '🫡', '😉', '🤙'],
  nature: ['🌸', '🌺', '🌹', '🌻', '🍀', '🦋', '🌈', '🌙', '☀️', '🌊'],
  dark: ['🖤', '💀', '👻', '😈', '🕷️', '🦇', '🌑', '☠️', '👽', '🤖'],
};
REACT_STYLES.mix = Object.values(REACT_STYLES).flat();

const ALIASES = {
  autorec: 'autorecording', arecording: 'autorecording',
  autotype: 'autotyping', atyping: 'autotyping',
  acall: 'anticall',
  autoviewsview: 'autoviewstatus', avs: 'autoviewstatus', statusseen: 'autoviewstatus', astatus: 'autoviewstatus',
  als: 'autolikestatus',
  areact: 'autoreact', reactall: 'autoreact',
  creact: 'channelreact', chreact: 'channelreact', react: 'channelreact',
};

const INFO = {
  autorecording: { emoji: '🎙️', label: 'AUTO RECORDING', desc: 'Shows "recording audio…" when someone writes to you.' },
  autotyping: { emoji: '⌨️', label: 'AUTO TYPING', desc: 'Shows "typing…" when someone writes to you.' },
  anticall: { emoji: '📵', label: 'ANTI CALL', desc: 'Automatically rejects incoming calls.' },
  welcome: { emoji: '👋', label: 'WELCOME', desc: 'Welcome message for new group members.' },
  goodbye: { emoji: '🚪', label: 'GOODBYE', desc: 'Goodbye message when a member leaves a group.' },
  autoread: { emoji: '👀', label: 'AUTO READ', desc: 'Marks received messages as read (blue ticks).' },
  autoviewstatus: { emoji: '👁️', label: 'AUTO STATUS VIEW', desc: 'Automatically views your contacts\' statuses.' },
  autolikestatus: { emoji: '❤️', label: 'AUTO STATUS LIKE', desc: 'Reacts ❤️ to your contacts\' statuses.' },
  channelreact: { emoji: '📣', label: 'CHANNEL REACT', desc: 'Gives your channel 10 reactions for 5 days; your account also reacts to the other channels.' },
};

const CMD_ALIASES = {
  ytmp4: 'video', vdl: 'video',
  pin: 'pinterest', pindl: 'pinterest',
  tgsticker: 'telegram', tg: 'telegram',
  jid: 'getid', chatid: 'getid', gjid: 'getid', mylid: 'getid',
  channelid: 'idch', chid: 'idch',
  facebook: 'fc', fb: 'fc', fbdl: 'fc',
  instagram: 'ig', igdl: 'ig', insta: 'ig',
  tiktok: 'tt', tiktokdl: 'tt',
  mf: 'mediafire',
  ...DL_ALIASES,
  ...NEW_ALIASES,
  gpt: 'chatgpt', ai: 'chatgpt', bg: 'bing', ytsearch: 'yts', ytv: 'video', yta: 'song',
  fancytext: 'fancy',
  ...MORE_ALIASES,
};
const COMMANDS = new Set([
  'apk', 'block', 'unblock', 'save', 'setprefix', 'mode', 'video', 'pinterest', 'telegram', 'getid', 'idch', 'fancy',
  'tt', 'fc', 'ig', 'mediafire', 'autoreact',
  ...ANIME_NAMES, ...GAME_NAMES, ...DL_NAMES, ...GROUP_NAMES, ...SUDO_NAMES, ...TOOL_NAMES, 'chatgpt', 'gemini', 'aitts', 'img', 'bing', 'yts', 'play',
  ...MORE_NAMES, ...Object.keys(INFO), ...Object.keys(ALIASES), ...Object.keys(CMD_ALIASES),
]);

/* ───────── public mode: what other people may use ───────── */
// Everything else (settings, unblock, save, pair, telegram, getid, mode…) stays owner-only.
const PUBLIC_CMDS = new Set(['menu', 'help', 'owner', 'alive', 'ping', 'runtime', 'status', 'apk', 'song', 'video', 'tt', 'fc', 'ig', 'mediafire', 'twitter', 'pinterest', 'sticker', 'tourl', 'fancy', 'img', 'bing', 'yts', 'play', ...ANIME_NAMES, ...GAME_NAMES, ...DL_NAMES]);
const HEAVY_CMDS = new Set(['dl', 'apk', 'song', 'video', 'tt', 'fc', 'ig', 'mediafire', 'twitter', 'pinterest', 'sticker', 'tourl', 'img', 'play']);
const OWNER_ONLY_BASE = new Set(['pair', 'getpair', 'depair', 'unpair']);
const GUEST_WINDOW_MS = 60_000;
const GUEST_MAX_PER_WINDOW = 8;
const GUEST_HEAVY_COOLDOWN_MS = 60_000;
const GUEST_MAX_HEAVY_PARALLEL = 2;

/* ───────── .fancy : 10 writing styles ───────── */
const SMALL_CAPS = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ғ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 's', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
const alpha = (up, low, dig, over = {}) => (ch) => {
  if (over[ch]) return over[ch];
  const c = ch.codePointAt(0);
  if (up != null && c >= 65 && c <= 90) return String.fromCodePoint(up + c - 65);
  if (low != null && c >= 97 && c <= 122) return String.fromCodePoint(low + c - 97);
  if (dig != null && c >= 48 && c <= 57) return String.fromCodePoint(dig + c - 48);
  return ch;
};
const circled = (ch) => {
  const c = ch.codePointAt(0);
  if (c >= 65 && c <= 90) return String.fromCodePoint(0x24b6 + c - 65);
  if (c >= 97 && c <= 122) return String.fromCodePoint(0x24d0 + c - 97);
  if (c === 48) return '⓪';
  if (c >= 49 && c <= 57) return String.fromCodePoint(0x2460 + c - 49);
  return ch;
};
export const FANCY_STYLES = [
  ['ꜱᴍᴀʟʟ ᴄᴀᴘs', (ch) => SMALL_CAPS[ch.toLowerCase()] || ch],
  ['𝐁𝐨𝐥𝐝', alpha(0x1d400, 0x1d41a, 0x1d7ce)],
  ['𝐼𝑡𝑎𝑙𝑖𝑐', alpha(0x1d434, 0x1d44e, null, { h: 'ℎ' })],
  ['𝑩𝒐𝒍𝒅 𝑰𝒕𝒂𝒍𝒊𝒄', alpha(0x1d468, 0x1d482, null)],
  ['𝒮𝒸𝓇𝒾𝓅𝓉', alpha(0x1d49c, 0x1d4b6, null, { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' })],
  ['𝔻𝕠𝕦𝕓𝕝𝕖', alpha(0x1d538, 0x1d552, 0x1d7d8, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' })],
  ['𝙼𝚘𝚗𝚘', alpha(0x1d670, 0x1d68a, 0x1d7f6)],
  ['𝗦𝗮𝗻𝘀 𝗕𝗼𝗹𝗱', alpha(0x1d5d4, 0x1d5ee, 0x1d7ec)],
  ['Ⓒⓘⓡⓒⓛⓔ', circled],
  ['Ｆｕｌｌｗｉｄｔｈ', alpha(0xff21, 0xff41, 0xff10)],
];
export const fancyAll = (text) => FANCY_STYLES.map(([name, fn]) => [name, [...String(text)].map(fn).join('')]);

/* ───────── network / file helpers ───────── */
export async function loadSettings(dir) {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
    for (const k of BOOL_KEYS) if (typeof raw[k] === 'boolean') s[k] = raw[k];
    if (raw.mode === 'public' || raw.mode === 'private') s.mode = raw.mode;
    if (Array.isArray(raw.sudo)) s.sudo = raw.sudo.map((x) => String(x).replace(/\D/g, '')).filter((x) => x.length >= 7 && x.length <= 15).slice(0, 30);
    if (REACT_SCOPES.includes(raw.autoreact)) s.autoreact = raw.autoreact;
    if (typeof raw.autoreactstyle === 'string' && REACT_STYLES[raw.autoreactstyle]) s.autoreactstyle = raw.autoreactstyle;
    if (typeof raw.prefix === 'string' && raw.prefix.length === 1 && PREFIX_CHARS.includes(raw.prefix)) s.prefix = raw.prefix;
  } catch {
    /* no file or unreadable file → default values */
  }
  return s;
}

async function saveSettings(dir, s) {
  const target = path.join(dir, SETTINGS_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

const toNum = (v) => (v == null ? 0 : typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
const num = (j) => String(j || '').split('@')[0].split(':')[0];
const okAptoideUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || x.protocol === 'http:') && /(^|\.)aptoide\.com$/i.test(x.hostname);
  } catch {
    return false;
  }
};


const TG_LINK = /^(?:https?:\/\/)?(?:t|telegram)\.me\/addstickers\/([A-Za-z0-9_]{1,64})\/?$/i;

/**
 * @param {object} d
 * @param {any} d.sock   Baileys socket
 * @param {string} d.authDir
 * @param {(jid:string, content:object, quoted?:object, plain?:boolean)=>Promise<any>} d.send
 * @param {{downloadMediaMessage:Function, normalizeMessageContent?:Function, jidNormalizedUser:Function, logger?:any}} d.helpers
 * @param {(key:string, value:any)=>void} [d.onSettingChange]
 */
export async function createExtras({ sock, authDir, send, helpers, log = () => {}, fetchImpl = globalThis.fetch, assets = {}, onSettingChange = () => {} }) {
  const settings = await loadSettings(authDir);
  const { downloadMediaMessage, normalizeMessageContent, jidNormalizedUser } = helpers;
  const norm = (m) => (normalizeMessageContent ? normalizeMessageContent(m) : null) || m;
  const ownJid = () => (sock.user?.id ? jidNormalizedUser(sock.user.id) : null);
  const isSelf = (j) => [num(sock.user?.id), num(sock.user?.lid)].filter(Boolean).includes(num(j));
  const P = () => settings.prefix;
  const brandName = () => process.env.BOT_NAME || 'NEXORA MD';
  const brandOwner = () => process.env.OWNER_NAME || 'KAIRO';
  const more = createMore({ sock, send, log, helpers, fetchImpl, P, ownJid, settings, assets });
  const social = createSocial({ sock, send, log });
  const contentCmds = createContent({ sock, send, log, fetchImpl, P, helpers });
  const newCmds = createNewCmds({ sock, send, log, fetchImpl, P, helpers, isSelf, settings, persist: () => saveSettings(authDir, settings) });

  /* ───────── .apk ───────── */
  async function apk(q, { reply, jid, m }) {
    if (!q) return reply(box('📦 APK DOWNLOAD', [`Usage : *${P()}apk <app name>*`, `Example : *${P()}apk whatsapp*`]));
    await reply(box('🔎 APK', [`Searching for "${q.slice(0, 60)}"…`]));
    const res = await fetchImpl(`https://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(q)}/limit=1`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`aptoide ${res.status}`);
    const data = await res.json();
    const app = data?.datalist?.list?.[0];
    if (!app) return reply(box('❌ APK', ['No result.']));
    const url = app.file?.path || app.file?.path_alt;
    const bytes = toNum(app.size) || toNum(app.file?.filesize);
    if (!url || !okAptoideUrl(url)) return reply(box('❌ APK', ['Download link unavailable.']));
    if (bytes > MAX_APK_BYTES) return reply(box('❌ APK', [`File too big (${(bytes / 1048576).toFixed(0)} MB, max 100 MB).`]));

    const info = box('📦 APK INFO', [
      `Name    : *${String(app.name || '').toUpperCase()}*`,
      `Size    : *${(bytes / 1048576).toFixed(2)} MB*`,
      `Package : *${app.package || '—'}*`,
      `Version : *${app.file?.vername || '—'}*`,
    ]);
    if (app.icon && okAptoideUrl(app.icon)) await send(jid, { image: { url: app.icon }, caption: info }, m, true);
    else await reply(info);
    await send(
      jid,
      {
        document: { url },
        mimetype: 'application/vnd.android.package-archive',
        fileName: `${String(app.name || 'app').replace(/[^\w.-]+/g, '_')}.apk`,
      },
      m,
      true,
    );
  }

  /* ───────── .block <times> <number> : block + unblock a number several times (default 5, max 600) ───────── */
  // Works from ANY chat: .block 5 +50912345678
  let blockBusy = false;
  async function blockCycles(args, { jid, content, reply }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    const ci0 = args.findIndex((a) => /^\d{1,3}$/.test(a)); // 1-3 digits = times
    const numberText = args.filter((_, k) => k !== ci0).join(' ').trim(); // "+509 1234 5678" is accepted too
    const digits = numberText.replace(/\D/g, '');
    const phone = /^[+\d\s()-]+$/.test(numberText) && digits.length >= 8 && digits.length <= 15 ? digits : null;
    const usage = () => reply(box('🚫 BLOCK', [
      `Usage : *${P()}block <times> <number>*`,
      `Example : *${P()}block 5 +50943212344*`,
      `Times : 1 to ${BLOCK_MAX} (default ${BLOCK_DEFAULT})`,
      'Each time = 1 block then 1 unblock. Ends unblocked.',
    ]));

    let target = null;
    let alt = null; // same person, other id format (pn / lid)
    if (phone) {
      if (isSelf(`${phone}@s.whatsapp.net`)) return reply(box('🚫 BLOCK', ['This is your own number.']));
      target = `${phone}@s.whatsapp.net`;
      try {
        const hit = (await sock.onWhatsApp(phone))?.[0];
        if (hit && hit.exists === false) return reply(box('❌ BLOCK', [`+${phone} is not on WhatsApp.`]));
        if (hit?.jid) target = hit.jid;
        if (hit?.lid && hit.lid !== target) alt = hit.lid;
      } catch {
        /* lookup unavailable: use the number as it is */
      }
    } else if (numberText) {
      return reply(box('❌ BLOCK', ['Invalid number.', `Example : *${P()}block 5 +50943212344*`]));
    } else {
      target = ci?.participant || null; // reply to a message (optional)
      if (!target && /@(s\.whatsapp\.net|lid)$/.test(jid)) target = jid; // private chat (optional)
      if (!target || isSelf(target)) return usage();
    }
    if (blockBusy) return reply(box('⏳ BLOCK', ['A block series is already running.']));
    const asked = Number.parseInt(args[ci0] ?? '', 10);
    const times = Math.min(BLOCK_MAX, Math.max(1, Number.isFinite(asked) ? asked : BLOCK_DEFAULT));
    const note = asked > BLOCK_MAX ? ` (limit ${BLOCK_MAX})` : '';
    const say = (title, lines) => send(jid, { text: box(title, lines), mentions: [target] }, null);
    await say('🚫 BLOCK', [`Target : @${num(target)}`, `Times : *${times}*${note}`, `Estimated : ~${Math.ceil((times * 2 * BLOCK_GAP_MS) / 60_000)} min`, 'Running…']);

    const setBlock = async (action) => {
      try {
        await sock.updateBlockStatus(target, action);
      } catch (e) {
        if (!alt) throw e;
        await sock.updateBlockStatus(alt, action); // some accounts only accept the other id format
        [target, alt] = [alt, target];
      }
    };
    const wait = () => new Promise((res) => setTimeout(res, BLOCK_GAP_MS));

    blockBusy = true;
    let done = 0;
    let failed = null;
    try {
      for (let i = 0; i < times; i++) {
        await setBlock('block');
        if (i === 0 && alt && typeof sock.fetchBlocklist === 'function') {
          // first cycle: check that WhatsApp really blocked the person, otherwise switch to the other id format
          const list = await sock.fetchBlocklist().catch(() => null);
          if (Array.isArray(list) && !list.includes(target) && list.includes(alt)) [target, alt] = [alt, target];
        }
        await wait();
        await setBlock('unblock');
        done++;
        if (done % 100 === 0 && done < times) await say('⏳ BLOCK', [`Progress : *${done}/${times}*`]);
        if (i < times - 1) await wait();
      }
    } catch (e) {
      failed = String(e?.message || 'error').slice(0, 60);
      log('warn', 'wa block series failed', { err: failed });
      await sock.updateBlockStatus(target, 'unblock').catch(() => {}); // never leave the person blocked
      if (alt) await sock.updateBlockStatus(alt, 'unblock').catch(() => {});
    } finally {
      blockBusy = false;
    }
    return say(failed ? '⚠️ BLOCK' : '✅ BLOCK', [`Target : @${num(target)}`, `Done : *${done}/${times}*`, failed ? `Stopped : ${failed}` : 'Finished ✅', 'The person is unblocked.']);
  }

  /* ───────── .unblock ───────── */
  async function unblock({ jid, content, reply }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    let target = ci?.participant || null; // reply to a message
    if (!target && /@(s\.whatsapp\.net|lid)$/.test(jid)) target = jid; // private chat
    if (!target || isSelf(target)) {
      return reply(box('✅ UNBLOCK', ['Reply to the person\'s message,', 'or send the command in their chat.']));
    }
    await sock.updateBlockStatus(target, 'unblock');
    await send(jid, { text: box('✅ UNBLOCKED', [`@${num(target)} is unblocked.`]), mentions: [target] }, null);
  }

  /* ───────── .save / reply "save" to a status ───────── */
  async function saveStatus({ jid, content, reply, requireStatus }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    if (!ci?.quotedMessage) {
      if (requireStatus) return false;
      await reply(box('📤 SAVE', [`Reply to a status (or a media) with *${P()}save*.`]));
      return true;
    }
    if (requireStatus && ci.remoteJid !== 'status@broadcast') return false;

    const q = norm(ci.quotedMessage);
    const from = ci.participant ? `@${num(ci.participant)}` : '—';
    const caption = box('📤 STATUS SAVED', [`From : ${from}`]);
    const me = ownJid();
    if (!me) return true;

    const media = q.imageMessage ? ['image', q.imageMessage] : q.videoMessage ? ['video', q.videoMessage] : null;
    if (!media) {
      const text = q.conversation || q.extendedTextMessage?.text;
      if (text) await send(me, { text: `${caption}\n\n${text}` }, null);
      else await reply(box('❌ SAVE', ['This status type is not supported.']));
      return true;
    }
    if (toNum(media[1].fileLength) > MAX_STATUS_BYTES) {
      await reply(box('❌ SAVE', ['Media too big (max 64 MB).']));
      return true;
    }
    const buf = await downloadMediaMessage(
      { key: { remoteJid: ci.remoteJid || jid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: q },
      'buffer',
      {},
      { logger: helpers.logger, reuploadRequest: sock.updateMediaMessage },
    );
    await send(me, { [media[0]]: buf, caption }, null, true);
    return true;
  }

  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});
  const getJson = async (url, ms = 25_000) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  };
  const remoteSize = async (url) => {
    try {
      const r = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      const n = Number(r.headers.get('content-length'));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };

  /* ───────── .pinterest <search> : up to 5 images ───────── */
  async function pinterest(q, { reply, jid, m }) {
    const query = String(q || '').trim().slice(0, 100);
    if (!query) return reply(box('📌 PINTEREST', [`Usage : *${P()}pinterest <search>*`, `Example : *${P()}pinterest nature*`]));
    react(jid, m, '🔍');
    const token = process.env.PINTEREST_API_TOKEN || 'SYDHKj';
    const data = await getJson(`https://whiteshadow-x-api.onrender.com/api/search/pinterest?q=${encodeURIComponent(query)}&apitoken=${encodeURIComponent(token)}`, 40_000);
    const results = data?.results || data?.result || data?.data || data?.images;
    const items = Array.isArray(results) ? results : results ? [results] : [];
    const urls = items
      .map((it) => (typeof it === 'string' ? it : it?.image || it?.imageUrl || it?.url || it?.src || it?.thumbnail))
      .filter((u) => typeof u === 'string' && isPublicHttps(u))
      .slice(0, 5);
    if (!urls.length) {
      react(jid, m, '❌');
      return reply(box('❌ PINTEREST', ['No image found.']));
    }
    let sent = 0;
    for (const [i, u] of urls.entries()) {
      try {
        await send(jid, { image: { url: u }, caption: i === 0 ? `📌 *${query}*` : '' }, m, true);
        sent++;
      } catch (e) {
        log('warn', 'pinterest image failed', { err: String(e?.message || '').slice(0, 60) });
      }
    }
    react(jid, m, sent ? '✅' : '❌');
    return sent ? null : reply(box('❌ PINTEREST', ['Could not send the images.']));
  }

  /* ───────── .telegram <link> <pack name> [| author] <amount> : Telegram sticker pack → WhatsApp stickers ───────── */
  // The pack name / author shown under each sticker are chosen by the user (no fixed brand name).
  // Progress is remembered per Telegram pack: each call sends the NEXT stickers, never the ones already sent.
  let tgBusy = false;
  const tgProgressPath = path.join(authDir, TG_PROGRESS_FILE);
  async function loadTgProgress() {
    try {
      const raw = JSON.parse(await fs.readFile(tgProgressPath, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }
  async function saveTgProgress(data) {
    const tmp = `${tgProgressPath}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(tmp, tgProgressPath);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async function tgStickers(args, { reply, jid, m }) {
    const pack = (args[0] || '').match(TG_LINK)?.[1];
    if (!pack) {
      return reply(box('📦 TELEGRAM STICKERS', [
        `Usage : *${P()}telegram <link> <pack name> <amount>*`,
        `Example : *${P()}telegram https://t.me/addstickers/PackName My Pack 20*`,
        `Author (optional) : *${P()}telegram <link> My Pack | My Name 20*`,
        `Next batch : send the same command again, it continues where it stopped.`,
        `Restart : *${P()}telegram <link> reset*`,
        `Amount : 1 to ${MAX_STICKERS} (default ${DEFAULT_STICKERS})`,
      ]));
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return reply(box('❌ STICKERS', ['TELEGRAM_BOT_TOKEN is missing on the server.']));
    if (tgBusy) return reply(box('⏳ STICKERS', ['A pack is already being sent.']));

    const rest = args.slice(1);
    const key = pack.toLowerCase();

    if (rest.length === 1 && /^(reset|restart|0)$/i.test(rest[0])) {
      const data = await loadTgProgress();
      delete data[key];
      await saveTgProgress(data);
      return reply(box('🔄 STICKERS', ['Progress cleared ✅', 'The next call starts from the first sticker.']));
    }

    let want = null;
    if (rest.length && /^\d{1,3}$/.test(rest[rest.length - 1])) want = Math.min(MAX_STICKERS, Math.max(1, Number(rest.pop())));
    const [namePart, ...authorParts] = rest.join(' ').split('|');
    const userLabel = namePart.trim().slice(0, 40);
    const author = authorParts.join('|').trim().slice(0, 40);

    tgBusy = true;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stk-'));
    let start = 0;
    let attempted = 0;
    let progress = {};
    try {
      const set = await getJson(`https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(pack)}`);
      const all = set?.result?.stickers;
      if (!set?.ok || !Array.isArray(all) || !all.length) return reply(box('❌ STICKERS', ['Pack not found.']));
      const label = userLabel || String(set.result.title || pack).slice(0, 40);

      progress = await loadTgProgress();
      start = Math.min(Math.max(0, Number(progress[key]) || 0), all.length);
      if (start >= all.length) {
        return reply(box('✅ STICKERS', [`All ${all.length} stickers of this pack were already sent.`, `Restart with *${P()}telegram ${args[0]} reset*`]));
      }
      const list = all.slice(start, start + (want ?? DEFAULT_STICKERS));
      await reply(box('📦 TELEGRAM STICKERS', [
        `Stickers : *${list.length}* (${start + 1} → ${start + list.length} of ${all.length})`,
        `Pack name : *${label}*`,
        ...(author ? [`Author : *${author}*`] : []),
        'Sending…',
      ]));

      let ffmpegOk = null;
      let ok = 0;
      let failed = 0;
      let animated = 0;
      for (const [i, st] of list.entries()) {
        attempted = i + 1;
        try {
          if (st.is_animated) {
            animated++;
            throw new Error('animated (.tgs)');
          }
          const info = await getJson(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(st.file_id)}`);
          if (!info?.ok || !info.result?.file_path) throw new Error('getFile');
          const res = await fetchImpl(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`, { signal: AbortSignal.timeout(25_000) });
          if (!res.ok) throw new Error('download');
          let buf = Buffer.from(await res.arrayBuffer());
          if (st.is_video) {
            if (ffmpegOk === null) ffmpegOk = await ffmpegBin().then(() => true, () => false);
            if (!ffmpegOk) throw new Error('ffmpeg missing');
            const inP = path.join(tmp, `${i}.webm`);
            const outP = path.join(tmp, `${i}.webp`);
            await fs.writeFile(inP, buf);
            try {
              await videoToWebp(inP, outP, { seconds: 8, inputArgs: ['-c:v', 'libvpx-vp9'] }); // keeps WebM transparency
            } catch {
              await videoToWebp(inP, outP, { seconds: 8 });
            }
            buf = await fs.readFile(outP);
          }
          buf = await addStickerMeta(buf, { pack: label, author, emoji: st.emoji || '🤖' });
          await send(jid, { sticker: buf }, m, true);
          ok++;
        } catch (e) {
          failed++;
          log('warn', 'wa sticker failed', { why: String(e?.message || 'error').slice(0, 60) });
        }
        await new Promise((r) => setTimeout(r, 900));
      }
      const left = all.length - (start + attempted);
      await reply(box(ok ? '✅ STICKERS' : '❌ STICKERS', [
        `Sent   : *${ok}/${list.length}*`,
        `Failed : *${failed}*`,
        animated ? `Animated .tgs stickers cannot be converted (${animated} skipped).` : failed ? 'Some stickers could not be converted.' : 'Done!',
        left > 0 ? `Remaining : *${left}* — send the same command again for the next ones.` : 'End of the pack 🎉',
      ]));
    } finally {
      // remember how far we got, even if the batch was interrupted
      if (attempted > 0) {
        progress[key] = start + attempted;
        await saveTgProgress(progress);
      }
      tgBusy = false;
      fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* ───────── .getid ───────── */
  async function getId({ jid, content, reply }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    const me = ownJid();
    const lid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : 'not detected';
    if (jid.endsWith('@g.us')) return reply(box('🏠 GROUP ID', [`ID : \`${jid}\``]));
    const lines = [`Chat : \`${jid}\``];
    if (ci?.participant) lines.push(`Target : \`${ci.participant}\``);
    lines.push(`My JID : \`${me || '—'}\``, `My LID : \`${lid}\``);
    return reply(box('🆔 USER DETAILS', lines));
  }

  /* ───────── .idch <channel link> ───────── */
  async function idCh(q, { reply }) {
    const url = q.trim() || channel.url;
    const code = inviteCode(url);
    if (!code) {
      return reply(box('📡 CHANNEL ID', [`Usage : *${P()}idch <channel link>*`, 'Example : https://whatsapp.com/channel/XXXX', `*${P()}idch* alone shows the ${brandName()} channel.`]));
    }
    let meta;
    try {
      meta = await sock.newsletterMetadata('invite', code);
    } catch {
      meta = null;
    }
    if (!meta?.id) return reply(box('❌ CHANNEL ID', ['Channel not found.', 'Check the link and try again.']));
    if (code === inviteCode(channel.url)) await resolveChannel(sock);
    const followers = meta.subscribers ?? meta.thread_metadata?.subscribers_count;
    return reply(box('📡 CHANNEL ID', [
      `Name : *${String(meta.name || meta.thread_metadata?.name?.text || '—').slice(0, 60)}*`,
      `ID : \`${meta.id}\``,
      ...(followers != null ? [`Followers : *${Number(followers).toLocaleString('en-US')}*`] : []),
    ]));
  }

  /* ───────── .channelreact [on|off|<channel link>] ───────── */
  // Each user turns it ON and gives THEIR channel link: for 5 days every connected account reacts to the new posts of
  // that channel (10 different emojis) and to its 10 latest posts. The link can be changed any time, and redone after 5 days.
  const CHANNEL_LINK = /https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[\w-]+/i;
  let awaitingLinkUntil = 0;
  const myId = () => num(sock.user?.id);
  const timeLeft = (ms) => {
    const h = Math.max(0, Math.floor(ms / 3_600_000));
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  };

  function boostLines() {
    const c = campaignOf(myId());
    const lines = [`React : *${settings.channelreact ? 'ON' : 'OFF'}*`];
    if (c) lines.push(`Your channel : *${c.name || '—'}*`, c.url, `Emojis : ${c.emojis.join(' ')}`, `Time left : *${timeLeft(c.until - Date.now())}*`);
    else lines.push('Your channel : *none yet*');
    return lines;
  }

  async function applyBoostLink(link, reply) {
    if (!settings.channelreact) {
      settings.channelreact = true;
      await saveSettings(authDir, settings);
    }
    awaitingLinkUntil = 0;
    await reply(box('🔎 CHANNEL REACT', ['Checking the channel…']));
    const r = await startBoost(sock, link, myId());
    if (!r.ok) {
      const why = { invalid_link: 'Invalid channel link.', not_found: 'Channel not found.', full: 'Too many channels are running right now. Try again later.' }[r.reason];
      return reply(box('❌ CHANNEL REACT', [why, 'Example : https://whatsapp.com/channel/XXXX']));
    }
    try { onSettingChange('channelreact', true); } catch { /* never block a setting */ }
    await reply(box('📣 CHANNEL REACT ✅', [
      `Channel : *${r.campaign.name || '—'}*`,
      r.campaign.url,
      `Emojis : ${r.campaign.emojis.join(' ')}`,
      'Sending 20 followers + 20 reactions…',
    ]));
    // up to 20 other connected accounts follow + react (works with ONE user too: this account reacts to the 10 latest posts)
    let res = { pool: 0, followers: 0, followersSkipped: false, reacts: 0 };
    try {
      res = await giveBoost(sock, r.campaign, log);
    } catch (e) {
      log('warn', 'channelreact give failed', { why: String(e?.message || '').slice(0, 60) });
    }
    const lines = [`Channel : *${r.campaign.name || '—'}*`, `Accounts online : *${res.pool}*`];
    if (res.followers) lines.push(`Followers : *+${res.followers}* 🎁`);
    else if (res.followersSkipped) lines.push('Free followers : already given today');
    else if (!res.pool) lines.push('Followers : *0* (no other connected account right now)');
    lines.push(`Reactions : *${res.reacts}*`);
    if (!res.reacts) {
      lines.push('⚠️ No reaction could be sent. Check that the link is a channel you can see, then try again in a minute.');
      if (lastBoostError()) lines.push(`Reason : ${lastBoostError()}`);
    }
    lines.push('Every day : new reactions, for *5 days*.', 'New posts : reacted automatically.', `Change channel : *${P()}channelreact <new link>*`);
    return reply(box('✅ CHANNEL REACT', lines));
  }

  async function channelBoostCmd(args, { reply }) {
    const link = args.find((a) => CHANNEL_LINK.test(a));
    if (link) return applyBoostLink(link.match(CHANNEL_LINK)[0], reply);
    const v = String(args[0] || '').toLowerCase();
    if (['off', 'false', '0'].includes(v)) {
      settings.channelreact = false;
      await saveSettings(authDir, settings);
      stopBoost(myId());
      try { onSettingChange('channelreact', false); } catch { /* never block a setting */ }
      return reply(box('📣 CHANNEL REACT', ['React : *OFF* ✅', 'Your account no longer reacts and your channel campaign is stopped.']));
    }
    if (['on', 'true', '1'].includes(v) || !v) {
      if (!settings.channelreact) {
        settings.channelreact = true;
        await saveSettings(authDir, settings);
        try { onSettingChange('channelreact', true); } catch { /* never block a setting */ }
      }
      awaitingLinkUntil = Date.now() + 3 * 60_000;
      const lines = boostLines();
      lines.push('📎 Send your channel link now.', `(or *${P()}channelreact <link>*)`, `Stop : *${P()}channelreact off*`);
      return reply(box('📣 CHANNEL REACT', lines));
    }
    return reply(box('📣 CHANNEL REACT', [...boostLines(), `Usage : *${P()}channelreact on* · *off* · *<channel link>*`]));
  }

  // Plain message (no prefix) right after .channelreact: a channel link sent alone is taken as the answer.
  async function boostLink(text, reply) {
    if (Date.now() > awaitingLinkUntil) return false;
    const hit = String(text || '').trim().match(/^(https?:\/\/(?:www\.)?whatsapp\.com\/channel\/[\w-]+)\/?$/i);
    if (!hit) return false;
    await applyBoostLink(hit[1], reply);
    return true;
  }

  /* ───────── .autoreact [all|groups|dms|off|style <name>] ───────── */
  const AR_ALIASES = { chats: 'dms', dm: 'dms', private: 'dms', group: 'groups', on: 'all', true: 'all', 1: 'all', false: 'off', 0: 'off' };
  async function autoReactCmd(args, { reply }) {
    const a = String(args[0] || '').toLowerCase();
    if (a === 'style') {
      const st = String(args[1] || '').toLowerCase();
      if (!REACT_STYLES[st]) return reply(box('🎭 AUTO REACT STYLE', [`Styles : ${Object.keys(REACT_STYLES).join(' · ')}`, `Usage : *${P()}autoreact style love*`]));
      settings.autoreactstyle = st;
      await saveSettings(authDir, settings);
      return reply(box('🎭 AUTO REACT STYLE', [`Style : *${st}* ✅`, REACT_STYLES[st].join(' ')]));
    }
    const scope = REACT_SCOPES.includes(a) ? a : AR_ALIASES[a];
    if (!scope) {
      return reply(box('🎭 AUTO REACT', [
        `Status : *${settings.autoreact.toUpperCase()}* · style *${settings.autoreactstyle}*`,
        'Reacts to incoming messages with random emojis.',
        `*${P()}autoreact all* — groups + chats`,
        `*${P()}autoreact groups* — groups only`,
        `*${P()}autoreact dms* — private chats only`,
        `*${P()}autoreact off*`,
        `*${P()}autoreact style <${Object.keys(REACT_STYLES).join('|')}>*`,
      ]));
    }
    settings.autoreact = scope;
    await saveSettings(authDir, settings);
    return reply(box('🎭 AUTO REACT', [`Status : *${scope.toUpperCase()}* ✅`, `Style : *${settings.autoreactstyle}*`]));
  }

  const lastReact = new Map(); // chat -> timestamp (at most one reaction every 4 s per chat: protects the account)
  async function autoReact(m, jid) {
    const scope = settings.autoreact;
    if (scope === 'off') return;
    const isGroup = jid.endsWith('@g.us');
    if ((scope === 'groups' && !isGroup) || (scope === 'dms' && isGroup)) return;
    const content = (helpers.normalizeMessageContent ? helpers.normalizeMessageContent(m.message) : null) || m.message || {};
    if (content.reactionMessage || content.protocolMessage || content.senderKeyDistributionMessage) return;
    const text = String(content.conversation || content.extendedTextMessage?.text || '');
    if (text.startsWith(P())) return; // commands are not reacted to
    const now = Date.now();
    if (now - (lastReact.get(jid) || 0) < 4000) return;
    lastReact.set(jid, now);
    if (lastReact.size > 300) lastReact.delete(lastReact.keys().next().value);
    const list = REACT_STYLES[settings.autoreactstyle] || REACT_STYLES.mix;
    const emoji = list[Math.floor(Math.random() * list.length)];
    await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 1800)));
    await sock.sendMessage(jid, { react: { text: emoji, key: m.key } });
  }

  /* ───────── .fancy ───────── */
  async function fancy(q, reply) {
    if (!q) return reply(box('✨ FANCY', [`Usage : *${P()}fancy <text>*`, '10 writing styles.']));
    const text = q.slice(0, 120);
    return reply(box('✨ FANCY TEXT', fancyAll(text).map(([, out], i) => `${i + 1}. ${out}`)));
  }

  /* ───────── .mode ───────── */
  async function setMode(arg, reply) {
    const v = String(arg || '').toLowerCase();
    if (v !== 'public' && v !== 'private') {
      return reply(box('🌐 MODE', [
        `Status : *${settings.mode.toUpperCase()}*`,
        'public  : other people use the public commands',
        'private : only you',
        `Usage : *${P()}mode public* or *${P()}mode private*`,
      ]));
    }
    settings.mode = v;
    await saveSettings(authDir, settings);
    return reply(box('🌐 MODE', [
      `Mode : *${v.toUpperCase()}* ✅`,
      v === 'public'
        ? `Open to everyone: ${[...PUBLIC_CMDS].map((c) => P() + c).join(' ')}`
        : 'Only the owner can use the bot.',
    ]));
  }

  /* ───────── access control for other users (public mode) ───────── */
  const guests = new Map(); // sender -> { times: number[], heavyAt: number, warnedAt: number }
  let heavyActive = 0;
  function guestCheck(cmd, sender, now = Date.now()) {
    const name = CMD_ALIASES[cmd] || cmd;
    const known = PUBLIC_CMDS.has(name);
    if (!known) return { status: COMMANDS.has(cmd) || OWNER_ONLY_BASE.has(cmd) ? 'owner_only' : 'ignore' };
    let g = guests.get(sender);
    if (!g) {
      g = { times: [], heavyAt: 0, warnedAt: 0 };
      guests.set(sender, g);
      if (guests.size > 500) for (const [k, v] of guests) if (!v.times.some((t) => now - t < GUEST_WINDOW_MS)) guests.delete(k);
    }
    g.times = g.times.filter((t) => now - t < GUEST_WINDOW_MS);
    const slow = (wait) => {
      const notify = now - g.warnedAt > 15_000;
      if (notify) g.warnedAt = now;
      return { status: 'slow', wait: Math.max(1, Math.ceil(wait / 1000)), notify };
    };
    if (g.times.length >= GUEST_MAX_PER_WINDOW) return slow(GUEST_WINDOW_MS - (now - g.times[0]));
    const heavy = HEAVY_CMDS.has(name);
    if (heavy) {
      if (now - g.heavyAt < GUEST_HEAVY_COOLDOWN_MS) return slow(GUEST_HEAVY_COOLDOWN_MS - (now - g.heavyAt));
      if (heavyActive >= GUEST_MAX_HEAVY_PARALLEL) return { status: 'busy' };
      g.heavyAt = now;
      heavyActive++;
    }
    g.times.push(now);
    let released = !heavy;
    return { status: 'ok', release: () => { if (!released) { released = true; heavyActive--; } } };
  }

  /* ───────── settings ───────── */
  async function toggle(key, name, arg, reply) {
    const i = INFO[key];
    const v = String(arg || '').toLowerCase();
    if (['on', 'true', '1'].includes(v)) settings[key] = true;
    else if (['off', 'false', '0'].includes(v)) settings[key] = false;
    else {
      return reply(box(`${i.emoji} ${i.label}`, [`Status : *${settings[key] ? 'ON' : 'OFF'}*`, i.desc, `Usage : *${P()}${name} on* or *off*`]));
    }
    await saveSettings(authDir, settings);
    try { onSettingChange(key, settings[key]); } catch { /* never block a setting */ }
    return reply(box(`${i.emoji} ${i.label}`, [`Status : *${settings[key] ? 'ON' : 'OFF'}* ✅`]));
  }

  async function setPrefix(arg, reply) {
    if (!arg || arg.length !== 1 || !PREFIX_CHARS.includes(arg)) {
      return reply(box('🔖 PREFIX', [`Current : *${P()}*`, `Choices : ${[...PREFIX_CHARS].join(' ')}`, `Usage : *${P()}setprefix <symbol>*`]));
    }
    settings.prefix = arg;
    await saveSettings(authDir, settings);
    return reply(box('🔖 PREFIX', [`New prefix : *${arg}*`, `Example : *${arg}menu*`, 'Backup : *.setprefix .* always works.']));
  }

  /* ───────── entry points ───────── */
  async function handleCommand({ cmd, args, q, jid, m, content, reply }) {
    const name = CMD_ALIASES[cmd] || ALIASES[cmd] || cmd;
    try {
      // .video <link from any site other than YouTube> → universal downloader
      if (name === 'video' && /https?:\/\/\S+/i.test(q) && !youtubeId(q.match(/https?:\/\/\S+/i)[0])) {
        return await newCmds.handlers.dl({ cmd, args, q, jid, m, content, reply });
      }
      if (Object.hasOwn(newCmds.handlers, name)) return await newCmds.handlers[name]({ cmd, args, q, jid, m, content, reply });
      if (Object.hasOwn(more, name)) return await more[name]({ cmd, args, q, jid, m, content, reply });
      if (name === 'apk') return await apk(q, { reply, jid, m });
      if (name === 'block') return await blockCycles(args, { jid, content, reply });
      if (name === 'unblock') return await unblock({ jid, content, reply });
      if (name === 'save') return await saveStatus({ jid, content, reply, requireStatus: false });
      if (name === 'setprefix') return await setPrefix(args[0], reply);
      if (name === 'mode') return await setMode(args[0], reply);
      if (name === 'pinterest') return await pinterest(q, { reply, jid, m });
      if (name === 'telegram') return await tgStickers(args, { reply, jid, m });
      if (name === 'getid') return await getId({ jid, content, reply });
      if (name === 'idch') return await idCh(q, { reply });
      if (Object.hasOwn(social, name)) return await social[name]({ cmd, args, q, jid, m, content, reply });
      if (Object.hasOwn(contentCmds.handlers, name)) return await contentCmds.handlers[name]({ cmd, args, q, jid, m, content, reply });
      if (name === 'fancy') return await fancy(q, reply);
      if (name === 'channelreact') return await channelBoostCmd(args, { reply });
      if (name === 'autoreact') return await autoReactCmd(args, { reply });
      if (INFO[name]) return await toggle(name, cmd, args[0], reply);
    } catch (e) {
      log('warn', 'wa command failed', { cmd: name, err: String(e?.message || 'error').slice(0, 80) });
      react(jid, m, '❌');
      await reply(box('⚠️ ERROR', [`The command ${P()}${name} failed.`, 'Try again in a moment.'])).catch(() => {});
    }
    return null;
  }

  // Reply "save / send / sendme" to a status (no prefix).
  const saveFromStatus = (a) => saveStatus({ ...a, requireStatus: true });

  const safe = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      log('warn', `wa ${label} failed`, { err: e?.message || 'error' });
    }
  };

  // .autolikestatus: a status is only "liked" once it has been viewed; one like per status; LID / phone ids both given.
  const liked = new Set();
  async function likeStatus(m) {
    const id = m.key.id;
    if (!id || liked.has(id)) return;
    liked.add(id);
    if (liked.size > 500) liked.delete(liked.values().next().value);
    const authors = [m.key.participant, m.key.participantAlt, m.participant].filter(Boolean);
    if (!authors.length) return;
    await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 2500)));
    const list = [...new Set([...authors, ownJid(), sock.user?.lid].filter(Boolean))];
    await sock.sendMessage('status@broadcast', { react: { text: '❤️', key: m.key } }, { statusJidList: list });
  }

  // Messages from OTHER people: only metadata is used (never the content).
  async function onIncoming(m, type) {
    if (!m.key) return;
    const jid = m.key.remoteJid;
    if (!jid) return;
    if (type !== 'notify' && !(jid === 'status@broadcast' && type === 'append')) return;
    if (jid === 'status@broadcast') {
      if (m.key.fromMe) return;
      if (settings.autoviewstatus || settings.autolikestatus) await safe('status view', () => sock.readMessages([m.key]));
      if (settings.autolikestatus) await likeStatus(m);
      return;
    }
    if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
    newCmds.track(m); // ids of the last group messages (for .delete <n>)
    if (settings.autoread) await safe('read', () => sock.readMessages([m.key]));
    if (settings.autoreact !== 'off') await safe('autoreact', () => autoReact(m, jid));
    if (settings.autorecording) await safe('presence', () => sock.sendPresenceUpdate('recording', jid));
    else if (settings.autotyping) await safe('presence', () => sock.sendPresenceUpdate('composing', jid));
  }

  async function onCalls(calls) {
    if (!settings.anticall) return;
    for (const c of calls || []) {
      if (c.status === 'offer' && c.id && c.from) await safe('reject call', () => sock.rejectCall(c.id, c.from));
    }
  }

  async function onGroupUpdate({ id, participants, action }) {
    const wanted = (action === 'add' && settings.welcome) || (action === 'remove' && settings.goodbye);
    if (!wanted) return;
    let subject = 'this group';
    try {
      subject = (await sock.groupMetadata(id))?.subject || subject;
    } catch {
      /* keep the default text */
    }
    for (const p of participants || []) {
      const who = typeof p === 'string' ? p : p?.phoneNumber || p?.id;
      if (!who || isSelf(who)) continue;
      const lines = action === 'add' ? [`Welcome @${num(who)} 🎉`, `To : *${subject}*`] : [`@${num(who)} left the group.`, `Group : *${subject}*`];
      const title = action === 'add' ? '👋 WELCOME' : '🚪 GOODBYE';
      await safe('group message', () => send(id, { text: box(title, lines), mentions: [who] }, null));
    }
  }

  // "1" (audio) or "2" (video) sent after .play
  async function playChoice(text, { jid, m, reply, content, isOwner }) {
    const pick = contentCmds.takePlayChoice(text, jid, m);
    if (!pick) return false;
    let g = null;
    if (!isOwner) {
      g = guestCheck(pick.name, m.key.participant || jid);
      if (g.status !== 'ok') return true; // too many requests: stay silent
    }
    try {
      await more[pick.name]({ cmd: pick.name, args: [], q: pick.video.url, jid, m, content: content || {}, reply });
    } catch (e) {
      log('warn', 'wa play choice failed', { err: String(e?.message || '').slice(0, 60) });
    } finally {
      g?.release?.();
    }
    return true;
  }

  return { settings, has: (cmd) => COMMANDS.has(cmd), guestCheck, boostLink, playChoice, handleCommand, saveFromStatus, onIncoming, onCalls, onGroupUpdate, isSudo: newCmds.isSudo };
}
