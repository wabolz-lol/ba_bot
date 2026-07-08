# Bedrock !kd bot (starter)

A 2b2t-style chat bot for Bedrock Edition: no server admin access, just a
bot account sitting in chat, watching join/leave/death messages, and
answering commands from its own local tally.

## Setup

```bash
npm install
```

Edit `HOST` and `PORT` at the top of `index.js` to point at the target server.

```bash
npm start
```

On first run, the console prints a Microsoft device-login URL and code
(`microsoft.com/link` + a short code). Sign in there with the account you
want the bot to play as. The auth token is then cached locally so you
won't repeat this every run.

## Commands

| Command | What it does |
|---|---|
| `!kd [player]` | Kills / deaths / KD ratio |
| `!pt [player]` | Total playtime seen by the bot |
| `!online` (`!who`) | Players currently tracked as online |
| `!seen <player>` | Online now, or how long ago last seen |
| `!streak [player]` | Current kill streak since last death |
| `!beststreak [player]` | Best kill streak ever recorded |
| `!deaths [player]` | Breakdown of death causes |
| `!nemesis [player]` | Who's killed this player the most |
| `!top <kills\|deaths\|kd\|playtime\|beststreak>` | Leaderboard, top 5 |
| `!uptime` | How long the bot process itself has been running |
| `!help` | Lists all commands |

All commands default to the sender if no player name is given.

## How it actually works

The bot joins as a normal player over Bedrock/RakNet via `bedrock-protocol`.
It has no special access to real server data — it's just a player, not an
admin — so everything above is reconstructed purely from chat broadcasts:

- **Kills/deaths/streaks/causes/nemesis** come from parsing death messages.
- **Playtime/online/seen** come from parsing join/leave messages.
- All of it is stored locally in `stats.json`.

## Known limitations (read before relying on this)

- **Playtime and "online" status only reflect what the bot itself
  observed.** If the bot is offline, restarts, or disconnects, it misses
  join/leave events during that gap — so playtime numbers are a lower
  bound, not the player's true total time on the server. An in-progress
  session is also lost if the bot restarts mid-session, since that's only
  tracked in memory.
- **Death/join/leave message parsing is fragile and server-specific.**
  Formats vary by server config and locale, and some servers send death
  messages as translation keys + parameters rather than plain text.
  Watch real chat from your target server for a while and adjust the
  regex patterns in `index.js` to match what it actually sends.
- **`bedrock-protocol` tracks Minecraft's version closely.** A
  protocol-breaking game update can break the bot until the library
  catches up.
- **Check the server's rules before running this for real.** Some servers
  disallow bots/automation even for read-only chat bots — worth
  confirming, since a banned account is wasted setup.

## Extending it

- Add more commands the same way the existing ones are defined in the
  `COMMANDS` object in `index.js` — each is just `name(sender, args) { ... }`.
- Swap `stats.json` for SQLite (e.g. `better-sqlite3`) if you want more
  than a few hundred tracked players, or want persisted open sessions.
- If you ever get admin/plugin access to this or another server, a
  behavior-pack bot using the `@minecraft/server` Script API would be far
  more reliable, since it can read real scoreboard/playtime data instead
  of inferring it from chat text.
