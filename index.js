const bedrock = require('bedrock-protocol');
const stats = require('./stats');

// ---- CONFIG: edit these ----
const HOST = 'bedrockanarchy.org';
const PORT = 19132;
const PREFIX = '!';
// -----------------------------

// ---- Auto-reconnect config ----
const RECONNECT_BASE_DELAY_MS = 5_000;   // first retry after 5s
const RECONNECT_MAX_DELAY_MS = 5 * 60_000; // cap backoff at 5 min
let reconnectAttempts = 0;
let reconnectTimer = null;
let intentionalShutdown = false; // set true only on SIGINT/SIGTERM so we don't reconnect after a clean exit
// --------------------------------

// ---- Periodic broadcast config ----
const BROADCAST_INTERVAL_MS = 10 * 60_000; // 10 minutes
const BROADCAST_MESSAGE = '§d§lT§aR§4S§9 O§7N §3T§1O§5P';
let broadcastTimer = null;
let isSpawned = false;
// ------------------------------------

const botStartTime = Date.now();
function elapsed() {
  return ((Date.now() - botStartTime) / 1000).toFixed(1) + 's';
}

// Short random alphanumeric tag, e.g. "9i31oasd" -- appended to the
// broadcast so the server doesn't treat it as an exact repeat of the
// last message (most servers/clients silently drop identical repeats).
function randomTag(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

let client = null;

function createClient() {
  client = bedrock.createClient({
    host: HOST,
    port: PORT,
  });

  client.on('spawn', () => {
    isSpawned = true;
    reconnectAttempts = 0; // reset backoff once we successfully connect
    console.log(`[${elapsed()}] Bot spawned in world, watching chat...`);
    console.log(`[${elapsed()}] profile:`, JSON.stringify(client.profile));
    startBroadcastTimer();
  });

  client.on('text', (packet) => {
    // Uncomment if a command misbehaves and you need to see the raw packet
    // shape again -- this server's formats were reverse-engineered from it.
    // console.log('[text packet]', JSON.stringify(packet));

    handleTranslationPacket(packet); // join/leave (type: "json")
    handleDeathMessage(packet);      // deaths (type: "raw", plain colored text)
    handleChatCommand(packet);       // player chat (type: "raw", "<name> msg")
  });

  client.on('disconnect', (reason) => {
    console.log(`[${elapsed()}] Disconnected:`, reason);
    handleDisconnection();
  });

  client.on('error', (err) => {
    console.error(`[${elapsed()}] Client error:`, err);
    handleDisconnection();
  });

  client.on('close', () => {
    console.log(`[${elapsed()}] Connection closed`);
    handleDisconnection();
  });
}

// Central place any "we're no longer connected" event routes through.
// Guards against double-scheduling a reconnect if e.g. both 'error' and
// 'close' fire for the same drop.
function handleDisconnection() {
  isSpawned = false;
  stopBroadcastTimer();

  if (intentionalShutdown) return;
  if (reconnectTimer) return; // already scheduled

  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_DELAY_MS
  );
  reconnectAttempts++;

  console.log(`[${elapsed()}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log(`[${elapsed()}] Attempting reconnect...`);
    try {
      createClient();
    } catch (e) {
      console.error(`[${elapsed()}] Reconnect attempt failed to even start:`, e.message);
      handleDisconnection();
    }
  }, delay);
}

function startBroadcastTimer() {
  stopBroadcastTimer();
  broadcastTimer = setInterval(() => {
    if (!isSpawned) return;
    say(`${BROADCAST_MESSAGE} [${randomTag()}]`);
  }, BROADCAST_INTERVAL_MS);
}

function stopBroadcastTimer() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
}

process.on('SIGINT', () => { intentionalShutdown = true; process.exit(); });
process.on('SIGTERM', () => { intentionalShutdown = true; process.exit(); });

createClient();

// ---------------------------------------------------------------------
// This server sends join/leave messages as type "json": a JSON-encoded
// Minecraft translation string, e.g.
//   {"rawtext":[{"translate":"§e%multiplayer.player.joined","with":{"rawtext":[{"text":"x7r46v"}]}}]}
// We pull out the translate key (stripped of color codes/%) and the list
// of substituted parameters (usually player names).
// ---------------------------------------------------------------------
function extractTranslation(packet) {
  if (packet.type !== 'json') return null;
  try {
    const data = JSON.parse(packet.message);
    const entry = data.rawtext && data.rawtext[0];
    if (!entry || !entry.translate) return null;

    // Strip leading color codes like "§e" and the "%" translation marker
    const key = entry.translate.replace(/§./g, '').replace(/^%/, '');

    const params = (entry.with && entry.with.rawtext)
      ? entry.with.rawtext.map((r) => r.text).filter(Boolean)
      : [];

    return { key, params };
  } catch (e) {
    return null;
  }
}

function handleTranslationPacket(packet) {
  const t = extractTranslation(packet);
  if (!t) return;

  if (t.key === 'multiplayer.player.joined') {
    stats.recordJoin(t.params[0]);
    console.log(`[join] ${t.params[0]}`);
    return;
  }

  if (t.key === 'multiplayer.player.left') {
    stats.recordLeave(t.params[0]);
    console.log(`[leave] ${t.params[0]}`);
    return;
  }
}

// ---------------------------------------------------------------------
// Deaths arrive as plain colored text, type "raw", e.g. "§cx7r46v burned to death"
// -- NOT the json translation format join/leave uses. We strip color codes
// then match against common vanilla death phrasings.
// NOTE: this list won't cover every possible death message. If !kd/!deaths
// still look wrong for some death types, re-enable the '[text packet]' debug
// log above, cause that specific death, and add a matching pattern below.
// ---------------------------------------------------------------------
const DEATH_PATTERNS = [
  // ---- combat: melee/generic ----
  { re: /^(\w+) was slain by (\w+)/i,                           victim: 1, killer: 2, cause: 'slain' },
  { re: /^(\w+) was fatally wounded (?:by|whilst fighting) (\w+)/i, victim: 1, killer: 2, cause: 'wounded' },
  { re: /^(\w+) was killed by (\w+) using magic/i,               victim: 1, killer: 2, cause: 'magic' },
  { re: /^(\w+) was killed by magic/i,                            victim: 1, killer: null, cause: 'magic' },
  { re: /^(\w+) was killed by (\w+)/i,                          victim: 1, killer: 2, cause: 'killed' },
  { re: /^(\w+) was killed while trying to hurt (\w+)/i,        victim: 1, killer: 2, cause: 'thorns' },
  { re: /^(\w+) was pricked to death/i,                         victim: 1, killer: null, cause: 'cactus' },
  { re: /^(\w+) walked into a cactus while trying to escape (\w+)/i, victim: 1, killer: 2, cause: 'cactus' },
  { re: /^(\w+) was shown too much love/i,                      victim: 1, killer: null, cause: 'cramming' },
  { re: /^(\w+) was squashed by a falling anvil/i,               victim: 1, killer: null, cause: 'anvil' },
  { re: /^(\w+) was squashed by a falling block/i,               victim: 1, killer: null, cause: 'falling_block' },
  { re: /^(\w+) was squashed by (\w+)/i,                        victim: 1, killer: 2, cause: 'cramming' },
  { re: /^(\w+) was skewered by a falling stalactite/i,          victim: 1, killer: null, cause: 'stalactite' },
  { re: /^(\w+) was impaled on a stalagmite/i,                   victim: 1, killer: null, cause: 'stalagmite' },
  { re: /^(\w+) was stung to death/i,                            victim: 1, killer: null, cause: 'bee_sting' },
  { re: /^(\w+) was poked to death by a sweet berry bush/i,      victim: 1, killer: null, cause: 'sweet_berry_bush' },

  // ---- combat: ranged / thrown ----
  { re: /^(\w+) was shot by a skull from (\w+)/i,                victim: 1, killer: 2, cause: 'wither_skull' },
  { re: /^(\w+) was shot by (\w+)/i,                             victim: 1, killer: 2, cause: 'shot' },
  { re: /^(\w+) was fireballed by (\w+)/i,                       victim: 1, killer: 2, cause: 'fireball' },
  { re: /^(\w+) was pummeled by (\w+)/i,                         victim: 1, killer: 2, cause: 'thrown_item' },

  // ---- magic / dragon / warden ----
  { re: /^(\w+) was roasted in dragon('|’)?s? breath/i,          victim: 1, killer: null, cause: 'dragon_breath' },
  { re: /^(\w+) was obliterated by a sonically-charged shriek(?: whilst trying to escape (\w+))?/i, victim: 1, killer: 2, cause: 'sonic_boom' },

  // ---- fall damage ----
  { re: /^(\w+) fell from a high place/i,                        victim: 1, killer: null, cause: 'fall' },
  { re: /^(\w+) fell off (a ladder|some vines|scaffolding|some twisting vines|some weeping vines)/i, victim: 1, killer: null, cause: 'fall_climbable' },
  { re: /^(\w+) fell while climbing/i,                           victim: 1, killer: null, cause: 'fall_climbing' },
  { re: /^(\w+) hit the ground too hard/i,                       victim: 1, killer: null, cause: 'fall_short' },
  { re: /^(\w+) was doomed to fall/i,                            victim: 1, killer: null, cause: 'fall_doomed' },
  { re: /^(\w+) fell too far and was finished by (\w+)/i,        victim: 1, killer: 2, cause: 'fall_finished' },
  { re: /^(\w+) fell out of (the water|the world)/i,             victim: 1, killer: null, cause: 'fall_water_or_void' },
  { re: /^(\w+) experienced kinetic energy/i,                    victim: 1, killer: null, cause: 'elytra_crash' },

  // ---- fire / lava / explosion ----
  { re: /^(\w+) went up in flames/i,                             victim: 1, killer: null, cause: 'in_fire' },
  { re: /^(\w+) walked into fire while fighting (\w+)/i,         victim: 1, killer: 2, cause: 'in_fire' },
  { re: /^(\w+) burned to death/i,                               victim: 1, killer: null, cause: 'burned' },
  { re: /^(\w+) was burned to a crisp while fighting (\w+)/i,    victim: 1, killer: 2, cause: 'burned' },
  { re: /^(\w+) tried to swim in lava/i,                         victim: 1, killer: null, cause: 'lava' },
  { re: /^(\w+) discovered (the )?floor was lava/i,              victim: 1, killer: null, cause: 'lava' },
  { re: /^(\w+) walked into (the )?danger zone due to (\w+)/i,   victim: 1, killer: 3, cause: 'lava' },
  { re: /^(\w+) blew up/i,                                       victim: 1, killer: null, cause: 'explosion' },
  { re: /^(\w+) was blown up by (\w+)/i,                         victim: 1, killer: 2, cause: 'explosion' },
  { re: /^(\w+) went off with a bang/i,                          victim: 1, killer: null, cause: 'explosion' },

  // ---- suffocation / void / misc environment ----
  { re: /^(\w+) suffocated in a wall/i,                          victim: 1, killer: null, cause: 'suffocation' },
  { re: /^(\w+) was squished too much/i,                         victim: 1, killer: null, cause: 'cramming' },
  { re: /^(\w+) left the confines of this world/i,               victim: 1, killer: null, cause: 'void' },
  { re: /^(\w+) drowned whilst trying to escape (\w+)/i,         victim: 1, killer: 2, cause: 'drowned' },
  { re: /^(\w+) drowned/i,                                       victim: 1, killer: null, cause: 'drowned' },
  { re: /^(\w+) starved to death/i,                              victim: 1, killer: null, cause: 'starved' },
  { re: /^(\w+) was struck by lightning/i,                       victim: 1, killer: null, cause: 'lightning' },
  { re: /^(\w+) froze to death/i,                                victim: 1, killer: null, cause: 'freezing' },
  { re: /^(\w+) was frozen to death by (\w+)/i,                  victim: 1, killer: 2, cause: 'freezing' },
  { re: /^(\w+) withered away/i,                                 victim: 1, killer: null, cause: 'wither' },
  { re: /^(\w+) died from dehydration/i,                         victim: 1, killer: null, cause: 'dehydration' },
  { re: /^(\w+) died/i,                                          victim: 1, killer: null, cause: 'died' }, // generic catch-all -- keep last
];

function handleDeathMessage(packet) {
  if (packet.type !== 'raw' || !packet.message) return;
  if (parseChatLine(packet)) return; // it's a player's typed chat, not a system message

  const text = packet.message.replace(/§./g, '').trim();

  for (const { re, victim, killer, cause } of DEATH_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;

    const victimName = m[victim];
    const killerName = killer ? m[killer] : null;

    stats.recordDeath(victimName, killerName, cause);
    if (killerName) stats.recordKill(killerName);

    console.log(`[death] ${victimName}${killerName ? ' <- ' + killerName : ' (' + cause + ')'}`);
    return;
  }
}

// ---------------------------------------------------------------------
// Commands
// Player chat arrives as: { type: "raw", message: "<username> the text" }
// ---------------------------------------------------------------------
function parseChatLine(packet) {
  if (packet.type !== 'raw' || !packet.message) return null;
  const m = packet.message.match(/^<(\S+)>\s?(.*)$/);
  if (!m) return null;
  return { sender: m[1], text: m[2] };
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatAgo(ts) {
  if (!ts) return 'never';
  return `${formatDuration(Date.now() - ts)} ago`;
}

const COMMANDS = {
  help() {
    say(`Commands: ${PREFIX}kd ${PREFIX}pt ${PREFIX}online ${PREFIX}seen ${PREFIX}streak ${PREFIX}beststreak ${PREFIX}deaths ${PREFIX}nemesis ${PREFIX}top ${PREFIX}uptime`);
  },

  kd(sender, args) {
    const target = args[0] || sender;
    const s = stats.getKD(target);
    say(s ? `${target}: ${s.kills}K / ${s.deaths}D (KD ${s.kd})` : `No stats yet for ${target}.`);
  },

  pt(sender, args) {
    const target = args[0] || sender;
    const ms = stats.currentPlaytimeMs(target);
    say(ms > 0
      ? `${target} has been seen online ${formatDuration(ms)} total (since bot started tracking).`
      : `No playtime recorded yet for ${target}.`);
  },

  online() {
    const list = stats.whoIsOnline();
    say(list.length ? `Online (seen by bot): ${list.join(', ')}` : 'No one currently tracked as online.');
  },

  who(sender, args) { COMMANDS.online(sender, args); },

  seen(sender, args) {
    const target = args[0];
    if (!target) return say('Usage: !seen <player>');
    const p = stats.getPlayer(target);
    if (!p) return say(`Never seen ${target}.`);
    say(p.online ? `${target} is currently online.` : `${target} last seen ${formatAgo(p.lastSeen)}.`);
  },

  streak(sender, args) {
    const target = args[0] || sender;
    const p = stats.getPlayer(target);
    say(p ? `${target}'s current streak: ${p.streak} kill(s) since last death.` : `No stats yet for ${target}.`);
  },

  beststreak(sender, args) {
    const target = args[0] || sender;
    const p = stats.getPlayer(target);
    say(p ? `${target}'s best streak: ${p.bestStreak} kill(s).` : `No stats yet for ${target}.`);
  },

  deaths(sender, args) {
    const target = args[0] || sender;
    const causes = stats.getCauses(target);
    if (!causes || Object.keys(causes).length === 0) return say(`No death causes recorded for ${target}.`);
    const parts = Object.entries(causes).map(([c, n]) => `${c}: ${n}`);
    say(`${target}'s deaths by cause -> ${parts.join(', ')}`);
  },

  nemesis(sender, args) {
    const target = args[0] || sender;
    const n = stats.getNemesis(target);
    say(n ? `${target}'s nemesis is ${n.killer} (${n.count} kill(s)).` : `No recorded kills against ${target} yet.`);
  },

  top(sender, args) {
    const field = (args[0] || 'kills').toLowerCase();
    const validFields = ['kills', 'deaths', 'kd', 'playtime', 'beststreak'];
    if (!validFields.includes(field)) {
      return say(`Usage: !top <${validFields.join('|')}>`);
    }
    const rows = stats.getTop(field === 'beststreak' ? 'bestStreak' : field, 5);
    if (rows.length === 0) return say('No stats recorded yet.');
    const formatted = rows.map((r, i) => {
      const val = field === 'playtime' ? formatDuration(r.value)
        : field === 'kd' ? r.value.toFixed(2)
        : r.value;
      return `${i + 1}. ${r.name} (${val})`;
    });
    say(`Top ${field}: ${formatted.join(' | ')}`);
  },

  uptime() {
    say(`Bot has been running for ${formatDuration(Date.now() - botStartTime)}.`);
  },
};

