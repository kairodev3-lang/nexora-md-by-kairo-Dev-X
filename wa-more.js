// Commandes supplémentaires : sticker, play, video, twitter, tourl, vv/vv2, kick, kickall, tagall,
// ping, alive, owner, help. Chargé par wa-extras.js. Liste fermée : aucune commande dynamique.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { box, COMMAND_COUNT, signature } from './wa-menu.js';

export const MORE_ALIASES = {
  s: 'sticker', stiker: 'sticker',
  song: 'play', music: 'play', ytmp3: 'play',
  ytmp4: 'video', vdl: 'video',
  twdl: 'twitter', x: 'twitter',
  url: 'tourl', upload: 'tourl',
  vv: 'viewonce', readvo: 'viewonce',
  k: 'kick',
  everyone: 'tagall',
};
export const MORE_NAMES = ['sticker', 'play', 'video', 'twitter', 'tourl', 'viewonce', 'vv2', 'kick', 'kickall', 'tagall', 'ping', 'alive', 'owner', 'help'];

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 30 * 60;

// Les liens renvoyés par des API tierces ne sont jamais suivis s'ils pointent vers un réseau interne.
export const isPublicHttps = (u) => {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h.startsWith('[')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
    }
    return true;
  } catch {
    return false;
  }
};

const toNum = (v) => (v == null ? 0 : typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v));
const jnum = (id) => String(id || '').split('@')[0].split(':')[0];
const execFileP = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout: 60_000, ...opts }, (err) => (err ? reject(err) : resolve())));
const fmtUp = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
};
const cleanTitle = (t, n = 100) => String(t || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Identifiant YouTube d'un lien, ou null (seuls youtube.com / youtu.be sont acceptés). */
export const youtubeId = (s) => {
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (h === 'youtube.com') return u.searchParams.get('v') || u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1] || null;
  } catch {
    /* pas un lien */
  }
  return null;
};

