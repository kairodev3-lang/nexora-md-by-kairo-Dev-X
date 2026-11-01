// channelBoost.js — every user can get reactions on their own WhatsApp channel.
//
// A user turns .channelboost ON and gives their channel link. For 5 days, each new post of that channel
// receives 10 reactions (10 different emojis) from 10 other connected sessions that have the boost ON,
// then the campaign stops by itself. A user can change their channel link at any time (the old campaign is replaced).
// WhatsApp keeps ONE reaction per account per message, so the 10 reactions come from 10 different accounts.

const BOOST_DAYS = 5;
export const BOOST_MS = BOOST_DAYS * 24 * 3600 * 1000;
const EMOJI_COUNT = 10; // reactions (and emojis) per post
const MAX_CAMPAIGNS = 20; // channels boosted at the same time
const MAX_POST_AGE_SEC = 10 * 60; // never react to old posts replayed after a restart

export const EMOJIS = [...new Set([
  '❤️', '🔥', '👏', '😍', '💯', '🙏', '⚡', '😂', '😎', '🤩',
  '🥰', '😘', '😇', '🤗', '🤭', '😏', '😌', '🤤', '😴', '🥳',
  '🤯', '😱', '😭', '😢', '🥺', '😡', '🤬', '🤡', '👻', '💀',
  '👽', '🤖', '🎃', '😈', '👑', '💎', '🌟', '✨', '💫', '🌈',
  '☀️', '🌙', '🌸', '🌺', '🌹', '🌻', '🍀', '🍓', '🍒', '🍉',
  '🍕', '🍔', '🍟', '🍩', '🍫', '☕', '🎉', '🎊', '🎁', '🎈',
  '🎵', '🎶', '🎧', '🎮', '⚽', '🏆', '🥇', '🚀', '✈️', '🌍',
  '💪', '👍', '👌', '✌️', '🤞', '🤝', '🙌', '👀', '🧠', '💡',
  '💥', '💢', '💦', '🫶', '🫡', '🫂', '🤎', '💜', '💙', '💚',
  '💛', '🧡', '🖤', '🤍', '💖', '💝', '💕', '😹', '🩸', '🦋',
])];

/** The NEXORA MD channel. The JID is verified from the invite link once a session is online. */
export const channel = {
  jid: process.env.CHANNEL_JID || '120363409975095814@newsletter',
  name: process.env.CHANNEL_NAME || 'NEXORA MD',
  url: process.env.CHANNEL_URL || 'https://whatsapp.com/channel/0029VbDmi1g77qVOA4cfRq13',
  resolved: Boolean(process.env.CHANNEL_JID),
};
export const inviteCode = (url = channel.url) => String(url).match(/whatsapp\.com\/channel\/([\w-]+)/i)?.[1] || null;

let resolving = null;
/** Looks up the real channel JID from the invite link (skipped when CHANNEL_JID is set). */
export async function resolveChannel(sock) {
  if (channel.resolved || typeof sock?.newsletterMetadata !== 'function') return channel;
  if (!resolving) {
    resolving = (async () => {
      try {
        const code = inviteCode();
        const meta = code ? await sock.newsletterMetadata('invite', code) : null;
        if (meta?.id && String(meta.id).endsWith('@newsletter')) {
          channel.jid = meta.id;
          if (meta.name) channel.name = meta.name;
          channel.resolved = true;
        }
      } catch {
        /* keep the configured JID */
      } finally {
        resolving = null;
      }
    })();
  }
  await resolving;
  return channel;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sessionId = (socket) => String(socket?.user?.id || 'unknown').split(':')[0].split('@')[0];

const tsOf = (m) => {
  const t = m?.messageTimestamp;
  if (t == null) return 0;
  return typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
};


/* ───────── campaigns (shared by all sessions of this process) ───────── */
const pickEmojis = () => shuffle(EMOJIS).slice(0, EMOJI_COUNT);

/** ownerId (phone number of the session that asked) -> { ownerId, jid, name, url, emojis, until } */
const campaigns = new Map();
const byJid = () => new Map([...campaigns.values()].map((c) => [c.jid, c]));

function sweep() {
  for (const [id, c] of campaigns) if (Date.now() >= c.until) campaigns.delete(id);
}
export const activeCampaigns = () => {
  sweep();
  return [...campaigns.values()];
};
export const campaignOf = (ownerId) => {
  sweep();
  return campaigns.get(String(ownerId)) || null;
};

const refreshers = new Set();
let stateFile = null;
let stateLoaded = false;

async function loadState(file) {
  if (stateLoaded) return;
  stateLoaded = true;
  stateFile = file;
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    for (const c of Array.isArray(raw) ? raw : []) {
      if (typeof c?.jid !== 'string' || !c.jid.endsWith('@newsletter') || !c.ownerId) continue;
      campaigns.set(String(c.ownerId), {
        ownerId: String(c.ownerId),
        jid: c.jid,
        name: String(c.name || '').slice(0, 80),
        url: String(c.url || '').slice(0, 200),
        emojis: Array.isArray(c.emojis) && c.emojis.length === EMOJI_COUNT ? c.emojis.map(String) : pickEmojis(),
        until: Number(c.until) || 0,
      });
    }
    sweep();
  } catch {
    /* no campaign saved yet */
  }
}

async function saveState() {
  if (!stateFile) return;
  try {
    const { writeFile, rename } = await import('node:fs/promises');
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify([...campaigns.values()]), { mode: 0o600 });
    await rename(tmp, stateFile);
  } catch {
    /* the campaigns still run in memory */
  }
}