function handleChatCommand(packet) {
  const parsed = parseChatLine(packet);
  if (!parsed) return;

  const { sender, text } = parsed;
  if (!text.startsWith(PREFIX)) return;

  const [cmdRaw, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  console.log(`[${elapsed()}] command recognized: "${cmdRaw}" from ${sender}, args=${JSON.stringify(args)}`);
  const fn = COMMANDS[cmdRaw.toLowerCase()];
  if (fn) {
    fn(sender, args);
  } else {
    console.log(`[${elapsed()}] no handler for command "${cmdRaw}"`);
  }
}

function say(message) {
  if (!client) {
    console.log(`[${elapsed()}] can't send, not connected: "${message}"`);
    return;
  }
  console.log(`[${elapsed()}] queuing reply: "${message}"`);
  try {
    client.queue('text', {
      needs_translation: false,
      category: 'authored', // was 'message_only' -- mismatched for a type with a source_name
      type: 'chat',
      source_name: client.username || '',
      message,
      xuid: String(client.profile?.xuid ?? ''), // real client always sends its true xuid here
      platform_chat_id: '',
      has_filtered_message: false,
    });
    console.log(`[${elapsed()}] reply queued successfully`);
  } catch (e) {
    console.log(`[${elapsed()}] FAILED to queue reply:`, e.message);
  }
}
