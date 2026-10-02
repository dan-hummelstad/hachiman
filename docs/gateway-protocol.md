# Hachiman Protocol Contract (v1)

Source of truth for every cross-process boundary after the Discord-architecture
refactor (`docs/discord-refactor.md`). If code and this file disagree, fix one of
them in the same change. This file replaces `Mumble.proto` as "the protocol".

Components:

| Process | Lang | Talks to |
|---|---|---|
| Oracle (Next.js, `apps/oracle`) | TS | Postgres (rw), Redis (PUBLISH) |
| Oracle gRPC (`apps/oracle/src/grpc`) | TS | Postgres (media_nodes) |
| `hachiman-gateway` (`apps/hachiman-server/cmd/hachiman-gateway`) | Go | Postgres (read), Redis (rw + SUBSCRIBE), Oracle REST (auth), Oracle gRPC (placement) |
| `hachiman-media` (`apps/hachiman-server/cmd/hachiman-media`) | Go | Oracle gRPC (register/heartbeat), Redis (SUBSCRIBE `media:{nodeId}`), clients (voice WS + WebRTC) |
| `@hachiman/client` (`pkgs/hachiman-client`) | TS | Oracle REST, gateway WS, media voice WS |

Conventions:
- **IDs** are UUID strings (Postgres `uuid`, `defaultRandom()`). No numeric ids anywhere on the wire.
- **JSON is camelCase** on every boundary (REST, gateway, voice WS, Redis payloads).
- **Timestamps** are ISO-8601 strings.
- **Permissions** are JS-safe integers (all bits < 2^31). `// ponytail:` switch to decimal strings + BigInt when a bit ≥ 31 is needed.

---

## 1. Entity shapes

These are the TS types exported from `@hachiman/client` (`src/types.ts`). Go mirrors them with `json:"camelCase"` tags.

```ts
type ChannelType = 'text' | 'voice' | 'category' | 'dm' | 'group_dm'
type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

// avatar, icon and banner are file keys (§4 Files), not URLs. The client builds the URL with RestClient.fileUrl(key).
interface User { id: string; username: string; avatar: string | null }   // username = users.displayName ?? users.name ?? email local-part

interface Guild { id: string; name: string; icon: string | null; banner: string | null; ownerId: string; region: string | null; createdAt: string }

// One uploaded file. POST /uploads returns it, and Message.attachments holds it.
// width/height come from the uploader (images and video only) and are for layout only.
interface Attachment { id: string; key: string; filename: string; size: number; contentType: string; width: number | null; height: number | null }

interface Limits { maxUploadBytes: number; maxAttachmentsPerMessage: number }

interface Role { id: string; guildId: string; name: string; color: number; position: number; permissions: number }
// The @everyone role has id === guildId and position 0. It always exists and cannot be deleted.

interface PermissionOverwrite { id: string /* role id or user id */; type: 'role' | 'member'; allow: number; deny: number }

interface Channel {
  id: string
  guildId: string | null           // null for dm / group_dm
  type: ChannelType
  name: string | null              // null for dm
  topic: string | null
  parentId: string | null          // category id
  position: number
  permissionOverwrites: PermissionOverwrite[]   // [] for DMs
  recipients?: User[]              // dm / group_dm only: every participant except the viewer
  ownerId?: string | null          // group_dm only
}

interface Member { guildId: string; user: User; nick: string | null; roles: string[] /* excludes @everyone */; joinedAt: string }

interface Message {
  id: string; channelId: string; guildId: string | null
  author: User; content: string   // '' is allowed when attachments is not empty
  attachments: Attachment[]        // upload order
  createdAt: string; editedAt: string | null
  nonce?: string                   // echoed from the create request, never stored
}

interface Invite { code: string; guildId: string; createdBy: string; expiresAt: string | null; maxUses: number | null; uses: number; createdAt: string }
interface InvitePreview { code: string; guild: Pick<Guild, 'id' | 'name' | 'icon'>; memberCount: number; expiresAt: string | null }

interface Presence { userId: string; status: PresenceStatus }

interface VoiceState {
  guildId: string; channelId: string | null; userId: string
  sessionId: string                // gateway session id
  selfMute: boolean; selfDeaf: boolean
}

interface GuildFull extends Guild {  // READY + GUILD_CREATE
  channels: Channel[]              // only channels the user can VIEW
  roles: Role[]
  members: Member[]                // ponytail: full list; add lazy member chunks when guilds exceed ~1k members
  voiceStates: VoiceState[]
  presences: Presence[]            // online members only
}
```

## 2. Permissions

Discord bit values (subset). Defined **once per language**:
TS `pkgs/hachiman-client/src/permissions.ts`, Go `apps/hachiman-server/pkg/permissions/permissions.go`.
A Go test (`pkg/permissions/sync_test.go`) parses the TS file and fails if any name/value differs.

| Name | Value |
|---|---|
| CREATE_INSTANT_INVITE | 1 << 0 |
| KICK_MEMBERS | 1 << 1 |
| ADMINISTRATOR | 1 << 3 |
| MANAGE_CHANNELS | 1 << 4 |
| MANAGE_GUILD | 1 << 5 |
| VIEW_CHANNEL | 1 << 10 |
| SEND_MESSAGES | 1 << 11 |
| MANAGE_MESSAGES | 1 << 13 |
| ATTACH_FILES | 1 << 15 |
| READ_MESSAGE_HISTORY | 1 << 16 |
| CONNECT | 1 << 20 |
| SPEAK | 1 << 21 |
| MUTE_MEMBERS | 1 << 22 |
| DEAFEN_MEMBERS | 1 << 23 |
| MOVE_MEMBERS | 1 << 24 |
| CHANGE_NICKNAME | 1 << 26 |
| MANAGE_NICKNAMES | 1 << 27 |
| MANAGE_ROLES | 1 << 28 |

`DEFAULT_EVERYONE = VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY | CONNECT | SPEAK | CREATE_INSTANT_INVITE | CHANGE_NICKNAME`.
`ALL` = OR of every bit above.

Algorithm (same in both languages, with the TS names):

