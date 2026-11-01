// WhatsApp commands that need the socket: .apk, .unblock, .save, .telegram, settings (.autoread, …).
// Reserved for the owner of the linked account: engine-baileys.js only calls this module for
// messages written BY the owner (other people only get the public commands in public mode).
// Settings are stored in settings.json (the user's session folder, deleted with the session).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { box } from './wa-menu.js';
import { createMore, MORE_ALIASES, MORE_NAMES, isPublicHttps } from './wa-more.js';
import { ffmpegBin, videoToWebp, addStickerMeta } from './media.js';
import { channel, inviteCode, resolveChannel } from './channelBoost.js';
export { isPublicHttps };

const SETTINGS_FILE = 'settings.json';
const PREFIX_CHARS = '.!#+-$~^?&';
const MAX_APK_BYTES = 100 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_STICKERS = 100; // Telegram packs hold up to 120 stickers
const DEFAULT_STICKERS = 20;
const MAX_BANNED_GROUPS = 200;

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
  channelboost: true,
});
const BOOL_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'prefix' && k !== 'mode');

const ALIASES = {
  autorec: 'autorecording', arecording: 'autorecording',
  autotype: 'autotyping', atyping: 'autotyping',
  acall: 'anticall',
  autoviewsview: 'autoviewstatus', avs: 'autoviewstatus', statusseen: 'autoviewstatus', astatus: 'autoviewstatus',
  als: 'autolikestatus',
  boost: 'channelboost', chboost: 'channelboost',
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
  channelboost: { emoji: '📣', label: 'CHANNEL BOOST', desc: 'Follows the NEXORA MD channel and reacts to its new posts.' },
};

const CMD_ALIASES = {
  ytmp4: 'video', vdl: 'video',
  pin: 'pinterest', pindl: 'pinterest',
  tgsticker: 'telegram', tg: 'telegram',
  jid: 'getid', chatid: 'getid', gjid: 'getid', mylid: 'getid',
  channelid: 'idch', chid: 'idch',
  banned: 'bannedgroups', listbanned: 'bannedgroups', unban: 'unbangroup',
  fancytext: 'fancy',
  ...MORE_ALIASES,
};
const COMMANDS = new Set([
  'apk', 'unblock', 'save', 'setprefix', 'mode', 'video', 'pinterest', 'telegram', 'getid', 'idch', 'fancy',
  'bangroup', 'unbangroup', 'bannedgroups',
  ...MORE_NAMES, ...Object.keys(INFO), ...Object.keys(ALIASES), ...Object.keys(CMD_ALIASES),
]);

