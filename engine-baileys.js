// WhatsApp engine based on Baileys.
//
// Contract expected by SessionManager:
//   engine.open({ tgId, authDir, key, onEvent }) -> Promise<Handle>
//   Handle = {
//     requestPairingCode(phone): Promise<string>   // "ABCD-EFGH"
//     logout(): Promise<void>                       // unlinks the device on the WhatsApp side
//     sendSelf(text): Promise<void>                 // message in the "You" chat
//     isAlive(): boolean                            // websocket still open?
//     close(): void                                 // closes the socket, blocks any disk write
//   }
//   onEvent({ type: 'open' })
//   onEvent({ type: 'close', reason: 'logged_out'|'bad_session'|'forbidden'|'restart_required'|'replaced'|'other', code })
//
// Messages: only commands WRITTEN BY the account owner (fromMe) are executed, from the closed
// list in wa-menu.js / wa-extras.js (plus the public commands when .mode public is on).
// The content of other people's messages is never read (only metadata for auto-read / presence).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { useEncryptedAuthState } from './crypto-store.js';
import { silentBaileysLogger } from './util.js';
import { createExtras } from './wa-extras.js';
import { box, isMenuText } from './wa-menu.js';
import { attachChannelBoost, channel } from './channelBoost.js';

const CODE_BY_NUMBER = {
  401: 'logged_out',
  500: 'bad_session',
  403: 'forbidden',
  515: 'restart_required',
  440: 'replaced',
};