```
computeBasePermissions(guild, member, roles):
  if member.user.id == guild.ownerId → ALL
  p = roles[@everyone].permissions | OR(roles[r].permissions for r in member.roles)
  if p & ADMINISTRATOR → ALL
  return p

computeChannelPermissions(guild, member, roles, channel):
  base = computeBasePermissions(...)
  if base & ADMINISTRATOR (or owner) → ALL
  p = base
  ow = channel.permissionOverwrites
  apply ow[@everyone]            : p = (p & ~deny) | allow
  apply OR of role overwrites for member.roles: p = (p & ~denyAll) | allowAll
  apply member overwrite         : p = (p & ~deny) | allow
  if !(p & VIEW_CHANNEL) → 0
  return p
```

Categories: overwrites are **not** inherited (Discord "synced" categories are a UI nicety — skip).
DM channels: participants get `VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY`, non-participants 0.
Role hierarchy: a member may only edit/assign roles whose `position` is strictly below the highest role of that member (owner/admin exempt).

## 3. Postgres schema (Oracle Drizzle, `apps/oracle/src/db/schema.ts`)

New/changed tables (all ids `uuid` defaultRandom, timestamps `timestamptz` default now):

| Table | Columns | Notes |
|---|---|---|
| `guilds` | id, owner_id → users (cascade), name, icon null, banner null, region → regions.code (set null), created_at | replaces virtual_servers. icon/banner hold file keys |
| `uploads` | id, uploader_id → users (cascade), key unique, filename, size bigint (mode number), content_type, width int null, height int null, message_id null → messages (cascade), position int default 0, purpose `upload_purpose` enum ('attachment','image') null, created_at | index (message_id); CHECK `uploads_attachment_has_message`: `(purpose IS NOT DISTINCT FROM 'attachment') = (message_id IS NOT NULL)`. One row per stored object. The first claim sets purpose, and purpose never changes. message_id is set when a message claims it, together with purpose |
| `guild_members` | guild_id → guilds (cascade), user_id → users (cascade), nick null, joined_at | PK (guild_id, user_id) |
| `channels` | id, guild_id null → guilds (cascade), type `channel_type` enum, name null, topic null, parent_id null → channels (set null), position int default 0, owner_id null → users (set null), created_at | index (guild_id) |
| `messages` | id, channel_id → channels (cascade), author_id → users (cascade), content text, created_at, edited_at null | index (channel_id, created_at desc, id desc) |
| `roles` | id, guild_id → guilds (cascade), name, color int default 0, position int default 0, permissions bigint (mode number) | @everyone row has id = guild_id |
| `member_roles` | guild_id, user_id, role_id → roles (cascade) | PK (user_id, role_id); FK (guild_id,user_id) → guild_members (cascade) |
| `permission_overwrites` | channel_id → channels (cascade), target_id uuid, target_type `overwrite_type` enum ('role','member'), allow bigint, deny bigint | PK (channel_id, target_id) |
| `dm_participants` | channel_id → channels (cascade), user_id → users (cascade) | PK (channel_id, user_id); index (user_id) |
| `invites` | id, code unique, guild_id → guilds (cascade), created_by → users (cascade), expires_at null, max_uses null, uses int default 0, revoked bool default false, created_at | replaces invite_codes |

Changed: `regions.probe_port` default **443**. `media_nodes.sidechannel_addr` → `signaling_url`.
Dropped column: `oidc_clients.virtual_server_id`. Dropped tables: `virtual_servers`, `islands`, `servers`,
`server_domain_verifications`, `user_servers`, `invite_codes`. Dropped enums: `island_status`, `virtual_server_status`.
`users.image` holds the avatar file key (Credentials is the only Auth.js provider, so nothing else writes it).
Kept unchanged: `users`, `accounts`, `sessions`, `verification_tokens`, `password_reset_tokens`,
`oidc_adapter_payloads`, `oidc_clients` (minus the column), `regions`, `media_nodes`.

Migration:
1. Delete `drizzle/*.sql` + `drizzle/meta`.
2. Regenerate a single `0000_initial.sql`. Keep the hand-added `idx_media_nodes_placement` index: declare it in schema.ts.
3. Drop + reseed the dev DB.

## 4. REST API (Oracle, base `/api/v1`)

Auth: `Authorization: Bearer <Oracle access token>` (or the dashboard cookie).
`requireUser()` in `apps/oracle/src/lib/auth-helpers.ts` resolves it. Errors: `{ error: string, message?: string }`
with status 400 (ValidationError), 401, 403 (MissingPermissions), 404 (NotFound), 409, 410 (InviteExpired/Revoked/Exhausted).
Success: JSON body of the listed type, or 204.

Every mutation publishes its gateway event **after** the DB commit (see §5 for channels/envelope). Oracle logs publish failures and does not surface them.

Implemented extras (Discord semantics):
- Kick enforces role hierarchy.
- Role create/edit and overwrite PUT may only grant bits the caller holds (owner/ADMINISTRATOR exempt).
- Deleting a role deletes its overwrites (+ CHANNEL_UPDATE).
- New roles insert at position 1 (others shift, GUILD_ROLE_UPDATE each).
- Invite defaults: `maxAgeSeconds` 86400, `maxUses` unlimited, 0 = never/unlimited.
- Revoke = soft (`revoked`).
- `GET /guilds/:id` reads voice states/presences from Redis.
- Next route folders for `/users/@me` live under `users/[id]` (`@x` is a parallel-route slot in Next).

