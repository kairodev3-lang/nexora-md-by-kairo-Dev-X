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
  resolved: true, // the JID above is used as it is (an old invite link can never redirect the reactions to another channel)
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

const isOnline = (x) => {
  try {
    return Boolean(x.open && x.socket?.user && !x.socket.ws?.isClosed && !x.socket.ws?.isClosing);
  } catch {
    return Boolean(x.open);
  }
};

/** Other connected accounts (never the owner, never accounts with .channelreact OFF, only sockets that are really online), least used first. */
function pickSessions(ownerId, exclude = new Set(), n = BOOST_SIZE) {
  const pool = shuffle(
    [...liveSessions.entries()].filter(([sid, x]) => sid !== String(ownerId) && !exclude.has(sid) && isOnline(x) && (typeof x.isEnabled !== 'function' || x.isEnabled())),
  );
  pool.sort((a, b) => a[1].given - b[1].given); // stable: random order among equal counts
  return pool.slice(0, n);
}

const pause = (min, spread) => new Promise((res) => setTimeout(res, min + Math.floor(Math.random() * spread)));

let lastError = '';
export const lastBoostError = () => lastError;
const noteErr = (where, why) => { lastError = `${where}: ${String(why).slice(0, 90)}`; };

const ALREADY = /already|exist|conflict|409|subscribed|follow(ing|ed)/i;

async function followWith(list, jid, log) {
  let done = 0;
  for (const [, x] of list) {
    await pause(800, 1500);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await x.socket.newsletterFollow(jid);
        x.given++;
        done++;
        break;
      } catch (e) {
        const why = String(e?.message || e?.output?.payload?.message || e || '').slice(0, 80);
        if (ALREADY.test(why)) { done++; break; } // that account already follows the channel
        noteErr('follow', why);
        log('warn', 'channel follow failed', { why, attempt });
        if (attempt === 0) await pause(1500, 1500);
      }
    }
    try { await x.socket.subscribeNewsletterUpdates?.(jid); } catch { /* live updates are optional */ }
  }
  return done;
}

/** An account that just followed a channel needs a moment, and a metadata call, before WhatsApp lets it react. */
async function prepareReact(x, jid) {
  try { await x.socket.newsletterMetadata?.('jid', jid); } catch { /* optional */ }
  try { await x.socket.subscribeNewsletterUpdates?.(jid); } catch { /* optional */ }
}

async function reactWith(list, jid, post, emojis, log) {
  const key = `${jid}:${post}`;
  const seen = reactedOn.get(key) || new Set();
  reactedOn.set(key, seen);
  if (reactedOn.size > 300) reactedOn.delete(reactedOn.keys().next().value);
  let sent = 0;
  for (const [i, [sid, x]] of list.entries()) {
    await pause(700, 1300);
    await prepareReact(x, jid);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await reactSafe(x.socket, jid, post, emojis[i % emojis.length]);
        seen.add(sid);
        sent++;
        break;
      } catch (e) {
        noteErr('react', e?.message || e);
        log('warn', 'channel react failed', { why: String(e?.message || e || '').slice(0, 80), attempt });
        if (attempt < 2) await pause(2500, 2000);
      }
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
  await pause(4000, 1500); // let the follows settle before asking for the posts
  try { await sock.newsletterFollow?.(c.jid); } catch { /* already following */ }
  let ids = await latestPostIds(sock, c.jid, 1, log);
  for (let k = 0; !ids.length && k < Math.min(3, pool.length); k++) ids = await latestPostIds(pool[k][1].socket, c.jid, 1, log);
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
  const bt = setInterval(() => brandTick(log), 3 * 60 * 1000);
  bt.unref?.();
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

// Brand channel: EVERY connected session (with .channelreact ON) reacts once to each of the 5 latest posts.
// 100 sessions connected = 100 reactions under every post, automatically. A new session also catches up on the 5 latest posts.
const BRAND_POSTS = 5;
const BRAND_MAX_PER_TICK = 400;
const brandSeen = new Map(); // "jid:serverId" -> Set(sessionId) that reacted
let brandFile = null;
let brandBusy = false;

async function loadBrand(file) {
  brandFile = file.replace(/[^/\\]*$/, '_brandreact.json');
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(brandFile, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) if (Array.isArray(v)) brandSeen.set(k, new Set(v.map(String)));
  } catch {
    /* nothing saved yet */
  }
}

