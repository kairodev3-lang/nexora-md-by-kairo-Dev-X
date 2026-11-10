// GET /api/stats  ->  { ok, connected }   (cached 10 s)
const { backend } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('cache-control', 's-maxage=10, stale-while-revalidate=20');
  try {
    const { data } = await backend('/v1/stats', { method: 'GET' });
    if (!data.ok) return res.status(200).json({ ok: false });
    return res.status(200).json({ ok: true, connected: data.connected_sessions || 0 });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
};
