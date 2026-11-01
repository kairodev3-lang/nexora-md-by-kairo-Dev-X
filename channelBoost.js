// channelBoost.js — coordinated reactions on the NEXORA MD channel across ALL connected sessions.
//
// For every new post, the connected sessions share the work: a random target of
// 34, 40 or 70 reactions is chosen (hard cap 90) and every reaction uses a DIFFERENT emoji
// (the pool holds 90 distinct emojis). A session reacts only once per post, so the real number
// can never exceed the number of connected sessions. Each account can opt out with .channelboost off.

const TARGETS = [34, 40, 70];
const MAX_REACTIONS = 90;
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

export { TARGETS, MAX_REACTIONS };

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

const posts = new Map(); // "jid:serverId" -> state
const MAX_TRACKED = 300;

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

export function handlePost(socket, message, jid, isEnabled, log = () => {}) {
  const serverId = message?.key?.server_id || message?.newsletterServerId || message?.newsletter_server_id;
  if (!serverId) return;
  const ts = tsOf(message);
  if (ts && Date.now() / 1000 - ts > MAX_POST_AGE_SEC) return;

  const key = `${jid}:${serverId}`;
  let st = posts.get(key);
  if (!st) {
    st = {
      target: Math.min(MAX_REACTIONS, pick(TARGETS), EMOJIS.length),
      claimed: 0,
      emojis: shuffle(EMOJIS),
      sessions: new Set(),
    };
    posts.set(key, st);
    if (posts.size > MAX_TRACKED) posts.delete(posts.keys().next().value);
  }

  const me = sessionId(socket);
  if (st.sessions.has(me)) return; // one reaction per session per post
  st.sessions.add(me);

  if (typeof isEnabled === 'function' && !isEnabled()) return;
  if (st.claimed >= st.target) return; // target already reached

  const slot = st.claimed++;
  const emoji = st.emojis[slot];
  const wait = slot * 120 + Math.floor(Math.random() * 1500); // ~10 s for 70 reactions

  const timer = setTimeout(async () => {
    try {
      await socket.newsletterReactMessage(jid, String(serverId), emoji);
    } catch (e) {
      log('warn', 'channel boost reaction failed', { err: String(e?.message || e).slice(0, 60) });
    }
  }, wait);
  timer.unref?.();
}

/**
 * Attaches the booster to one socket: reacts to posts + keeps the live-updates subscription alive.
 * Returns dispose() — call it when the socket is closed.
 */
export function attachChannelBoost(socket, { isEnabled, log = () => {} } = {}) {
  let timer = null;
  let disposed = false;

  const onUpsert = ({ messages }) => {
    if (disposed) return;
    for (const message of messages || []) {
      if (message?.key?.remoteJid !== channel.jid) continue;
      try {
        handlePost(socket, message, channel.jid, isEnabled, log);
      } catch (e) {
        log('warn', 'channel boost error', { err: String(e?.message || e).slice(0, 60) });
      }
    }
  };

  // Follow the channel (needed to react) and keep live updates flowing.
  let followed = false;
  const subscribe = async () => {
    if (disposed) return;
    if (typeof isEnabled === 'function' && !isEnabled()) return;
    await resolveChannel(socket);
    if (!followed && typeof socket.newsletterFollow === 'function') {
      try { await socket.newsletterFollow(channel.jid); } catch { /* already following */ }
      followed = true;
    }
    if (typeof socket.subscribeNewsletterUpdates === 'function') {
      try { await socket.subscribeNewsletterUpdates(channel.jid); } catch { /* retried on the next tick */ }
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

  socket.ev.on('messages.upsert', onUpsert);
  socket.ev.on('connection.update', onConn);

  return {
    refresh: () => subscribe().catch(() => {}),
    dispose() {
      disposed = true;
      clearInterval(timer);
      try {
        socket.ev.off('messages.upsert', onUpsert);
        socket.ev.off('connection.update', onConn);
      } catch { /* socket already gone */ }
    },
  };
}
