// wa-games.js — game commands (loaded by wa-newcmds.js)
//
//   .dungeon   text RPG (reply with a number, then "attack" / "run")
//   .tekateki  riddles (reply with the answer in the chat)
//   .dinorun .pinzo .pixzo .xozo [.zonic]   HTML games, sent as an .html file → open it in the phone browser
//
// The HTML games live in ./game/*.html (or ./games/). To add the ZONIC game, drop a file named zonic.html in that folder.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { box } from './wa-menu.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// the folder may be called "game" or "games"
const DIRS = ['game', 'games'].map((d) => path.join(ROOT, d));
const htmlPath = (name) => DIRS.map((d) => path.join(d, `${name}.html`)).find((f) => fs.existsSync(f)) || null;

const HTML_GAMES = {
  dinorun: { title: '🦖 DINO RUN', desc: 'Endless runner: jump, duck, collect coins.', how: 'Tap = jump · swipe down / hold the button = duck.' },
  pinzo: { title: '🎹 PIANO', desc: 'Piano with 7 keys (Do Re Mi Fa Sol La Si).', how: 'Tap the keys.' },
  pixzo: { title: '🟡 PIXEL MAZE', desc: 'Maze game: eat every dot and avoid the ghosts.', how: 'Use the arrow buttons.' },
  xozo: { title: '❌⭕ TIC TAC TOE', desc: 'You vs robot: 3×3, 4×4 or 8×8, three levels.', how: 'Tap a cell to play.' },
  zonic: { title: '🔵 ZONIC', desc: 'Speed adventure.', how: 'Follow the on-screen controls.' },
};
const htmlAvailable = (name) => Boolean(htmlPath(name));

export const GAME_NAMES = ['game', 'dungeon', 'tekateki', ...Object.keys(HTML_GAMES).filter(htmlAvailable)];
export const GAME_ALIASES = { dg: 'dungeon', explore: 'dungeon', teka: 'tekateki', riddle: 'tekateki', dino: 'dinorun', piano: 'pinzo', maze: 'pixzo', tictactoe: 'xozo', ttt: 'xozo', games: 'game' };

const TTL_MS = 5 * 60_000;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/* ───────── DUNGEON ───────── */
const DUNGEONS = [
  { id: 1, name: '🌲 Dark Forest', lv: 1, monsters: ['Wild Goblin', 'Giant Slime', 'Night Wolf', 'Forest Bandit'], exp: [60, 140], drop: 40 },
  { id: 2, name: '🍄 Poison Swamp', lv: 3, monsters: ['Mutant Toad', 'Walking Tree', 'Venom Spider', 'Swamp Viper'], exp: [120, 220], drop: 45 },
  { id: 3, name: '🏰 Old Castle', lv: 5, monsters: ['Skeleton Soldier', 'Starving Zombie', 'Restless Ghost', 'Stone Gargoyle'], exp: [180, 320], drop: 50 },
  { id: 4, name: '🏜️ Death Desert', lv: 8, monsters: ['Giant Scorpion', 'Risen Mummy', 'Desert Worm', 'Evil Jinn'], exp: [260, 440], drop: 55 },
  { id: 5, name: '🌋 Volcano', lv: 11, monsters: ['Fire Elemental', 'Magma Golem', 'Baby Dragon', 'Hellhound'], exp: [360, 600], drop: 60 },
  { id: 6, name: '🧊 Eternal Ice Cave', lv: 14, monsters: ['Ice Golem', 'Frost Giant', 'Angry Yeti', 'Snow Wolf'], exp: [480, 780], drop: 65 },
  { id: 7, name: '👹 Deepest Hell', lv: 18, monsters: ['Red Demon', 'Deadly Succubus', 'Cerberus', 'Demon King'], exp: [700, 1100], drop: 80 },
];
const LOOT = [
  { item: 'iron', chance: 40, qty: [1, 5], icon: '⛏️' },
  { item: 'gold', chance: 20, qty: [1, 3], icon: '🪙' },
  { item: 'diamond', chance: 5, qty: [1, 2], icon: '💎' },
  { item: 'potion', chance: 30, qty: [1, 3], icon: '🧪' },
  { item: 'herb', chance: 25, qty: [2, 6], icon: '🌿' },
  { item: 'leather', chance: 35, qty: [2, 5], icon: '👞' },
  { item: 'mystery box', chance: 3, qty: [1, 1], icon: '📦' },
];
const STAMINA_COST = 30;
const levelOf = (exp) => 1 + Math.floor(exp / 400);

