// wa-newcmds.js — new commands (loaded by wa-extras.js)
//
//   ANIME     .itori .nezuko .miku .itachi .naruto .couplepp .animestatus   (.waifu and .neko stay in wa-content.js)
//   GAME      .game .rps .dice .flip .slot .8ball .guess .math
//   DOWNLOAD  .dl <link>  — video from (almost) any site: TikTok, Instagram, Facebook, X, YouTube, Pinterest, Reddit…
//
// Environment variables (all optional):
//   ARSLAN_API       base URL of the downloader API        (default https://arslan-apis-v2.vercel.app)
//   ARSLAN_DL_PATHS  comma separated endpoint paths to try  (default: see DEFAULT_PATHS below)
//
// Same reply style as the rest of the bot (box + typewriter font). Every media URL returned by a third-party API is
// checked with isPublicHttps() so it can never point to an internal network.

import { box } from './wa-menu.js';
import { isPublicHttps } from './wa-more.js';

const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/* ───────── ANIME ───────── */
const GIST = (id, file) => `https://gist.githubusercontent.com/AbhishekSuresh2/${id}/raw/${file}.json`;
const ANIME_LISTS = {
  itori: { url: GIST('276c7a325c5c75857215a6b07b20caf2', 'itori'), emoji: '🌸', kind: 'image' },
  nezuko: { url: GIST('9c8b667a7e116ca83895278113940b42', 'nezuko'), emoji: '🎋', kind: 'image' },
  miku: { url: GIST('94900564d03da00d7588c78f371ce761', 'miku'), emoji: '🎤', kind: 'image' },
  itachi: { url: GIST('d09e02e722f51f49f52b518c6acdf0c1', 'itachi'), emoji: '🌙', kind: 'image' },
  naruto: { url: GIST('a1324f33a66624a377f8de8c91df1941', 'naruto'), emoji: '🍥', kind: 'image' },
  couplepp: { url: GIST('78ca46a7a13e37de5a722d008ee224a0', 'couplepp'), emoji: '💞', kind: 'couple' },
  animestatus: { url: GIST('a66de9e857973fb4fa7f191a95ee9912', 'astatus'), emoji: '🎬', kind: 'video' },
};
export const ANIME_NAMES = Object.keys(ANIME_LISTS);
const LIST_TTL_MS = 30 * 60_000;

/* ───────── GAMES ───────── */
export const GAME_NAMES = ['game', 'rps', 'dice', 'flip', 'slot', '8ball', 'guess', 'math'];
const GAME_STATE_TTL_MS = 5 * 60_000;

