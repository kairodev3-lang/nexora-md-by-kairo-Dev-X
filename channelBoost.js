// channelBoost.js — two automatic reaction systems (no command to turn them on):
//
// 1) BRAND CHANNEL (internal): every connected session follows the NEXORA MD channel and, for each new post,
//    the sessions share the work: a random target of 34, 40 or 70 reactions (hard cap 90), each with a DIFFERENT emoji.
//
// 2) .channelreact : a user gives THEIR channel link; for 5 days every connected session (that has .channelreact ON)
//    reacts to each new post of that channel with 10 different emojis spread over the sessions, and also reacts to the
//    10 latest posts when the campaign starts (so each connected person is worth 10 reactions). Then it stops by itself.
//    WhatsApp keeps ONE reaction per account per message, so one account cannot add 10 reactions to the same post.

const BOOST_DAYS = 5;
export const BOOST_MS = BOOST_DAYS * 24 * 3600 * 1000;
const EMOJI_COUNT = 10; // different emojis per campaign
const MAX_CAMPAIGNS = 20; // channels boosted at the same time
const TARGETS = [34, 40, 70];
const MAX_REACTIONS = 90;
const BACKFILL_POSTS = 10;
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
  for (const refresh of refreshers) refresh(campaign); // sessions follow the new channel and react to its latest posts
  return { ok: true, campaign: { ...campaign } };
}

/* ───────── .autofollowers : 10 connected accounts follow a user's channel ───────── */
const FOLLOWERS = 10;
const FOLLOW_COOLDOWN_MS = 24 * 3600 * 1000; // one request per user per day (anti-spam)
const liveSessions = new Map(); // sessionId -> { socket, isEnabled, given }
const followCooldown = new Map(); // ownerId -> timestamp

/**
 * 10 other connected sessions (least used first, random among equals) follow the channel behind `link`.
 * Accounts that turned .channelreact OFF are never used.
 * @returns {Promise<{ok:true,name:string,url:string,asked:number,done:number}|{ok:false,reason:string,waitMs?:number}>}
 */
export async function autoFollowers(sock, link, ownerId, log = () => {}) {
  const id = String(ownerId);
  const code = inviteCode(link);
  if (!code) return { ok: false, reason: 'invalid_link' };
  const last = followCooldown.get(id) || 0;
  if (Date.now() - last < FOLLOW_COOLDOWN_MS) return { ok: false, reason: 'cooldown', waitMs: FOLLOW_COOLDOWN_MS - (Date.now() - last) };
  let meta;
  try {
    meta = await sock.newsletterMetadata('invite', code);
  } catch {
    meta = null;
  }
  if (!meta?.id || !String(meta.id).endsWith('@newsletter')) return { ok: false, reason: 'not_found' };

  const pool = shuffle([...liveSessions.entries()].filter(([sid, x]) => sid !== id && (typeof x.isEnabled !== 'function' || x.isEnabled())));
  pool.sort((a, b) => a[1].given - b[1].given); // stable: random order among equal counts
  const chosen = pool.slice(0, FOLLOWERS);
  if (!chosen.length) return { ok: false, reason: 'no_sessions' };

  followCooldown.set(id, Date.now());
  let done = 0;
  for (const [, x] of chosen) {
    await new Promise((res) => setTimeout(res, 1000 + Math.floor(Math.random() * 2000)));
    try {
      await x.socket.newsletterFollow(meta.id);
      x.given++;
      done++;
    } catch (e) {
      log('warn', 'autofollowers: follow failed', { why: String(e?.message || '').slice(0, 50) });
    }
  }
  if (!done) followCooldown.delete(id); // nothing happened: allow a retry
  return { ok: true, name: String(meta.name || meta.thread_metadata?.name?.text || '').slice(0, 80), url: `https://whatsapp.com/channel/${code}`, asked: chosen.length, done };
}

export function stopBoost(ownerId) {
  const had = campaigns.delete(String(ownerId));
  if (had) saveState().catch(() => {});
  return had;
}

const posts = new Map(); // "jid:serverId" -> state (campaign channels)
const brandPosts = new Map(); // "jid:serverId" -> state (brand channel)
const MAX_TRACKED = 300;
const trim = (map) => { if (map.size > MAX_TRACKED) map.delete(map.keys().next().value); };
const postId = (message) => message?.key?.server_id || message?.newsletterServerId || message?.newsletter_server_id;
const fresh = (message) => {
  const ts = tsOf(message);
  return !ts || Date.now() / 1000 - ts <= MAX_POST_AGE_SEC;
};