export function createMore({ sock, send, log, helpers, fetchImpl, P, ownJid, settings, assets = {} }) {
  const { downloadMediaMessage, normalizeMessageContent } = helpers;
  const norm = (x) => (normalizeMessageContent ? normalizeMessageContent(x) : null) || x;
  const brand = () => ({
    bot: process.env.BOT_NAME || 'NEXORA MD',
    owner: process.env.OWNER_NAME || 'KAIRO',
    number: String(process.env.OWNER_NUMBER || '+50939360237').replace(/\D/g, ''),
    channel: process.env.CHANNEL_URL || 'https://whatsapp.com/channel/0029VbDmi1g77qVOA4cfRq13',
  });
  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});
  const getJson = async (url, ms = 30_000) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
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
  const dl = (msgLike) => downloadMediaMessage(msgLike, 'buffer', {}, { logger: helpers.logger, reuploadRequest: sock.updateMediaMessage });

  /** Trouve un média dans le message lui-même ou dans le message cité. */
  function findMedia({ jid, m, content }, kinds) {
    const pick = (c) => {
      for (const k of kinds) if (c?.[`${k}Message`]) return [k, c[`${k}Message`]];
      return null;
    };
    const direct = pick(content);
    if (direct) return { kind: direct[0], node: direct[1], msgLike: m };
    const ci = content?.extendedTextMessage?.contextInfo;
    if (!ci?.quotedMessage) return null;
    const q = norm(ci.quotedMessage);
    const hit = pick(q);
    if (!hit) return null;
    return {
      kind: hit[0],
      node: hit[1],
      msgLike: { key: { remoteJid: jid, id: ci.stanzaId, participant: ci.participant, fromMe: false }, message: q },
    };
  }

  /* ───────── .ping ───────── */
  async function ping({ jid, m }) {
    const t0 = Date.now();
    const sent = await sock.sendMessage(jid, { text: '🏓 ᴘɪɴɢɪɴɢ…' }, { quoted: m });
    const ms = Date.now() - t0;
    const text = box('🏓 *PONG*', [`Vitesse : *${ms} ms*`, `En ligne : *${fmtUp(process.uptime())}*`, `Bot : *${brand().bot}*`]);
    if (sent?.key) await sock.sendMessage(jid, { text, edit: sent.key }).catch(() => send(jid, text, m));
    else await send(jid, text, m);
  }

  /* ───────── .alive ───────── */
  async function alive({ jid, m }) {
    const b = brand();
    const text = [
      `╭━━━⟦ *${b.bot}* ⟧━━━╮`,
      '┃ ▸ Status   : *Online* 🟢',
      `┃ ▸ Owner    : *${b.owner}*`,
      `┃ ▸ Prefix   : *${P()}*`,
      `┃ ▸ Mode     : *${String(settings.mode).toUpperCase()}*`,
      `┃ ▸ Commands : *${COMMAND_COUNT}*`,
      `┃ ▸ Uptime   : *${fmtUp(process.uptime())}*`,
      '╰━━━━━━━━━━━━━━━━━━╯',
      '',
      `> ${b.bot} est actif et prêt ⚡`,
      '',
      signature({ ownerName: b.owner }),
    ].join('\n');
    if (assets.menuImage) await send(jid, { image: assets.menuImage, caption: text }, m, true);
    else await send(jid, text, m);
  }

  /* ───────── .owner : carte de contact ───────── */
  async function owner({ jid, m }) {
    const b = brand();
    const name = `${b.owner} DEV`;
    const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `ORG:${b.bot};`, `TEL;type=CELL;type=VOICE;waid=${b.number}:+${b.number}`, 'END:VCARD'].join('\n');
    await send(jid, { contacts: { displayName: name, contacts: [{ vcard }] } }, m, true);
  }

  /* ───────── .help ───────── */
  async function help({ jid, m }) {
    const b = brand();
    const text = [
      `╭━━━⟦ *${b.bot} · HELP* ⟧━━━╮`,
      `┃ ▸ Tapez *${P()}menu* pour toutes les commandes`,
      `┃ ▸ Préfixe : *${P()}*`,
      `┃ ▸ Exemple : *${P()}play perfect ed sheeran*`,
      '╰━━━━━━━━━━━━━━━━━━╯',
      '',
      `> Répondez avec *${P()}menu* pour explorer toutes les fonctions ✨`,
    ].join('\n');
    const ad = {
      title: `✦ ${b.bot} HELP CENTER ✦`,
      body: 'Touchez pour ouvrir la chaîne',
      sourceUrl: b.channel,
      mediaType: 1,
      renderLargerThumbnail: true,
      ...(assets.menuImage ? { thumbnail: assets.menuImage } : {}),
    };
    await send(jid, { text, contextInfo: { externalAdReply: ad } }, m, true);
  }

  /* ───────── .sticker (image / vidéo → sticker) ───────── */
  async function addExif(buf) {
    try {
      const mod = await import('node-webpmux');
      const webp = mod.default || mod;
      const img = new webp.Image();
      await img.load(buf);
      const meta = { 'sticker-pack-id': crypto.randomBytes(16).toString('hex'), 'sticker-pack-name': brand().bot, 'sticker-pack-publisher': brand().owner, emojis: ['🤖'] };
      const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
      const json = Buffer.from(JSON.stringify(meta), 'utf8');
      const exif = Buffer.concat([head, json]);
      exif.writeUIntLE(json.length, 14, 4);
      img.exif = exif;
      return await img.save(null);
    } catch {
      return buf; // module absent : le sticker part sans nom de pack
    }
  }
  async function sticker({ jid, m, content, reply }) {
    const found = findMedia({ jid, m, content }, ['image', 'video']);
    if (!found) return reply(box('🎨 *STICKER*', [`Répondez à une image ou une vidéo avec *${P()}s*`, 'Vidéo : 8 secondes maximum.']));
    if (toNum(found.node.fileLength) > MAX_UPLOAD_BYTES) return reply(box('❌ *STICKER*', ['Fichier trop gros (max 50 MB).']));
    if (!(await execFileP('ffmpeg', ['-version'], { timeout: 5000 }).then(() => true, () => false))) {
      return reply(box('❌ *STICKER*', ['ffmpeg n\'est pas installé sur le serveur.']));
    }
    react(jid, m, '⏳');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stk-'));
    try {
      const buf = await dl(found.msgLike);
      const inP = path.join(tmp, found.kind === 'image' ? 'in.jpg' : 'in.mp4');
      const outP = path.join(tmp, 'out.webp');
      await fs.writeFile(inP, buf);
      const fit = 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0';
      if (found.kind === 'image') {
        await execFileP('ffmpeg', ['-y', '-i', inP, '-vf', fit, '-c:v', 'libwebp', '-q:v', '70', '-frames:v', '1', outP]);
      } else {
        for (const q of ['60', '40', '25']) {
          await execFileP('ffmpeg', ['-y', '-t', '8', '-i', inP, '-vf', `fps=15,${fit}`, '-c:v', 'libwebp', '-loop', '0', '-an', '-q:v', q, outP]);
          if ((await fs.stat(outP)).size <= 900 * 1024) break;
        }
      }
      await send(jid, { sticker: await addExif(await fs.readFile(outP)) }, m, true);
      react(jid, m, '✅');
    } finally {
      fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* ───────── .play / .video (YouTube, plusieurs serveurs en secours) ───────── */
  const enc = encodeURIComponent;
  const servers = (url, kind) =>
    kind === 'video'
      ? [
          async () => { const d = await getJson(`https://eliteprotech-apis.zone.id/ytdown?url=${enc(url)}&format=mp4`); return d?.success && d.downloadURL ? { url: d.downloadURL, title: d.title } : null; },
          async () => { const d = await getJson(`https://api.yupra.my.id/api/downloader/ytmp4?url=${enc(url)}`); return d?.success && d.data?.download_url ? { url: d.data.download_url, title: d.data.title, thumb: d.data.thumbnail } : null; },
          async () => { const d = await getJson(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${enc(url)}`); return d?.result?.mp4 ? { url: d.result.mp4, title: d.result.title } : null; },
        ]
      : [
          async () => { const d = await getJson(`https://eliteprotech-apis.zone.id/ytdown?url=${enc(url)}&format=mp3`); return d?.success && d.downloadURL ? { url: d.downloadURL, title: d.title } : null; },
          async () => { const d = await getJson(`https://api.yupra.my.id/api/downloader/ytmp3?url=${enc(url)}`); return d?.success && d.data?.download_url ? { url: d.data.download_url, title: d.data.title, thumb: d.data.thumbnail } : null; },
          async () => { const d = await getJson(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${enc(url)}`); return d?.result?.mp3 ? { url: d.result.mp3, title: d.result.title } : null; },
        ];
  async function viaServers(url, kind) {
    for (const [i, run] of servers(url, kind).entries()) {
      try {
        const r = await run();
        if (r?.url && isPublicHttps(r.url)) return r;
      } catch (e) {
        log('warn', 'wa download server failed', { kind, server: i, why: String(e?.message || '').slice(0, 40) });
      }
    }
    return null;
  }
  async function youtube(kind, q, { jid, m, reply }) {
    const label = kind === 'video' ? '🎬 *VIDEO*' : '🎵 *PLAY*';
    if (!q) return reply(box(label, [`Usage : *${P()}${kind === 'video' ? 'video' : 'play'} <nom ou lien YouTube>*`, `Exemple : *${P()}${kind === 'video' ? 'video' : 'play'} perfect ed sheeran*`]));
    let yts;
    try {
      const mod = await import('yt-search');
      yts = mod.default || mod;
    } catch {
      return reply(box('❌ *YOUTUBE*', ['Module yt-search non installé sur le serveur.']));
    }
    react(jid, m, '🔍');
    let v;
    if (/^https?:\/\//i.test(q.trim())) {
      const id = youtubeId(q.trim());
      if (!id) return reply(box('❌ *YOUTUBE*', ['Lien invalide : seuls les liens YouTube sont acceptés.']));
      v = await yts({ videoId: id }).catch(() => null);
      v = v || { url: `https://youtube.com/watch?v=${id}`, title: '' };
    } else {
      v = (await yts(q)).videos?.[0];
    }
    if (!v) {
      react(jid, m, '❌');
      return reply(box('❌ *YOUTUBE*', ['Aucun résultat.']));
    }
    if (toNum(v.seconds) > MAX_VIDEO_SECONDS) return reply(box('❌ *YOUTUBE*', ['Contenu trop long (max 30 minutes).']));
    react(jid, m, '⏳');
    const r = await viaServers(v.url, kind);
    if (!r) {
      react(jid, m, '❌');
      return reply(box('❌ *YOUTUBE*', ['Tous les serveurs sont indisponibles.', 'Réessayez plus tard.']));
    }
    if ((await remoteSize(r.url)) > (kind === 'video' ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES)) {
      return reply(box('❌ *YOUTUBE*', ['Fichier trop gros pour WhatsApp.']));
    }
    const title = String(r.title || v.title || 'YouTube').slice(0, 100);
    const thumb = [r.thumb, v.thumbnail, v.image].find((x) => x && isPublicHttps(x));
    if (kind === 'video') {
      await send(jid, {
        video: { url: r.url },
        mimetype: 'video/mp4',
        fileName: `${cleanTitle(title)}.mp4`,
        caption: box('🎬 *VIDEO*', [`Titre : *${title}*`, `Durée : *${v.timestamp || '—'}*`, `Bot   : *${brand().bot}*`]),
      }, m, true);
    } else {
      await send(jid, {
        audio: { url: r.url },
        mimetype: 'audio/mpeg',
        fileName: `${cleanTitle(title)}.mp3`,
        contextInfo: {
          externalAdReply: { title, body: `${brand().bot} MUSIC`, ...(thumb ? { thumbnailUrl: thumb } : {}), sourceUrl: v.url, mediaType: 1, renderLargerThumbnail: true },
        },
      }, m, true);
    }
    react(jid, m, '✅');
  }

  /* ───────── .twitter / .x ───────── */
  const TW_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com', 'fxtwitter.com', 'vxtwitter.com']);
  async function twitter(q, { jid, m, reply }) {
    let host = '';
    try {
      host = new URL(String(q).trim()).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      /* pas un lien */
    }
    if (!TW_HOSTS.has(host)) return reply(box('🐦 *X / TWITTER*', [`Usage : *${P()}twitter <lien>*`, `Exemple : *${P()}x https://x.com/...*`]));
    react(jid, m, '🐦');
    const d = await getJson(`https://apis.davidcyriltech.my.id/download/twitter?url=${enc(q.trim())}`);
    const r = d?.result;
    if (!r?.video_url || !isPublicHttps(r.video_url)) {
      react(jid, m, '❌');
      return reply(box('❌ *X / TWITTER*', ['Aucune vidéo trouvée (publication privée ou sans vidéo).']));
    }
    if ((await remoteSize(r.video_url)) > MAX_VIDEO_BYTES) return reply(box('❌ *X / TWITTER*', ['Vidéo trop grosse (max 100 MB).']));
    await send(jid, { video: { url: r.video_url }, caption: box('🐦 *X DOWNLOADER*', ['Téléchargé ✅', `Texte : ${String(r.description || '—').slice(0, 150)}`]) }, m, true);
    react(jid, m, '✅');
  }

  /* ───────── .tourl ───────── */
  const EXT = { image: 'jpg', video: 'mp4', audio: 'mp3' };
  async function tourl({ jid, m, content, reply }) {
    const found = findMedia({ jid, m, content }, ['image', 'video', 'audio', 'document']);
    if (!found) return reply(box('🔗 *TOURL*', [`Répondez à une image, vidéo ou audio avec *${P()}tourl*`]));
    if (toNum(found.node.fileLength) > MAX_UPLOAD_BYTES) return reply(box('❌ *TOURL*', ['Fichier trop gros (max 50 MB).']));
    react(jid, m, '⏳');
    const buf = await dl(found.msgLike);
    let ext = EXT[found.kind] || String(found.node.fileName || '').split('.').pop().toLowerCase();
    if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = 'bin';
    const fd = new FormData();
    fd.append('file', new Blob([buf]), `file.${ext}`);
    const res = await fetchImpl('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(90_000) });
    const j = await res.json();
    const raw = j?.data?.url;
    const u = raw ? new URL(raw) : null;
    if (!u || !/(^|\.)tmpfiles\.org$/.test(u.hostname)) throw new Error('upload');
    const link = `https://tmpfiles.org/dl/${u.pathname.replace(/^\/(dl\/)?/, '')}`;
    await reply(box('🔗 *UPLOADER*', ['Envoi réussi ✅', `Lien : ${link}`, 'Lien temporaire (quelques heures).']));
    react(jid, m, '✅');
  }

  /* ───────── .viewonce (.vv) / .vv2 ───────── */
  async function viewonce(toDm, { jid, m, content, reply }) {
    const ci = content?.extendedTextMessage?.contextInfo;
    if (!ci?.quotedMessage) return reply(box('👁️ *VIEW ONCE*', [`Répondez à un média avec *${P()}${toDm ? 'vv2' : 'vv'}*`, toDm ? 'Le média est envoyé dans votre DM.' : 'Le média est renvoyé ici.']));
    const found = findMedia({ jid, m, content: { extendedTextMessage: { contextInfo: ci } } }, ['image', 'video', 'audio']);
    if (!found) return reply(box('❌ *VIEW ONCE*', ['Aucune photo, vidéo ou audio dans ce message.']));
    if (toNum(found.node.fileLength) > MAX_DOWNLOAD_BYTES) return reply(box('❌ *VIEW ONCE*', ['Média trop gros (max 64 MB).']));
    react(jid, m, '⏳');
    const buf = await dl(found.msgLike);
    const cap = box('👁️ *VIEW ONCE*', ['Média récupéré ✅', `Bot : *${brand().bot}*`]);
    const payload =
      found.kind === 'image' ? { image: buf, caption: cap }
        : found.kind === 'video' ? { video: buf, caption: cap, mimetype: 'video/mp4' }
          : { audio: buf, mimetype: found.node.mimetype || 'audio/mpeg', ptt: Boolean(found.node.ptt) };
    const target = toDm ? ownJid() : jid;
    if (!target) return reply(box('❌ *VIEW ONCE*', ['Numéro du bot introuvable.']));
    await send(target, payload, toDm ? null : m, true);
    react(jid, m, '✅');
  }

  /* ───────── commandes de groupe ───────── */
  const isAdminP = (p) => p.admin === 'admin' || p.admin === 'superadmin';
  const selfNums = () => new Set([jnum(sock.user?.id), jnum(sock.user?.lid)].filter(Boolean));
  async function groupInfo(jid) {
    const meta = await sock.groupMetadata(jid);
    const me = selfNums();
    const isMe = (p) => [p.id, p.jid, p.phoneNumber, p.lid].some((x) => x && me.has(jnum(x)));
    return { meta, me, isMe, botAdmin: meta.participants.some((p) => isAdminP(p) && isMe(p)) };
  }
  const needGroup = (jid, reply) => (jid.endsWith('@g.us') ? false : reply(box('❌ *GROUPE*', ['Cette commande fonctionne seulement dans un groupe.'])));

  async function kick({ jid, m, args, content, reply }) {
    if (jid && !jid.endsWith('@g.us')) return needGroup(jid, reply);
    const ci = content?.extendedTextMessage?.contextInfo;
    const digits = String(args[0] || '').replace(/\D/g, '');
    const target = ci?.mentionedJid?.[0] || ci?.participant || (digits.length >= 8 ? `${digits}@s.whatsapp.net` : null);
    if (!target) return reply(box('👢 *KICK*', ['Répondez à un message, mentionnez quelqu\'un', `ou donnez un numéro. Exemple : *${P()}kick @user*`]));
    const { botAdmin, me } = await groupInfo(jid);
    if (!botAdmin) return reply(box('❌ *KICK*', ['Vous devez être admin du groupe.']));
    if (me.has(jnum(target))) return reply(box('❌ *KICK*', ['Vous ne pouvez pas vous retirer vous-même.']));
    const res = await sock.groupParticipantsUpdate(jid, [target], 'remove');
    const ok = String(res?.[0]?.status || '200') === '200';
    if (!ok) return reply(box('❌ *KICK*', [`Échec (code ${res?.[0]?.status}). La personne est admin ou n'est plus dans le groupe.`]));
    await sock.sendMessage(jid, { text: box('👢 *USER REMOVED*', [`Cible : @${jnum(target)}`]), mentions: [target] }, { quoted: m });
    sock.sendMessage(jid, { delete: m.key }).catch(() => {});
  }

  async function kickall({ jid, args, reply }) {
    if (!jid.endsWith('@g.us')) return needGroup(jid, reply);
    const { meta, botAdmin, isMe } = await groupInfo(jid);
    if (!botAdmin) return reply(box('❌ *KICKALL*', ['Vous devez être admin du groupe.']));
    const targets = meta.participants.filter((p) => !isAdminP(p) && !isMe(p)).map((p) => p.id);
    if (!targets.length) return reply(box('ℹ️ *KICKALL*', ['Aucun membre non-admin à retirer.']));
    if (String(args[0] || '').toLowerCase() !== 'confirm') {
      return reply(box('⚠️ *KICKALL*', [`Cela retire ${targets.length} membre(s) non-admin.`, 'Action irréversible.', `Confirmez : *${P()}kickall confirm*`]));
    }
    await reply(box('⏳ *KICKALL*', [`Retrait de ${targets.length} membre(s)…`]));
    let done = 0;
    for (let i = 0; i < targets.length; i += 10) {
      const res = await sock.groupParticipantsUpdate(jid, targets.slice(i, i + 10), 'remove').catch(() => []);
      done += (res || []).filter((r) => String(r.status) === '200').length;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await reply(box('✅ *KICKALL*', [`Retirés : *${done}/${targets.length}*`]));
  }

  async function tagall({ jid, m, q, reply }) {
    if (!jid.endsWith('@g.us')) return needGroup(jid, reply);
    react(jid, m, '📢');
    const meta = await sock.groupMetadata(jid);
    const ids = meta.participants.map((p) => p.id);
    for (let i = 0; i < ids.length; i += 60) {
      const part = ids.slice(i, i + 60);
      const head = i === 0 ? `╭━━━⟦ *ANNOUNCEMENT* ⟧━━━╮\n┃ ▸ Groupe  : ${meta.subject}\n┃ ▸ Membres : ${ids.length}${q ? `\n┃ ▸ Message : ${q.slice(0, 200)}` : ''}\n╰━━━━━━━━━━━━━━━━━━╯\n\n` : '';
      const text = `${head}${part.map((id) => `│ ✧ @${jnum(id)}`).join('\n')}${i + 60 >= ids.length ? `\n\n${signature({ ownerName: brand().owner })}` : ''}`;
      await sock.sendMessage(jid, { text, mentions: part }, i === 0 ? { quoted: m } : undefined);
      if (i + 60 < ids.length) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  return {
    ping, alive, owner, help, sticker, tourl, kick, kickall, tagall,
    play: (c) => youtube('audio', c.q, c),
    video: (c) => youtube('video', c.q, c),
    twitter: (c) => twitter(c.q, c),
    viewonce: (c) => viewonce(false, c),
    vv2: (c) => viewonce(true, c),
  };
}
