// POST /api/pair  { phone }  ->  { ok, status, code, expires_in }
const { PHONE_RE, webId, backend, limited } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const fail = (code, status, message, extra) => res.status(code).json({ ok: false, error: { code: status, message, ...extra } });

  if (req.method !== 'POST') return fail(405, 'METHOD', 'Method not allowed.');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.website) return fail(400, 'BLOCKED', 'Request blocked.'); // honeypot field, humans leave it empty

  const phone = String(body.phone || '').replace(/\D/g, '');
  if (!PHONE_RE.test(phone)) return fail(400, 'BAD_PHONE', 'Enter 8 to 15 digits with the country code, no plus and no leading zero.');
  if (limited(req, 5, 10 * 60 * 1000)) return fail(429, 'RATE_LIMITED', 'Too many requests. Try again in a few minutes.');

  try {
    const { status, data } = await backend('/v1/connect', {
      method: 'POST',
      body: JSON.stringify({ tg_id: webId(phone), phone }),
    });
    if (!data.ok) {
      const e = data.error || {};
      return fail(status >= 400 ? status : 502, e.code || 'ERROR', e.message || 'Could not create the code.', { retry_after: e.retry_after });
    }
    return res.status(200).json({ ok: true, status: data.status, code: data.code || null, expires_in: data.expires_in || 180 });
  } catch (e) {
    return fail(502, 'UNREACHABLE', 'Service unavailable. Try again in a moment.');
  }
};