| Method + path | Permission | Returns | Publishes |
|---|---|---|---|
| GET `/users/@me` | auth | `User` | — |
| PATCH `/users/@me` `{avatar?: uploadId \| null}` | auth | `User` | `USER_UPDATE` → user:{me}; `GUILD_MEMBER_UPDATE` (full `Member`) → guild:{g} for each guild of me |
| GET `/users/:id` | auth | `User` | — |
| POST `/guilds` `{name, region?}` | auth | `GuildFull` | `GUILD_CREATE` → user:{me} |
| GET `/guilds/:id` | member | `GuildFull` | — |
| PATCH `/guilds/:id` `{name?, icon?: uploadId \| null, banner?: uploadId \| null, region?}` | MANAGE_GUILD | `Guild` | `GUILD_UPDATE` → guild |
| DELETE `/guilds/:id` | owner | 204 | `GUILD_DELETE {id}` → guild |
| POST `/guilds/:id/channels` `{name, type: text\|voice\|category, parentId?, topic?}` | MANAGE_CHANNELS | `Channel` | `CHANNEL_CREATE` → guild |
| PATCH `/guilds/:id/channels` `[{id, position, parentId?}]` | MANAGE_CHANNELS | 204 | `CHANNEL_UPDATE` per changed channel |
| PATCH `/channels/:id` `{name?, topic?, parentId?, position?}` | MANAGE_CHANNELS | `Channel` | `CHANNEL_UPDATE` |
| DELETE `/channels/:id` | MANAGE_CHANNELS | 204 | `CHANNEL_DELETE` |
| PUT `/channels/:id/permissions/:targetId` `{type, allow, deny}` | MANAGE_ROLES | 204 | `CHANNEL_UPDATE` |
| DELETE `/channels/:id/permissions/:targetId` | MANAGE_ROLES | 204 | `CHANNEL_UPDATE` |
| GET `/channels/:id/messages?before=<messageId>&limit=50` | VIEW_CHANNEL + READ_MESSAGE_HISTORY | `Message[]` newest first, limit ≤ 100 | — |
| POST `/channels/:id/messages` `{content, nonce?, attachments?: uploadId[]}` | SEND_MESSAGES; ATTACH_FILES if attachments is not empty | `Message` (with nonce) | `MESSAGE_CREATE` (with nonce) |
| PATCH `/channels/:id/messages/:mid` `{content}` (attachments do not change) | author | `Message` | `MESSAGE_UPDATE` |
| DELETE `/channels/:id/messages/:mid` | author or MANAGE_MESSAGES | 204 | `MESSAGE_DELETE {id, channelId, guildId}` |
| POST `/channels/:id/typing` | SEND_MESSAGES | 204 | `TYPING_START {channelId, guildId, userId, timestamp}` |
| GET `/guilds/:id/members` | member | `Member[]` | — |
| PATCH `/guilds/:id/members/:userId` `{nick?, roles?}` | nick: self→CHANGE_NICKNAME, other→MANAGE_NICKNAMES; roles→MANAGE_ROLES + hierarchy | `Member` | `GUILD_MEMBER_UPDATE` |
| DELETE `/guilds/:id/members/:userId` | KICK_MEMBERS (not owner) | 204 | `GUILD_MEMBER_REMOVE {guildId, user}` → guild; `GUILD_DELETE {id}` → user:{kicked} |
| DELETE `/users/@me/guilds/:id` | member, not owner | 204 | same as kick |
| GET `/guilds/:id/roles` | member | `Role[]` | — |
| POST `/guilds/:id/roles` `{name, color?, permissions?}` | MANAGE_ROLES | `Role` | `GUILD_ROLE_CREATE {guildId, role}` |
| PATCH `/guilds/:id/roles` `[{id, position}]` | MANAGE_ROLES | `Role[]` | `GUILD_ROLE_UPDATE` per changed role |
| PATCH `/guilds/:id/roles/:roleId` `{name?, color?, permissions?}` | MANAGE_ROLES + hierarchy | `Role` | `GUILD_ROLE_UPDATE` |
| DELETE `/guilds/:id/roles/:roleId` | MANAGE_ROLES + hierarchy, not @everyone | 204 | `GUILD_ROLE_DELETE {guildId, roleId}` |
| GET `/guilds/:id/invites` | MANAGE_GUILD | `Invite[]` | — |
| POST `/guilds/:id/invites` `{maxAgeSeconds?, maxUses?}` | CREATE_INSTANT_INVITE | `Invite` | — |
| DELETE `/invites/:code` | MANAGE_GUILD | 204 | — |
| GET `/invites/:code` | **public** | `InvitePreview` (non-consuming) | — |
| POST `/invites/:code` | auth | `GuildFull` (idempotent if already a member — no use consumed) | `GUILD_MEMBER_ADD` → guild; `GUILD_CREATE` → user:{me} |
| GET `/users/@me/channels` | auth | `Channel[]` (DMs) | — |
| POST `/users/@me/channels` `{recipientIds: string[]}` | auth; recipients must share a guild with me | `Channel` (1 recipient → reuse existing `dm`; ≥2 → new `group_dm`, max 10) | `CHANNEL_CREATE` → user:{each participant} |
| GET `/limits` | auth | `Limits` | — |
| POST `/uploads?filename=<name>&width=<n>&height=<n>` raw body | auth | `Attachment` (201) | — |
| GET `/files/:uploadId/:filename` | **public** | file bytes | — |

### Files

Oracle owns blob storage. Clients never talk to S3: uploads and downloads go through Oracle, so the host CSP
only needs the Oracle origin, and the bucket can stay private.
`// ponytail:` this sends every byte through Oracle. Move to presigned S3 URLs + a CDN when bandwidth matters.

- **Limits.** `ORACLE_MAX_UPLOAD_BYTES` (default 26214400 = 25 MiB) applies to every upload. `maxAttachmentsPerMessage` is 10. The defaults are `DEFAULT_LIMITS` in `@hachiman/client`.
- **Upload.** `POST /uploads`. The body is the raw file. `Content-Type` is the file MIME type (default `application/octet-stream`).
  `Content-Length` is required. A missing length or a length above the limit gives 413 `UploadTooLarge` before Oracle reads the body.
  Oracle stores the lowercased `type/subtype` without parameters, and `application/octet-stream` for a malformed value.
  Oracle stops the stream and gives 413 if the body is longer than `Content-Length`. A shorter body fails the upload and stores nothing.
  `filename` is required (at most 255 characters). `width`/`height` are optional positive integers.
  The Oracle middleware does not run for this path, because Next.js buffers every body that middleware sees and truncates it at 10 MB.
  The route applies the same CORS policy itself.
