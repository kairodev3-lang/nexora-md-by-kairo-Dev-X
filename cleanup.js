// Keeps the sessions volume from filling up (Railway volume full = ENOSPC = sessions silently broken).
//
// Safe to delete: leftover *.tmp files, and sender-key / sender-key-memory files (WhatsApp recreates them on demand).
// NEVER touched: creds, session-*, pre-key-*, app-state-*, meta.enc, settings.
//
//  - cleanupSessions()  : normal pass (age based), optionally with a report of what takes the space
//  - diskGuard()        : cheap check (statfs). Above 80 % used it cleans harder, above 92 % it cleans everything it may.
//  - reserve file      : a block of real disk space kept aside (_reserve.bin). When the volume is full it is deleted, which gives
//                        room for the accounts to keep saving and for a few more users. Recreated once space is free again.
//  - emergencyCleanup() : called by the session store the moment a write fails with ENOSPC (throttled).
import fs from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600 * 1000;
const SESSION_EMERGENCY_AGE_MS = 30 * 24 * HOUR; // last resort: Signal sessions untouched for 30 days (contacts that never write)
export const DEFAULT_MAX_AGE_MS = 24 * HOUR; // sender keys older than 1 day (was 3 days: too long for a small volume)
const TMP_MIN_AGE_MS = 2 * 60 * 1000; // a .tmp younger than that may still be being written

export async function diskInfo(root) {
  try {
    const st = await fs.statfs(root);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail) * Number(st.bsize);
    return {
      totalMb: Math.round(total / 1048576),
      freeMb: Math.round(free / 1048576),
      usedPct: total ? Math.round((1 - free / total) * 100) : 0,
    };
  } catch {
    return null;
  }
}

const prefixOf = (f) => f.replace(/\.enc$/, '').split(/[-%.]/)[0] || f;

export async function cleanupSessions(root, logger, { maxAgeMs = DEFAULT_MAX_AGE_MS, report = false, sessionMaxAgeMs = Infinity } = {}) {
  let removed = 0;
  let bytes = 0;
  const now = Date.now();
  let dirs = [];
  try { dirs = await fs.readdir(root, { withFileTypes: true }); } catch { return { removed, bytes }; }
  const byPrefix = new Map(); // prefix -> { n, kb }
  const byUser = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    let userKb = 0;
    for (const f of files) {
      const isTmp = f.endsWith('.tmp');
      const isSender = f.startsWith('sender-key');
      const isSession = Number.isFinite(sessionMaxAgeMs) && f.startsWith('session-');
      if (!isTmp && !isSender && !isSession && !report) continue;
      try {
        const p = path.join(dir, f);
        const st = await fs.stat(p);
        const age = now - st.mtimeMs;
        if ((isTmp && age > TMP_MIN_AGE_MS) || (isSender && age >= maxAgeMs) || (isSession && age >= sessionMaxAgeMs)) {
          await fs.rm(p, { force: true });
          removed++;
          bytes += st.size;
          continue;
        }
        if (report) {
          const kb = Math.ceil((st.blocks * 512) / 1024) || Math.ceil(st.size / 1024);
          userKb += kb;
          const k = prefixOf(f);
          const cur = byPrefix.get(k) || { n: 0, kb: 0 };
          cur.n++;
          cur.kb += kb;
          byPrefix.set(k, cur);
        }
      } catch { /* ignore */ }
    }
    if (report) byUser.push({ tg: d.name, files: files.length, mb: Math.round(userKb / 1024) });
  }
  logger.info('disk cleanup', { removed, freed_kb: Math.round(bytes / 1024), max_age_h: Math.round(maxAgeMs / HOUR) });
  if (report) {
    const top = [...byPrefix.entries()].sort((a, b) => b[1].kb - a[1].kb).slice(0, 8)
      .map(([k, v]) => `${k}:${v.n}f/${Math.round(v.kb / 1024)}MB`);
    byUser.sort((a, b) => b.mb - a.mb);
    logger.info('disk usage', { by_type: top, biggest_users: byUser.slice(0, 3), users: byUser.length });
  }
  return { removed, bytes };
}

/** Cheap periodic check. Returns the disk numbers (or null when statfs is not available). */
export async function diskGuard(root, logger) {
  const d = await diskInfo(root);
  if (!d) return null;
  if (d.usedPct >= 92) {
    logger.error('DISK ALMOST FULL: increase the Railway volume size', d);
    await cleanupSessions(root, logger, { maxAgeMs: 0, sessionMaxAgeMs: SESSION_EMERGENCY_AGE_MS });
    const after = await diskInfo(root);
    if (after && after.usedPct >= 92) await releaseReserve(root, logger);
    return after || d;
  } else if (d.usedPct >= 80) {
    logger.warn('disk filling up', d);
    await cleanupSessions(root, logger, { maxAgeMs: 6 * HOUR });
  }
  return d;
}

const RESERVE_FILE = '_reserve.bin';

/** Creates the reserve (real zeros, not a sparse file) when the disk has plenty of room. Returns true when it exists. */
export async function ensureReserve(root, logger, mb) {
  if (!mb) return false;
  const file = path.join(root, RESERVE_FILE);
  try {
    const st = await fs.stat(file);
    if (st.size >= mb * 1048576 * 0.9) return true;
  } catch { /* not there yet */ }
  const d = await diskInfo(root);
  if (!d || d.freeMb < mb + 100) return false; // never take space the sessions need
  const tmp = `${file}.part`;
  try {
    const fh = await fs.open(tmp, 'w', 0o600);
    try {
      const chunk = Buffer.alloc(1048576);
      for (let i = 0; i < mb; i++) await fh.write(chunk);
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    logger.info('disk reserve created', { mb });
    return true;
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}

/** Deletes the reserve to make room. Returns true when something was freed. */
export async function releaseReserve(root, logger) {
  const file = path.join(root, RESERVE_FILE);
  try {
    const st = await fs.stat(file);
    await fs.rm(file, { force: true });
    logger?.warn?.('disk reserve released (volume almost full)', { mb: Math.round(st.size / 1048576) });
    return true;
  } catch {
    return false;
  }
}

let emergency = null;
let emergencyAt = 0;
/** ENOSPC just happened: free everything that may be freed. At most once every 30 s, concurrent callers share the run. */
export function emergencyCleanup(root, logger) {
  if (emergency) return emergency;
  if (Date.now() - emergencyAt < 30_000) return Promise.resolve();
  emergencyAt = Date.now();
  logger?.error?.('disk full (ENOSPC): emergency cleanup');
  emergency = cleanupSessions(root, logger || { info() {} }, { maxAgeMs: 0, sessionMaxAgeMs: SESSION_EMERGENCY_AGE_MS })
    .then(() => releaseReserve(root, logger))
    .catch(() => {})
    .finally(() => { emergency = null; });
  return emergency;
}
