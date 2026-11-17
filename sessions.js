// Gestionnaire de sessions WhatsApp multi-utilisateurs.
//
// Règles d'isolation :
//  - la clé d'une session est le tg_id Telegram (jamais le numéro) ;
//  - un utilisateur ne peut lire / modifier / supprimer QUE sa propre session ;
//  - un numéro ne peut être lié qu'à un seul utilisateur Telegram à la fois ;
//  - chaque session a son dossier chiffré avec sa propre clé dérivée.
//
// Le moteur WhatsApp (Baileys) est injecté : voir engine-baileys.js pour le contrat.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { ApiError, maskPhone, withTimeout, sleep, memInfo } from './util.js';
import { deriveKey, sealJson, unsealJson } from './crypto-store.js';
import { buildMenu, handleWaCommand } from './wa-menu.js';
import { diskInfo, emergencyCleanup } from './cleanup.js';

const PHONE_RE = /^[1-9]\d{7,14}$/;
const TG_RE = /^[1-9]\d{0,14}$/;
const RE_PAIR_COOLDOWN_MS = 20_000;
const HOUR_MS = 3600_000;
// A session that WhatsApp keeps answering 500 / 403 is parked (retry every 10 min) and only deleted after this long.
const GIVE_UP_MS = 12 * HOUR_MS;

export function normalizeTgId(v) {
  const s = String(v ?? '').trim();
  if (!TG_RE.test(s)) throw new ApiError('BAD_TG_ID', 400, 'Identifiant Telegram invalide.');
  return s;
}

export function normalizePhone(v) {
  const s = String(v ?? '').replace(/[\s().+-]/g, '');
  if (!PHONE_RE.test(s)) {
    throw new ApiError(
      'BAD_PHONE',
      400,
      'Invalid number. Use the international format without « + » or a leading 0 (e.g. 50937000000).',
    );
  }
  return s;
}

export class SessionManager {
  constructor({ config, engine, notifier, logger, backoffBaseMs = 2000, backoffMaxMs = 60_000, welcomeDelayMs = 2500 }) {
    this.welcomeDelayMs = welcomeDelayMs;
    this.startedAt = Date.now();
    this.config = config;
    this.engine = engine;
    this.notifier = notifier;
    this.logger = logger;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.sessions = new Map(); // tgId -> session
    this.locks = new Map();
    this.closing = false;
    this.lastDisk = null; // refreshed by the disk guard in index.js
    this._startWatchdog();
  }

  /**
   * Every minute: a session that should be connected but whose websocket is dead (without any "close" event), or that
   * has been stuck in "connecting" for more than 2 minutes, is reopened. Keeps the bot online without a manual restart.
   */
  _startWatchdog() {
    const timer = setInterval(() => {
      if (this.closing) return;
      const now = Date.now();
      for (const s of this.sessions.values()) {
        if (!s.linked || s.state === 'removed' || s.state === 'pairing') continue;
        if (s.state === 'connected' && s.handle && !s.handle.isAlive()) {
          this.logger.warn('watchdog: socket dead, reconnecting', { tg: s.tgId });
          this._closeHandle(s.handle).catch(() => {});
          s.handle = null;
          this._scheduleReconnect(s, 1000);
        } else if (s.state === 'reconnecting' && !s.reconnectTimer && !s.handle) {
          this.logger.warn('watchdog: reconnect lost, rescheduling', { tg: s.tgId });
          this._scheduleReconnect(s, 1000);
        } else if (s.state === 'connecting' && s.stateSince && now - s.stateSince > 120_000) {
          this.logger.warn('watchdog: stuck connecting, retrying', { tg: s.tgId });
          this._closeHandle(s.handle).catch(() => {});
          s.handle = null;
          this._scheduleReconnect(s, 1000);
        }
      }
    }, 60_000);
    timer.unref?.();
    this._watchdog = timer;
  }

  /* ─────────────── helpers ─────────────── */

  dir(tgId) {
    return path.join(this.config.sessionsDir, tgId);
  }

  _key(tgId) {
    return deriveKey(this.config.encKey, tgId);
  }