/* ───────── public mode: what other people may use ───────── */
// Everything else (settings, unblock, save, pair, telegram, getid, mode, bangroup…) stays owner-only.
const PUBLIC_CMDS = new Set(['menu', 'help', 'owner', 'alive', 'ping', 'runtime', 'status', 'apk', 'song', 'video', 'twitter', 'pinterest', 'sticker', 'tourl', 'fancy']);
const HEAVY_CMDS = new Set(['apk', 'song', 'video', 'twitter', 'pinterest', 'sticker', 'tourl']);
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
  const s = { ...DEFAULT_SETTINGS, bannedGroups: [] };
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
    for (const k of BOOL_KEYS) if (typeof raw[k] === 'boolean') s[k] = raw[k];
    if (raw.mode === 'public' || raw.mode === 'private') s.mode = raw.mode;
    if (typeof raw.prefix === 'string' && raw.prefix.length === 1 && PREFIX_CHARS.includes(raw.prefix)) s.prefix = raw.prefix;
    if (Array.isArray(raw.bannedGroups)) {
      s.bannedGroups = [...new Set(raw.bannedGroups.filter((g) => typeof g === 'string' && /^[\w-]+@g\.us$/.test(g)))].slice(0, MAX_BANNED_GROUPS);
    }
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

  /* ───────── .pinterest ───────── */
  async function pinterest(q, { reply, jid, m }) {
    if (!q) return reply(box('📌 PINTEREST', [`Usage : *${P()}pinterest <link>*`, 'pinterest.com or pin.it link']));
    let host = '';
    try {
      host = new URL(q.trim()).hostname.toLowerCase();
    } catch {
      /* invalid link */
    }
    if (!/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/.test(host)) return reply(box('❌ PINTEREST', ['Invalid link: use a pinterest.com or pin.it link.']));
    react(jid, m, '⏳');
    const data = await getJson(`https://jawad-tech.vercel.app/download/pinterest?url=${encodeURIComponent(q.trim())}`);
    const r = data?.result;
    if (!data?.status || !r?.url || !isPublicHttps(r.url)) {
      react(jid, m, '❌');
      return reply(box('❌ PINTEREST', ['Could not fetch this media.', 'Check the link and try again.']));
    }
    if ((await remoteSize(r.url)) > MAX_MEDIA_BYTES) return reply(box('❌ PINTEREST', ['File too big (max 100 MB).']));
    const isVideo = r.type === 'video' || /\.mp4(\?|$)/i.test(r.url);
    const caption = box('📌 PINTEREST', [`Title : *${String(r.title || '—').slice(0, 80)}*`, `Type  : *${isVideo ? 'Video' : 'Image'}*`]);
    await send(jid, isVideo ? { video: { url: r.url }, mimetype: 'video/mp4', caption } : { image: { url: r.url }, caption }, m, true);
    react(jid, m, '✅');
  }

  /* ───────── .telegram <link> <pack name> <amount> : Telegram sticker pack → WhatsApp stickers ───────── */
  let tgBusy = false;
  async function tgStickers(args, { reply, jid, m }) {
    const pack = (args[0] || '').match(TG_LINK)?.[1];
    if (!pack) {
      return reply(box('📦 TELEGRAM STICKERS', [
        `Usage : *${P()}telegram <link> <pack name> <amount>*`,
        `Example : *${P()}telegram https://t.me/addstickers/PackName orange 50*`,
        `Amount : 1 to ${MAX_STICKERS} (default ${DEFAULT_STICKERS})`,
        'Static and video stickers are supported.',
      ]));
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return reply(box('❌ STICKERS', ['TELEGRAM_BOT_TOKEN is missing on the server.']));
    if (tgBusy) return reply(box('⏳ STICKERS', ['A pack is already being sent.']));

    const rest = args.slice(1);
    let want = null;
    if (rest.length && /^\d{1,3}$/.test(rest[rest.length - 1])) want = Math.min(MAX_STICKERS, Math.max(1, Number(rest.pop())));
    const label = rest.join(' ').trim().slice(0, 40) || brandName();

    tgBusy = true;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stk-'));
    try {
      const set = await getJson(`https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(pack)}`);
      const all = set?.result?.stickers;
      if (!set?.ok || !Array.isArray(all) || !all.length) return reply(box('❌ STICKERS', ['Pack not found.']));
      const list = all.slice(0, want ?? Math.min(DEFAULT_STICKERS, all.length));
      await reply(box('📦 TELEGRAM STICKERS', [`Stickers : *${list.length}* (pack has ${all.length})`, `Pack name : *${label}*`, 'Sending…']));

      let ffmpegOk = null;
      let ok = 0;
      let failed = 0;
      let animated = 0;
      for (const [i, st] of list.entries()) {
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
          buf = await addStickerMeta(buf, { pack: label, author: brandOwner(), emoji: st.emoji || '🤖' });
          await send(jid, { sticker: buf }, m, true);
          ok++;
        } catch (e) {
          failed++;
          log('warn', 'wa sticker failed', { why: String(e?.message || 'error').slice(0, 60) });
        }
        await new Promise((r) => setTimeout(r, 900));
      }
      await reply(box(ok ? '✅ STICKERS' : '❌ STICKERS', [
        `Sent   : *${ok}/${list.length}*`,
        `Failed : *${failed}*`,
        animated ? `Animated .tgs stickers cannot be converted (${animated} skipped).` : failed ? 'Some stickers could not be converted.' : 'Done!',
      ]));
    } finally {
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

  /* ───────── .bangroup / .unbangroup / .bannedgroups ───────── */
  const isGroupBanned = (jid) => settings.bannedGroups.includes(jid);
  async function setBan(ban, args, { jid, reply }) {
    const arg = String(args[0] || '');
    const target = /^[\w-]+@g\.us$/.test(arg) ? arg : jid;
    const title = ban ? '🚫 BAN GROUP' : '✅ UNBAN GROUP';
    if (!target.endsWith('@g.us')) {
      return reply(box(title, [`Use *${P()}${ban ? 'bangroup' : 'unbangroup'}* inside a group,`, `or give a group ID: *${P()}${ban ? 'bangroup' : 'unbangroup'} 1203…@g.us*`, `Find IDs with *${P()}getid*`]));
    }
    const has = settings.bannedGroups.includes(target);
    if (ban) {
      if (has) return reply(box(title, ['This group is already banned.', `Unban it with *${P()}unbangroup*`]));
      if (settings.bannedGroups.length >= MAX_BANNED_GROUPS) return reply(box('❌ BAN GROUP', [`Limit reached (${MAX_BANNED_GROUPS} groups).`]));
      settings.bannedGroups.push(target);
    } else {
      if (!has) return reply(box(title, ['This group is not banned.']));
      settings.bannedGroups = settings.bannedGroups.filter((g) => g !== target);
    }
    await saveSettings(authDir, settings);
    return reply(box(title, ban
      ? ['Group banned ✅', 'The bot is now silent there for everyone.', `Unban with *${P()}unbangroup*`]
      : ['Group unbanned ✅', 'The bot answers there again.']));
  }

  async function bannedGroups({ reply }) {
    const list = settings.bannedGroups;
    if (!list.length) return reply(box('🚫 BANNED GROUPS', ['No banned group.']));
    const lines = [];
    for (const g of list.slice(0, 20)) {
      let name = '';
      try {
        name = (await sock.groupMetadata(g))?.subject || '';
      } catch {
        /* the bot may have left the group */
      }
      lines.push(`${name ? `${name.slice(0, 30)} ` : ''}\`${g}\``);
    }
    if (list.length > 20) lines.push(`…and ${list.length - 20} more`);
    return reply(box('🚫 BANNED GROUPS', [`Total : *${list.length}*`, ...lines]));
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
      if (Object.hasOwn(more, name)) return await more[name]({ cmd, args, q, jid, m, content, reply });
      if (name === 'apk') return await apk(q, { reply, jid, m });
      if (name === 'unblock') return await unblock({ jid, content, reply });
      if (name === 'save') return await saveStatus({ jid, content, reply, requireStatus: false });
      if (name === 'setprefix') return await setPrefix(args[0], reply);
      if (name === 'mode') return await setMode(args[0], reply);
      if (name === 'pinterest') return await pinterest(q, { reply, jid, m });
      if (name === 'telegram') return await tgStickers(args, { reply, jid, m });
      if (name === 'getid') return await getId({ jid, content, reply });
      if (name === 'idch') return await idCh(q, { reply });
      if (name === 'bangroup') return await setBan(true, args, { jid, reply });
      if (name === 'unbangroup') return await setBan(false, args, { jid, reply });
      if (name === 'bannedgroups') return await bannedGroups({ reply });
      if (name === 'fancy') return await fancy(q, reply);
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

  // Messages from OTHER people: only metadata is used (never the content).
  async function onIncoming(m, type) {
    if (type !== 'notify' || !m.key) return;
    const jid = m.key.remoteJid;
    if (!jid) return;
    if (jid === 'status@broadcast') {
      if (settings.autoviewstatus) await safe('status view', () => sock.readMessages([m.key]));
      if (settings.autolikestatus && m.key.participant) {
        await safe('status like', () =>
          sock.sendMessage('status@broadcast', { react: { text: '❤️', key: m.key } }, { statusJidList: [m.key.participant, ownJid()].filter(Boolean) }),
        );
      }
      return;
    }
    if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
    if (settings.autoread) await safe('read', () => sock.readMessages([m.key]));
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
    if (isGroupBanned(id)) return;
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

  return { settings, has: (cmd) => COMMANDS.has(cmd), isGroupBanned, guestCheck, handleCommand, saveFromStatus, onIncoming, onCalls, onGroupUpdate };
}
