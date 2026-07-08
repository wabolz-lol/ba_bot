const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'stats.json');

function load() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to read stats.json, starting fresh:', e.message);
    return {};
  }
}

let db = load();
let dirty = false;

// In-memory only: start time of each player's current online session.
// Not persisted -- if the bot restarts mid-session, that partial session
// is lost. This is a hard limitation of only observing chat, not the
// server's own player list.
const openSessions = new Map();

function save() {
  if (!dirty) return;
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  dirty = false;
}

setInterval(save, 10_000);
process.on('SIGINT', () => { save(); process.exit(); });

function blank() {
  return {
    kills: 0,
    deaths: 0,
    playtimeMs: 0,
    lastSeen: null,      // timestamp, last join or leave event observed
    online: false,
    streak: 0,           // current kills-since-last-death
    bestStreak: 0,
    causes: {},           // death cause -> count, e.g. { slain: 3, drowned: 1 }
    killedBy: {},         // killerName -> times they've killed this player
  };
}

function ensurePlayer(name) {
  if (!db[name]) {
    db[name] = blank();
    dirty = true;
  }
  return db[name];
}

// ---- events ----

function recordJoin(name) {
  const p = ensurePlayer(name);
  p.online = true;
  p.lastSeen = Date.now();
  openSessions.set(name, Date.now());
  dirty = true;
}

function recordLeave(name) {
  const p = ensurePlayer(name);
  const start = openSessions.get(name);
  if (start) {
    p.playtimeMs += Date.now() - start;
    openSessions.delete(name);
  }
  p.online = false;
  p.lastSeen = Date.now();
  dirty = true;
}

function recordKill(killer) {
  if (!killer) return;
  const p = ensurePlayer(killer);
  p.kills += 1;
  p.streak += 1;
  if (p.streak > p.bestStreak) p.bestStreak = p.streak;
  dirty = true;
}

function recordDeath(victim, killer, cause) {
  if (!victim) return;
  const p = ensurePlayer(victim);
  p.deaths += 1;
  p.streak = 0;
  if (cause) p.causes[cause] = (p.causes[cause] || 0) + 1;
  if (killer) p.killedBy[killer] = (p.killedBy[killer] || 0) + 1;
  dirty = true;
}

// ---- queries ----

function getPlayer(name) {
  return db[name] || null;
}

function currentPlaytimeMs(name) {
  const p = db[name];
  if (!p) return 0;
  const openStart = openSessions.get(name);
  return p.playtimeMs + (openStart ? Date.now() - openStart : 0);
}

function getKD(name) {
  const p = db[name];
  if (!p) return null;
  const kd = p.deaths === 0 ? p.kills : p.kills / p.deaths;
  return { kills: p.kills, deaths: p.deaths, kd: kd.toFixed(2) };
}

function getNemesis(name) {
  const p = db[name];
  if (!p || Object.keys(p.killedBy).length === 0) return null;
  const [killer, count] = Object.entries(p.killedBy).sort((a, b) => b[1] - a[1])[0];
  return { killer, count };
}

function getCauses(name) {
  const p = db[name];
  if (!p) return null;
  return p.causes;
}

function whoIsOnline() {
  return Object.entries(db)
    .filter(([, p]) => p.online)
    .map(([name]) => name);
}

function getTop(field, limit = 5) {
  // field: 'kills' | 'deaths' | 'kd' | 'playtime' | 'bestStreak'
  const entries = Object.entries(db).map(([name, p]) => {
    let value;
    if (field === 'kd') value = p.deaths === 0 ? p.kills : p.kills / p.deaths;
    else if (field === 'playtime') value = currentPlaytimeMs(name);
    else value = p[field] ?? 0;
    return { name, value };
  });
  entries.sort((a, b) => b.value - a.value);
  return entries.slice(0, limit);
}

module.exports = {
  recordJoin, recordLeave, recordKill, recordDeath,
  getPlayer, currentPlaytimeMs, getKD, getNemesis, getCauses,
  whoIsOnline, getTop,
};