- **Key.** `{uploadId}/{safeName}`. `safeName` is the filename with every character outside `[A-Za-z0-9._-]` replaced by `_`, cut to 100 characters (`file` if empty). Keys never change, so a key is also a cache key.
- **Claim.** A message, avatar, icon or banner takes upload ids. Each id must belong to the caller, else 400 `UnknownUpload`.
  The first claim sets the upload `purpose`, and the purpose never changes, because a message, channel or guild delete deletes its attachment objects.
  A message claim needs purpose null and sets `purpose = 'attachment'`, `message_id` and `position`, else 400 `UnknownUpload`.
  An avatar, icon or banner claim needs purpose null or `'image'` and sets `purpose = 'image'`. An `'attachment'` upload gives 400 `UnknownUpload`.
  The type must be in `PROFILE_IMAGE_TYPES` (`image/png`, `image/jpeg`, `image/gif`, `image/webp`), else 400 `InvalidImage`.
  An `'image'` upload can be claimed again as an avatar, icon or banner.
  Each claim is one conditional `UPDATE` in the same transaction as the write that uses it.
  Thus, when two claims for different purposes race for one upload, only one claim wins.
  A message create claims all ids in one transaction: one bad id gives 400 `UnknownUpload` and no message. Duplicate ids give 400 `ValidationError`.
- **Download.** `GET /files/:uploadId/:filename` streams the object. Only the canonical path (the key) resolves, else 404.
  It supports one `bytes=` range (206 + `Content-Range`) for video and audio seeking. A multi-range or malformed `Range` gets the whole file (200).
  A range that starts past the end gets 416 with `Content-Range: bytes */<size>`.
  Headers: `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, `Accept-Ranges: bytes`.
  `Content-Disposition` is `inline` only for the embeddable types below. Every other type, including `image/svg+xml`, gets
  `attachment; filename="<filename, ASCII only, quotes replaced>"; filename*=UTF-8''<percent-encoded filename>`.
  The URL is unguessable but not secret: anyone with the URL can read the file (Discord semantics).
- **Embeddable types.** Images: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`.
  Video: `video/mp4`, `video/webm`, `video/ogg`. Audio: `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/webm`, `audio/flac`, `audio/mp4`, `audio/aac`.
  The client embeds the same list (`EMBEDDABLE` in `@hachiman/client`) and shows every other type as a file card.
  Matching ignores MIME parameters (`; codecs=...`) and case. Oracle decides `inline` with the same `embedKind` function.
- **Delete.** A message, channel or guild delete removes the upload rows of the deleted messages in its transaction and then, best effort, their objects.
  The FK cascade alone would remove the rows but not the objects, so each of these routes uses the same helper (`deleteAttachmentRows` in `apps/oracle/src/lib/uploads.ts`).
  A channel or guild delete locks its channel rows (and the guild row) first, so a message sent at the same time cannot lose its rows without its objects.
  If Oracle cannot insert the row after the object PUT, it deletes the object, so every object has a row.
  A new avatar, icon or banner leaves the old object in the bucket.
  `// ponytail:` unclaimed uploads and replaced images stay in the bucket. Add a sweeper (unclaimed + older than 1 day) when storage cost matters.

Storage env (Oracle only): `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`.
Oracle sends plain signed requests (no aws-chunked checksum trailers), so S3-compatible stores such as SeaweedFS work.

Kept outside `/api/v1`: `GET /api/regions`, `POST /api/servers/recommend-region` (renamed → `POST /api/v1/regions/recommend`), OIDC under `/api/oidc`.

## 5. Event bus (Redis pub/sub)

Oracle `PUBLISH`es. Every gateway node `PSUBSCRIBE`s `guild:*` and `user:*`.

Channels: `guild:{guildId}`, `user:{userId}`. DM events go to `user:{id}` of every participant.

Envelope (JSON): `{ "t": "<EVENT_NAME>", "d": <payload>, "channelId"?: "<guild channel id>" }`.
The publisher sets `channelId` for events scoped to one guild channel (MESSAGE_*, TYPING_START, CHANNEL_UPDATE/DELETE).
The gateway only forwards those to sessions with VIEW_CHANNEL on it (CHANNEL_CREATE carries it too). When a CHANNEL_UPDATE changes
overwrites, the gateway re-evaluates visibility. It then sends CHANNEL_CREATE / CHANNEL_DELETE to sessions that gained / lost view.

Other Redis keys (owned by the gateway unless noted):

| Key | Type | Contents / TTL |
|---|---|---|
| `session:{sessionId}` | hash | `userId`, `seq`, `owner` (gateway process id — seq/buffer appends are Lua-guarded on ownership; RESUME takes ownership atomically); TTL 90 s, refreshed on each heartbeat |
| `user_sessions:{userId}` | set | live session ids (TTL 90 s) — a user goes offline only when the last session ends |
| `events:{sessionId}` | list | last 500 dispatched frames (JSON, newest first) for RESUME. Same TTL |
| `presence:{userId}` | string | status. TTL 90 s, refreshed on heartbeat. Absent ⇒ offline |
| `voice:{guildId}` | hash | userId → `VoiceState` JSON. Readers drop entries whose `session:{sessionId}` is gone |
| `voice_user:{userId}` | string | guildId the user is in voice for (one voice session per user globally) |
| `voice_room:{channelId}` | string | mediaNodeId hosting that channel (sticky; SET NX, EX 24 h, deleted when the last user leaves). The endpoint comes from `media_nodes.signaling_url`. A missing node row drops the key and re-places |
| `media:{nodeId}` | pub/sub | gateway → media: `{ "op": "kick", "sessionId": "...", "channelId": "..." }` — media only closes a conn whose token channelId matches (a late kick must not kill a newer connection of the same session) |

## 6. Gateway WebSocket (`hachiman-gateway`)

URL: `ws(s)://<host>/gateway` (dev `ws://localhost:8080/gateway`). Text frames, JSON:
`{ "op": number, "d": any, "s"?: number, "t"?: string }`. `s`/`t` occur only on op 0.