export async function createBaileysEngine() {
  const mod = await import('@whiskeysockets/baileys');
  const makeWASocket = typeof mod.default === 'function' ? mod.default : mod.makeWASocket;
  const {
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
    BufferJSON,
    initAuthCreds,
    proto,
    jidNormalizedUser,
    normalizeMessageContent,
    downloadMediaMessage,
  } = mod;

  const logger = silentBaileysLogger();
  const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

  // Menu image (menu.jpg next to the .js files). Missing → text-only menu.
  let menuImage = null;
  try {
    menuImage = await readFile(new URL('./menu.jpg', import.meta.url));
  } catch {
    log('warn', 'menu.jpg not found: menu sent without image');
  }

  // Bot messages show up as "forwarded" from the WhatsApp channel (the "View channel" button).
  const forwardedCtx = () => ({
    isForwarded: true,
    forwardingScore: 999,
    forwardedNewsletterMessageInfo: { newsletterJid: channel.jid, newsletterName: channel.name, serverMessageId: 143 },
  });

  /** content: text (string) or Baileys object. plain = true → no "channel" wrapper (media, files). */
  const sendMsg = async (sock, jid, content, quoted, plain = false, sentCache = null) => {
    const opts = quoted ? { quoted } : undefined;
    let msg = typeof content === 'string' ? { text: content } : { ...content };
    if (menuImage && typeof content === 'string' && isMenuText(content) && content.length <= 3500) {
      msg = { image: menuImage, caption: content };
    }
    // stickers, reactions, deletions and edits go out as they are; everything else carries the channel wrapper
    // Every sent message is remembered for a while: WhatsApp asks for it again when the receiver could not decrypt it
    // (typical in DMs). Without it the person sees "Waiting for this message…" and the reply never shows up.
    const remember = (sent) => {
      try {
        if (sentCache && sent?.key?.id && sent.message) {
          sentCache.set(sent.key.id, sent.message);
          if (sentCache.size > 400) sentCache.delete(sentCache.keys().next().value);
        }
      } catch { /* cache is best effort */ }
      return sent;
    };
    if (plain && (msg.sticker || msg.react || msg.delete || msg.edit)) return remember(await sock.sendMessage(jid, msg, opts));
    try {
      return remember(await sock.sendMessage(jid, { ...msg, contextInfo: { ...(msg.contextInfo || {}), ...forwardedCtx() } }, opts));
    } catch (e) {
      log('warn', 'send with channel wrapper refused, retrying plain', { err: e?.message || 'error' });
      return remember(await sock.sendMessage(jid, msg, opts));
    }
  };

  /** Tiny TTL cache with the interface Baileys expects (get / set / del / flushAll). */
  const makeRetryCache = (ttlMs = 10 * 60_000) => {
    const m = new Map();
    return {
      get: (k) => {
        const v = m.get(k);
        if (!v) return undefined;
        if (Date.now() > v.until) { m.delete(k); return undefined; }
        return v.value;
      },
      set: (k, value) => {
        m.set(k, { value, until: Date.now() + ttlMs });
        if (m.size > 2000) m.delete(m.keys().next().value);
      },
      del: (k) => { m.delete(k); },
      flushAll: () => m.clear(),
    };
  };

  return {
    async open({ authDir, key, onEvent, onCommand }) {
      const store = await useEncryptedAuthState(authDir, key, { BufferJSON, initAuthCreds, proto });

      let version;
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        /* keep the library's default version */
      }

      const sentCache = new Map(); // message id -> message content (for getMessage)
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        logger,
        printQRInTerminal: false,
        auth: {
          creds: store.state.creds,
          keys: makeCacheableSignalKeyStore(store.state.keys, logger),
        },
        browser: Browsers.ubuntu('Chrome'), // name shown in "Linked devices"
        markOnlineOnConnect: false,
        // stay connected: ping WhatsApp often, give slow networks time, never hang on a query
        keepAliveIntervalMs: 20_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        retryRequestDelayMs: 500,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache: makeRetryCache(),
        getMessage: async (key) => sentCache.get(key?.id) || undefined,
      });

      const send = (jid, content, quoted, plain) => sendMsg(sock, jid, content, quoted, plain, sentCache);
      let boost = null;
      const extras = await createExtras({
        sock,
        authDir,
        send,
        log,
        helpers: { downloadMediaMessage, normalizeMessageContent, jidNormalizedUser, logger },
        assets: { menuImage },
        onSettingChange: (key, value) => {
          if (key === 'channelreact' && value) boost?.refresh();
        },
      });
      // Channel reactions: brand channel (automatic) + channels given with .channelreact (shared by all sessions of this process)
      // campaign state lives next to the sessions folders (a plain file there is ignored by the session scan)
      boost = attachChannelBoost(sock, {
        isEnabled: () => extras.settings.channelreact,
        log,
        stateFile: path.join(authDir, '..', '_channelreact.json'),
      });

      let closedWith = null; // status code when WhatsApp closes the socket before the pairing code is issued
      let readyResolve;
      const ready = new Promise((r) => { readyResolve = r; });

      sock.ev.on('creds.update', () => {
        store.saveCreds().catch(() => {});
      });

      sock.ev.on('connection.update', (u) => {
        if (u.connection) log('info', 'wa connection', { connection: u.connection, code: u.lastDisconnect?.error?.output?.statusCode });
        // the socket is ready to request a pairing code: QR emitted, or the connection has started (+ short pause)
        if (u.qr) readyResolve();
        if (u.connection === 'connecting') setTimeout(readyResolve, 2500);
        if (u.connection === 'open') onEvent({ type: 'open' });
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          closedWith = code ?? 'unknown';
          onEvent({ type: 'close', reason: CODE_BY_NUMBER[code] || 'other', code });
        }
      });

      sock.ev.on('call', (calls) => {
        extras.onCalls(calls).catch(() => {});
      });
      sock.ev.on('group-participants.update', (u) => {
        extras.onGroupUpdate(u).catch(() => {});
      });

      // Commands: only messages WRITTEN BY the account owner (fromMe), in any chat (plus public
      // commands for other people in public mode). Bot replies never start with the prefix → no loop.
      const tsOf = (m) => {
        const t = m.messageTimestamp;
        if (t == null) return 0;
        return typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
      };
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (!onCommand) return;
        for (const m of messages || []) {
          try {
            if (!m.message) {
              // could not be decrypted (yet): WhatsApp retries by itself, we only log it
              if (!m.key?.fromMe && m.messageStubType) log('warn', 'wa message not decrypted', { stub: m.messageStubType, dm: !String(m.key?.remoteJid || '').endsWith('@g.us') });
              continue;
            }
            // the owner (message written by the account itself) and the sudo users have full access
            const isOwner = Boolean(m.key?.fromMe) || (type === 'notify' && Boolean(extras.isSudo?.(m)));
            if (!isOwner) {
              try {
                await extras.onIncoming(m, type); // metadata only (read, presence, statuses)
              } catch { /* never stop a command because of auto-read / presence */ }
              if (extras.settings.mode !== 'public' || type !== 'notify') continue; // private mode: stop here
            }
            const jid = m.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
            // synced messages (append): ignore old ones so nothing is replayed after a restart
            if (type !== 'notify' && Date.now() / 1000 - tsOf(m) > 60) continue;
            const content = (normalizeMessageContent ? normalizeMessageContent(m.message) : null) || m.message;
            const text = String(content.conversation || content.extendedTextMessage?.text || '').trim();
            if (!text) continue;
            const reply = (c) => send(jid, c, m);

            // "save" / "send" / "sendme" as a reply to a status
            if (isOwner && ['save', 'send', 'sendme'].includes(text.toLowerCase())) {
              if (await extras.saveFromStatus({ jid, content, reply })) log('info', 'wa status save', { type });
              continue;
            }

            // answer to ".channelreact": a channel link sent alone by the owner
            if (isOwner && /^https?:\/\/(?:www\.)?whatsapp\.com\/channel\//i.test(text) && (await extras.boostLink(text, reply))) continue;

            // "1" / "2" after .play: audio / video of the song that was shown
            if (/^[12]$/.test(text) && (await extras.playChoice(text, { jid, m, reply, content, isOwner }))) continue;

            // plain text that answers a running game (.dungeon, .tekateki)
            if (extras.gameText && (await extras.gameText(text, { jid, m, reply }))) continue;

            // current prefix; ".setprefix" always works (backup if the prefix is forgotten)
            const prefix = extras.settings.prefix;
            const used = text.startsWith(prefix) ? prefix : isOwner && /^\.setprefix(\s|$)/i.test(text) ? '.' : null;
            if (!used) continue;
            const [rawCmd = '', ...rest] = text.slice(used.length).split(/\s+/);
            const cmd = rawCmd.toLowerCase();
            if (!cmd) continue;
            const args = rest.filter(Boolean);

            // other users (public mode): public commands only + anti-abuse limits
            let guest = null;
            if (!isOwner) {
              guest = extras.guestCheck(cmd, m.key.participant || jid);
              if (guest.status === 'ignore') continue;
              if (guest.status === 'owner_only') {
                await reply(box('🚫 ACCESS DENIED', ['This command is reserved for the owner.']));
                continue;
              }
              if (guest.status === 'slow') {
                if (guest.notify) await reply(box('⏳ PLEASE WAIT', [`Try again in ${guest.wait} s.`]));
                continue;
              }
              if (guest.status === 'busy') {
                await reply(box('⏳ BUSY', ['Too many downloads in progress, try again in a moment.']));
                continue;
              }
            }

            try {
              if (extras.has(cmd)) {
                log('info', 'wa command', { cmd, known: true, type, guest: !isOwner });
                await extras.handleCommand({ cmd, args, q: args.join(' '), jid, m, content, reply });
                continue;
              }
              // .menu → 🕷 reaction under the command message
              if (cmd === 'menu') sock.sendMessage(jid, { react: { text: '🕷', key: m.key } }).catch(() => {});
              const out = await onCommand(text, { prefix: used, mode: extras.settings.mode });
              log('info', 'wa command', { cmd, known: Boolean(out), type, guest: !isOwner });
              if (out) await reply(out);
            } finally {
              guest?.release?.();
            }
          } catch (e) {
            // a failing command must never break the session
            log('warn', 'wa command failed', { err: e?.message || 'error' });
          }
        }
      });

      let closed = false;
      return {
        async sendSelf(text) {
          const me = sock.user?.id;
          if (me) await send(jidNormalizedUser(me), text, null);
        },
        isAlive() {
          try {
            return !closed && !sock.ws?.isClosed && !sock.ws?.isClosing;
          } catch {
            return !closed;
          }
        },
        async requestPairingCode(phone) {
          await Promise.race([ready, new Promise((r) => setTimeout(r, 12_000))]);
          if (sock.authState.creds.registered) throw new Error('already registered');
          const digits = String(phone).replace(/\D/g, '');
          let lastErr;
          // WhatsApp sometimes refuses the first request while the socket is still opening: retry a few times
          for (let attempt = 0; attempt < 4; attempt++) {
            if (closedWith != null) throw new Error(`WhatsApp closed the connection (code ${closedWith})`);
            try {
              const raw = await sock.requestPairingCode(digits);
              return String(raw).match(/.{1,4}/g)?.join('-') ?? String(raw);
            } catch (e) {
              lastErr = e;
              log('warn', 'pairing code request failed', { attempt, err: String(e?.message || e).slice(0, 80) });
              await new Promise((r) => setTimeout(r, 1500 + attempt * 1500));
            }
          }
          throw lastErr || new Error('pairing failed');
        },
        async logout() {
          await sock.logout();
        },
        close() {
          if (closed) return;
          closed = true;
          boost?.dispose();
          store.close();
          try {
            for (const ev of ['connection.update', 'creds.update', 'messages.upsert', 'call', 'group-participants.update']) {
              sock.ev.removeAllListeners(ev);
            }
          } catch { /* ignore */ }
          try { sock.end(undefined); } catch { /* ignore */ }
        },
      };
    },
  };
}
