// channelBoost.js — two automatic reaction systems (no command to turn them on):
//
// 1) BRAND CHANNEL (internal): every connected session follows the NEXORA MD channel and, for each new post,
//    the sessions share the work: a random target of 34, 40 or 70 reactions (hard cap 90), each with a DIFFERENT emoji.
//
// 2) .channelreact : a user gives THEIR channel link; ONE burst of 10 reactions is sent right away (10 different emojis
//    on the 10 latest posts of that channel). No automatic reactions afterwards.
//    Limits (per user): 1 channel per day, and the SAME channel link can only be redone after 30 minutes.
//    WhatsApp keeps ONE reaction per account per message, so one account cannot add 10 reactions to the same post.

const EMOJI_COUNT = 10; // different emojis per campaign
const DAY_MS = 24 * 3600 * 1000;
const DAILY_CHANNELS = 1; // new channels a user can boost per day (24h window)
export const SAME_LINK_COOLDOWN_MS = 30 * 60 * 1000; // wait before redoing the same channel link
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


/* ───────── burst limits (shared by all sessions of this process) ───────── */
const pickEmojis = () => shuffle(EMOJIS).slice(0, EMOJI_COUNT);

/** ownerId -> { windowStart, links: { [channelJid]: lastBurstAt } } */
const usage = new Map();

function currentUsage(id, now = Date.now()) {
  const rec = usage.get(id);
  if (rec && now - rec.windowStart >= DAY_MS) usage.delete(id); // new day window
  return usage.get(id) || null;
}

/** What this user already used today: { channels, windowEnd } or null. */
export function boostStatus(ownerId) {
  const rec = currentUsage(String(ownerId));
  if (!rec) return null;
  return { channels: Object.keys(rec.links).length, windowEnd: rec.windowStart + DAY_MS, links: { ...rec.links } };
}

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
    for (const [id, rec] of Object.entries(raw?.usage || {})) {
      if (!rec || !Number(rec.windowStart) || typeof rec.links !== 'object') continue;
      usage.set(String(id), { windowStart: Number(rec.windowStart), links: { ...rec.links } });
    }
  } catch {
    /* nothing saved yet */
  }
}

async function saveState() {
  if (!stateFile) return;
  try {
    const { writeFile, rename } = await import('node:fs/promises');
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ usage: Object.fromEntries(usage) }), { mode: 0o600 });
    await rename(tmp, stateFile);
  } catch {
    /* limits still work in memory */
  }
}

/**
 * Checks the limits and reserves one burst of 10 reactions for `ownerId` on the channel behind `link`.
 * @returns {Promise<{ok:true, campaign:object}|{ok:false, reason:'invalid_link'|'not_found'|'cooldown'|'daily', waitMs?:number}>}
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

  const now = Date.now();
  const rec = currentUsage(id, now);
  const last = rec?.links[meta.id];
  if (last && now - last < SAME_LINK_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', waitMs: last + SAME_LINK_COOLDOWN_MS - now };
  }
  if (rec && last == null && Object.keys(rec.links).length >= DAILY_CHANNELS) {
    return { ok: false, reason: 'daily', waitMs: rec.windowStart + DAY_MS - now };
  }
  const entry = rec || { windowStart: now, links: {} };
  const prevAt = last ?? null;
  entry.links[meta.id] = now;
  usage.set(id, entry);
  await saveState();

  const campaign = {
    ownerId: id,
    jid: meta.id,
    name: String(meta.name || meta.thread_metadata?.name?.text || '').slice(0, 80),
    url: `https://whatsapp.com/channel/${code}`,
    emojis: pickEmojis(),
    prevAt,
  };
  for (const refresh of refreshers) refresh(campaign); // the other connected sessions follow the channel and react too
  return { ok: true, campaign: { ...campaign } };
}

/** Gives the burst back when nothing could be sent (so a failed try does not use up the day). */
export async function releaseBoost(ownerId, jid, prevAt = null) {
  const rec = usage.get(String(ownerId));
  if (!rec) return;
  if (prevAt) rec.links[jid] = prevAt;
  else delete rec.links[jid];
  if (!Object.keys(rec.links).length) usage.delete(String(ownerId));
  await saveState();
}

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
 * This session reacts to the latest posts of a channel (up to 10, one different emoji each).
 * It needs no other session: one account = one reaction per post, so 10 reactions = the 10 latest posts.
 * @returns {Promise<{sent:number, posts:number}>}
 */
export async function reactLatest(socket, c, log = () => {}) {
  const ids = await latestPostIds(socket, c.jid, BACKFILL_POSTS, log);
  const offset = Math.floor(Math.random() * c.emojis.length);
  let sent = 0;
  for (const [i, id] of ids.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 500)));
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
 * Attaches the reactions to one socket: brand channel (always) + the one-time bursts of .channelreact (when isEnabled()).
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
      .then(async () => {
        if (!campaign || !enabled() || campaign.ownerId === sessionId(socket)) return undefined;
        await follow(campaign.jid);
        return reactLatest(socket, campaign, log);
      })
      .catch(() => {});
  };
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