| op | Name | Direction | `d` |
|---|---|---|---|
| 0 | DISPATCH | S→C | event payload; `s` = seq, `t` = event name |
| 1 | HEARTBEAT | C→S | last seq received or null |
| 2 | IDENTIFY | C→S | `{ token }` (Oracle access token) |
| 3 | PRESENCE_UPDATE | C→S | `{ status }` |
| 4 | VOICE_STATE_UPDATE | C→S | `{ guildId, channelId: string \| null, selfMute, selfDeaf }` |
| 6 | RESUME | C→S | `{ token, sessionId, seq }` |
| 7 | RECONNECT | S→C | null — client should reconnect + RESUME |
| 9 | INVALID_SESSION | S→C | `resumable: boolean` |
| 10 | HELLO | S→C | `{ heartbeatInterval }` (ms, 41250) |
| 11 | HEARTBEAT_ACK | S→C | null |

Close codes: 4000 unknown error, 4001 unknown opcode, 4002 decode error, 4003 not authenticated,
4004 authentication failed, 4005 already authenticated, 4007 invalid seq, 4009 session timed out.

Flow: connect → HELLO → client IDENTIFY within 10 s (else 4003) → gateway calls
`GET {ORACLE_URL}/api/v1/users/@me` with the bearer token (non-200 ⇒ 4004) → READY.
Client heartbeats every `heartbeatInterval`. No heartbeat for 1.5× interval ⇒ close 4009.

Token lifetime: the gateway checks the token only at IDENTIFY/RESUME. A live socket outlives token expiry
(Discord semantics). Clients must fetch a fresh token before every IDENTIFY/RESUME.

Dispatch events:

| t | d |
|---|---|
| READY | `{ v: 1, sessionId, user: User, guilds: GuildFull[], privateChannels: Channel[], presences: Presence[] /* DM partners */ }` |
| RESUMED | `{}` |
| GUILD_CREATE | `GuildFull` |
| GUILD_UPDATE | `Guild` |
| GUILD_DELETE | `{ id }` |
| CHANNEL_CREATE / CHANNEL_UPDATE / CHANNEL_DELETE | `Channel` |
| MESSAGE_CREATE / MESSAGE_UPDATE | `Message` |
| MESSAGE_DELETE | `{ id, channelId, guildId }` |
| TYPING_START | `{ channelId, guildId, userId, timestamp }` |
| GUILD_MEMBER_ADD / GUILD_MEMBER_UPDATE | `Member` |
| GUILD_MEMBER_REMOVE | `{ guildId, user: User }` |
| USER_UPDATE | `User` — the current user changed (to user:{me} only). Other users see the change through GUILD_MEMBER_UPDATE. `// ponytail:` DM recipients stay stale until the next READY |
| GUILD_ROLE_CREATE / GUILD_ROLE_UPDATE | `{ guildId, role: Role }` |
| GUILD_ROLE_DELETE | `{ guildId, roleId }` |
| PRESENCE_UPDATE | `{ userId, status }` (published to guild:{g} for every guild of the user, and user:{p} for DM partners) |
| VOICE_STATE_UPDATE | `VoiceState` (`channelId: null` = left) |
| VOICE_SERVER_UPDATE | `{ guildId, channelId, endpoint, token, iceServers: RTCIceServer[], expiresAt }` — to the requesting session only |

Detached sessions: when a socket closes with any code but 1000, the session stays resumable for 60 s. Events keep buffering,
and the voice state stays. After that, or immediately on a clean 1000 close, the session does these steps:
- It leaves voice.
- It publishes offline if no other session of the user is live.
- It deletes `session:`/`events:`.

After INVALID_SESSION, the socket stays open for a fresh IDENTIFY.
The gateway re-materializes GUILD_CREATE on `user:{me}` from Postgres (it needs hidden channels for later visibility diffs).
Visibility diffs (synthetic CHANNEL_CREATE/DELETE) also follow GUILD_ROLE_*, GUILD_MEMBER_UPDATE for the viewer, and GUILD_UPDATE.

Resume: on RESUME, the gateway loads `session:{id}`. Missing or user mismatch ⇒ INVALID_SESSION(false).
Otherwise, the gateway replays frames from `events:{id}` with `s > seq` (gap ⇒ INVALID_SESSION(false)), then sends RESUMED.
Sessions are not pinned to a node.

Presence: IDENTIFY sets `online` (or the last client-requested status). The session TTL expiring ⇒ offline.
The gateway publishes `offline` itself when a socket closes without resuming within 60 s (in-process timer).
`// ponytail:` the users of a crashed node flip to offline only when readers notice that the key is gone. Add a sweeper if that matters.

### Voice join (gateway side)

On op 4 with a `channelId`:
1. Require channel.type == voice and CONNECT + VIEW_CHANNEL.
2. If `voice_user:{me}` names another guild, remove that voice state first (publish VOICE_STATE_UPDATE with channelId null + kick).
3. HSET `voice:{guildId}`, SET `voice_user:{me}`, publish VOICE_STATE_UPDATE to guild.
4. If the channel changed (not a mute/deaf toggle): resolve media node = GET `voice_room:{channelId}`, else
   `PlaceMediaSession{channelId, guildId, homeRegion: guild.region}` through Oracle gRPC, and SET NX.
   Kick the old media session if the user was elsewhere.
5. Mint a voice token (§7). Send VOICE_SERVER_UPDATE with the `signalingUrl` of the node as `endpoint`.

Clients send op 4 with `channelId: null` when their media connection drops unexpectedly. Thus, a re-join is a fresh join.

On op 4 with `channelId: null`, or session end: HDEL, DEL `voice_user`, publish VOICE_STATE_UPDATE(null),
publish kick to `media:{nodeId}`, and DEL `voice_room:{channelId}` if HLEN of occupants in that channel hits 0.

ICE servers: if TURN is configured (`--turn-secret`, `--turn-urls`), mint coturn REST credentials (`pkg/coturn`), else
`[{ "urls": ["stun:stun.l.google.com:19302"] }]`.

Not in v1 (explicitly deferred): server mute/deafen (MUTE_MEMBERS / DEAFEN_MEMBERS), moving others (MOVE_MEMBERS), video.

## 7. Voice token (PASETO v4.public, `pkg/voicetoken`)

Claims:

