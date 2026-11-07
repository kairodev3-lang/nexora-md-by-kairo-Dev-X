// channelBoost.js — two automatic reaction systems (no command to turn them on):
//
// 1) BRAND CHANNEL (internal): every connected session follows the NEXORA MD channel and, for each new post,
//    the sessions share the work: a random target of 34, 40 or 70 reactions (hard cap 90), each with a DIFFERENT emoji.
//
// 2) .channelreact : a user gives THEIR channel link. Immediately, up to 20 other connected accounts follow the channel
//    and react to its latest post (20 reactions, 10 different emojis). The same 20-reaction round is repeated every day for
//    5 days, and each new post gets up to 20 reactions. Then the campaign stops by itself.
//    WhatsApp keeps ONE reaction per account per message, so the 20 reactions come from 20 different accounts.
//    If the user is the only one connected, their own account reacts to the 10 latest posts.

const BOOST_DAYS = 5;
export const BOOST_MS = BOOST_DAYS * 24 * 3600 * 1000;
const EMOJI_COUNT = 10; // different emojis per campaign
const MAX_CAMPAIGNS = 20; // channels boosted at the same time
const BOOST_SIZE = 20; // accounts used per round (followers and reactions)
const REACTS_PER_POST = 20; // max reactions on one new post
const ROUND_MS = 24 * 3600 * 1000; // one round per day
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
        nextRound: Number(c.nextRound) || 0,
        members: Array.isArray(c.members) ? c.members.map(String).slice(0, BOOST_SIZE) : [],
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
    nextRound: Date.now() + ROUND_MS,
    members: [], // the (up to) 20 accounts that follow this channel and react to its posts: set by giveBoost
  };
  campaigns.set(id, campaign); // replaces the previous channel of this user
  await saveState();
  for (const refresh of refreshers) refresh(); // sessions subscribe to the new channel
  return { ok: true, campaign: { ...campaign } };
}

/* ───────── rounds: 20 accounts follow + react (at the start, then every day) ───────── */
const liveSessions = new Map(); // sessionId -> { socket, isEnabled, given }
const followCooldown = new Map(); // ownerId -> timestamp (free followers: once a day per user)
const reactedOn = new Map(); // "jid:postId" -> Set(sessionId) that already reacted
const FOLLOW_COOLDOWN_MS = ROUND_MS;

/** Other connected accounts (never the owner, never accounts with .channelreact OFF), least used first. */
function pickSessions(ownerId, exclude = new Set(), n = BOOST_SIZE) {
  const pool = shuffle(
    [...liveSessions.entries()].filter(([sid, x]) => sid !== String(ownerId) && !exclude.has(sid) && (typeof x.isEnabled !== 'function' || x.isEnabled())),
  );
  pool.sort((a, b) => a[1].given - b[1].given); // stable: random order among equal counts
  return pool.slice(0, n);
}

const pause = (min, spread) => new Promise((res) => setTimeout(res, min + Math.floor(Math.random() * spread)));

async function followWith(list, jid, log) {
  let done = 0;
  for (const [, x] of list) {
    await pause(800, 1500);
    try {
      await x.socket.newsletterFollow(jid);
      x.given++;
      done++;
    } catch (e) {
      log('warn', 'channel follow failed', { why: String(e?.message || '').slice(0, 50) });
    }
  }
  return done;
}

async function reactWith(list, jid, post, emojis, log) {
  const key = `${jid}:${post}`;
  const seen = reactedOn.get(key) || new Set();
  reactedOn.set(key, seen);
  if (reactedOn.size > 300) reactedOn.delete(reactedOn.keys().next().value);
  let sent = 0;
  for (const [i, [sid, x]] of list.entries()) {
    await pause(700, 1300);
    try {
      await x.socket.newsletterReactMessage(jid, String(post), emojis[i % emojis.length]);
      seen.add(sid);
      sent++;
    } catch (e) {
      log('warn', 'channel react failed', { why: String(e?.message || '').slice(0, 50) });
    }
  }
  return sent;
}