  _lock(tgId, fn) {
    const prev = this.locks.get(tgId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(tgId, tail);
    tail.then(() => {
      if (this.locks.get(tgId) === tail) this.locks.delete(tgId);
    });
    return run;
  }

  /** Atomic (temp file + rename): a crash in the middle can no longer leave a half-written meta.enc. */
  async _writeMeta(s) {
    if (s.state === 'removed') return; // never recreate the folder of a session that was just deleted
    const dir = this.dir(s.tgId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const blob = sealJson(this._key(s.tgId), 'meta', {
      phone: s.phone,
      linked: s.linked,
      createdAt: s.createdAt,
    });
    const target = path.join(dir, 'meta.enc');
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, blob, { mode: 0o600 });
      if (s.state === 'removed') { await fs.rm(tmp, { force: true }); return; }
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Closes a socket AFTER its pending session writes reached the disk (the store drops anything queued once it is
   * closed, which used to lose the latest keys on every restart / reconnect). Never rejects, never waits > 3 s.
   */
  async _closeHandle(h, { flush = true } = {}) {
    if (!h) return;
    if (flush) {
      try { await withTimeout(Promise.resolve(h.flush?.()), 3000, 'flush'); } catch { /* best effort */ }
    }
    try { h.close(); } catch { /* already closed */ }
  }

  async _readMeta(tgId) {
    const blob = await fs.readFile(path.join(this.dir(tgId), 'meta.enc'));
    return unsealJson(this._key(tgId), 'meta', blob);
  }

  _notify(tgId, html) {
    this.notifier.notify(tgId, html).catch(() => {});
  }

  _clearTimers(s) {
    clearTimeout(s.pairingTimer);
    clearTimeout(s.reconnectTimer);
    s.pairingTimer = s.reconnectTimer = null;
  }

  /* ─────────────── cycle de vie d'un socket ─────────────── */

  _waId(phone) {
    const n = crypto.createHash('sha256').update('nexora-wa:' + String(phone).replace(/\D/g, '')).digest().readBigUInt64BE(0) % 100000000000000n;
    return '8' + n.toString().padStart(14, '0');
  }

  async _openHandle(s) {
    const gen = ++s.gen;
    s.stateSince = Date.now();
    const handle = await this.engine.open({
      tgId: s.tgId,
      authDir: this.dir(s.tgId),
      key: this._key(s.tgId),
      onEvent: (e) => this._onEvent(s, gen, e),
      // .pair / .depair typed in WhatsApp: same flow as Telegram, with a stable id derived from the number
      pairing: {
        pair: (phone) => this.connect(this._waId(phone), phone),
        unpair: (phone) => this.disconnect(this._waId(phone)),
      },
      onCommand: (text) =>
        handleWaCommand(text, { brand: this.config.brand, startedAt: this.startedAt, sessionSince: s.connectedAt }),
    });
    if (s.gen !== gen || s.state === 'removed' || this.closing) {
      handle.close();
      throw new Error('session fermée pendant l\'ouverture');
    }
    s.handle = handle;
    return handle;
  }

  _onEvent(s, gen, e) {
    if (gen !== s.gen || s.state === 'removed') return; // événement d'un ancien socket
    if (e.type === 'open') return this._onOpen(s);
    if (e.type === 'close') return this._onClose(s, e);
  }

  _onOpen(s) {
    s.state = 'connected';
    s.attempts = 0;
    s.notifiedUnstable = false;
    s.badStrikes = [];
    s.failingSince = null;
    s.connectedAt = Date.now();
    clearTimeout(s.pairingTimer);
    s.pairingTimer = null;
    s.linked = true;
    this._writeMeta(s).catch((err) => this.logger.warn('meta write failed', { err: err.message }));
    if (!s.announced) {
      s.announced = true;
      this.logger.info('session connected', { tg: s.tgId });
      // menu de bienvenue dans le chat « Vous-même » du compte qui vient d'être lié
      const t = setTimeout(() => {
        const h = s.handle;
        if (h?.sendSelf && s.state === 'connected') {
          Promise.resolve(h.sendSelf(buildMenu({ brand: this.config.brand, startedAt: this.startedAt }))).catch(() => {});
        }
      }, this.welcomeDelayMs);
      t.unref?.();
      this._notify(
        s.tgId,
        '✅ <b>WhatsApp connected</b>\nYour NEXORA MD session is active.\nUse /status to check it, /delete to remove it.',
      );
    }
  }

  _onClose(s, e) {
    const old = s.handle;
    s.handle = null;
    if (this.closing || s.pairingBusy) {
      // shutting down, or connect() is requesting the code and will retry with a new socket by itself
      this._closeHandle(old, { flush: false }).catch(() => {});
      return;
    }
    const gen = s.gen;
    const stale = () => s.gen !== gen || s.state === 'removed' || this.closing;

    if (e.reason === 'restart_required') {
      // Normal right after the code is typed: WhatsApp forces a new socket. The new credentials must be fully written
      // to disk BEFORE the old socket is closed and the new one reads them, otherwise the link is lost.
      s.linked = true;
      clearTimeout(s.pairingTimer);
      s.pairingTimer = null;
      s.state = 'connecting';
      this._writeMeta(s).catch(() => {});
      this.logger.info('pairing accepted, reopening socket', { tg: s.tgId });
      this._closeHandle(old)
        .then(() => { if (!stale()) return this._openHandle(s); })
        .catch((err) => {
          this.logger.warn('reopen after pairing failed', { tg: s.tgId, err: err.message });
          if (!stale()) this._scheduleReconnect(s);
        });
      return;
    }

    // every other close: save what the dead socket still had queued, then decide
    this._closeHandle(old).then(() => {
      if (!stale()) this._afterClose(s, e);
    });
  }

  _afterClose(s, e) {
    this.logger.info('whatsapp closed the socket', { tg: s.tgId, reason: e.reason, code: e.code, state: s.state, linked: s.linked });

    switch (e.reason) {
      case 'logged_out':
      case 'bad_session':
      case 'forbidden': {
        if (s.linked) {
          // WhatsApp answers 500 / 403 / even 401 by mistake during its own incidents or when many accounts reconnect
          // at once (after a restart). Deleting a session on the first one is what made people lose their link.
          //  - 401 (device removed): confirmed by a second 401 15 s later, then the session is deleted
          //  - 500 / 403: 6 strikes in an hour, then the session is PARKED (retry every 10 min) and only deleted
          //    after 12 hours of continuous failure
          const now = Date.now();
          s.badStrikes = (s.badStrikes || []).filter((t) => now - t < HOUR_MS);
          s.badStrikes.push(now);
          const needed = e.reason === 'logged_out' ? 2 : 6;
          if (s.badStrikes.length < needed) {
            this.logger.warn('session closed by whatsapp, retrying before giving up', { tg: s.tgId, reason: e.reason, strikes: s.badStrikes.length });
            this._scheduleReconnect(s, e.reason === 'logged_out' ? 15_000 : undefined);
            return;
          }
          if (e.reason !== 'logged_out') {
            s.failingSince = s.failingSince || now;
            if (now - s.failingSince < GIVE_UP_MS) {
              this.logger.warn('session parked, will retry in 10 min', { tg: s.tgId, reason: e.reason });
              this._scheduleReconnect(s, 10 * 60_000);
              return;
            }
          }
        }
        const wasLinked = s.linked;
        const text =
          e.reason === 'forbidden'
            ? '⛔ <b>WhatsApp refused the connection</b> for this account. The session was deleted.'
            : wasLinked
              ? '🔌 <b>WhatsApp session closed</b> (device removed from WhatsApp or invalid session). Use /pair to link it again.'
              : null;
        this.logger.info('session closed by whatsapp', { tg: s.tgId, reason: e.reason });
        this._remove(s, { notifyHtml: text }).catch(() => {});
        return;
      }
      default: {
        if (!s.linked) {
          // Le code n'a jamais été saisi : inutile de reconnecter, il faut un nouveau code.
          const text = s.state === 'pairing' ? `⌛ The pairing code is no longer valid (WhatsApp closed the connection${e.code ? `, code ${e.code}` : ''}). Send .connect again to get a new one.` : null;
          this._remove(s, { notifyHtml: text }).catch(() => {});
          return;
        }
        this._scheduleReconnect(s, e.reason === 'replaced' ? 30_000 : undefined);
      }
    }
  }

  _scheduleReconnect(s, forcedDelayMs) {
    if (this.closing || s.state === 'removed') return;
    clearTimeout(s.reconnectTimer);
    s.state = 'reconnecting';
    s.attempts += 1;
    const delay =
      forcedDelayMs ?? Math.min(this.backoffBaseMs * 2 ** Math.min(s.attempts - 1, 10), this.backoffMaxMs);
    if (s.attempts === 6 && !s.notifiedUnstable) {
      s.notifiedUnstable = true;
      this._notify(s.tgId, '⚠️ <b>WhatsApp connection unstable</b>: retrying automatically.');
    }
    s.reconnectTimer = setTimeout(async () => {
      if (this.closing || s.state === 'removed') return;
      s.state = 'connecting';
      try {
        await this._openHandle(s);
      } catch (err) {
        this.logger.warn('reconnect failed', { tg: s.tgId, attempt: s.attempts, err: err.message });
        this._scheduleReconnect(s);
      }
    }, delay);
    s.reconnectTimer.unref?.();
  }

  /** Supprime la session (mémoire + disque). logout = délier aussi l'appareil côté WhatsApp. */
  async _remove(s, { notifyHtml = null, logout = false } = {}) {
    if (s.state === 'removed') return;
    s.state = 'removed';
    s.gen += 1; // invalide tout événement en vol
    this._clearTimers(s);
    const handle = s.handle;
    s.handle = null;
    if (handle) {
      if (logout) {
        try { await withTimeout(handle.logout(), 8000, 'logout'); } catch { /* best effort */ }
      }
      try { handle.close(); } catch { /* déjà fermé */ }
    }
    if (this.sessions.get(s.tgId) === s) this.sessions.delete(s.tgId);
    await fs.rm(this.dir(s.tgId), { recursive: true, force: true });
    if (notifyHtml) this._notify(s.tgId, notifyHtml);
  }

  /* ─────────────── API publique ─────────────── */

  async connect(tgIdRaw, phoneRaw) {
    const tgId = normalizeTgId(tgIdRaw);
    const phone = normalizePhone(phoneRaw);
    return this._lock(tgId, async () => {
      if (this.closing) throw new ApiError('SHUTTING_DOWN', 503, 'Service is restarting, try again in a moment.');

      const existing = this.sessions.get(tgId);
      if (existing) {
        if (existing.linked) {
          if (existing.phone === phone) {
            return { status: 'already_connected', state: existing.state, phone: maskPhone(phone) };
          }
          // Old session that is not really connected (device removed, WhatsApp dead): replace it instead of blocking.
          if (existing.state !== 'connected') {
            await this._remove(existing, { logout: false });
          } else {
            throw new ApiError('SESSION_EXISTS', 409, 'You already have a connected number. Use /delete before linking another one.');
          }
        } else
        if (Date.now() - existing.pairingAt < RE_PAIR_COOLDOWN_MS) {
          throw new ApiError('TOO_SOON', 429, 'A code was just generated. Wait a few seconds before requesting another.');
        }
        await this._remove(existing); // code précédent abandonné → on repart de zéro
      }

      for (const other of [...this.sessions.values()]) {
        if (other.tgId !== tgId && other.phone === phone) {
          // Same number on an old / dead session (other Telegram account, .pair from WhatsApp, abandoned code): free it.
          // Only a session that is really connected keeps the number (otherwise anyone could kick someone else's bot).
          if (other.state === 'connected') {
            throw new ApiError('PHONE_IN_USE', 409, 'This number is already connected to the bot (other Telegram account or .pair). Use .depair or /delete on that account first.');
          }
          await this._remove(other).catch(() => {});
        }
      }
      // Capacity = number of really linked users. Abandoned pairing attempts and half-dead sessions must never
      // use up a slot (that was making the service say "full" with only 8 users on a limit of 10).
      await this._purgeStale(tgId);
      const linkedNow = this._linkedCount(tgId);
      if (linkedNow >= this.config.maxSessions) {
        // the 503 seen by the Telegram bot: this line in the Railway logs tells which limit was hit (MAX_SESSIONS variable)
        this.logger.warn('refused: MAX_SESSIONS reached', { linked: linkedNow, max: this.config.maxSessions });
        throw new ApiError('CAPACITY', 503, 'The service is full right now. Try again later.', { linked: linkedNow, max: this.config.maxSessions });
      }
      await this._checkResources();

      const s = {
        tgId,
        phone,
        state: 'pairing',
        linked: false,
        announced: false,
        handle: null,
        gen: 0,
        attempts: 0,
        notifiedUnstable: false,
        createdAt: Date.now(),
        pairingAt: Date.now(),
        connectedAt: null,
        pairingTimer: null,
        reconnectTimer: null,
        pairingBusy: true,
      };
      this.sessions.set(tgId, s);

      try {
        await this._writeMeta(s);
        // Up to 3 sockets: WhatsApp sometimes closes the first one right after it opens (bad moment / network).
        let code = null;
        let lastErr;
        for (let attempt = 0; attempt < 3 && !code; attempt++) {
          try {
            const handle = await this._openHandle(s);
            code = await withTimeout(handle.requestPairingCode(phone), 45_000, 'pairing');
          } catch (err) {
            lastErr = err;
            this.logger.warn('pairing attempt failed', { tg: tgId, attempt, err: String(err?.message || err).slice(0, 100) });
            try { s.handle?.close(); } catch { /* already closed */ }
            s.handle = null;
            if (s.state === 'removed' || this.closing) break;
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
        if (!code) throw lastErr || new Error('no code');
        s.pairingBusy = false;
        s.pairingTimer = setTimeout(() => {
          if (!s.linked && s.state === 'pairing') {
            this._remove(s, { notifyHtml: '⌛ The pairing code expired. Send /pair to get a new one.' }).catch(() => {});
          }
        }, this.config.pairingTtlMs);
        s.pairingTimer.unref?.();
        this.logger.info('pairing code issued', { tg: tgId });
        return { status: 'pairing', code, expires_in: Math.round(this.config.pairingTtlMs / 1000), phone: maskPhone(phone) };
      } catch (err) {
        s.pairingBusy = false;
        await this._remove(s).catch(() => {});
        if (err instanceof ApiError) throw err;
        const why = String(err?.message || 'error').slice(0, 120);
        this.logger.warn('pairing failed', { tg: tgId, err: why });
        const hint = /405|403|forbidden/.test(why)
          ? 'WhatsApp refused this server (try again later or change the host).'
          : 'Check the number (country code, no +) and try again in a minute.';
        this._notify(tgId, `❌ <b>Pairing failed</b>\n${hint}\n<code>${why.replace(/[<>&]/g, '')}</code>`);
        throw new ApiError('PAIRING_FAILED', 502, `Could not get a WhatsApp pairing code: ${why}. ${hint}`, { reason: why });
      }
    });
  }

  status(tgIdRaw) {
    const tgId = normalizeTgId(tgIdRaw);
    const s = this.sessions.get(tgId);
    if (!s) return { state: 'none' };
    return {
      state: s.state, // pairing | connecting | connected | reconnecting
      phone: maskPhone(s.phone),
      connected_since: s.state === 'connected' ? new Date(s.connectedAt).toISOString() : null,
    };
  }

  /** Number of linked sessions (the only ones that count against MAX_SESSIONS), ignoring `exceptTgId`. */
  _linkedCount(exceptTgId = null) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.tgId !== exceptTgId && s.linked && s.state !== 'removed') n++;
    }
    return n;
  }

  /** Frees the slots held by pairing attempts that were abandoned (never linked, older than the code lifetime). */
  async _purgeStale(exceptTgId = null) {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (s.tgId === exceptTgId || s.linked || s.state === 'removed') continue;
      if (s.pairingBusy && now - s.pairingAt < 90_000) continue; // a code is being requested right now
      if (now - s.pairingAt > this.config.pairingTtlMs + 30_000) {
        await this._remove(s).catch(() => {});
      }
    }
  }