export function createGames({ sock, send, P, log = () => {} }) {
  /* ═════════════ HTML GAMES ═════════════ */
  const htmlGame = (name) => async ({ jid, m, reply }) => {
    const g = HTML_GAMES[name];
    let buf;
    try {
      buf = await fsp.readFile(htmlPath(name));
    } catch {
      return reply(box(g.title, ['This game file is missing on the server.']));
    }
    sock.sendMessage(jid, { react: { text: '🎮', key: m.key } }).catch(() => {});
    return send(jid, {
      document: buf,
      mimetype: 'text/html',
      fileName: `${name}.html`,
      caption: box(g.title, [g.desc, g.how, '📲 Open the file with Chrome / your browser to play.']),
    }, m, true);
  };

  /* ═════════════ DUNGEON ═════════════ */
  const players = new Map(); // "jid|user" -> profile
  const sessions = new Map(); // "jid|user" -> { stage, until, ... }
  const userKey = (jid, m) => `${jid}|${m.key?.participant || (m.key?.fromMe ? 'me' : jid)}`;
  const profile = (k) => {
    let p = players.get(k);
    if (!p) {
      if (players.size > 1000) players.delete(players.keys().next().value);
      p = { exp: 0, hp: 100, stamina: 100, inv: {}, at: Date.now() };
      players.set(k, p);
    }
    const mins = (Date.now() - p.at) / 60_000; // slow regeneration
    p.stamina = Math.min(100, p.stamina + Math.floor(mins * 2));
    p.hp = Math.min(100, p.hp + Math.floor(mins * 3));
    if (mins >= 0.5) p.at = Date.now();
    return p;
  };
  const getSession = (k) => {
    const s = sessions.get(k);
    if (s && Date.now() > s.until) { sessions.delete(k); return null; }
    return s || null;
  };
  const setSession = (k, data) => {
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    sessions.set(k, { ...data, until: Date.now() + TTL_MS });
  };

  const dungeon = async ({ args, jid, m, reply }) => {
    const k = userKey(jid, m);
    const p = profile(k);
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'bag' || sub === 'inv' || sub === 'inventory') {
      const items = Object.entries(p.inv).map(([n, q]) => `• ${n} ×${q}`);
      return reply(box('🎒 INVENTORY', items.length ? items : ['Empty. Win fights to find loot.']));
    }
    if (sub === 'heal' || sub === 'potion') {
      if (!p.inv.potion) return reply(box('🧪 POTION', ['You have no potion.']));
      p.inv.potion -= 1;
      if (!p.inv.potion) delete p.inv.potion;
      p.hp = Math.min(100, p.hp + 50);
      return reply(box('🧪 POTION', [`+50 HP → *${p.hp}/100*`]));
    }
    const lv = levelOf(p.exp);
    setSession(k, { stage: 'lobby' });
    const rows = DUNGEONS.map((d) => (lv >= d.lv ? `🔓 *${d.id}.* ${d.name} (Lv ${d.lv}+)` : `🔒 *${d.id}.* ${d.name} (needs Lv ${d.lv})`));
    return reply(box('🏰 DUNGEON', [
      `Level *${lv}* · EXP *${p.exp}*`,
      `❤️ HP *${p.hp}/100* · ⚡ Stamina *${p.stamina}/100*`,
      '',
      ...rows,
      '',
      'Reply with a *number* to enter, or *cancel*.',
      `Also : *${P()}dungeon bag* · *${P()}dungeon heal*`,
    ]));
  };

  const dungeonText = async (text, { jid, m, reply }) => {
    const k = userKey(jid, m);
    const s = getSession(k);
    if (!s || !['lobby', 'fight'].includes(s.stage)) return false;
    const t = text.trim().toLowerCase();
    const p = profile(k);
    if (['cancel', 'exit', 'quit', 'kite', 'batal'].includes(t)) {
      sessions.delete(k);
      await reply(box('🚪 DUNGEON', ['You left the dungeon safely.']));
      return true;
    }
    if (s.stage === 'lobby') {
      if (!/^\d{1,2}$/.test(t)) return false;
      const d = DUNGEONS.find((x) => x.id === Number(t));
      if (!d) { await reply(box('❌ DUNGEON', ['No dungeon with that number.'])); return true; }
      const lv = levelOf(p.exp);
      if (lv < d.lv) { await reply(box('🔒 LOCKED', [`${d.name} needs *Lv ${d.lv}* (you are Lv ${lv}).`])); return true; }
      if (p.stamina < STAMINA_COST) { await reply(box('⚡ NO STAMINA', [`You need ${STAMINA_COST} stamina, you have ${p.stamina}.`, 'Wait a few minutes to recover.'])); return true; }
      if (p.hp <= 10) { await reply(box('💔 TOO WEAK', ['Your HP is too low.', `Use *${P()}dungeon heal* (potion) or wait.`])); return true; }
      p.stamina -= STAMINA_COST;
      const monster = pick(d.monsters);
      const power = d.lv * 6 + rand(0, 25);
      setSession(k, { stage: 'fight', d, monster, power });
      await reply(box('🚪 ENCOUNTER', [
        `You enter *${d.name}*… (⚡ -${STAMINA_COST})`,
        `A *👹 ${monster}* blocks your way!`,
        '',
        'Reply *attack* to fight or *run* to flee.',
      ]));
      return true;
    }
    // fight
    const lv = levelOf(p.exp);
    if (['attack', 'fight', 'atake', 'serang', 'lawan'].includes(t)) {
      const mine = 10 + lv * 5 + rand(0, 22);
      const win = mine >= s.power || Math.random() > 0.55;
      sessions.delete(k);
      if (win) {
        const exp = rand(s.d.exp[0], s.d.exp[1]);
        const found = [];
        for (const l of LOOT) {
          if (Math.random() * 100 < l.chance * (s.d.drop / 50)) {
            const q = rand(l.qty[0], l.qty[1]);
            p.inv[l.item] = (p.inv[l.item] || 0) + q;
            found.push(`${l.icon} ${l.item} ×${q}`);
          }
        }
        const before = levelOf(p.exp);
        p.exp += exp;
        const after = levelOf(p.exp);
        await reply(box('🏆 VICTORY', [
          `You defeated *${s.monster}*!`,
          `✨ EXP +${exp}`,
          ...(found.length ? ['📦 Loot :', ...found] : []),
          ...(after > before ? [`🎉 LEVEL UP → *Lv ${after}*`] : []),
        ]));
      } else {
        p.hp = Math.max(1, p.hp - 40);
        await reply(box('💀 DEFEAT', [`*${s.monster}* was too strong.`, `❤️ HP -40 → *${p.hp}/100*`]));
      }
      return true;
    }
    if (['run', 'flee', 'kouri', 'lari', 'kabur'].includes(t)) {
      sessions.delete(k);
      if (Math.random() > 0.5) {
        await reply(box('💨 ESCAPED', [`You lost *${s.monster}* in the dark.`]));
      } else {
        p.hp = Math.max(1, p.hp - 25);
        await reply(box('🩸 CAUGHT', [`*${s.monster}* hit you while you ran.`, `❤️ HP -25 → *${p.hp}/100*`]));
      }
      return true;
    }
    return false; // anything else is a normal chat message
  };

  /* ═════════════ TEKATEKI (riddles) ═════════════ */
  const RIDDLES = [
    ['What has keys but cannot open locks?', ['piano', 'keyboard']],
    ['What gets wetter the more it dries?', ['towel']],
    ['What has hands but cannot clap?', ['clock', 'watch']],
    ['What has a neck but no head?', ['bottle']],
    ['What runs but never walks?', ['river', 'water', 'stream']],
    ['What can you catch but not throw?', ['cold']],
    ['What has teeth but cannot bite?', ['comb']],
    ['What goes up but never comes down?', ['age']],
    ['The more you take, the more you leave behind. What are they?', ['footsteps', 'steps', 'footstep']],
    ['What has one eye but cannot see?', ['needle']],
    ['What stays in a corner but travels around the world?', ['stamp']],
    ['What breaks when you say its name?', ['silence']],
    ['What has a heart that does not beat?', ['artichoke']],
    ['What building has the most stories?', ['library']],
    ['What can fill a room but takes up no space?', ['light']],
    ['I am tall when I am young and short when I am old. What am I?', ['candle']],
    ['What has many rings but no finger?', ['phone', 'telephone']],
    ['What begins with T, ends with T, and has T inside?', ['teapot']],
    ['What is full of holes but still holds water?', ['sponge']],
    ['What is always in front of you but cannot be seen?', ['future']],
    ['What has a bed but never sleeps, and a mouth but never eats?', ['river']],
    ['What invention lets you look right through a wall?', ['window']],
  ];
  const riddles = new Map(); // jid -> { q, a, until, tries, hinted }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\b(a|an|the|it|is|its)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const getRiddle = (jid) => {
    const r = riddles.get(jid);
    if (r && Date.now() > r.until) { riddles.delete(jid); return null; }
    return r || null;
  };
  const maskOf = (word, shown) => word.split('').map((c, i) => (c === ' ' ? ' ' : i < shown ? c : '_')).join(' ');

  const tekateki = async ({ args, jid, reply }) => {
    const sub = String(args[0] || '').toLowerCase();
    const cur = getRiddle(jid);
    if (sub === 'hint' || sub === 'help') {
      if (!cur) return reply(box('🧩 TEKATEKI', [`No riddle running. Start one : *${P()}tekateki*`]));
      cur.hinted = Math.min(cur.hinted + 1, 3);
      return reply(box('💡 HINT', [maskOf(cur.a[0], cur.hinted), `${cur.a[0].length} letters`]));
    }
    if (sub === 'skip' || sub === 'stop' || sub === 'giveup') {
      if (!cur) return reply(box('🧩 TEKATEKI', [`No riddle running. Start one : *${P()}tekateki*`]));
      riddles.delete(jid);
      return reply(box('🏳️ SKIPPED', [`The answer was *${cur.a[0]}*.`]));
    }
    if (cur) return reply(box('🧩 TEKATEKI', ['A riddle is already running:', cur.q, '', `Hint : *${P()}tekateki hint* · Skip : *${P()}tekateki skip*`]));
    const [q, a] = pick(RIDDLES);
    if (riddles.size > 500) riddles.delete(riddles.keys().next().value);
    riddles.set(jid, { q, a, hinted: 0, until: Date.now() + 2 * 60_000 });
    return reply(box('🧩 TEKATEKI', [q, '', 'Reply with your answer (2 min).', `Hint : *${P()}tekateki hint* · Skip : *${P()}tekateki skip*`]));
  };

  const tekatekiText = async (text, { jid, m, reply }) => {
    const r = getRiddle(jid);
    if (!r || text.length > 60) return false;
    const guess = norm(text);
    if (!guess) return false;
    const ok = r.a.some((x) => guess === x || (x.length >= 4 && guess.split(' ').includes(x)));
    if (!ok) return false; // stay silent on wrong answers: the chat keeps talking normally
    riddles.delete(jid);
    const who = m.key?.participant || (m.key?.fromMe ? sock.user?.id : jid) || jid;
    await send(jid, { text: box('🎉 CORRECT', [`@${String(who).split('@')[0].split(':')[0]} got it!`, `Answer : *${r.a[0]}*`, `Next : *${P()}tekateki*`]), mentions: [who] }, m, true);
    return true;
  };

  /* ═════════════ .game (list) ═════════════ */
  const game = ({ reply }) =>
    reply(box('🎮 GAMES', [
      `${P()}dungeon — text RPG (fight monsters, loot, level up)`,
      `${P()}tekateki — riddles`,
      ...Object.keys(HTML_GAMES).filter(htmlAvailable).map((n) => `${P()}${n} — ${HTML_GAMES[n].title}`),
      '',
      'HTML games arrive as a file: open it in your browser.',
    ]));

  const handlers = { game, dungeon, tekateki };
  for (const n of Object.keys(HTML_GAMES)) if (htmlAvailable(n)) handlers[n] = htmlGame(n);

  /** Plain chat text (no prefix) that may be an answer to a running game. Returns true when it was used. */
  const onText = async (text, ctx) => {
    try {
      if (text.startsWith(P())) return false;
      if (await dungeonText(text, ctx)) return true;
      if (await tekatekiText(text, ctx)) return true;
    } catch (e) {
      log('warn', 'game text failed', { why: String(e?.message || '').slice(0, 60) });
    }
    return false;
  };

  return { handlers, onText };
}