async function saveBrand() {
  if (!brandFile) return;
  try {
    const { writeFile, rename } = await import('node:fs/promises');
    const keys = [...brandSeen.keys()].slice(-12);
    const out = Object.fromEntries(keys.map((k) => [k, [...brandSeen.get(k)]]));
    const tmp = `${brandFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
    await rename(tmp, brandFile);
  } catch {
    /* kept in memory */
  }
}

async function brandTick(log) {
  if (brandBusy) return;
  brandBusy = true;
  try {
    const online = shuffle([...liveSessions.entries()].filter(([, x]) => isOnline(x) && (typeof x.isEnabled !== 'function' || x.isEnabled())));
    if (!online.length) return;
    let ids = [];
    for (const [, x] of online.slice(0, 6)) {
      try { await x.socket.newsletterFollow?.(channel.jid); } catch { /* already following */ }
      ids = await latestPostIds(x.socket, channel.jid, BRAND_POSTS, log);
      if (ids.length) break;
    }
    if (!ids.length) {
      log('warn', 'brand channel: no post found', { why: lastError });
      return;
    }
    let sent = 0;
    for (const post of ids) {
      const key = `${channel.jid}:${post}`;
      const seen = brandSeen.get(key) || new Set();
      brandSeen.set(key, seen);
      const emojis = shuffle(EMOJIS);
      let i = 0;
      for (const [sid, x] of online) {
        if (seen.has(sid)) continue;
        if (sent >= BRAND_MAX_PER_TICK) break;
        if (!x.followedBrand) {
          try { await x.socket.newsletterFollow(channel.jid); } catch { /* already following */ }
          x.followedBrand = true;
        }
        try {
          await reactSafe(x.socket, channel.jid, post, emojis[i++ % emojis.length]);
          seen.add(sid);
          sent++;
        } catch (e) {
          noteErr('brand react', e?.message || e);
          log('warn', 'brand reaction failed', { err: String(e?.message || e).slice(0, 80) });
        }
        await pause(250, 500);
      }
    }
    if (sent) {
      log('info', 'brand reactions sent', { sent, sessions: online.length });
      await saveBrand();
    }
  } catch (e) {
    log('warn', 'brand tick failed', { err: String(e?.message || e).slice(0, 80) });
  } finally {
    brandBusy = false;
  }
}

/** Live post on the brand channel: this session reacts after a random delay (the tick above catches whatever is missed). */
function handleBrandPost(socket, message, log) {
  const serverId = postId(message);
  if (!serverId || !fresh(message)) return;
  const key = `${channel.jid}:${serverId}`;
  const seen = brandSeen.get(key) || new Set();
  brandSeen.set(key, seen);
  const me = sessionId(socket);
  if (seen.has(me)) return;
  seen.add(me);
  const emoji = pick(EMOJIS);
  const timer = setTimeout(async () => {
    try {
      await reactSafe(socket, channel.jid, serverId, emoji);
      saveBrand().catch(() => {});
    } catch (e) {
      seen.delete(me); // the next tick tries again
      log('warn', 'channel reaction failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }, Math.floor(Math.random() * 45_000));
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
      await reactSafe(socket, jid, serverId, emoji);
      const k = `${jid}:${serverId}`;
      if (!reactedOn.has(k)) reactedOn.set(k, new Set());
      reactedOn.get(k).add(me);
    } catch (e) {
      log('warn', 'channel react failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }, Math.min(slot * 150, 40_000) + Math.floor(Math.random() * 1500));
  timer.unref?.();
}

const BASIC_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** Reacts with the wanted emoji; some channels only allow the basic set, so a second try uses one of those. */
async function reactSafe(socket, jid, post, emoji) {
  try {
    await socket.newsletterReactMessage(jid, String(post), emoji);
  } catch (e) {
    if (BASIC_EMOJIS.includes(emoji)) throw e;
    await socket.newsletterReactMessage(jid, String(post), pick(BASIC_EMOJIS));
  }
}

/** Post ids seen live on a channel (sessions subscribed to it receive every new post): last-resort source for the ids. */
const knownPosts = new Map(); // jid -> [serverId, ...] newest last
const rememberPost = (jid, id) => {
  if (!id) return;
  const arr = knownPosts.get(jid) || [];
  if (!arr.includes(String(id))) arr.push(String(id));
  while (arr.length > 20) arr.shift();
  knownPosts.set(jid, arr);
  if (knownPosts.size > 100) knownPosts.delete(knownPosts.keys().next().value);
};

const collectServerIds = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (node.attrs?.server_id && /^\d+$/.test(String(node.attrs.server_id))) out.push(String(node.attrs.server_id));
  if (Array.isArray(node.content)) for (const c of node.content) collectServerIds(c, out);
  return out;
};

/** Last resort: asks WhatsApp directly (the three known query shapes) and reads every server_id of the answer. */
async function rawFetchIds(socket, jid, count) {
  if (typeof socket.query !== 'function') return [];
  const id = () => `nx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const shapes = [
    { to: 's.whatsapp.net', content: [{ tag: 'messages', attrs: { type: 'jid', jid, count: String(count) } }] },
    { to: jid, content: [{ tag: 'message_updates', attrs: { count: String(count) } }] },
    { to: jid, content: [{ tag: 'messages', attrs: { count: String(count) } }] },
  ];
  for (const sh of shapes) {
    try {
      const res = await socket.query({ tag: 'iq', attrs: { id: id(), type: 'get', xmlns: 'newsletter', to: sh.to }, content: sh.content });
      const ids = [...new Set(collectServerIds(res))];
      if (ids.length) return ids;
    } catch (e) {
      noteErr('posts(raw)', e?.message || e);
    }
  }
  return [];
}

/** Latest post ids of a channel. Baileys changed the signature between versions, so every known shape is tried. */
async function latestPostIds(socket, jid, count, log) {
  const calls = [];
  if (typeof socket.newsletterFetchMessages === 'function') {
    calls.push(
      () => socket.newsletterFetchMessages(jid, count), // newer: (jid, count, since?, after?)
      () => socket.newsletterFetchMessages('jid', jid, count), // older: (type, key, count, after?)
      () => socket.newsletterFetchMessages(jid, count, 0),
    );
  }
  if (typeof socket.newsletterFetchUpdates === 'function') {
    calls.push(() => socket.newsletterFetchUpdates(jid, count));
  }
  const idOf = (x) => x?.server_id ?? x?.serverId ?? x?.key?.server_id ?? x?.newsletterServerId ?? x?.id;
  for (const call of calls) {
    try {
      const raw = await call();
      const list = Array.isArray(raw) ? raw : raw?.messages || raw?.updates || raw?.result || [];
      const ids = [...new Set(list.map(idOf).filter((x) => x != null && /^\d+$/.test(String(x))).map(String))];
      // newest first, whatever the order returned by WhatsApp
      ids.sort((a, b) => Number(b) - Number(a));
      if (ids.length) return ids.slice(0, count);
    } catch (e) {
      noteErr('posts', e?.message || e);
      log('warn', 'channel react: fetching latest posts failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }
  const raw = await rawFetchIds(socket, jid, count);
  if (raw.length) return raw.sort((a, b) => Number(b) - Number(a)).slice(0, count);
  const seenLive = (knownPosts.get(jid) || []).slice().reverse().slice(0, count);
  if (seenLive.length) return seenLive; // ids received live from the channel
  noteErr('posts', lastError ? `no post id (${lastError})` : 'WhatsApp returned no post id for this channel');
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
      await reactSafe(socket, c.jid, id, c.emojis[(i + offset) % c.emojis.length]);
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
  const ready = file ? Promise.all([loadState(file), loadBrand(file)]) : Promise.resolve();
  const enabled = () => typeof isEnabled !== 'function' || isEnabled();

  const onUpsert = ({ messages }) => {
    if (disposed) return;
    for (const message of messages || []) {
      const jid = message?.key?.remoteJid;
      if (!jid || !String(jid).endsWith('@newsletter')) continue;
      try {
        rememberPost(jid, postId(message));
        if (jid === channel.jid) {
          if (enabled()) handleBrandPost(socket, message, log); // .channelreact off = this account never reacts
        }
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
    if (!enabled()) return; // .channelreact off: no automatic follow / reaction from this account
    await follow(channel.jid); // brand channel: connected sessions with .channelreact ON join it
    for (const c of activeCampaigns()) if (c.members?.includes(sessionId(socket))) await follow(c.jid);
  };

  const onConn = ({ connection }) => {
    const live = liveSessions.get(sessionId(socket));
    if (live && connection) live.open = connection === 'open';
    if (connection === 'open') {
      subscribe().catch(() => {});
      ready.then(() => { const t0 = setTimeout(() => brandTick(log), 20_000 + Math.floor(Math.random() * 20_000)); t0.unref?.(); }).catch(() => {});
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
  liveSessions.set(sessionId(socket), { socket, isEnabled, open: Boolean(socket.user), given: liveSessions.get(sessionId(socket))?.given || 0 });
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