```go
type Claims struct {
    SessionID   string    `json:"sessionId"`   // gateway session id
    UserID      string    `json:"userId"`
    GuildID     string    `json:"guildId"`
    ChannelID   string    `json:"channelId"`   // = media room id
    MediaNodeID string    `json:"aud"`         // must equal the verifying node's id
    JTI         string    `json:"jti"`
    IssuedAt    time.Time `json:"iat"`
    ExpiresAt   time.Time `json:"exp"`         // 60–120 s after iat
}
```

Go API:

```go
func NewSigner(seedPath string) (*Signer, error)            // gateway; seed = raw 32-byte Ed25519 seed, generated if missing
func (s *Signer) Mint(c Claims) (string, error)              // any aud allowed
func (s *Signer) PublicKeyHex() string
func NewVerifier(pubKeyHex string, nodeID string) (*Verifier, error)   // media
func NewVerifierFromSeed(seedPath, nodeID string) (*Verifier, error)   // dev convenience
func (v *Verifier) Verify(token string) (*Claims, error)     // checks sig, exp, aud == nodeID, jti replay (existing LRU)
```

Key file default: `.dev/keys/voice-signer.ed25519` (dev: gateway and media point at the same file).
DTLS fingerprint / ICE ufrag binding: dropped (the client has no PC yet when the gateway mints the token).

## 8. Media voice WebSocket (`hachiman-media`)

URL: the `signalingUrl` of the node, e.g. `wss://media-1.example.com/voice` (dev `ws://localhost:8090/voice`).
JSON text frames `{ "op": string, "d": any }`. Media is always the SDP **offerer**. The client only answers.

| op | Direction | d |
|---|---|---|
| identify | C→M | `{ token }` — must be the first frame, within 10 s |
| ready | M→C | `{ sessionId, ssrc }` |
| offer | M→C | `{ sdp }` (initial + every renegotiation) |
| answer | C→M | `{ sdp }` |
| candidate | both | `{ candidate: RTCIceCandidateInit \| null }` (null = end of candidates) |
| peers | M→C | `{ peers: [{ userId, ssrc }] }` — full snapshot of other room members; sent on join and on every change |
| speaking | C→M | `{ speaking: boolean }` |
| speaking | M→C | `{ userId, speaking }` — relayed to other room members |

Keepalive: media pings every ~20 s and drops sockets silent for 60 s. Media closes 1011 if an offer goes unanswered ~15 s or the PC is not `connected` ~30 s after join. Media rejects frames > 64 KiB.

Close codes: 4004 bad token (incl. replayed jti — clients need a fresh VOICE_SERVER_UPDATE token per voice-WS connect), 4009 token expired / identify timeout,
4010 kicked (Redis `media:{nodeId}` kick), 4011 replaced (same sessionId connected again), 1011 ICE/negotiation failure, 1008 client send queue overflow, 1001 shutdown.

`ssrc` in `ready`/`peers` is a node-unique id from `SSRCPool`, **not** the on-wire RTP SSRC (pion v3 picks those). Map tracks by msid (below).
Opus payload type 111. Mic upload slot = the recvonly transceiver at m-line 0 of the initial offer (stable across renegotiations).
Peer tracks ride separate sendonly transceivers. Frame order on join: `ready` → `peers` → `offer`.

Track labeling: each output track the media node creates for a peer has **stream id = peer userId** and track id
`audio-<userId>`. Clients map remote tracks to users via `ontrack` → `event.streams[0].id`.

SFU keys: session = `Claims.SessionID` (string), room = `Claims.ChannelID`. Media allocates SSRCs per node from
`SSRCPool` keyed by session string. A client receives output tracks **only** for peers in its own room.

Media flags/env: `--node-id` (`MEDIA_NODE_ID`), `--region` (`MEDIA_REGION`), `--listen :8090`, `--signaling-url ws://localhost:8090/voice`,
`--oracle-grpc-addr` (`ORACLE_GRPC_ADDR`), `--redis-url` (`REDIS_URL`), `--voice-pubkey` (`VOICE_PUBKEY`) or `--voice-key` (`VOICE_KEY`, seed path shared with the gateway),
`--public-ip` (pion NAT 1:1), `--udp-port-min/max`. Media calls Oracle `RegisterMediaNode` at start and
`MediaNodeHeartbeat` every 10 s (via `pkg/oracleclient`). No gateway↔media gRPC sidechannel exists anymore.

## 9. Oracle management gRPC (`apps/hachiman-server/pkg/management/management.proto`)

Package `hachiman.management.v1`, service `Management` (Oracle serves it, and media + gateway call it):

```proto
rpc RegisterMediaNode(RegisterMediaNodeRequest) returns (RegisterMediaNodeResponse);
rpc MediaNodeHeartbeat(MediaNodeHeartbeatRequest) returns (MediaNodeHeartbeatResponse);
rpc PlaceMediaSession(PlaceMediaSessionRequest) returns (PlaceMediaSessionResponse);

message RegisterMediaNodeRequest { string node_id = 1; string region = 2; string signaling_url = 3; uint32 max_sessions = 4; string version = 5; }
message MediaNodeHeartbeatRequest { string node_id = 1; uint32 active_sessions = 2; float cpu_fraction = 3; bool accepting = 4; }
message PlaceMediaSessionRequest { string channel_id = 1; string home_region = 2; string guild_id = 3; }
message PlaceMediaSessionResponse { string node_id = 1; string signaling_url = 2; }
// RegisterMediaNodeResponse / MediaNodeHeartbeatResponse are empty.
```

Oracle placement ignores `channel_id`/`guild_id`. It returns the least-loaded fresh node in `home_region`, or in any region when `home_region` is empty (guilds default to no region). Channel stickiness comes from the gateway key `voice_room:{channelId}`.

Create/DeleteVirtualServer: deleted. Oracle loads the proto dynamically (`@grpc/proto-loader`), so the
TS handler names follow the proto (`Management`, `hachiman.management.v1`).

## 10. Client library surface (`@hachiman/client`)

Browser-safe only (fetch, WebSocket, RTCPeerConnection). No Node imports, no rxjs, no protobuf.
`package.json` `exports` points at `./src/index.ts` (consumed as source, like `@hachiman/hachiman`).

