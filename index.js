import { loadConfig } from './config.js';
import { createLogger } from './util.js';
import { createTelegramNotifier } from './notifier.js';
import { createBaileysEngine } from './engine-baileys.js';
import { SessionManager } from './sessions.js';
import { createHttpServer } from './server.js';
import { startKeepAlive } from './keepalive.js';

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

// Stay online: a stray error must not take every WhatsApp session down. We log it and keep going;
// only a real crash loop (8 errors in a minute) exits so the supervisor (Docker restart / PM2) can restart us.
const recentErrors = [];
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { err: err?.message });
  const now = Date.now();
  recentErrors.push(now);
  while (recentErrors.length && now - recentErrors[0] > 60_000) recentErrors.shift();
  if (recentErrors.length >= 8) process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection', { err: err?.message || String(err) });
});
