// GET /api/status?phone=...  ->  { ok, state }   (state only, never the number)
const { PHONE_RE, webId, backend, limited } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const phone = String((req.query && req.query.phone) || '').replace(/\D/g, '');
  if (!PHONE_RE.test(phone)) return res.status(400).json({ ok: false });
  if (limited(req, 120, 10 * 60 * 1000)) return res.status(429).json({ ok: false });
  try {
    const { data } = await backend('/v1/status?tg_id=' + webId(phone), { method: 'GET' });
    return res.status(200).json({ ok: !!data.ok, state: data.state || 'none' });
  } catch (e) {
    return res.status(502).json({ ok: false });
  }
};