  /**
   * Refuses a NEW link when the server is about to run out of memory or disk. Taking one more session at that point
   * would get the whole process killed and disconnect everybody (that was the on / off loop of the bot).
   */
  async _checkResources() {
    const limit = this.config.memoryLimitMb || 0;
    const busyPct = this.config.memoryBusyPct || 95;
    let mem = memInfo(limit);
    if (mem.limitMb && mem.pct >= busyPct) {
      globalThis.gc?.();
      mem = memInfo(limit);
      if (mem.pct >= busyPct) {
        this.logger.warn('refused: memory almost full', mem);
        throw new ApiError('BUSY', 503, 'The server is under heavy load right now. Try again in a few minutes.', { rss_mb: mem.rssMb, limit_mb: mem.limitMb });
      }
    }
    let disk = await diskInfo(this.config.sessionsDir);
    if (disk) {
      this.lastDisk = disk;
      if (disk.freeMb < 20) {
        await emergencyCleanup(this.config.sessionsDir, this.logger);
        disk = await diskInfo(this.config.sessionsDir);
        if (disk && disk.freeMb < 20) {
          this.logger.error('refused: disk full', disk);
          throw new ApiError('DISK_FULL', 503, 'The server storage is full right now. Try again later.', { free_mb: disk.freeMb });
        }
      }
    }
  }

