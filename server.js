// Minimal HTTP API (node:http, zero dependency) called by Telebot Creator.
//
//   GET  /health                public — { ok, uptime_s }
//   POST /v1/connect            { tg_id, phone }  -> { status:'pairing', code, expires_in } | { status:'already_connected' }
//   GET  /v1/status?tg_id=...   -> { state, phone (masqué), connected_since }
//   POST /v1/disconnect         { tg_id }         -> { found }
//
// All /v1 routes require the x-api-key header.

import http from 'node:http';
import crypto from 'node:crypto';
import { ApiError, RateLimiter } from './util.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const MAX_BODY = 4096;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError('TOO_LARGE', 413, 'Request too large.'));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
        resolve(v);
      } catch {
        reject(new ApiError('BAD_JSON', 400, 'Invalid JSON body.'));
      }
    });
    req.on('error', () => reject(new ApiError('BAD_REQUEST', 400, 'Invalid request.')));
  });
}

export function createHttpServer({ config, manager, logger, notifier = null, startedAt = Date.now() }) {
  const apiHash = sha(config.apiKey);
  const connectLimiter = new RateLimiter(3, 10 * 60_000); // 3 code requests / 10 min / user
  const globalLimiter = new RateLimiter(300, 60_000);

  const authOk = (req) => {
    const h = req.headers['x-api-key'];
    return typeof h === 'string' && crypto.timingSafeEqual(sha(h), apiHash);
  };

  const send = (res, status, body, headers = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(data);
  };

  async function route(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, { ok: true, name: 'NEXORA MD', status: 'online' });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, uptime_s: Math.floor((Date.now() - startedAt) / 1000) });
    }
    if (!url.pathname.startsWith('/v1/')) throw new ApiError('NOT_FOUND', 404, 'Unknown route.');

    if (!authOk(req)) throw new ApiError('UNAUTHORIZED', 401, 'Invalid API key.');
    const g = globalLimiter.hit('all');
    if (!g.ok) throw new ApiError('RATE_LIMITED', 429, 'Too many requests.', { retry_after: g.retryAfterSec });

    if (url.pathname === '/v1/connect') {
      if (req.method !== 'POST') throw new ApiError('METHOD', 405, 'Method not allowed.');
      const body = await readJson(req);
      const lim = connectLimiter.hit(String(body.tg_id));
      if (!lim.ok) {
        throw new ApiError('RATE_LIMITED', 429, `Too many code requests. Try again in ${Math.ceil(lim.retryAfterSec / 60)} min.`, {
          retry_after: lim.retryAfterSec,
        });
      }
      const result = await manager.connect(body.tg_id, body.phone);
      let delivered = false;
      if (result.status === 'pairing' && result.code && notifier?.enabled && notifier.sendTemp) {
        const html =
          '🔐 <b>PAIRING CODE</b>\n━━━━━━━━━━━━━━━━━━━━\n\n' +
          '<code>' + result.code + '</code>\n<i>(tap the code to copy it)</i>\n\n' +
          '1️⃣ Open <b>WhatsApp</b> on the phone of number +' + String(result.phone || '').replace('+', '') + '\n' +
          '2️⃣ <b>Settings → Linked devices → Link a device</b>\n' +
          '3️⃣ Choose <b>"Link with phone number instead"</b>\n' +
          '4️⃣ Enter the code above\n\n' +
          '⏳ This message deletes itself in 10 minutes. If WhatsApp rejects the code, run <code>.connect</code> again.\n' +
          '🔒 Never share this code with anyone.';
        delivered = await notifier.sendTemp(body.tg_id, html, 10 * 60_000);
      }
      return send(res, 200, { ok: true, ...result, delivered });
    }

    if (url.pathname === '/v1/status') {
      if (req.method !== 'GET') throw new ApiError('METHOD', 405, 'Method not allowed.');
      return send(res, 200, { ok: true, ...manager.status(url.searchParams.get('tg_id')) });
    }

    if (url.pathname === '/v1/disconnect') {
      if (req.method !== 'POST') throw new ApiError('METHOD', 405, 'Method not allowed.');
      const body = await readJson(req);
      return send(res, 200, { ok: true, ...(await manager.disconnect(body.tg_id)) });
    }

    throw new ApiError('NOT_FOUND', 404, 'Unknown route.');
  }

  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    let status = 500;
    try {
      const url = new URL(req.url, 'http://localhost');
      await route(req, res, url);
      status = res.statusCode;
    } catch (err) {
      if (err instanceof ApiError) {
        status = err.status;
        const headers = err.extra?.retry_after ? { 'retry-after': String(err.extra.retry_after) } : {};
        send(res, err.status, { ok: false, error: { code: err.code, message: err.message, ...err.extra } }, headers);
      } else {
        logger.error('unhandled', { err: err?.message });
        send(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Internal error.' } });
      }
    } finally {
      // never log a body, number, code or key
      logger.info('http', { method: req.method, path: (req.url || '').split('?')[0], status, ms: Date.now() - t0 });
    }
  });
}