```ts
export * from './types'          // §1 + gateway frame/event types (GatewayEvents map: event name → payload)
export * from './permissions'    // Permissions, DEFAULT_EVERYONE, ALL, computeBasePermissions, computeChannelPermissions, has(perms, bit)
export { TypedEventEmitter } from './typed-event-emitter'

type TokenProvider = () => Promise<string>   // must return a fresh, valid Oracle access token

export class RestClient {
  constructor(opts: { baseUrl: string /* e.g. http://localhost:3000/api/v1 */; getToken: TokenProvider })
  // one method per §4 row, e.g.:
  getMe(); createGuild(body); getGuild(id); updateGuild(id, body); deleteGuild(id)
  createChannel(guildId, body); reorderChannels(guildId, body); updateChannel(id, body); deleteChannel(id)
  putOverwrite(channelId, targetId, body); deleteOverwrite(channelId, targetId)
  getMessages(channelId, { before?, limit? }); editMessage(...); deleteMessage(...); triggerTyping(channelId)
  getMembers(guildId); updateMember(guildId, userId, body); kickMember(guildId, userId); leaveGuild(guildId)
  getRoles(guildId); createRole(...); reorderRoles(...); updateRole(...); deleteRole(...)
  getInvites(guildId); createInvite(guildId, body); deleteInvite(code); previewInvite(code); acceptInvite(code)
  getDmChannels(); openDm(recipientIds); getUser(id)
  updateMe({ avatar? }); getLimits()
  sendMessage(channelId, { content, nonce?, attachments?: string[] /* upload ids */ })
  // XHR, because fetch has no upload progress. Rejects with RestError (413 UploadTooLarge, ...) or an AbortError.
  upload(file: Blob, opts: { filename: string; width?: number; height?: number; signal?: AbortSignal; onProgress?(loaded: number, total: number): void }): Promise<Attachment>
  fileUrl(key: string): string   // `${baseUrl}/files/${key}`, each path segment URI-encoded
}
export const EMBEDDABLE: { image: readonly string[]; video: readonly string[]; audio: readonly string[] }   // src/files.ts
export function embedKind(contentType: string): 'image' | 'video' | 'audio' | 'file'   // ignores MIME parameters (`; codecs=...`) and case
export class RestError extends Error { status: number; code: string }

export class GatewayClient extends TypedEventEmitter<GatewayClientEvents> {
  constructor(opts: { url: string; getToken: TokenProvider })
  connect(): void          // auto-reconnect with backoff; RESUME when possible, else fresh IDENTIFY
  disconnect(): void
  readonly state: 'idle' | 'connecting' | 'ready' | 'resuming' | 'closed'
  readonly sessionId: string | null
  readonly latencyMs: number | null   // HEARTBEAT → ACK RTT
  updatePresence(status: PresenceStatus): void
  updateVoiceState(d: { guildId: string; channelId: string | null; selfMute: boolean; selfDeaf: boolean }): void
  // events: 'state' (state), 'dispatch' ({t, d}), and each event name from §6 with its typed payload
}

export class VoiceConnection extends TypedEventEmitter<VoiceEvents> {
  constructor(opts: { endpoint: string; token: string; iceServers: RTCIceServer[] })
  connect(): Promise<void>
  close(): void
  setMicrophone(stream: MediaStream | null): Promise<void>   // null = stop sending
  setMuted(muted: boolean): Promise<void>                    // gates the outgoing track; the mic stream stays open
  setSpeaking(speaking: boolean): void                       // sends op speaking
  setDeafened(deafened: boolean): void                       // mutes all remote playback locally
  setOutputDevice(deviceId: string | null): Promise<void>    // null = system default
  setOutputVolume(userId: string, volume: number): void
  getStats(): Promise<{ rttMs: number | null; jitterMs: number | null; packetLoss: number | null }>
  // events: 'state' (RTCPeerConnectionState), 'speaking' ({userId, speaking}), 'peers' ({userId, ssrc}[])
}

export class HachimanClient extends TypedEventEmitter<HachimanClientEvents> {
  constructor(opts: { apiUrl: string; gatewayUrl: string; getToken: TokenProvider })
  readonly rest: RestClient
  readonly gateway: GatewayClient
  readonly cache: {
    user: User | null
    guilds: Map<string, Guild>
    channels: Map<string, Channel>               // guild channels + DMs
    roles: Map<string, Map<string, Role>>        // guildId → roleId → Role
    members: Map<string, Map<string, Member>>    // guildId → userId → Member
    presences: Map<string, PresenceStatus>       // userId → status
    voiceStates: Map<string, Map<string, VoiceState>>  // guildId → userId → state
  }
  connect(): void; disconnect(): void
  permissionsFor(channelId: string): number      // for the current user
  guildPermissions(guildId: string): number
  joinVoice(guildId: string, channelId: string): Promise<VoiceConnection>   // joins with the current selfVoice
  leaveVoice(): void
  readonly selfVoice: SelfVoiceState             // { ownMute, selfMute, selfDeaf }
  setSelfVoice(change: Partial<SelfVoice>): SelfVoiceState   // SelfVoice = { selfMute, selfDeaf }
  readonly voice: VoiceConnection | null
  // events: 'ready', 'state', 'update' (fired after any cache mutation with { t, d }), plus every gateway event re-emitted after the cache is updated
}
```

`setSelfVoice` is the only place that sets self mute and deafen. The rules follow Discord:
- Deafen mutes the outgoing audio and all remote playback. Op 4 then sends `selfMute: true`.
- Undeafen restores the mute state that the user set before the deafen.
- `selfMute: false` while deafened also undeafens.

`selfVoice` and the return value of `setSelfVoice` give the full state. `selfMute` and `selfDeaf` are the values that op 4 sends. `ownMute` is the mute state that the user set. Deafen does not change `ownMute`, and undeafen restores it.

Each call sends exactly one op 4 when the client is in voice. Outside voice, it sends nothing, and the next `joinVoice` uses the new state.
Mute does not release the microphone. It only stops the outgoing track (`VoiceConnection.setMuted`).