/**
 * First round of a campaign: up to 20 other accounts follow the channel (free followers, once a day per user)
 * and react to its latest post. When nobody else is connected, the owner's own account reacts to the 10 latest posts.
 * @returns {Promise<{pool:number, followers:number, followersSkipped:boolean, reacts:number}>}
 */
export async function giveBoost(sock, campaign, log = () => {}) {
  const c = campaigns.get(String(campaign.ownerId)) || campaign; // the stored campaign (members, nextRound)
  const pool = pickSessions(c.ownerId);
  if (!pool.length) {
    try { await sock.newsletterFollow?.(c.jid); } catch { /* already following */ }
    const res = await reactLatest(sock, c, log);
    return { pool: 0, followers: 0, followersSkipped: false, reacts: res.sent };
  }
  c.members = pool.map(([sid]) => sid);
  let followers = 0;
  const followersSkipped = Date.now() - (followCooldown.get(c.ownerId) || 0) < FOLLOW_COOLDOWN_MS;
  if (!followersSkipped) {
    followCooldown.set(c.ownerId, Date.now());
    followers = await followWith(pool, c.jid, log);
    if (!followers) followCooldown.delete(c.ownerId); // nothing happened: allow a retry
  }
  let ids = await latestPostIds(sock, c.jid, 1, log);
  if (!ids.length) ids = await latestPostIds(pool[0][1].socket, c.jid, 1, log);
  const reacts = ids.length ? await reactWith(pool, c.jid, ids[0], c.emojis, log) : 0;
  c.nextRound = Date.now() + ROUND_MS;
  await saveState();
  for (const refresh of refreshers) refresh(); // members subscribe to the live updates of the channel
  return { pool: pool.length, followers, followersSkipped, reacts };
}

/** Daily round: the members that did not react yet react to the latest post of the channel (a new post gets it too). */
async function dailyRound(c, log) {
  c.nextRound = Date.now() + ROUND_MS;
  await saveState();
  const members = new Set(c.members || []);
  const live = pickSessions(c.ownerId, new Set(), BOOST_SIZE * 5).filter(([sid]) => members.has(sid));
  if (!live.length) return;
  const ids = await latestPostIds(live[0][1].socket, c.jid, 1, log);
  if (!ids.length) return;
  const done = reactedOn.get(`${c.jid}:${ids[0]}`) || new Set();
  const todo = live.filter(([sid]) => !done.has(sid));
  if (todo.length) await reactWith(todo, c.jid, ids[0], c.emojis, log);
}

let ticker = null;
function startTicker(log) {
  if (ticker) return;
  ticker = setInterval(async () => {
    sweep();
    for (const c of campaigns.values()) {
      if (!c.nextRound || Date.now() < c.nextRound || c.busy) continue;
      c.busy = true;
      try {
        await dailyRound(c, log);
      } catch (e) {
        log('warn', 'channel daily round failed', { why: String(e?.message || '').slice(0, 50) });
      } finally {
        c.busy = false;
      }
    }
  }, 30 * 60 * 1000);
  ticker.unref?.();
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
  if (me === c.ownerId || !c.members?.includes(me) || st.claimed >= REACTS_PER_POST) return; // the owner does not react to their own posts; max 20 per post

  const slot = st.claimed++;
  const emoji = st.emojis[slot % st.emojis.length];
  const timer = setTimeout(async () => {
    if (Date.now() >= c.until) return;
    try {
      await socket.newsletterReactMessage(jid, String(serverId), emoji);
      const k = `${jid}:${serverId}`;
      if (!reactedOn.has(k)) reactedOn.set(k, new Set());
      reactedOn.get(k).add(me);
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
    for (const c of activeCampaigns()) if (c.members?.includes(sessionId(socket))) await follow(c.jid);
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

  const refresh = () => {
    subscribe().catch(() => {});
  };
  startTicker(log);
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
