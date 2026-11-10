// Shared helpers for the Vercel functions. The API key stays on the server (Vercel env vars).
const crypto = require('node:crypto');

const PHONE_RE = /^[1-9]\d{7,14}$/;

// The backend wants a numeric id (1-15 digits). Web visitors get a stable 15-digit id derived from
// their number, starting with 9, so it never mixes with real Telegram ids.
function webId(phone) {
  const h = crypto.createHash('sha256').update('nexora-web:' + (process.env.WEB_SALT || '') + phone).digest();
  const n = h.readBigUInt64BE(0) % 100000000000000n;
  return '9' + n.toString().padStart(14, '0');
}

async function backend(path, opts) {
  const base = String(process.env.BACKEND_URL || '').replace(/\/+$/, '');
  if (!base || !process.env.API_KEY) throw new Error('not configured');
  const r = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.API_KEY },
    signal: AbortSignal.timeout(55000),
  });
  let data = {};
  try { data = await r.json(); } catch (e) { data = {}; }
  return { status: r.status, data };
}

// Best-effort limiter (memory of one function instance). The backend also limits 3 codes / 10 min per number.
const hits = new Map();
function limited(req, max, windowMs) {
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  const now = Date.now();
  if (hits.size > 2000) hits.clear();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  return false;
}

module.exports = { PHONE_RE, webId, backend, limited };
