// Petits utilitaires partagés (aucune dépendance externe).

export class ApiError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** +509•••••37 — ne jamais afficher un numéro complet dans une réponse ou un log. */
export function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length < 6) return '+•••';
  return `+${p.slice(0, 3)}${'•'.repeat(p.length - 5)}${p.slice(-2)}`;
}

/** Logger JSON minimal. Les appelants ne passent jamais de numéro/code/secret. */
export function createLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level] ?? 20;
  const emit = (lvl) => (msg, meta = {}) => {
    if (order[lvl] < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...meta });
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** Logger « pino-compatible » muet exigé par Baileys (il peut contenir des données sensibles). */
export function silentBaileysLogger() {
  const l = {
    level: 'silent',
    child: () => l,
    trace() {}, debug() {}, info() {}, warn() {}, error() {},
  };
  return l;
}

/** Fenêtre glissante en mémoire. */
export class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  hit(key, now = Date.now()) {
    if (this.hits.size > 5000) this.#prune(now);
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.windowMs - (now - arr[0])) / 1000)) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true, retryAfterSec: 0 };
  }

  #prune(now) {
    for (const [k, arr] of this.hits) {
      if (!arr.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
  }
}

/**
 * Memory used by the process (rss) and the container limit when the host exposes one (Railway, Docker…).
 * limitMb = 0 means "unknown". `overrideLimitMb` comes from the MEMORY_LIMIT_MB variable.
 */
export function memInfo(overrideLimitMb = 0) {
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  let limitMb = overrideLimitMb || 0;
  if (!limitMb) {
    try {
      const c = process.constrainedMemory?.();
      // an "unlimited" cgroup reports a huge number (or 0): ignore anything above 64 GB
      if (Number.isFinite(c) && c > 0 && c < 64 * 1024 ** 3) limitMb = Math.round(c / 1048576);
    } catch { /* unknown */ }
  }
  return { rssMb, limitMb, pct: limitMb ? Math.round((rssMb / limitMb) * 100) : 0 };
}
