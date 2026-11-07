// Keep-alive: stops free hosts (Render, Koyeb, Replit, Railway trial…) from putting the bot to sleep
// after a few minutes without HTTP traffic. Pings /health on the local server and on the public URL
// of the deployment (auto-detected, or set KEEPALIVE_URL). KEEPALIVE_SEC changes the delay (default 60 s).

const publicUrl = (env = process.env) => {
  const direct = env.KEEPALIVE_URL || env.RENDER_EXTERNAL_URL || env.APP_URL || env.PUBLIC_URL;
  if (direct) return direct;
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.KOYEB_PUBLIC_DOMAIN) return `https://${env.KOYEB_PUBLIC_DOMAIN}`;
  if (env.REPLIT_DEV_DOMAIN) return `https://${env.REPLIT_DEV_DOMAIN}`;
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  return '';
};

export function startKeepAlive({ port, logger, env = process.env, fetchImpl = globalThis.fetch }) {
  const targets = [`http://127.0.0.1:${port}/health`];
  const pub = publicUrl(env);
  if (pub) {
    try {
      targets.push(new URL('/health', /^https?:\/\//i.test(pub) ? pub : `https://${pub}`).href);
    } catch {
      logger.warn('keep-alive: invalid public URL, only pinging locally');
    }
  }
  const sec = Number.parseInt(env.KEEPALIVE_SEC ?? '', 10);
  const everyMs = (Number.isFinite(sec) && sec >= 20 ? sec : 60) * 1000;
  const tick = () => {
    for (const url of targets) fetchImpl(url, { signal: AbortSignal.timeout(15_000) }).catch(() => {});
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  logger.info('keep-alive started', { every_s: everyMs / 1000, public: Boolean(pub) });
  return () => clearInterval(timer);
}