/* ───────── DOWNLOADER ───────── */
export const DL_NAMES = ['dl'];
export const DL_ALIASES = { download: 'dl', alldl: 'dl', videodl: 'dl', getvideo: 'dl' };
const DEFAULT_PATHS = [
  '/download/alldl', '/download/aio', '/download/allinone', '/download/video', '/download/ytmp4',
  '/api/download/alldl', '/api/alldl', '/alldl', '/aio',
];
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // sent as a video
const MAX_DOC_BYTES = 100 * 1024 * 1024; // sent as a document
const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v)(\?|#|$)/i;
const NOT_VIDEO_RE = /\.(jpe?g|png|webp|gif|mp3|m4a|opus|ogg|aac|wav|vtt|srt|json|html?)(\?|#|$)/i;
const URL_RE = /https?:\/\/[^\s<>"']+/i;
const BAD_KEY_RE = /thumb|cover|poster|image|avatar|audio|music|photo|icon|preview/i;
const GOOD_KEY_RE = /^(hd|video|nowm|no_?wm|download|dl|play|url|link|sd|mp4|src)$/i;

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cut = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Walks any JSON answer and returns the best video URL (and a title when there is one). */
export function extractMedia(data) {
  const found = [];
  let title = '';
  const walk = (node, key, depth) => {
    if (node == null || depth > 7) return;
    if (typeof node === 'string') {
      if (/^https?:\/\//i.test(node)) found.push({ url: node.trim(), key: String(key || '') });
      return;
    }
    if (Array.isArray(node)) {
      node.slice(0, 60).forEach((x) => walk(x, key, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      if (!title && typeof node.title === 'string') title = node.title;
      for (const [k, v] of Object.entries(node)) walk(v, k, depth + 1);
    }
  };
  walk(data, '', 0);
  let best = null;
  for (const f of found) {
    if (NOT_VIDEO_RE.test(f.url) && !VIDEO_RE.test(f.url)) continue;
    let score = 0;
    if (VIDEO_RE.test(f.url)) score += 10;
    if (GOOD_KEY_RE.test(f.key)) score += 3;
    if (/hd/i.test(f.key)) score += 1;
    if (BAD_KEY_RE.test(f.key)) score -= 8;
    if (/googlevideo|video|mp4|download|cdn/i.test(f.url)) score += 1;
    if (!best || score > best.score) best = { ...f, score };
  }
  return best && best.score > -5 ? { url: best.url, title: cut(title, 90) } : null;
}

export function createNewCmds({ sock, send, log = () => {}, fetchImpl = globalThis.fetch, P }) {
  const react = (jid, m, emoji) => sock.sendMessage(jid, { react: { text: emoji, key: m.key } }).catch(() => {});

  const jget = async (url, { ms = 20_000 } = {}) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*' } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('not json');
    }
  };

  /* ═════════════ ANIME ═════════════ */
  const listCache = new Map(); // name -> { at, items }

  async function loadList(name) {
    const hit = listCache.get(name);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.items;
    const raw = await jget(ANIME_LISTS[name].url, { ms: 25_000 });
    const arr = Array.isArray(raw) ? raw : raw?.results || raw?.data || raw?.list || [];
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty list');
    listCache.set(name, { at: Date.now(), items: arr });
    return arr;
  }

  const urlOf = (x) => (typeof x === 'string' ? x : x?.url || x?.link || x?.image || x?.video || x?.src || '');

  const animeCmd = (name) => async ({ jid, m, reply }) => {
    const cfg = ANIME_LISTS[name];
    react(jid, m, cfg.emoji);
    try {
      const items = await loadList(name);
      const item = pickOne(items);
      const caption = box(`${cfg.emoji} ${name.toUpperCase()}`, ['Random pick ✨']);
      if (cfg.kind === 'couple') {
        const male = urlOf(item?.male);
        const female = urlOf(item?.female);
        if (!isPublicHttps(male, true) || !isPublicHttps(female, true)) throw new Error('bad couple item');
        await send(jid, { image: { url: male }, caption: box('💞 COUPLE PP', ['👦 Male']) }, m, true);
        await send(jid, { image: { url: female }, caption: box('💞 COUPLE PP', ['👧 Female']) }, m, true);
      } else {
        const u = urlOf(item);
        if (!isPublicHttps(u, true)) throw new Error('bad item');
        const isVideo = cfg.kind === 'video' || VIDEO_RE.test(u);
        await send(jid, isVideo ? { video: { url: u }, mimetype: 'video/mp4', caption } : { image: { url: u }, caption }, m, true);
      }
      react(jid, m, '✅');
    } catch (e) {
      log('warn', `anime ${name} failed`, { why: String(e?.message || '').slice(0, 60) });
      react(jid, m, '❌');
      return reply(box('❌ ANIME', [`Could not fetch ${name}. Try again.`]));
    }
    return null;
  };

  /* ═════════════ GAMES ═════════════ */
  const states = new Map(); // "chat|user|game" -> { until, ... }
  const who = (jid, m) => `${jid}|${m.key?.participant || (m.key?.fromMe ? 'me' : jid)}`;
  const getState = (jid, m, game) => {
    const k = `${who(jid, m)}|${game}`;
    const s = states.get(k);
    if (s && Date.now() > s.until) { states.delete(k); return null; }
    return s || null;
  };
  const setState = (jid, m, game, data) => {
    if (states.size > 500) states.delete(states.keys().next().value);
    states.set(`${who(jid, m)}|${game}`, { ...data, until: Date.now() + GAME_STATE_TTL_MS });
  };
  const clearState = (jid, m, game) => states.delete(`${who(jid, m)}|${game}`);

  const game = ({ reply }) =>
    reply(box('🎮 GAMES', [
      `${P()}rps <rock|paper|scissors> — play against the bot`,
      `${P()}dice — roll a dice`,
      `${P()}flip — heads or tails`,
      `${P()}slot — slot machine`,
      `${P()}8ball <question> — ask the magic ball`,
      `${P()}guess — guess a number from 1 to 20`,
      `${P()}math — quick calculation challenge`,
    ]));

  const RPS = { rock: '🪨', paper: '📄', scissors: '✂️' };
  const RPS_ALIAS = { r: 'rock', p: 'paper', s: 'scissors', pierre: 'rock', feuille: 'paper', ciseaux: 'scissors', wòch: 'rock', papye: 'paper', sizo: 'scissors' };
  const rps = ({ args, reply }) => {
    const a = String(args[0] || '').toLowerCase();
    const mine = RPS[a] ? a : RPS_ALIAS[a];
    if (!mine) return reply(box('🎮 ROCK PAPER SCISSORS', [`Usage : *${P()}rps rock* · *paper* · *scissors*`]));
    const bot = pickOne(Object.keys(RPS));
    const win = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    const res = mine === bot ? '🤝 Draw' : win[mine] === bot ? '🏆 You win!' : '😈 I win!';
    return reply(box('🎮 ROCK PAPER SCISSORS', [`You : ${RPS[mine]} ${mine}`, `Bot : ${RPS[bot]} ${bot}`, res]));
  };

  const dice = ({ reply }) => reply(box('🎲 DICE', [`You rolled : *${1 + Math.floor(Math.random() * 6)}*`]));
  const flip = ({ reply }) => reply(box('🪙 COIN', [Math.random() < 0.5 ? 'Heads 🙂' : 'Tails 🦅']));

  const SLOT = ['🍒', '🍋', '🍉', '⭐', '💎', '7️⃣'];
  const slot = ({ reply }) => {
    const r = [pickOne(SLOT), pickOne(SLOT), pickOne(SLOT)];
    const same = new Set(r).size;
    const res = same === 1 ? '🎉 JACKPOT!' : same === 2 ? '😮 Almost… two match' : '😅 No luck, try again';
    return reply(box('🎰 SLOT', [`| ${r.join(' | ')} |`, res]));
  };

  const BALL = ['Yes ✅', 'No ❌', 'Maybe 🤔', 'Definitely 💯', 'Ask again later ⏳', 'I doubt it 😬', 'Without a doubt 🔥', 'Very unlikely 🧊'];
  const ball = ({ q, reply }) => {
    if (!q) return reply(box('🎱 8BALL', [`Usage : *${P()}8ball <question>*`]));
    return reply(box('🎱 8BALL', [`Q : ${cut(q, 100)}`, `A : *${pickOne(BALL)}*`]));
  };

  const guess = ({ args, jid, m, reply }) => {
    const st = getState(jid, m, 'guess');
    const n = Number.parseInt(args[0], 10);
    if (!st) {
      setState(jid, m, 'guess', { secret: 1 + Math.floor(Math.random() * 20), tries: 5 });
      if (!Number.isFinite(n)) return reply(box('🔢 GUESS', ['I picked a number from 1 to 20.', 'You have *5* tries.', `Play : *${P()}guess <number>*`]));
    }
    const cur = getState(jid, m, 'guess');
    if (!Number.isFinite(n) || n < 1 || n > 20) return reply(box('🔢 GUESS', [`Send a number from 1 to 20: *${P()}guess 7*`]));
    cur.tries -= 1;
    if (n === cur.secret) {
      clearState(jid, m, 'guess');
      return reply(box('🔢 GUESS', [`🎉 Correct! It was *${cur.secret}*.`]));
    }
    if (cur.tries <= 0) {
      clearState(jid, m, 'guess');
      return reply(box('🔢 GUESS', [`💀 Game over. It was *${cur.secret}*.`]));
    }
    return reply(box('🔢 GUESS', [n < cur.secret ? 'Higher ⬆️' : 'Lower ⬇️', `Tries left : *${cur.tries}*`]));
  };

  const math = ({ args, jid, m, reply }) => {
    const st = getState(jid, m, 'math');
    const ans = args[0] != null && args[0] !== '' ? Number(args[0]) : NaN;
    if (st && Number.isFinite(ans)) {
      clearState(jid, m, 'math');
      return reply(box('➕ MATH', [ans === st.answer ? '🎉 Correct!' : `❌ Wrong. The answer was *${st.answer}*.`]));
    }
    const a = 2 + Math.floor(Math.random() * 40);
    const b = 2 + Math.floor(Math.random() * 12);
    const op = pickOne(['+', '-', '×']);
    const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
    setState(jid, m, 'math', { answer });
    return reply(box('➕ MATH', [`${a} ${op} ${b} = ?`, `Answer with *${P()}math <number>* (5 min).`]));
  };

  /* ═════════════ DOWNLOADER ═════════════ */
  const apiBase = () => String(process.env.ARSLAN_API || 'https://arslan-apis-v2.vercel.app').replace(/\/+$/, '');
  const apiPaths = () =>
    (process.env.ARSLAN_DL_PATHS ? process.env.ARSLAN_DL_PATHS.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_PATHS);

  /** Tries every endpoint at the same time, the first one that returns a real video link wins. */
  async function fromArslan(link) {
    const base = apiBase();
    const tries = apiPaths().map(async (p) => {
      const path = p.startsWith('/') ? p : `/${p}`;
      const data = await jget(`${base}${path}?url=${encodeURIComponent(link)}`, { ms: 25_000 });
      const hit = extractMedia(data);
      if (!hit || !isPublicHttps(hit.url, true)) throw new Error('no video');
      return { ...hit, source: path };
    });
    return Promise.any(tries);
  }

  /** Backup sources already used elsewhere in the bot. */
  async function fromBackups(link) {
    const backups = [
      async () => extractMedia(await jget(`https://tele-social.vercel.app/down?url=${encodeURIComponent(link)}`, { ms: 20_000 })),
      async () => {
        if (!/tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(link)) return null;
        const res = await fetchImpl('https://www.tikwm.com/api/', {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'user-agent': UA },
          body: new URLSearchParams({ url: link }).toString(),
        });
        const d = (await res.json())?.data;
        return d?.play ? { url: d.play, title: cut(d.title, 90) } : null;
      },
    ];
    for (const b of backups) {
      try {
        const hit = await b();
        if (hit?.url && isPublicHttps(hit.url, true)) return { ...hit, source: 'backup' };
      } catch (e) {
        log('warn', 'dl backup failed', { why: String(e?.message || '').slice(0, 50) });
      }
    }
    return null;
  }

  async function remoteSize(url) {
    try {
      const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': UA }, redirect: 'follow' });
      const n = Number(res.headers.get('content-length'));
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  const quotedLink = (content) => {
    const q = content?.extendedTextMessage?.contextInfo?.quotedMessage;
    const t = q ? String(q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || '') : '';
    return t.match(URL_RE)?.[0] || '';
  };

  const dl = async ({ q, content, jid, m, reply }) => {
    const link = (String(q || '').match(URL_RE)?.[0] || quotedLink(content)).trim();
    if (!link) {
      return reply(box('📥 VIDEO DOWNLOADER', [`Usage : *${P()}dl <video link>*`, 'Works with TikTok, Instagram, Facebook, X, YouTube, Pinterest, Reddit…', 'You can also reply to a message that contains a link.']));
    }
    if (!isPublicHttps(link, true)) return reply(box('❌ DOWNLOAD', ['Invalid link.']));
    react(jid, m, '⏳');
    let hit = null;
    try {
      hit = await fromArslan(link);
    } catch (e) {
      log('warn', 'dl api failed', { why: String(e?.errors?.[0]?.message || e?.message || '').slice(0, 60) });
    }
    if (!hit) hit = await fromBackups(link);
    if (!hit) {
      react(jid, m, '❌');
      return reply(box('❌ DOWNLOAD', ['No downloadable video found.', 'The post may be private, or the link is not supported.']));
    }
    const size = await remoteSize(hit.url);
    const caption = box('📥 VIDEO', [hit.title ? `Title : *${hit.title}*` : 'Downloaded ✅']);
    try {
      if (size > MAX_DOC_BYTES) {
        react(jid, m, '⚠️');
        return reply(box('⚠️ VIDEO TOO BIG', ['The file is bigger than 100 MB.', `Direct link : ${hit.url}`]));
      }
      if (size > MAX_VIDEO_BYTES) {
        await send(jid, { document: { url: hit.url }, mimetype: 'video/mp4', fileName: `${hit.title || 'video'}.mp4`.replace(/[\\/:*?"<>|]/g, ''), caption }, m, true);
      } else {
        await send(jid, { video: { url: hit.url }, mimetype: 'video/mp4', caption }, m, true);
      }
      react(jid, m, '✅');
    } catch (e) {
      log('warn', 'dl send failed', { why: String(e?.message || '').slice(0, 60) });
      react(jid, m, '❌');
      return reply(box('❌ DOWNLOAD', ['The video could not be sent.', `Direct link : ${hit.url}`]));
    }
    return null;
  };

  const handlers = {
    ...Object.fromEntries(ANIME_NAMES.map((n) => [n, animeCmd(n)])),
    game, rps, dice, flip, slot, '8ball': ball, guess, math,
    dl,
  };
  return { handlers };
}
