import { loadConfig } from './config.js';
import { createLogger, memInfo } from './util.js';
import { createTelegramNotifier } from './notifier.js';
import { createBaileysEngine } from './engine-baileys.js';
import { SessionManager } from './sessions.js';
import { createHttpServer } from './server.js';
import { startKeepAlive } from './keepalive.js';
import { cleanupSessions, diskGuard, ensureReserve } from './cleanup.js';

const logger = createLogger(process.env.LOG_LEVEL || 'info');

let config;
try {
  config = loadConfig();
} catch (e) {
  logger.error('invalid configuration', { err: e.message });
  process.exit(1);
}

const engine = await createBaileysEngine();
const notifier = createTelegramNotifier({ token: config.telegramToken, logger });
const manager = new SessionManager({ config, engine, notifier, logger });
const server = createHttpServer({ config, manager, logger, notifier });

server.listen(config.port, config.host, async () => {
  logger.info('NEXORA MD backend ready', { port: config.port, notifications: notifier.enabled });
  startKeepAlive({ port: config.port, logger });
  // free the disk BEFORE reopening the sessions (a full volume breaks the writes of every account)
  try {
    manager.lastDisk = await diskGuard(config.sessionsDir, logger);
    await ensureReserve(config.sessionsDir, logger, config.reserveMb);
    logger.info('resources', { memory: memInfo(config.memoryLimitMb), disk: manager.lastDisk, max_sessions: config.maxSessions });
  } catch { /* the guard is best effort */ }
  cleanupSessions(config.sessionsDir, logger, { report: true }).catch(() => {});
  setInterval(() => cleanupSessions(config.sessionsDir, logger, { report: true }).catch(() => {}), 6 * 3600 * 1000).unref();
  // cheap disk check every 10 minutes: cleans harder when the volume is filling up
  setInterval(() => {
    diskGuard(config.sessionsDir, logger)
      .then(async (d) => {
        if (d) manager.lastDisk = d;
        if (d && d.usedPct < 75) await ensureReserve(config.sessionsDir, logger, config.reserveMb); // refill the reserve once there is room
      })
      .catch(() => {});
  }, 10 * 60 * 1000).unref();
  manager.restoreAll().catch((e) => logger.error('restoreAll failed', { err: e.message }));
});

const stop = async (sig) => {
  logger.info('shutting down', { sig });
  await manager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 6000).unref(); // time to save the pending session files
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

// Stay online: a stray error must never take every WhatsApp session down. We log it and keep going
// (the previous "exit after 8 errors in a minute" rule was restarting the whole bot in a loop).
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err: err?.message });
});

// Heartbeat: one line a minute with the memory used. If the host kills the bot (out of memory), the last
// lines of the log show it. Set MEMORY_WARN_MB to get a warning before that happens.
const warnMb = Number.parseInt(process.env.MEMORY_WARN_MB ?? '', 10) || 0;
const beat = setInterval(() => {
  const mem = memInfo(config.memoryLimitMb);
  const st = manager.stats();
  logger.info('heartbeat', {
    rss_mb: mem.rssMb,
    limit_mb: mem.limitMb,
    sessions: st.total_sessions,
    connected: st.connected_sessions,
    reconnecting: st.reconnecting_sessions,
    disk_used_pct: manager.lastDisk?.usedPct ?? null,
    up_s: Math.round(process.uptime()),
  });
  const high = (warnMb && mem.rssMb > warnMb) || (mem.limitMb && mem.pct >= 85);
  if (high) {
    logger.warn('memory high', { rss_mb: mem.rssMb, limit_mb: mem.limitMb, pct: mem.pct });
    globalThis.gc?.();
  }
}, 60_000);
beat.unref?.();
process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection', { err: err?.message || String(err) });
});
