import { loadConfig } from './config.js';
import { createLogger } from './util.js';
import { createTelegramNotifier } from './notifier.js';
import { createBaileysEngine } from './engine-baileys.js';
import { SessionManager } from './sessions.js';
import { createHttpServer } from './server.js';
import { startKeepAlive } from './keepalive.js';
import { cleanupSessions } from './cleanup.js';

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

server.listen(config.port, config.host, () => {
  logger.info('NEXORA MD backend ready', { port: config.port, notifications: notifier.enabled });
  startKeepAlive({ port: config.port, logger });
  cleanupSessions(config.sessionsDir, logger).catch(() => {});
  setInterval(() => cleanupSessions(config.sessionsDir, logger).catch(() => {}), 6 * 3600 * 1000).unref();
  manager.restoreAll().catch((e) => logger.error('restoreAll failed', { err: e.message }));
});

const stop = async (sig) => {
  logger.info('shutting down', { sig });
  await manager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
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
  const mb = Math.round(process.memoryUsage().rss / 1048576);
  logger.info('heartbeat', { rss_mb: mb, sessions: manager.sessions.size, up_s: Math.round(process.uptime()) });
  if (warnMb && mb > warnMb) {
    logger.warn('memory high', { rss_mb: mb, warn_mb: warnMb });
    globalThis.gc?.();
  }
}, 60_000);
beat.unref?.();
process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection', { err: err?.message || String(err) });
});