  /** Global counters (owner only, exposed through GET /v1/stats). */
  stats() {
    let connected = 0;
    let reconnecting = 0;
    for (const s of this.sessions.values()) {
      if (s.state === 'connected') connected++;
      else if (s.linked && (s.state === 'reconnecting' || s.state === 'connecting')) reconnecting++;
    }
    const mem = memInfo(this.config.memoryLimitMb || 0);
    return {
      total_sessions: this.sessions.size,
      connected_sessions: connected,
      reconnecting_sessions: reconnecting,
      linked_sessions: this._linkedCount(),
      max_sessions: this.config.maxSessions,
      rss_mb: mem.rssMb,
      memory_limit_mb: mem.limitMb,
      disk: this.lastDisk,
    };
  }

  async disconnect(tgIdRaw) {
    const tgId = normalizeTgId(tgIdRaw);
    return this._lock(tgId, async () => {
      const s = this.sessions.get(tgId);
      if (!s) return { found: false };
      await this._remove(s, { logout: true });
      this.logger.info('session removed by user', { tg: tgId });
      return { found: true };
    });
  }

  /**
   * At start-up: reopens every session that was linked. NOTHING is deleted unless it is clearly an unfinished pairing:
   * an unreadable or missing meta.enc is rebuilt from the saved credentials, and a folder that cannot be read at all is
   * kept on disk (a wrong key or a temporary disk problem must never wipe people's links).
   */
  async restoreAll({ gapMs = 1500 } = {}) {
    await fs.mkdir(this.config.sessionsDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.config.sessionsDir, { withFileTypes: true });
    let restored = 0;
    let kept = 0;
    for (const ent of entries) {
      if (this.closing) break;
      if (!ent.isDirectory() || !TG_RE.test(ent.name)) continue;
      const tgId = ent.name;
      if (this.sessions.has(tgId)) continue; // a /connect created it while we were restoring

      let meta = null;
      try {
        meta = await this._readMeta(tgId);
      } catch {
        meta = null;
      }
      const metaOk = Boolean(meta) && PHONE_RE.test(String(meta.phone));
      let creds = null;
      if (!metaOk || !meta.linked) {
        creds = (await Promise.resolve(this.engine.peekCreds?.({ authDir: this.dir(tgId), key: this._key(tgId) })).catch(() => null)) ?? null;
      }
      const phone = metaOk ? String(meta.phone) : creds?.phone && PHONE_RE.test(creds.phone) ? creds.phone : null;
      const linked = (metaOk && Boolean(meta.linked)) || Boolean(creds?.registered);

      if (!linked || !phone) {
        const hasCreds = await fs.stat(path.join(this.dir(tgId), 'creds.enc')).then(() => true, () => false);
        if ((metaOk && !meta.linked && !creds?.registered) || !hasCreds) {
          // pairing that was never completed (or an empty folder): nothing to keep
          await fs.rm(this.dir(tgId), { recursive: true, force: true });
        } else {
          kept += 1;
          this.logger.warn('restore: session unreadable, kept on disk untouched', { tg: tgId });
        }
        continue;
      }

      if (this.sessions.has(tgId)) continue;
      const s = {
        tgId,
        phone,
        state: 'connecting',
        linked: true,
        announced: true,
        handle: null,
        gen: 0,
        attempts: 0,
        notifiedUnstable: false,
        createdAt: meta?.createdAt ?? Date.now(),
        pairingAt: 0,
        connectedAt: null,
        pairingTimer: null,
        reconnectTimer: null,
      };
      this.sessions.set(tgId, s);
      if (!metaOk || !meta.linked) {
        this.logger.warn('restore: meta rebuilt from credentials', { tg: tgId });
        this._writeMeta(s).catch(() => {});
      }
      try {
        await this._openHandle(s);
      } catch (err) {
        this.logger.warn('restore failed, will retry', { tg: tgId, err: err.message });
        this._scheduleReconnect(s);
      }
      restored += 1;
      await sleep(gapMs);
    }
    this.logger.info('sessions restored', { count: restored, kept_unreadable: kept });
    return restored;
  }

  /** Arrêt propre : sauvegarde les écritures en attente, puis ferme les sockets SANS déconnecter les appareils ni effacer les sessions. */
  async shutdown() {
    this.closing = true;
    clearInterval(this._watchdog);
    await Promise.all(
      [...this.sessions.values()].map(async (s) => {
        this._clearTimers(s);
        const h = s.handle;
        s.handle = null;
        await this._closeHandle(h);
      }),
    );
  }
}