## 11. Shared UI ↔ host seam (`apps/hachiman/src/shared/IPlatformService.ts`)

```ts
export interface IPlatformService {
  readonly platform: 'electron' | 'browser'
  /** The host hides the native title bar, so the UI draws a draggable strip (Electron on macOS). */
  readonly insetTitleBar: boolean
  /** OAuth `redirect_uri` for this host. Oracle's client registration must allow it. */
  readonly oauthRedirectUri: string
  /** Opens the OAuth authorization page. Browser: same-tab redirect. Electron: system browser. */
  beginOAuth(url: string): void
  /** Invite links (`takusen://invite/<code>` or `https://<oracle>/invite/<code>`) → code. Returns unsubscribe. */
  onInviteCode(cb: (code: string) => void): () => void
  /** OAuth redirect URLs delivered by the host (Electron custom scheme / browser callback route). */
  onOAuthCallback(cb: (url: string) => void): () => void
  /** Electron: TCP-connect RTT probe from main. Browser: resolves []. */
  probeRegions(targets: { region: string; host: string; port: number }[]): Promise<{ region: string; rttMs: number | null }[]>
}
```

The shared UI must not examine `window`, `navigator.userAgent`, or `window.location` to identify the host. It reads the host facts from this interface.

Each host declares its title bar. The Electron main process hides the native title bar on macOS only. The preload script gives this fact to the renderer as `window.hachiman.insetTitleBar`. The browser host sets `insetTitleBar` to `false`.

`beginOAuth` is the only way to start sign-in. The UI gives `oauthRedirectUri` to `oracleService.beginSignIn`. The pending PKCE flow keeps the URI, and `completeSignIn` sends the same URI in the token exchange. The two hosts use different redirect URIs:

- Browser: `${location.origin}/oauth/callback`. The host replaces the current page, so the callback comes back to the same app instance.
- Electron: `${issuerOrigin}/oauth/electron-bridge`. A system browser cannot show an `app.hachiman://` URL. Thus the Oracle bridge page receives the code and opens `app.hachiman://oauth-callback?…`. The main process then sends that URL to the renderer.

`VITE_HACHIMAN_OIDC_REDIRECT` replaces the default URI on either host.

When the user starts sign-in from an invite dialog, the pending PKCE flow also keeps the invite code. After the callback, the UI opens the invite dialog again. It does this also when sign-in fails. The browser host needs this step: the redirect loads the page again, and the host removed `/invite/<code>` from the URL at start-up. When the callback fails, the UI shows the cause and tells the user to sign in again. The sign-in screen and the invite dialog show this message.

The guild region pickers use `probeRegions`. They send the measured RTTs to `POST /api/v1/regions/recommend` and show the result as "Automatic (recommended: <region>)". The browser host measures nothing, so the picker shows only "Automatic".

Hosts render `<PlatformProvider value={platformService}><ThemeProvider><App /></ThemeProvider></PlatformProvider>`. `ThemeProvider` applies the theme from `prefsStore` to `<html>`. The config comes from
the existing Vite env read in `OracleService.ts` (`VITE_TAKUSEN_OIDC_ISSUER`, `VITE_TAKUSEN_OIDC_CLIENT_ID`,
`VITE_TAKUSEN_API_BASE` default `<issuer-origin>/api`) plus the new
`VITE_HACHIMAN_GATEWAY_URL` (default `ws://localhost:8080/gateway`). REST base = `${apiBase}/v1`.

### Packaged renderer origin

The packaged Electron app does not load the renderer from `file://`. A `file://` page sends `Origin: null`, and Oracle rejects that origin. The main process serves the built renderer from the privileged scheme `hachiman` (`apps/hachiman-electron/src/main/renderer-protocol.ts`). The window loads `hachiman://app/index.html`, so the page origin is `hachiman://app`. The dev build loads the electron-vite dev server URL.

- The handler serves only files in the built renderer directory. Other paths get a 404 response. The renderer has no client-side routes, thus there is no `index.html` fallback.
- `hachiman` is not an OS deep-link scheme. The deep-link schemes stay `takusen://` and `app.hachiman://`.
- The main process blocks navigation to all URLs outside the app origin. `window.open` gives `http(s)` URLs to the system browser and opens no window.
- The main process sends the Content-Security-Policy (CSP) as a response header (`apps/hachiman-electron/src/main/csp.ts`). The `index.html` file has no CSP meta tag. In the packaged app, the `hachiman` handler sends the header. In dev, the header goes on the responses from the dev server.
- `connect-src` gets the origins of `VITE_TAKUSEN_OIDC_ISSUER`, `VITE_TAKUSEN_API_BASE` and `VITE_HACHIMAN_GATEWAY_URL`, plus `wss:` for the media nodes. The main process and the renderer use the same resolver (`@hachiman/hachiman/oracle-env`) and the same defaults.
- `connect-src` also allows `ws:` when one of these endpoints, or the dev server, uses `ws:` or `http:`. Thus a local stack keeps voice in `electron-vite preview` too.
- `script-src` is `'self'`. With the dev server only, it also allows `'unsafe-inline'`, because the React Fast Refresh preamble is an inline script.
- The policy also sets `object-src 'none'`, `form-action 'none'` and `frame-ancestors 'none'`.

### Oracle allowed origins

`apps/oracle/src/lib/allowed-origins.ts` holds one CORS allowlist. The `/api/*` middleware and the per-client CORS of the OIDC provider both use it.

- `TAKUSEN_ALLOWED_ORIGINS` (comma-separated) replaces the default list.
- The default list has the Vite dev origins and `hachiman://app`.
- Oracle never allows the origin `null`.
- The middleware is the only source of CORS headers under `/api/*`, `/api/oidc` included. It answers all preflights. The OIDC route removes the CORS headers and the `Vary` header that the OIDC provider sets.
- On the token, userinfo and revocation endpoints, the OIDC provider also examines the origin with the same allowlist. It rejects a different origin with a 400 response.

Deep link scheme: `takusen://invite/<code>` (replaces `takusen://join#<signed payload>`). OAuth callback scheme unchanged (`app.hachiman://oauth-callback`).