/**
 * Starts (or replaces) the campaign of `ownerId` on the channel behind `link`.
 * @returns {Promise<{ok:true, campaign:object}|{ok:false, reason:'invalid_link'|'not_found'|'full'}>}
 */
export async function startBoost(sock, link, ownerId) {
  const id = String(ownerId);
  const code = inviteCode(link);
  if (!code) return { ok: false, reason: 'invalid_link' };
  let meta;
  try {
    meta = await sock.newsletterMetadata('invite', code);
  } catch {
    meta = null;
  }
  if (!meta?.id || !String(meta.id).endsWith('@newsletter')) return { ok: false, reason: 'not_found' };
  sweep();
  if (!campaigns.has(id) && campaigns.size >= MAX_CAMPAIGNS) return { ok: false, reason: 'full' };
  const campaign = {
    ownerId: id,
    jid: meta.id,
    name: String(meta.name || meta.thread_metadata?.name?.text || '').slice(0, 80),
    url: `https://whatsapp.com/channel/${code}`,
    emojis: pickEmojis(),
    until: Date.now() + BOOST_MS,
  };
  campaigns.set(id, campaign); // replaces the previous channel of this user
  await saveState();
  for (const refresh of refreshers) refresh(); // sessions follow the new channel
  return { ok: true, campaign: { ...campaign } };
}

export function stopBoost(ownerId) {
  const had = campaigns.delete(String(ownerId));
  if (had) saveState().catch(() => {});
  return had;
}

const posts = new Map(); // "jid:serverId" -> state
const MAX_TRACKED = 300;

export function handlePost(socket, message, jid, isEnabled, log = () => {}) {
  sweep();
  const c = byJid().get(jid);
  if (!c) return;
  const me = sessionId(socket);
  if (me === c.ownerId) return; // the channel's owner does not react to their own posts
  const serverId = message?.key?.server_id || message?.newsletterServerId || message?.newsletter_server_id;
  if (!serverId) return;
  const ts = tsOf(message);
  if (ts && Date.now() / 1000 - ts > MAX_POST_AGE_SEC) return;

  const key = `${jid}:${serverId}`;
  let st = posts.get(key);
  if (!st) {
    st = { claimed: 0, emojis: shuffle(c.emojis), sessions: new Set() };
    posts.set(key, st);
    if (posts.size > MAX_TRACKED) posts.delete(posts.keys().next().value);
  }
  if (st.sessions.has(me)) return; // one reaction per session per post
  st.sessions.add(me);

  if (typeof isEnabled === 'function' && !isEnabled()) return;

  // random delay: the 10 reactions of a post come from different, randomly chosen sessions
  const wait = 500 + Math.floor(Math.random() * 6000);
  const timer = setTimeout(async () => {
    if (st.claimed >= EMOJI_COUNT || Date.now() >= c.until) return;
    const emoji = st.emojis[st.claimed++];
    try {
      await socket.newsletterReactMessage(jid, String(serverId), emoji);
    } catch (e) {
      log('warn', 'channel boost reaction failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }, wait);
  timer.unref?.();
}

/**
 * Attaches the booster to one socket: reacts to posts + keeps the live-updates subscriptions alive.
 * Returns dispose() — call it when the socket is closed.
 */
export function attachChannelBoost(socket, { isEnabled, log = () => {}, stateFile: file } = {}) {
  let timer = null;
  let disposed = false;
  const ready = file ? loadState(file) : Promise.resolve();

  const onUpsert = ({ messages }) => {
    if (disposed) return;
    for (const message of messages || []) {
      const jid = message?.key?.remoteJid;
      if (!jid || !String(jid).endsWith('@newsletter')) continue;
      try {
        handlePost(socket, message, jid, isEnabled, log);
      } catch (e) {
        log('warn', 'channel boost error', { err: String(e?.message || e).slice(0, 60) });
      }
    }
  };

  // Follow the boosted channels (needed to react) and keep live updates flowing.
  const followed = new Set();
  const subscribe = async () => {
    if (disposed) return;
    await ready;
    if (typeof isEnabled === 'function' && !isEnabled()) return;
    for (const c of activeCampaigns()) {
      if (c.ownerId === sessionId(socket)) continue;
      if (!followed.has(c.jid) && typeof socket.newsletterFollow === 'function') {
        try { await socket.newsletterFollow(c.jid); } catch { /* already following */ }
        followed.add(c.jid);
      }
      if (typeof socket.subscribeNewsletterUpdates === 'function') {
        try { await socket.subscribeNewsletterUpdates(c.jid); } catch { /* retried on the next tick */ }
      }
    }
  };

  const onConn = ({ connection }) => {
    if (connection === 'open') {
      subscribe().catch(() => {});
      clearInterval(timer);
      timer = setInterval(() => subscribe().catch(() => {}), 4 * 60 * 1000);
      timer.unref?.();
    }
    if (connection === 'close') clearInterval(timer);
  };

  const refresh = () => subscribe().catch(() => {});
  refreshers.add(refresh);
  socket.ev.on('messages.upsert', onUpsert);
  socket.ev.on('connection.update', onConn);

  return {
    refresh,
    dispose() {
      disposed = true;
      clearInterval(timer);
      refreshers.delete(refresh);
      try {
        socket.ev.off('messages.upsert', onUpsert);
        socket.ev.off('connection.update', onConn);
      } catch { /* socket already gone */ }
    },
  };
}
