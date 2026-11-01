// WhatsApp text commands (default prefix "." — change it with .setprefix).
// They only answer messages written by the owner of the linked account
// (see engine-baileys.js). Closed list: no dynamic commands, no eval.

export const PREFIX = '.';

const DEFAULT_BRAND = {
  botName: 'NEXORA MD',
  ownerName: 'KAIRO',
  ownerNumber: '+50939360237',
  ownerTg: '',
  ownerWa: 'https://wa.me/50939360237',
  channelLink: 'https://whatsapp.com/channel/0029VbDmi1g77qVOA4cfRq13',
};

// Single source of truth for the command list (menu + .alive counter).
export const SECTIONS = [
  { icon: '🏠', title: 'GENERAL', bullet: '✧', cmds: ['menu', 'help', 'owner'] },
  { icon: '⚡', title: 'SESSION', bullet: '◈', cmds: ['alive', 'ping', 'runtime', 'status'] },
  { icon: '📥', title: 'DOWNLOAD', bullet: '⌁', cmds: ['apk', 'song', 'video', 'tiktok', 'facebook', 'instagram', 'twitter', 'pinterest', 'telegram'] },
  { icon: '🧸', title: 'MEDIA', bullet: '✧', cmds: ['sticker', 'tourl', 'vv', 'vv2', 'save', 'fancy'] },
  { icon: '👥', title: 'GROUP', bullet: '◈', cmds: ['kick', 'kickall', 'tagall'] },
  { icon: '🛠️', title: 'OWNER', bullet: '⌁', cmds: ['getid', 'idch', 'unblock', 'pair', 'depair'] },
  {
    icon: '⚙️',
    title: 'SETTINGS',
    bullet: '✧',
    cmds: ['mode', 'setprefix', 'autoread', 'autotyping', 'autorecording', 'anticall', 'welcome', 'goodbye', 'autoviewstatus', 'autolikestatus', 'channelboost'],
  },
];
export const COMMAND_COUNT = SECTIONS.reduce((n, s) => n + s.cmds.length, 0);

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m ${s % 60}s`;
}

/** Mathematical bold text (𝐏𝐎𝐖𝐄𝐑𝐄𝐃) for the signature. */
export function boldUnicode(str) {
  return [...String(str)]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d400 + c - 65);
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d41a + c - 97);
      if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ce + c - 48);
      return ch;
    })
    .join('');
}

/** Typewriter font text (𝙼𝙴𝙽𝚄). */
export function mono(str) {
  return [...String(str)]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d670 + c - 65);
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d68a + c - 97);
      return ch;
    })
    .join('');
}

// Never restyled: `code`, links, @mentions, commands (.song) and <placeholders> must stay typable / clickable.
const KEEP = /`[^`]*`|https?:\/\/\S+|@\w+|(?<![\w])[.!#+\-$~^?&][A-Za-z]\w*|<[^>\n]*>/g;

/** Applies the bot's writing style (typewriter font) to a sentence, leaving codes, links and commands intact. */
export function styleText(str) {
  const s = String(str);
  let out = '';
  let last = 0;
  for (const m of s.matchAll(KEEP)) {
    out += mono(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + mono(s.slice(last));
}

const LINE_END = '└━━━━━━━━━━━━━━━━─●─○';

/** Plain frame: ┌─『 title 』 │ ✧ line … └━━━ */
export function plainBox(title, lines, bullet = '✧') {
  return [`┌─『 ${title} 』`, ...lines.map((l) => `│ ${bullet} ${l}`), LINE_END].join('\n');
}

/** Frame used by every bot reply (typewriter font on the text; codes, links and commands stay intact). */
export function box(title, lines, bullet = '✧') {
  return plainBox(styleText(String(title).replace(/\*/g, '')), lines.map(styleText), bullet);
}

export function signature(b = DEFAULT_BRAND) {
  return `*⟪ ${mono('POWERED BY')} ${mono(String(b.ownerName).toUpperCase())} 〆 ${mono('DEV')} ⟫*`;
}

// The menu is recognised by this prefix so the engine can attach menu.jpg to it.
export const MENU_MARK = '╭━━━⟦';
export const isMenuText = (t) => typeof t === 'string' && t.startsWith(MENU_MARK);

const TZ = 'America/Port-au-Prince';

/** Menu: info frame, then one frame per category with ONE command per line. */
export function buildMenu(ctx = {}) {
  const b = { ...DEFAULT_BRAND, ...(ctx.brand || {}) };
  const P = ctx.prefix || PREFIX;
  const now = new Date(ctx.now ?? Date.now());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);
  const out = [
    `╭━━━⟦ *${b.botName}* ⟧━━━╮`,
    `┃ ▸ Prefix   : ${P}`,
    `┃ ▸ Platform : ${process.env.RAILWAY_ENVIRONMENT ? 'RAILWAY' : 'SERVER'}`,
    `┃ ▸ Commands : ${COMMAND_COUNT}`,
    `┃ ▸ Time     : ${time}`,
    `┃ ▸ Date     : ${date}`,
    `┃ ▸ Owner    : ${b.ownerName}`,
    '╰━━━━━━━━━━━━━━━━━━╯',
  ];
  // one command per line
  for (const s of SECTIONS) out.push('', plainBox(`${s.icon} ${mono(s.title)}`, s.cmds.map((c) => `${P}${c}`), s.bullet));
  out.push('', signature(b));
  return out.join('\n');
}

/** @returns {string|null} reply text, or null when the command is unknown. */
export function handleWaCommand(text, ctx = {}) {
  const P = ctx.prefix || PREFIX;
  const t = String(text || '').trim();
  if (!t.startsWith(P)) return null;
  const cmd = t.slice(P.length).split(/\s+/)[0].toLowerCase();
  const b = { ...DEFAULT_BRAND, ...(ctx.brand || {}) };
  const now = ctx.now ?? Date.now();
  const since = (v) => (v ? fmtDuration(now - v) : '—');

  switch (cmd) {
    case 'menu':
    case 'help':
      return buildMenu(ctx);
    case 'ping':
      return box('🏓 PING', [`Pong! ${ctx.latencyMs != null ? `${ctx.latencyMs} ms` : '✅'}`]);
    case 'alive':
      return `${box('🟢 ALIVE', [
        `Bot      : *${b.botName}*`,
        'Status   : *Online* ✅',
        `Owner    : *${b.ownerName}*`,
        `Prefix   : *${P}*`,
        `Commands : *${COMMAND_COUNT}*`,
        `Uptime   : *${since(ctx.startedAt)}*`,
      ])}`;
    case 'runtime':
      return box('⏱️ RUNTIME', [`Service : ${since(ctx.startedAt)}`, `Session : ${since(ctx.sessionSince)}`]);
    case 'status':
      return box('📡 SESSION', ['State : 🟢 connected', `Since : ${since(ctx.sessionSince)}`]);
    case 'owner':
      return box(
        '👑 OWNER',
        [
          `Created by : ${b.ownerName}`,
          `Number : ${b.ownerNumber}`,
          b.ownerTg ? `Telegram : ${b.ownerTg}` : null,
          b.ownerWa ? `WhatsApp : ${b.ownerWa}` : null,
          b.channelLink ? `Channel : ${b.channelLink}` : null,
        ].filter(Boolean),
      );
    default:
      return null; // unknown command: stay silent
  }
}
