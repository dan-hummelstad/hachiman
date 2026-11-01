# Bots: a Discord-compatible SDK

## Status (2026-11-01)

Phases 1 to 5 are built. A check against the local stack passes (`pkgs/hachiman-discord.js/scripts/e2e-local.ts`): an unchanged discord.js bot, configured only by its environment, answers an E2EE message. A plain `node bot.cjs` with the built package installed as `discord.js` passes the same check. Changes to the plan during the work:

- **Store:** `FileCryptoStore` (`pkgs/hachiman-bot/src/store.ts`) replaces IndexedDB in Node. One encrypted file, replaced atomically on each write.
- **Engine:** `@hachiman/crypto/host` exports the in-process engine. Only a host that holds the keys itself imports it. The browser hosts keep the Worker.
- **Onboarding:** `resetIdentity` makes the identity, on a first start and after a key reset. It never replaces a current master key.
- **Lost keys:** the owner clicks **Reset keys** on the dashboard (cookie only, the DS change of a password reset). A token alone never replaces a master key (§12.4).
- **Device platform:** `browser`, device name `Bot`. A `bot` platform value would need a contract §12 and a schema change; not done.
- **Only the token:** the token names its server (`hbot_<origin>.h1.<secret>`), Takusen names the gateway (`GET /api/v1/gateway`), and the owner adds the bot to a guild with **Add to guild** (Discord's bot invite). A plain `node bot.cjs` with only `DISCORD_TOKEN` passes the local check.
- **Not in v1:** the open items of §6 (interactions, attachments, voice, …) and npm publishing (the `build:dist` bundle is ready).

## Context

Users want to run bots on Hachiman. Most bots in the world are written for Discord, with discord.js (JavaScript) or discord.py (Python). The goal: an existing Discord bot runs on Hachiman with the smallest change possible. Ideally the only change is the token: the bot gets a Hachiman API key in place of its Discord token.

**Constraint from the E2EE design:** every channel uses E2EE, and there is no plaintext mode (CLAUDE.md, contract §12). Takusen and the gateway see only ciphertext. Thus Takusen cannot serve a Discord-shaped REST API with message text in it, as Discord does. Whoever reads a message must hold the keys of an MLS member device. A bot is therefore an E2EE client, the same as the desktop app: it has a user account, a master key, a device, key packages, and it is a leaf in the MLS group of each channel that it can read.

## Decisions

### 1. The bot is a user with `bot = true`, owned by a human

- `users.bot` (boolean, default false). The `User` entity gets `bot: boolean`. The UI shows a BOT tag, as Discord does.
- `bots` table: `user_id` (the bot user, PK), `owner_id` (the human user), `created_at`.
- `bot_tokens` table: `id`, `bot_id`, `token_hash` (SHA-256), `created_at`, `last_used_at`, `revoked_at`. One live token per bot. "Reset token" revokes the old one.
- A bot has no password, no email login and no OIDC session. Its email is `<userId>@bots.invalid`, so the `users.email` NOT NULL UNIQUE rule holds.
- The owner manages bots on the Takusen dashboard (`/bots`): create (name), reveal the token once, reset the token, delete. The REST API (`/api/v1/bots`) does the same for the dashboard and for scripts.

### 2. The API key is a bearer token that Takusen accepts in place of an OIDC access token

- Format: `hbot_<base64url 32 random bytes>`. Takusen stores only the SHA-256.
- `findAccessToken` in `lib/auth-helpers.ts` is the only auth seam. A token that starts with `hbot_` is looked up in `bot_tokens`. The result has the same shape as an OIDC access token: `accountId` = the bot user, `grantId` = `bot:<tokenId>`.
- Thus every route, the gateway IDENTIFY (it resolves the token with `GET /users/@me`), and the device binding (§12.12, keyed by the grant) work for a bot with no further change. A reset token is a new grant, so it can bind a new device only through the existing "pending device" rule.
- `Authorization: Bot <token>` (the Discord scheme) is accepted as well as `Bearer`.

### 3. The keys stay with the bot operator: a local Discord-compatible bridge

The bot needs plaintext. The server must not have it. So the translation from Hachiman (ciphertext, UUIDs, Hachiman shapes) to Discord (plaintext, snowflakes, Discord shapes) runs **next to the bot**, in a process that the bot operator controls:

```
discord.js / discord.py bot ──Discord REST v10 + Gateway v10──▶ bridge (local) ──Hachiman REST + gateway (ciphertext)──▶ Takusen / gateway
                                                                 │
                                                                 └─ @hachiman/crypto engine in-process, key store on disk
```

- The bridge is a new package, `pkgs/hachiman-bot` (`@hachiman/bot`). It runs the `@hachiman/crypto` engine in-process (no Worker), with `HachimanClient` from `@hachiman/client` for REST and the gateway. Node 22 has `fetch` and `WebSocket`.
- It serves a subset of Discord's REST API v10 and Gateway v10 on localhost, with plaintext content.
- It keeps the key store in a state directory (default `./.hachiman-bot`), encrypted with a wrap key from that directory. The operator must keep that directory, as a Discord bot operator keeps its token.

### 4. Two ways to use it

1. **Drop-in for discord.js (no code change).** `@hachiman/discord.js` re-exports discord.js. Its `Client` starts the bridge in-process on `login()` and points discord.js at it (`rest.api`). The bot installs it under the name `discord.js` with a package alias, and changes only its token:

   ```json
   "dependencies": { "discord.js": "npm:@hachiman/discord.js@^0.1.0" }
   ```

   `DISCORD_TOKEN=hbot_…` (and `HACHIMAN_URL` for a self-hosted Takusen). The bot code stays the same.

2. **Any language: the bridge as a process.** `hachiman-discord-bridge --token hbot_… --port 8787` serves `http://127.0.0.1:8787/api/v10` and `ws://127.0.0.1:8787/gateway`. A bot in another language sets the Discord API base URL to it (discord.py: one line, `discord.http.Route.BASE = 'http://127.0.0.1:8787/api/v10'`).

### 5. IDs: a persistent UUID ↔ snowflake map

Discord libraries parse ids as 64-bit snowflakes (discord.js reads the creation time from the id with `BigInt`). Hachiman ids are UUIDs. The bridge keeps a two-way map in the state directory. A new snowflake is `(createdAtMs − DISCORD_EPOCH) << 22 | counter`, from the creation time of the entity when the bridge knows it, else now. The map never forgets an id, so ids stay stable across restarts.

### 6. The Discord surface (v1)

Enough for the common bot: commands by message prefix, replies, embeds as text, reactions, member and channel lookups.

**Gateway v10** (`/gateway?v=10&encoding=json`): HELLO (op 10), IDENTIFY (op 2), heartbeat (op 1 / 11), RESUME (op 6, the bridge replays from a small buffer), READY, GUILD_CREATE (with channels, roles, members), MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE (decrypted), MESSAGE_REACTION_ADD / REMOVE, GUILD_MEMBER_ADD / UPDATE / REMOVE, CHANNEL_CREATE / UPDATE / DELETE, GUILD_ROLE_CREATE / UPDATE / DELETE, TYPING_START, PRESENCE_UPDATE (when intents ask). Intents filter the events, as Discord does. `MESSAGE_CONTENT` is honored: without it, `content` is empty in guild messages that do not mention the bot.

**REST v10:** `GET /gateway`, `GET /gateway/bot`, `GET /users/@me`, `GET /users/:id`, `GET /guilds/:id`, `GET /guilds/:id/channels`, `GET /guilds/:id/members[/:userId]`, `GET /guilds/:id/roles`, `GET /channels/:id`, `GET /channels/:id/messages[/:id]`, `POST /channels/:id/messages`, `PATCH /channels/:id/messages/:id`, `DELETE /channels/:id/messages/:id`, `PUT|DELETE /channels/:id/messages/:id/reactions/:emoji/@me`, `POST /channels/:id/typing`, `POST /users/@me/channels` (open a DM), `GET /applications/@me` (discord.js reads it).

**Not in v1** (the bridge answers 404 or an empty list, and logs once): slash commands and interactions (Hachiman has no interactions yet), voice, threads, webhooks, stickers, scheduled events, audit logs, file uploads (attachments are a v2 item: the bridge would encrypt them as the app does).

### 7. Joining a guild

Discord adds a bot with an OAuth2 URL. On Hachiman, the owner clicks **Add to guild** on the Bots page (`POST /bots/:id/guilds`): the owner needs MANAGE_GUILD in the guild, and the bot joins with a single-use invite. An invite code also works (`--join <code>` or `HACHIMAN_BOT_JOIN`). The E2EE join is the same as a user's: the engine asks to join the guild's groups, and a member device commits the add. A bot that is already a member does nothing.

## Phases

1. **Takusen bot accounts.** Schema + migration, `findAccessToken` bot branch, `/api/v1/bots` routes, `User.bot`, dashboard page, contract §3/§4. Tests: the auth branch and the token routes.
2. **`@hachiman/bot` runtime.** The engine in-process, a disk-backed store, the DS transport, the gateway → engine wiring, onboarding of a new bot identity (master key, device, recovery key saved to the state directory), message decrypt and encrypt. Test: the bridge's message codec and id map; an E2E check against a local stack.
3. **Discord bridge.** REST + gateway v10 subset over the runtime. Tests: shapes against `discord-api-types`, and a discord.js client that logs in to a bridge with a fake runtime.
4. **`@hachiman/discord.js` drop-in.** Re-export + `Client` that starts the bridge. Test: an unmodified sample bot (ping/pong) runs against the fake runtime.
5. **Docs.** A "Run your Discord bot on Hachiman" guide in the package README.

## Risks

- **Store in Node.** The crypto store is IndexedDB. The bridge needs an IndexedDB in Node that persists to disk.
- **discord.js internals.** discord.js assumes Discord's shapes in many places. The bridge fills every field that discord.js reads, with Discord's defaults.
- **Group joins.** A bot only reads a channel once a member device has added it to the MLS group. A guild with no online member delays the bot's first messages, as it does for a human.