/** Brand channel: sessions share the work, random target (34 / 40 / 70), a different emoji per reaction. */
function handleBrandPost(socket, message, log) {
  const serverId = postId(message);
  if (!serverId || !fresh(message)) return;
  const key = `${channel.jid}:${serverId}`;
  let st = brandPosts.get(key);
  if (!st) {
    st = { target: Math.min(MAX_REACTIONS, pick(TARGETS), EMOJIS.length), claimed: 0, emojis: shuffle(EMOJIS), sessions: new Set() };
    brandPosts.set(key, st);
    trim(brandPosts);
  }
  const me = sessionId(socket);
  if (st.sessions.has(me)) return;
  st.sessions.add(me);
  if (st.claimed >= st.target) return;
  const slot = st.claimed++;
  const emoji = st.emojis[slot];
  const timer = setTimeout(async () => {
    try {
      await socket.newsletterReactMessage(channel.jid, String(serverId), emoji);
    } catch (e) {
      log('warn', 'channel reaction failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }, slot * 120 + Math.floor(Math.random() * 1500));
  timer.unref?.();
}

/** Campaign channel (.channelreact): every enabled session reacts once, emojis spread over the 10 of the campaign. */
export function handlePost(socket, message, jid, isEnabled, log = () => {}) {
  sweep();
  const c = byJid().get(jid);
  if (!c) return;
  const serverId = postId(message);
  if (!serverId || !fresh(message)) return;
  const key = `${jid}:${serverId}`;
  let st = posts.get(key);
  if (!st) {
    st = { claimed: 0, emojis: shuffle(c.emojis), sessions: new Set() };
    posts.set(key, st);
    trim(posts);
  }
  const me = sessionId(socket);
  if (st.sessions.has(me)) return; // one reaction per session per post
  st.sessions.add(me);
  if (typeof isEnabled === 'function' && !isEnabled()) return;

  const slot = st.claimed++;
  const emoji = st.emojis[slot % st.emojis.length];
  const timer = setTimeout(async () => {
    if (Date.now() >= c.until) return;
    try {
      await socket.newsletterReactMessage(jid, String(serverId), emoji);
    } catch (e) {
      log('warn', 'channel react failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }, Math.min(slot * 150, 40_000) + Math.floor(Math.random() * 1500));
  timer.unref?.();
}

/** Latest post ids of a channel. Baileys changed the signature between versions, so both are tried. */
async function latestPostIds(socket, jid, count, log) {
  if (typeof socket.newsletterFetchMessages !== 'function') return [];
  const calls = [
    () => socket.newsletterFetchMessages(jid, count), // newer: (jid, count, since?, after?)
    () => socket.newsletterFetchMessages('jid', jid, count), // older: (type, key, count, after?)
  ];
  for (const call of calls) {
    try {
      const raw = await call();
      const list = Array.isArray(raw) ? raw : raw?.messages || raw?.result || [];
      const ids = [...new Set(list.map((x) => x?.server_id ?? x?.serverId ?? x?.id ?? x?.key?.server_id).filter((x) => x != null && /^\d+$/.test(String(x))).map(String))];
      if (ids.length) return ids.slice(0, count);
    } catch (e) {
      log('warn', 'channel react: fetching latest posts failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }
  return [];
}

/**
 * This session reacts to the latest posts of a campaign channel (up to 10, one different emoji each).
 * It needs no other session: one account = one reaction per post, so 10 reactions = the 10 latest posts.
 * @returns {Promise<{sent:number, posts:number}>}
 */
export async function reactLatest(socket, c, log = () => {}) {
  const ids = await latestPostIds(socket, c.jid, BACKFILL_POSTS, log);
  const offset = Math.floor(Math.random() * c.emojis.length);
  let sent = 0;
  for (const [i, id] of ids.entries()) {
    if (Date.now() >= c.until) break;
    if (i) await new Promise((r) => setTimeout(r, 1200 + Math.floor(Math.random() * 1300)));
    try {
      await socket.newsletterReactMessage(c.jid, id, c.emojis[(i + offset) % c.emojis.length]);
      sent++;
    } catch (e) {
      log('warn', 'channel react (latest post) failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }
  return { sent, posts: ids.length };
}

/**
 * Attaches the reactions to one socket: brand channel (always) + campaign channels (when isEnabled()).
 * Returns dispose() — call it when the socket is closed.
 */
export function attachChannelBoost(socket, { isEnabled, log = () => {}, stateFile: file } = {}) {
  let timer = null;
  let disposed = false;
  const ready = file ? loadState(file) : Promise.resolve();
  const enabled = () => typeof isEnabled !== 'function' || isEnabled();

  const onUpsert = ({ messages }) => {
    if (disposed) return;
    for (const message of messages || []) {
      const jid = message?.key?.remoteJid;
      if (!jid || !String(jid).endsWith('@newsletter')) continue;
      try {
        if (jid === channel.jid) handleBrandPost(socket, message, log);
        else handlePost(socket, message, jid, isEnabled, log);
      } catch (e) {
        log('warn', 'channel reaction error', { err: String(e?.message || e).slice(0, 60) });
      }
    }
  };

  // Follow the channels (needed to react) and keep live updates flowing.
  const followed = new Set();
  const follow = async (jid) => {
    if (!followed.has(jid) && typeof socket.newsletterFollow === 'function') {
      try { await socket.newsletterFollow(jid); } catch { /* already following */ }
      followed.add(jid);
    }
    if (typeof socket.subscribeNewsletterUpdates === 'function') {
      try { await socket.subscribeNewsletterUpdates(jid); } catch { /* retried on the next tick */ }
    }
  };
  const subscribe = async () => {
    if (disposed) return;
    await ready;
    await resolveChannel(socket);
    await follow(channel.jid); // brand channel: every connected session joins it automatically
    if (!enabled()) return;
    for (const c of activeCampaigns()) await follow(c.jid);
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

  const refresh = (campaign) => {
    subscribe()
      .then(() => (campaign && enabled() && campaign.ownerId !== sessionId(socket) ? reactLatest(socket, campaign, log) : undefined))
      .catch(() => {});
  };
  refreshers.add(refresh);
  liveSessions.set(sessionId(socket), { socket, isEnabled, given: liveSessions.get(sessionId(socket))?.given || 0 });
  socket.ev.on('messages.upsert', onUpsert);
  socket.ev.on('connection.update', onConn);

  return {
    refresh,
    dispose() {
      disposed = true;
      clearInterval(timer);
      refreshers.delete(refresh);
      liveSessions.delete(sessionId(socket));
      try {
        socket.ev.off('messages.upsert', onUpsert);
        socket.ev.off('connection.update', onConn);
      } catch { /* socket already gone */ }
    },
  };
}
