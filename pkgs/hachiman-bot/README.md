# @hachiman/bot

The bot runtime of Hachiman, and a Discord API v10 bridge on top of it. `@hachiman/discord.js` uses it in-process. A bot in another language uses the bridge as a process. The design is in `docs/bots-plan.md`. The bot account, the token and the dashboard are in contract §4 Bots.

## Where it fits

```
Discord library (discord.js, discord.py, …)
        │  Discord REST v10 + Gateway v10, plaintext, 127.0.0.1
        ▼
DiscordBridge (src/discord)          ids.ts: UUID → snowflake (computed)
        │  BotMessage, BotReaction, Hachiman events
        ▼
BotRuntime (src/runtime.ts)
  HachimanClient (@hachiman/client) ── REST + gateway, ciphertext ──▶ Takusen, gateway
  crypto engine in-process (@hachiman/crypto/host)
  FileCryptoStore (src/store.ts) ── state directory
```

The bot holds its own keys. Takusen and the gateway see only ciphertext, as for every other client. The plaintext stays on the machine of the bot operator.

## Modules

| File | Contents |
|---|---|
| `src/runtime.ts` | `BotRuntime`: start (wrap key, engine, onboarding, gateway), the §12.13 event forwarding, decrypt to `BotMessage`, `send` / `edit` / `delete` / `react` / `fetchMessages` with the send retry of the app |
| `src/store.ts` | `FileCryptoStore`: the `CryptoStore` of §12.17 in one encrypted file. Each write replaces the file atomically and resolves after `fsync`. A transaction is an overlay, as in the IndexedDB store |
| `src/ids.ts` | `IdMap`: the snowflake of a Hachiman id, computed from the UUID (dated for guilds and messages), so it is the same in every run. `shardOfGuild`: Discord's shard formula |
| `src/link.ts` | The deployment key, the sealed link payload, the bot routes (owner, link mailbox, device tokens) |
| `src/discord/shapes.ts` | Hachiman entities → Discord objects; mentions and embeds |
| `src/discord/bridge.ts` | `DiscordBridge`: the REST routes, the gateway sessions (HELLO, IDENTIFY, RESUME, heartbeat, intents, member chunks) |
| `src/start.ts` | `startBridge`: runtime + bridge from options and environment |
| `src/cli.ts` | `hachiman-discord-bridge` |

## Devices, linking and shards

Each device of a bot (each shard) has its own state folder and its own device token, minted with the bot token on its first start. A device with no keys does one of these (contract §4 Bots):

1. `recovery-key.txt` is in its folder: it restores the identity.
2. The bot has no identity yet: it makes it (`resetIdentity`), writes the recovery key, and makes `deployment.key` in the shared folder.
3. The bot has keys elsewhere: it opens a QR link session and waits. With `deployment.key`, it posts the sealed QR payload to the link mailbox, and a running device links it. Without it, it logs the QR payload for the owner to send in a DM.

A running device reads the link mailbox every 5 seconds and links the requests that its deployment key opens. It also links a QR payload that the pinned owner sends in a DM.

## Onboarding

On the first start, `BotRuntime` makes the bot identity with `resetIdentity` (generation 1 on a new account, the next generation after **Reset keys**). It writes the recovery key to `recovery-key.txt`. A later start opens the store with `wrap.key`. A new directory with `recovery-key.txt` restores the identity. The device platform is `browser` and the device name is `Bot`.

## The bridge as a process

```sh
hachiman-discord-bridge --token hbot_… --port 8787
```

The token names its server, and the server names its gateway (`GET /api/v1/gateway`). `--url` and `--gateway` override them.

Then point the Discord library at `http://127.0.0.1:8787/api`:

- discord.js: `new Client({ intents, rest: { api: 'http://127.0.0.1:8787/api' } })`
- discord.py: `discord.http.Route.BASE = 'http://127.0.0.1:8787/api/v10'`

The bridge accepts only the bot's own token. It listens on 127.0.0.1 unless `--host` says otherwise.

## Test

`pnpm -F @hachiman/bot test`: the store and the id map. The discord.js test of the bridge is in `@hachiman/discord.js`.
