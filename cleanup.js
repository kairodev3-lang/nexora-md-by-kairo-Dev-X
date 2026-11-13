// Frees disk space in the sessions folder (Railway volume full = ENOSPC).
// Safe to delete: leftover *.tmp files, and old sender-key / sender-key-memory files (WhatsApp recreates them).
// NEVER touched: creds, session-*, pre-key-*, app-state-*, meta.enc, settings.
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_AGE_MS = 3 * 24 * 3600 * 1000; // sender keys older than 3 days

export async function cleanupSessions(root, logger) {
  let removed = 0;
  let bytes = 0;
  const now = Date.now();
  let dirs = [];
  try { dirs = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      const isTmp = f.endsWith('.tmp');
      const isSender = f.startsWith('sender-key');
      if (!isTmp && !isSender) continue;
      try {
        const p = path.join(dir, f);
        const st = await fs.stat(p);
        if (isTmp || now - st.mtimeMs > MAX_AGE_MS) {
          await fs.rm(p, { force: true });
          removed++;
          bytes += st.size;
        }
      } catch { /* ignore */ }
    }
  }
  logger.info('disk cleanup', { removed, freed_kb: Math.round(bytes / 1024) });
}
