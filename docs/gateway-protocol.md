# Hachiman Protocol Contract (v1)

Source of truth for every cross-process boundary after the Discord-architecture
refactor (`docs/discord-refactor.md`). If code and this file disagree, fix one of
them in the same change. This file replaces `Mumble.proto` as "the protocol".

Components:

| Process | Lang | Talks to |
|---|---|---|
| Takusen (Next.js, `apps/takusen`) | TS | Postgres (rw), Redis (PUBLISH) |
| Takusen gRPC (`apps/takusen/src/grpc`) | TS | Postgres (media_nodes) |
| `hachiman-gateway` (`apps/hachiman-server/cmd/hachiman-gateway`) | Go | Postgres (read), Redis (rw + SUBSCRIBE), Takusen REST (auth), Takusen gRPC (placement) |
| `hachiman-media` (`apps/hachiman-server/cmd/hachiman-media`) | Go | Takusen gRPC (register/heartbeat), Redis (SUBSCRIBE `media:{nodeId}`), clients (voice WS + WebRTC) |
| `@hachiman/client` (`pkgs/hachiman-client`) | TS | Takusen REST, gateway WS, media voice WS |
| `@hachiman/crypto` (`pkgs/hachiman-crypto`) | TS | runs in a Worker. Takusen REST through the main thread (§12) |

Conventions:
- **IDs** are UUID strings (Postgres `uuid`, `defaultRandom()`). No numeric ids anywhere on the wire.
- **JSON is camelCase** on every boundary (REST, gateway, voice WS, Redis payloads).
- **Timestamps** are ISO-8601 strings.
- **Permissions** are JS-safe integers (all bits < 2^31). `// ponytail:` switch to decimal strings + BigInt when a bit ≥ 31 is needed.
- **Bytes** on JSON wires are base64url without padding (§12.2).
- **E2EE.** Message content, attachments and media frames are end-to-end encrypted. §12 is the contract.

---

## 1. Entity shapes

These are the TS types exported from `@hachiman/client` (`src/types.ts`). Go mirrors them with `json:"camelCase"` tags.

```ts
type ChannelType = 'text' | 'voice' | 'category' | 'dm' | 'group_dm' | 'pages' | 'thread'
type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

// avatar, icon and banner are file keys (§4 Files), not URLs. The client builds the URL with RestClient.fileUrl(key).
interface User { id: string; username: string; avatar: string | null }   // username = users.displayName ?? users.name ?? email local-part

interface Guild {
  id: string; name: string; icon: string | null; banner: string | null; ownerId: string; region: string | null; createdAt: string
  publicHistoryVisibility: 'joined' | 'shared'   // the public_set group (§12.6). Default 'shared'
}

// One encrypted blob (§12.9). POST /uploads?kind=blob returns it, and Message.attachments holds it.
// The file name, MIME type, dimensions and plaintext size are only in the envelope (AttachmentPointer, §12.8).
interface Attachment { id: string; key: string /* `${id}/blob` */; size: number /* blob bytes */ }

interface Limits { maxUploadBytes: number; maxAttachmentsPerMessage: number; maxEnvelopeBytes: number; maxPageSnapshotBytes: number }

interface Role { id: string; guildId: string; name: string; color: number; hoist: boolean /* own group in the member list */; position: number; permissions: number }
// The @everyone role has id === guildId and position 0. It always exists and cannot be deleted.

interface PermissionOverwrite { id: string /* role id or user id */; type: 'role' | 'member'; allow: number; deny: number }

interface Channel {
  id: string
  guildId: string | null           // null for dm / group_dm
  type: ChannelType
  name: string | null              // null for dm
  topic: string | null
  parentId: string | null          // category id. thread: the parent text channel (never null)
  position: number                 // thread: 0
  permissionOverwrites: PermissionOverwrite[]   // [] for DMs and threads
  recipients?: User[]              // dm / group_dm only: every participant except the viewer
  ownerId?: string | null          // group_dm: the owner. thread: the creator
  mlsGroupId: string | null        // text, pages, dm, group_dm: the current MLS group (base64url, §12.6). null: no group yet, or voice/category/thread. A thread uses the group of its parent: read it from the parent channel or GET /channels/:threadId/mls-group
  historyVisibility: 'joined' | 'shared' | null   // text, pages, dm, group_dm: the effective value (§12.6). null for voice/category/thread (a thread has the value of its parent)
  threadStartMessageId?: string | null   // thread only: the message of the parent that starts the thread, or null
}

interface Member {
  guildId: string; user: User; nick: string | null; roles: string[] /* excludes @everyone */; joinedAt: string
  mute: boolean; deaf: boolean     // server mute and deafen (§6 "Voice moderation"). They stay across calls
}

interface Ban { user: User; reason: string | null; createdAt: string }   // §4 Bans

// A scheduled guild event (§4 Pins, guild events and blocks). Plaintext metadata, like a channel topic (§12.1).
interface GuildEvent {
  id: string; guildId: string
  channelId: string | null         // an optional voice channel of the guild
  title: string                    // 1–100 characters
  startsAt: string; endsAt: string | null
  createdBy: string | null; createdAt: string
  rsvpCount: number                // members who are going
}
interface GuildEventWithMe extends GuildEvent { me: boolean }   // GET /guilds/:id/events: true when the caller is going

// A custom guild emoji (§4 Emojis). Plaintext, like the guild icon. A message names it as `<:name:id>` inside its envelope.
interface GuildEmoji {
  id: string; guildId: string
  name: string                     // 2–32 characters of [a-z0-9_], unique in the guild
  key: string                      // file key of the image (§4 Files): PNG, GIF or WebP, at most 256 KiB
  createdBy: string | null; createdAt: string
}

interface BlockedUser { user: User; createdAt: string }         // GET /users/@me/blocks

// A soundboard sound (§4 Soundboard). name and emoji are plaintext metadata; the file key is only in `envelope` (§12.21).
interface GuildSound {
  id: string; guildId: string; name: string; emoji: string | null
  uploadId: string; key: string /* `${uploadId}/blob` */; size: number /* blob bytes */
  channelId: string                // the public text or pages channel whose group sealed `envelope`
  groupId: string; epoch: number; senderDevice: string | null
  envelope: string                 // doc_snapshot envelope with page_id = id: the sound pointer (§12.21)
  createdBy: string | null; createdAt: string
}

// The server never sees content. The client decrypts `envelope` (§12.8).
interface Message {
  id: string; channelId: string; guildId: string | null
  author: User
  senderDevice: string | null      // device id. null after the device row is gone
  groupId: string                  // base64url MLS group id (§12.6)
  epoch: number                    // MLS epoch of the envelope
  clientMsgId: string              // base64url, 16 bytes. The original's id after an edit
  envelope: string                 // base64url Envelope (§12.8.1). An edit replaces it
  attachments: Attachment[]        // upload order
  createdAt: string; editedAt: string | null
  nonce?: string                   // echoed from the create request, never stored
}

interface Invite { id: string; code: string; guildId: string; createdBy: string; expiresAt: string | null; maxUses: number | null; uses: number; createdAt: string
  hasHistory: boolean }            // the invite has a signed record: an invite with history (§12.11.4)
interface InvitePreview { code: string; guild: Pick<Guild, 'id' | 'name' | 'icon'>; memberCount: number; expiresAt: string | null; hasHistory: boolean }

interface Presence {
  userId: string; status: PresenceStatus
  customStatus?: CustomStatus      // absent = none. Plaintext: the same people see it as the status
}
interface CustomStatus {
  text: string                     // 1–64 characters, trimmed, no control or bidi control characters (§6 op 3)
  expiresAt: string | null         // RFC 3339. Clients hide the status from then on; the gateway sends no event at expiry
}

interface VoiceState {
  guildId: string | null           // null: a DM or group DM call (§6 "DM calls")
  channelId: string | null; userId: string
  sessionId: string                // gateway session id
  selfMute: boolean; selfDeaf: boolean
  mute: boolean; deaf: boolean     // server mute and deafen: the Member values (§6 "Voice moderation")
  selfStream: boolean              // screen share is live (§8)
  joinedAt: string                 // RFC 3339: when this session joined the channel. Kept across mute, deafen and stream
                                   // changes, set again on a move to another channel or a join from another session.
                                   // The call start of a channel is the oldest joinedAt of its states
}

// A page of a pages channel (§4 Pages). The server sees only the tree and the timestamps.
interface Page {
  id: string                       // chosen by the client on create: the title envelope binds it (§12.20)
  channelId: string
  parentId: string | null          // null for a root page. A page of the same channel
  position: number
  titleEnvelope: string            // base64url doc_title envelope (§12.20)
  createdBy: string | null         // null after the user is gone
  createdAt: string; updatedAt: string
}
interface DocUpdate { pageId: string; seq: number /* per page, from 1, no gaps */; groupId: string; epoch: number; senderDevice: string | null; envelope: string /* doc_update */; createdAt: string }
interface DocSnapshot {
  pageId: string; baseSeq: number  // the state covers every update with seq <= baseSeq
  uploadId: string; key: string /* `${uploadId}/blob` */; size: number /* blob bytes */
  groupId: string; epoch: number; senderDevice: string | null
  envelope: string                 // doc_snapshot envelope: the pointer and the file key (§12.20)
  mediaUploadIds: string[]; createdAt: string
}
interface PageState { snapshot: DocSnapshot | null; updates: DocUpdate[] /* after snapshot.baseSeq (or 0), at most 500 */; latestSeq: number }
interface PageHead {               // GET /channels/:id/pages/heads: the data of a re-wrap pass (§12.20)
  pageId: string; latestSeq: number
  title: { groupId: string; epoch: number } | null   // from the header of titleEnvelope. null when the header does not decode
  snapshot: DocSnapshot | null     // the newest snapshot
}

interface ReadState {              // READY readStates; READ_STATE_UPDATE sets lastReadMessageId
  channelId: string
  lastReadMessageId: string | null // null: the user did not ack this channel
  unreadCount: number              // messages after lastReadMessageId from other authors, at most 100. 0 when lastReadMessageId is null
  lastMessageId: string | null     // the newest message of the channel. null: no messages
}

interface GuildFull extends Guild {  // READY + GUILD_CREATE
  channels: Channel[]              // only channels the user can VIEW. READY and GET /guilds/:id: at most the 50 most recently active threads of the guild (channels.last_activity_at)
  roles: Role[]
  members: Member[]                // ponytail: full list; add lazy member chunks when guilds exceed ~1k members
  voiceStates: VoiceState[]
  presences: Presence[]            // online members only
  emojis: GuildEmoji[]             // the custom emojis of the guild, oldest first
}
```

The E2EE shapes (`Device`, `UserKeys`, `MlsGroup`, `Handshake`, …) are in §12.12.

## 2. Permissions

Discord bit values (subset). Defined **once per language**:
TS `pkgs/hachiman-client/src/permissions.ts`, Go `apps/hachiman-server/pkg/permissions/permissions.go`.
A Go test (`pkg/permissions/sync_test.go`) parses the TS file and fails if any name/value differs.

| Name | Value |
|---|---|
| CREATE_INSTANT_INVITE | 1 << 0 |
| KICK_MEMBERS | 1 << 1 |
| BAN_MEMBERS | 1 << 2 |
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
| USE_SOUNDBOARD | 1 << 25 |
| CHANGE_NICKNAME | 1 << 26 |
| MANAGE_NICKNAMES | 1 << 27 |
| MANAGE_ROLES | 1 << 28 |
| MANAGE_EVENTS | 1 << 29 |
| MANAGE_EXPRESSIONS | 1 << 30 |

`DEFAULT_EVERYONE = VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY | CONNECT | SPEAK | USE_SOUNDBOARD | CREATE_INSTANT_INVITE | CHANGE_NICKNAME`.
USE_SOUNDBOARD lets a member play the guild sounds in a voice call. MANAGE_EXPRESSIONS lets a member upload and delete guild sounds (§4 Soundboard). USE_SOUNDBOARD joined DEFAULT_EVERYONE after guilds existed: migration `0009_sound_permission_backfill` sets it on the @everyone role of each existing guild without a signed action. It is not a security permission (a member with SPEAK can send any audio in its track), and the signed admin replay does not check it (§12.16 "Unchecked bits"). MANAGE_EXPRESSIONS decides which sound pointers a member trusts, so clients read it from the signed admin state (§12.21). Bit 30 is the last bit below 2^31, the limit of the plain-number bitfield.
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
Threads: a thread has no overwrites. Every permission check on a thread uses its parent channel: `computeChannelPermissions(…, parent)`. Takusen, the gateway and the client (`permissionChannel(channel, lookup)` in `permissions.ts`) do this. A thread whose parent is not known gives 0.
DM channels: participants get `VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES | READ_MESSAGE_HISTORY`, non-participants 0.
Role hierarchy: a member may only edit/assign roles whose `position` is strictly below the highest role of that member (owner/admin exempt).

## 3. Postgres schema (Takusen Drizzle, `apps/takusen/src/db/schema.ts` and the files it re-exports: `schema-auth.ts`, `schema-channel-state.ts`, `schema-pages.ts`)

New/changed tables (all ids `uuid` defaultRandom, timestamps `timestamptz` default now):

| Table | Columns | Notes |
|---|---|---|
| `guilds` | id, owner_id → users (cascade), name, icon null, banner null, region → regions.code (set null), page_storage_bytes bigint (mode number) default 0, created_at | replaces virtual_servers. icon/banner hold file keys. `page_storage_bytes`: the page quota count (§4 Pages) |
| `uploads` | id, uploader_id → users (cascade), key unique, filename null (null for blobs), size bigint (mode number), content_type, encrypted bool default false, message_id null → messages (cascade), position int default 0, purpose `upload_purpose` enum ('attachment','image','page_snapshot','page_media','sound','emoji') null, page_id null → doc_pages (cascade), last_referenced_at null, created_at | index (message_id); index (page_id); CHECK `uploads_attachment_has_message`: `(purpose IS NOT DISTINCT FROM 'attachment') = (message_id IS NOT NULL)`; CHECK `uploads_page_media_has_page`: `purpose IS DISTINCT FROM 'page_media' OR page_id IS NOT NULL`; CHECK `uploads_page_id_is_page_purpose`: `page_id IS NULL OR purpose IN ('page_snapshot','page_media')`. One row per stored object. The first claim sets purpose, and purpose never changes. message_id is set when a message claims it, together with purpose. A `page_snapshot` upload has its purpose from the upload on, and page_id from the snapshot claim (§4 Pages) |
| `guild_members` | guild_id → guilds (cascade), user_id → users (cascade), nick null, joined_at, invite_id null → invites (set null), mute bool default false, deaf bool default false | PK (guild_id, user_id); index (invite_id) where not null. `invite_id`: the invite of the join (§4 accept). The redeemer of an invite with history gets its bundles with it (§12.11.4) |
| `guild_bans` | guild_id → guilds (cascade), user_id → users (cascade), reason text null, banned_by null → users (set null), created_at | PK (guild_id, user_id). §4 Bans |
| `channels` | id, guild_id null → guilds (cascade), type `channel_type` enum (incl. `thread`), name null, topic null, parent_id null → channels (set null), position int default 0, owner_id null → users (set null), mls_group_id bytea null → mls_groups (set null), thread_start_message_id uuid null → messages (set null), created_at, last_activity_at timestamptz not null default now() (a thread: set by POST /channels/:id/messages; the migration backfills the last message, else created_at) | index (guild_id); index (parent_id, last_activity_at); index (guild_id, last_activity_at) where type = 'thread'. A thread has `mls_group_id` null: readers take the group of the parent. `DELETE /channels/:id` deletes the threads of the channel (the FK alone sets null) |
| `messages` | id, channel_id → channels (cascade), author_id → users (cascade), group_id bytea → mls_groups (cascade), epoch bigint, sender_device uuid null → devices (set null), client_msg_id bytea, envelope bytea, franking_tag bytea, size int, created_at, edited_at null | index (channel_id, created_at desc, id desc); unique (channel_id, client_msg_id). No `content` column (§12.8) |
| `roles` | id, guild_id → guilds (cascade), name, color int default 0, hoist boolean default false, position int default 0, permissions bigint (mode number) | @everyone row has id = guild_id |
| `member_roles` | guild_id, user_id, role_id → roles (cascade) | PK (user_id, role_id); FK (guild_id,user_id) → guild_members (cascade) |
| `permission_overwrites` | channel_id → channels (cascade), target_id uuid, target_type `overwrite_type` enum ('role','member'), allow bigint, deny bigint | PK (channel_id, target_id) |
| `dm_participants` | channel_id → channels (cascade), user_id → users (cascade) | PK (channel_id, user_id); index (user_id) |
| `read_states` | user_id → users (cascade), channel_id → channels (cascade), last_read_message_id uuid, last_read_created_at, updated_at | PK (user_id, channel_id). The read position is (`last_read_created_at`, `last_read_message_id`), the order of `messages`. It has no foreign key to `messages`: the position stays when that message is deleted |
| `guild_emojis` | id, guild_id → guilds (cascade), name text, upload_id unique → uploads (cascade), created_by null → users (set null), created_at | unique (guild_id, name). A custom emoji (§4 Emojis). `upload_id` is a plaintext `emoji` upload. Migration 0010 |
| `invites` | id, code unique, guild_id → guilds (cascade), created_by → users (cascade), expires_at null, max_uses null, uses int default 0, revoked bool default false, record bytea null, key_id bytea null, exhausted_at null, created_at | index (guild_id); unique (key_id). Replaces invite_codes. `record` and `key_id`: the `SignedInviteRecord` of an invite with history and its `sign_public` (§12.11.4). The accept of the last use sets `exhausted_at` |

Pages tables (§4 Pages, §12.20). The server sees the tree and the timestamps. Titles, edits and snapshot pointers are envelopes:

| Table | Columns | Notes |
|---|---|---|
| `doc_pages` | id uuid PK (no default: the client chooses it), channel_id → channels (cascade), parent_id null → doc_pages (cascade), position int default 0, title_envelope bytea, created_by null → users (set null), latest_seq bigint default 0, created_at, updated_at | index (channel_id); index (parent_id). `latest_seq` is the highest `doc_updates.seq` of the page |
| `doc_updates` | page_id → doc_pages (cascade), seq bigint, group_id bytea → mls_groups (cascade), epoch bigint, sender_device null → devices (set null), envelope bytea, created_at | PK (page_id, seq). One doc_update envelope (one encrypted Yjs update) per row |
| `doc_snapshots` | page_id → doc_pages (cascade), base_seq bigint, upload_id unique → uploads (cascade), group_id bytea → mls_groups (cascade), epoch bigint, sender_device null → devices (set null), envelope bytea, media_upload_ids uuid[] default '{}', created_at | PK (page_id, base_seq). The bytes are the S3 object of `upload_id`. `envelope` is the doc_snapshot pointer envelope. A re-wrap (§4 Pages) replaces `envelope`, `group_id`, `epoch` and `sender_device` in place |

Pins, guild events and blocks (§4 Pins, guild events and blocks, `apps/takusen/src/db/schema-channel-state.ts`, with `read_states`):

| Table | Columns | Notes |
|---|---|---|
| `channel_pins` | channel_id → channels (cascade), message_id → messages (cascade), pinned_by null → users (set null), pinned_at | PK (channel_id, message_id). The server learns which message ids are pinned, not their content |
| `guild_events` | id, guild_id → guilds (cascade), channel_id null → channels (set null), title, starts_at, ends_at null, created_by null → users (set null), created_at | index (guild_id, starts_at). CHECK (ends_at is null or ends_at > starts_at). Plaintext metadata (§12.1) |
| `guild_event_rsvps` | event_id → guild_events (cascade), user_id → users (cascade), created_at | PK (event_id, user_id). One row per member who is going |
| `user_blocks` | user_id → users (cascade), blocked_user_id → users (cascade), created_at | PK (user_id, blocked_user_id); index (blocked_user_id) |
| `guild_sounds` | id uuid PK (no default: the client chooses it), guild_id → guilds (cascade), name, emoji null, upload_id unique → uploads (cascade), channel_id uuid (no FK), group_id bytea (no FK), epoch bigint, sender_device null → devices (set null), envelope bytea, created_by null → users (set null), created_at | index (guild_id, created_at). Migration 0008. The soundboard (§4 Soundboard). `name` and `emoji` are plaintext metadata. The clip is the encrypted blob of `upload_id` (purpose `sound`). `envelope` is the sound pointer with the file key, sealed in the group of `channel_id` (§12.21). Migration 0009 adds USE_SOUNDBOARD to the @everyone role of every existing guild |

E2EE tables (§12). `bytea` columns hold the binary objects of §12 as they are. Enums: `device_status` ('pending','active','revoked'), `device_platform` ('electron','browser'), `revoke_reason` ('user','lost','password_reset','compromised','signed_out'), `mls_group_kind` ('public_set','channel','dm'), `mls_group_status` ('pending','active','retired'), `history_visibility` ('joined','shared'), `handshake_kind` ('commit','external_commit','proposal'), `pending_op` ('add','remove'), `pending_status` ('queued','assigned','rejected'), `join_status` ('queued','committed','rejected','external_commit','waiting'), `inbox_kind` ('welcome','dsk_transfer','history_keys'), `backup_kind` ('identity','history').

| Table | Columns | Notes |
|---|---|---|
| `devices` | id, user_id → users (cascade), status `device_status` default 'pending', name, platform, client_version, certificate bytea null, mls_signature_key bytea null, hpke_key bytea null, dsk_generation int null, created_at, last_seen_at null, revoked_at null | index (user_id) |
| `device_revocations` | device_id PK → devices (cascade), user_id → users (cascade), reason `revoke_reason`, revocation bytea null (null = server revocation), created_at | |
| `master_keys` | user_id → users (cascade), generation int, public_key bytea, record bytea, created_at, superseded_at null | PK (user_id, generation) |
| `device_signing_keys` | user_id → users (cascade), generation int, master_generation int, public_key bytea, cert bytea, created_at, superseded_at null | PK (user_id, generation) |
| `key_packages` | id, device_id → devices (cascade), user_id → users (cascade), cipher_suite int, ref bytea unique, data bytea, last_resort bool default false, created_at, expires_at | index (device_id, cipher_suite, last_resort, created_at); unique (device_id, cipher_suite) where last_resort |
| `mls_groups` | group_id bytea PK, kind `mls_group_kind`, scope_id uuid, guild_id null → guilds (cascade), channel_id null → channels (cascade), generation int, cipher_suite int, status `mls_group_status`, epoch bigint null, group_info bytea null, ratchet_tree bytea null, history_visibility, epoch_started_at null, last_commit_removed bool default false, latest_seq bigint default 0, created_at | unique (kind, scope_id, generation); index (guild_id); index (channel_id) |
| `mls_group_epochs` | group_id → mls_groups (cascade), epoch bigint, group_info bytea, ratchet_tree bytea, tree_hash bytea, confirmed_transcript_hash bytea, created_at | PK (group_id, epoch). The last 8 epochs |
| `mls_group_members` | group_id → mls_groups (cascade), leaf_index int, device_id null → devices (set null), user_id null → users (set null), credential_identity text, signature_key bytea | PK (group_id, leaf_index); unique (group_id, device_id); index (device_id). The DS roster. A row with a null device_id is the leaf of a deleted device. It stays until a commit removes the leaf |
| `mls_handshakes` | group_id → mls_groups (cascade), seq bigint, epoch bigint, kind `handshake_kind`, sender_device null → devices (set null), message bytea, tree_hash bytea null, confirmed_transcript_hash bytea null, created_at | PK (group_id, seq); index (created_at). 30-day retention |
| `mls_pending` | id, group_id → mls_groups (cascade), op `pending_op`, user_id null → users (set null), device_id null → devices (set null), leaf_index int null, key_package bytea null, join_request_id null → mls_join_requests (cascade), reason text, status `pending_status` default 'queued', proposal bytea null, proposal_epoch bigint null, proposal_ref bytea null, created_at | index (group_id, status); unique (group_id, leaf_index) where op = 'remove' and status <> 'rejected'. A Remove is keyed by `leaf_index`, so it survives the delete of its user or device. `proposal` is the one signed external proposal for `proposal_epoch` (§12.7.4) |
| `mls_batches` | id, group_id → mls_groups (cascade), epoch bigint, device_id → devices (cascade), pending_ids uuid[], timed_out_devices uuid[] default '{}', deadline_at, created_at | index (group_id) |
| `mls_join_requests` | id, group_id → mls_groups (cascade), device_id → devices (cascade), user_id → users (cascade), key_package bytea, status `join_status`, reason null, created_at, updated_at | index (device_id) |
| `device_inbox` | id, seq bigint identity, device_id → devices (cascade), kind `inbox_kind`, sender_device null → devices (set null), body bytea, size int, created_at, expires_at | index (device_id, seq) |
| `key_backups` | id, user_id → users (cascade), key_id bytea, kind `backup_kind`, group_id bytea null, epoch_from bigint null, epoch_to bigint null, blob bytea, size int, created_at | index (user_id); unique (user_id) where kind = 'identity' |
| `history_bundles` | id, group_id → mls_groups (cascade), epoch bigint, sender_device → devices (cascade), blob bytea, created_at | unique (group_id, epoch, sender_device) |
| `invite_bundles` | id, invite_id → invites (cascade), group_id bytea, epoch int, sender_device uuid (no FK), sender_user uuid (no FK), blob bytea, size int, created_at | index (invite_id, created_at). The sealed `InviteBundle`s of an invite with history (§12.11.4). At most `INVITE_BUNDLES_MAX_BYTES` per invite, and at most 1 MiB per sender user other than the creator, for all devices of that user together: the oldest go first |
| `device_link_sessions` | id, user_id → users (cascade), new_device_id → devices (cascade), offer bytea, created_at, expires_at | |
| `device_link_messages` | session_id → device_link_sessions (cascade), seq int, from_device → devices (cascade), body bytea, created_at | PK (session_id, seq) |
| `kt_entries` | idx bigint PK (leaf index from 0), user_id uuid (no FK: the log is append-only), type smallint, entry bytea, leaf_hash bytea, created_at | index (user_id, idx) |
| `kt_tree_heads` | tree_size bigint PK, root_hash bytea, signed bytea, created_at, published_at null | The gRPC process signs heads (§12.14) |
| `admin_actions` | guild_id → guilds (cascade), seq bigint, action bytea, hash bytea, actor_user_id uuid, created_at | PK (guild_id, seq) |
| `message_reports` | id, message_id null → messages (set null), channel_id uuid, reporter_id → users (cascade), reason text, content bytea, franking_key bytea, verified bool, created_at | |

Changed: `regions.probe_port` default **443**. `media_nodes.sidechannel_addr` → `signaling_url`.
Added: `media_nodes.admin_drain` boolean default false (set by the admin API, see §4 Admin API).
Dropped column: `oidc_clients.virtual_server_id`. Dropped tables: `virtual_servers`, `islands`, `servers`,
`server_domain_verifications`, `user_servers`, `invite_codes`. Dropped enums: `island_status`, `virtual_server_status`.
`users.image` holds the avatar file key (Credentials is the only Auth.js provider, so nothing else writes it).
Added: `users.password_changed_at` timestamptz null (migration 0007). Sign-up, the password change and the password reset set it. Null for accounts from before the column.
Kept unchanged: `users` (except `password_changed_at`), `accounts`, `sessions`, `verification_tokens`, `password_reset_tokens`,
`oidc_adapter_payloads`, `oidc_clients` (minus the column), `regions`, `media_nodes`.

Migration (one time, in the Discord-style refactor; since then each schema change adds a new migration, see `CLAUDE.md`):
1. Delete `drizzle/*.sql` + `drizzle/meta`.
2. Regenerate a single `0000_initial.sql`. Keep the hand-added `idx_media_nodes_placement` index: declare it in schema.ts.
3. Drop + reseed the dev DB.

## 4. REST API (Takusen, base `/api/v1`)

Auth: `Authorization: Bearer <Takusen access token>` (or the dashboard cookie).
`requireUser()` in `apps/takusen/src/lib/auth-helpers.ts` resolves it. Errors: `{ error: string, message?: string }`
with status 400 (ValidationError), 401, 403 (MissingPermissions), 404 (NotFound), 409, 410 (InviteExpired/Revoked/Exhausted).
Success: JSON body of the listed type, or 204.

Every mutation publishes its gateway event **after** the DB commit (see §5 for channels/envelope). Takusen logs publish failures and does not surface them.

Implemented extras (Discord semantics):
- Kick enforces role hierarchy.
- Role create/edit and overwrite PUT may only grant bits the caller holds (owner/ADMINISTRATOR exempt).
- Deleting a role deletes its overwrites (+ CHANNEL_UPDATE).
- New roles insert at position 1 (others shift, GUILD_ROLE_UPDATE each).
- Invite limits (`apps/takusen/src/lib/invite-limits.ts`):
  - `maxAgeSeconds` has the default 86400. A user without ADMINISTRATOR can send 1 to 86400. Takusen rejects 0 and larger values from this user with 403 `MissingPermissions`.
  - A user with ADMINISTRATOR can send 1 to 604800, or 0. 0 makes a permanent invite (`expiresAt: null`). A permanent invite needs `acknowledgedPermanent: true`, else 400 `ValidationError`. The 403 check runs before the 400 check. A value above 604800 gets 400 `ValidationError` for every user.
  - `maxUses` is 0 to 100. The default 0 means no limit.
  - An invite with history (body `record`, §12.11.4) needs ADMINISTRATOR, else 403 `MissingPermissions` before the other checks, and an active `X-Hachiman-Device`. `record` is the base64url `SignedInviteRecord`, at most 16 KiB. Takusen verifies it with `DsModule.verifyInviteRecord` under the certificate of the device (§12.18). Then it requires all of these, else 400 `ValidationError`: `guild_id`, `creator_user_id` and `creator_device_id` are the guild, the caller and the device of the request. `max_uses` is `maxUses`. `expires_at_ms` is 0 when `maxAgeSeconds` is 0. Else it is not 0, and it differs by at most 5 minutes from now + `maxAgeSeconds`. `channel_ids` has at most 500 ids, and each id is a channel of the guild. A channel id does not name its guild, so a redeemer cannot check the guild of a channel group that it does not hold (§12.11.4 "Scope"). No other invite has the key id (`sign_public`). Takusen stores `record` and `key_id`. Takusen does not check the admin state of the record: members do (§12.16). The creator device sends the first bundles with the `id` of the returned `Invite` (`POST /invite-records/:inviteId/bundles`, §12.12).
  - Takusen makes a permanent invite and an invite with history in a transaction. The transaction locks the guild row and the membership row of the creator (`FOR SHARE`), and checks ADMINISTRATOR again. Thus a role or member change at the same time cannot leave such an invite of a user without ADMINISTRATOR.
- Accept: the membership row of a new member names the invite (`guild_members.invite_id`). The accept of the last use sets `invites.exhausted_at`.
- Revoke = soft (`revoked`). The revoke deletes the bundles of the invite (§12.11.4) in the same transaction. Only the first revoke publishes `INVITE_DELETE`. A revoke stops new joins at once, because the accept locks the invite row. Members who joined already stay members.
- Revoke on loss of ADMINISTRATOR: a role permissions edit, a role delete, a member-role edit that removes a role, a kick and a leave revoke the permanent invites and the invites with history whose creator no longer has ADMINISTRATOR or is no longer a member, and delete their bundles. This occurs in the transaction of the change, before the DS change. Takusen checks every creator in the guild, because one role change can demote many users. After the commit, Takusen publishes `INVITE_DELETE` → guild for each revoked invite. The first such change in a guild also revokes the permanent invites that users without ADMINISTRATOR made before these limits existed.
- `GET /guilds/:id` reads voice states, presences and custom statuses (`custom_status:{userId}`) from Redis, as READY does.
- Next route folders for `/users/@me` live under `users/[id]`, and `/devices/@me/...` lives under `devices/[id]/...` (`@x` is a parallel-route slot in Next). The `[id]` handlers accept `@me`.
- CORS (`apps/takusen/src/lib/cors.ts`): `Access-Control-Allow-Headers` is `Authorization, Content-Type, X-Requested-With, X-Hachiman-Device, X-Hachiman-Device-Ts, X-Hachiman-Device-Nonce, X-Hachiman-Device-Sig, X-Hachiman-Signed-Action`. `Access-Control-Expose-Headers` is `Retry-After`.

| Method + path | Permission | Returns | Publishes |
|---|---|---|---|
| GET `/users/@me` | auth | `User` | — |
| PATCH `/users/@me` `{avatar?: uploadId \| null}` | auth | `User` | `USER_UPDATE` → user:{me}; `GUILD_MEMBER_UPDATE` (full `Member`) → guild:{g} for each guild of me |
| GET `/users/:id` | auth | `User` | — |
| POST `/guilds` `{name, region?}` | auth | `GuildFull` | `GUILD_CREATE` → user:{me} |
| GET `/guilds/:id` | member | `GuildFull` | — |
| PATCH `/guilds/:id` `{name?, icon?: uploadId \| null, banner?: uploadId \| null, region?, publicHistoryVisibility?}` | MANAGE_GUILD | `Guild` | `GUILD_UPDATE` → guild |
| DELETE `/guilds/:id` | owner | 204 | `GUILD_DELETE {id}` → guild |
| POST `/guilds/:id/channels` `{name, type: text\|voice\|category\|pages, parentId?, topic?}` | MANAGE_CHANNELS | `Channel` | `CHANNEL_CREATE` → guild |
| PATCH `/guilds/:id/channels` `[{id, position, parentId?}]` | MANAGE_CHANNELS | 204 | `CHANNEL_UPDATE` per changed channel |
| PATCH `/channels/:id` `{name?, topic?, parentId?, position?, historyVisibility?}` | MANAGE_CHANNELS. `historyVisibility` only for a channel with its own group. A thread: only `name`, from MANAGE_CHANNELS or the creator of the thread | `Channel` | `CHANNEL_UPDATE` |
| DELETE `/channels/:id` | MANAGE_CHANNELS, or the creator of a thread | 204 | `CHANNEL_DELETE`. For a text channel: first one `CHANNEL_DELETE` for each of its threads, which are deleted with it |
| POST `/channels/:id/threads` `{name, startMessageId?}` | SEND_MESSAGES on `:id`, a guild text channel (else 400). `startMessageId` must be a message of `:id` (else 400) | `Channel` (type `thread`) | `CHANNEL_CREATE` |
| GET `/channels/:id/threads` | VIEW_CHANNEL on `:id` | `Channel[]`: at most 50 threads, newest activity first (`last_activity_at`: last message, else creation) | — |
| PUT `/channels/:id/permissions/:targetId` `{type, allow, deny}` | MANAGE_ROLES. Not on a thread (400) | 204 | `CHANNEL_UPDATE` |
| DELETE `/channels/:id/permissions/:targetId` | MANAGE_ROLES | 204 | `CHANNEL_UPDATE` |
| GET `/channels/:id/messages?before=<messageId>&limit=50` | VIEW_CHANNEL + READ_MESSAGE_HISTORY | `Message[]` (ciphertext) newest first, limit ≤ 100 | — |
| POST `/channels/:id/messages` `{envelope, nonce?, attachments?: uploadId[]}` + `X-Hachiman-Device` | SEND_MESSAGES; ATTACH_FILES if attachments is not empty; envelope checks of §12.8.4. `attachments` lists, for each pointer in order, the file id and then its thumbnail id when it has one (at most 20 ids) | `Message` (with nonce) | `MESSAGE_CREATE` (with nonce) |
| PATCH `/channels/:id/messages/:mid` `{envelope}` + `X-Hachiman-Device` (attachments do not change) | author; §12.8.4 | `Message` | `MESSAGE_UPDATE` |
| DELETE `/channels/:id/messages/:mid` | author or MANAGE_MESSAGES | 204 | `MESSAGE_DELETE {id, channelId, guildId}` |
| POST `/channels/:id/typing` | SEND_MESSAGES | 204 | `TYPING_START {channelId, guildId, userId, timestamp}` |
| POST `/channels/:id/ack` `{messageId}` | VIEW_CHANNEL. The message must be in the channel, else 404 `NotFound`. 120 per user per 60 s, else 429 `RateLimited` | 204 | `READ_STATE_UPDATE {channelId, lastReadMessageId}` → user:{me}, only when the read state moved. The read state moves only forward in (created_at, id) order. An ack for the same or an older message changes nothing |
| GET `/guilds/:id/members` | member | `Member[]` | — |
| PATCH `/guilds/:id/members/:userId` `{nick?, roles?, mute?, deaf?, channelId?: string \| null}` | nick: self→CHANGE_NICKNAME, other→MANAGE_NICKNAMES; roles→MANAGE_ROLES + hierarchy; mute→MUTE_MEMBERS; deaf→DEAFEN_MEMBERS; channelId→MOVE_MEMBERS. mute, deaf and channelId on another member: also the moderation rule of Bans. channelId: the member must be in voice in the guild (else 400); a voice channel of the guild that the caller can CONNECT to and the member can VIEW_CHANNEL and CONNECT to (else 400 / 403), or null to disconnect | `Member` | `GUILD_MEMBER_UPDATE`; `INVITE_DELETE` → guild for each revoked invite (Invite limits); channelId: the internal `VOICE_MOVE` → user (§5) |
| DELETE `/guilds/:id/members/:userId` | KICK_MEMBERS (not owner) | 204 | `GUILD_MEMBER_REMOVE {guildId, user}` → guild; `GUILD_DELETE {id}` → user:{kicked}; `INVITE_DELETE` → guild for each revoked invite (Invite limits) |
| DELETE `/users/@me/guilds/:id` | member, not owner | 204 | same as kick |
| GET `/guilds/:id/bans` | BAN_MEMBERS | `Ban[]`, newest first | — |
| PUT `/guilds/:id/bans/:userId` `{reason?: string \| null}` (at most 512 characters) | BAN_MEMBERS; not the owner, not yourself; a member target: hierarchy as kick | 204. Idempotent: a second ban keeps the first row. A user who is not a member can be banned | when the user was a member: the same events as kick |
| DELETE `/guilds/:id/bans/:userId` | BAN_MEMBERS | 204. 404 without a ban | — |
| GET `/guilds/:id/roles` | member | `Role[]` | — |
| POST `/guilds/:id/roles` `{name, color?, hoist?, permissions?}` | MANAGE_ROLES | `Role` | `GUILD_ROLE_CREATE {guildId, role}` |
| PATCH `/guilds/:id/roles` `[{id, position}]` | MANAGE_ROLES | `Role[]` | `GUILD_ROLE_UPDATE` per changed role |
| PATCH `/guilds/:id/roles/:roleId` `{name?, color?, hoist?, permissions?}` | MANAGE_ROLES + hierarchy | `Role` | `GUILD_ROLE_UPDATE`; `INVITE_DELETE` → guild for each revoked invite (Invite limits) |
| DELETE `/guilds/:id/roles/:roleId` | MANAGE_ROLES + hierarchy, not @everyone | 204 | `GUILD_ROLE_DELETE {guildId, roleId}`; `INVITE_DELETE` → guild for each revoked invite (Invite limits) |
| GET `/guilds/:id/invites` | MANAGE_GUILD | `Invite[]`: the invites that are not revoked (expired ones too), permanent first, then newest first | — |
| POST `/guilds/:id/invites` `{maxAgeSeconds?, maxUses?, acknowledgedPermanent?, record?}` | CREATE_INSTANT_INVITE; ADMINISTRATOR for `maxAgeSeconds` 0 or above 86400, and for `record` (with `X-Hachiman-Device`) (Invite limits) | `Invite` | — |
| DELETE `/invites/:code` | MANAGE_GUILD | 204. Deletes the bundles of the invite | `INVITE_DELETE {guildId, code, inviteId}` → guild (first revoke only) |
| GET `/invites/:code` | **public** | `InvitePreview` (non-consuming) | — |
| POST `/invites/:code` | auth; 403 `Banned` for a banned user (§4 Bans) | `GuildFull` (idempotent if already a member — no use consumed) | `GUILD_MEMBER_ADD` → guild; `GUILD_CREATE` → user:{me} |
| GET `/users/@me/channels` | auth | `Channel[]` (DMs) | — |
| POST `/users/@me/channels` `{recipientIds: string[]}` | auth; recipients must share a guild with me; no block either way (403 `Blocked`, Pins, guild events and blocks) | `Channel` (1 recipient → reuse existing `dm`; ≥2 → new `group_dm`, max 10) | `CHANNEL_CREATE` → user:{each participant} |
| GET `/limits` | auth | `Limits` | — |
| POST `/uploads?kind=blob` raw body | auth | `Attachment` (201): an encrypted attachment or thumbnail blob | — |
| POST `/uploads?kind=page_snapshot` raw body | auth | `Attachment` (201): an encrypted page snapshot blob (§4 Pages) | — |
| POST `/uploads?filename=<name>` raw body | auth | `{id, key, size}` (201): a plaintext profile image | — |
| GET `/files/:uploadId/:filename` | **public** | file bytes (`/files/{uploadId}/blob` for blobs) | — |

**Bans.** A ban is a row in `guild_bans`. `PUT /guilds/:id/bans/:userId` writes the row and removes the membership in the same transaction, through the leave path: the DS gets `member_left` (§12.18), the invites of users who lost ADMINISTRATOR are revoked, and the gateway drops the guild and its voice state from the sessions of the user (`GUILD_DELETE` → user). While the row exists, the invite accept refuses the user with 403 `Banned`. There are no ban events: the Bans page of the guild settings reads `GET /guilds/:id/bans` when it opens and after each change. Kick, ban and the voice moderation (below) all use one rule: never the owner, and the top role of a member target must be below the top role of the caller (owner and ADMINISTRATOR exempt).

The E2EE routes (devices, keys, MLS, inbox, backups, linking, key transparency, reports, invites with history) are in §12.12. In Phase 4, the role, overwrite and member-role routes and the channel `historyVisibility` change also take the header `X-Hachiman-Signed-Action` (§12.16). The header is necessary only when the request changes signed state: a role PATCH only with `permissions`, a member PATCH only with `roles`. A signed `role_create` names the role id, and `POST /guilds/:id/roles` creates the role with that id. The guild `publicHistoryVisibility` has no admin action type and is not signed.

### Pins, guild events and blocks

| Method + path | Permission | Returns | Publishes |
|---|---|---|---|
| GET `/channels/:id/pins` | VIEW_CHANNEL + READ_MESSAGE_HISTORY | `Message[]` (ciphertext), newest pin first | — |
| PUT `/channels/:id/pins/:messageId` | MANAGE_MESSAGES (DM, group DM: any participant). The message must be in the channel (404). At most 50 pins per channel, else 400 `TooManyPins` | 204 | `CHANNEL_PINS_UPDATE {channelId, guildId}` to the viewers of the channel (DM: each participant) |
| DELETE `/channels/:id/pins/:messageId` | same as PUT | 204 | `CHANNEL_PINS_UPDATE` |
| GET `/guilds/:id/events` | member | `GuildEventWithMe[]`: the upcoming and ongoing events, soonest first, at most 100 | — |
| POST `/guilds/:id/events` `{title, startsAt, endsAt?, channelId?}` | MANAGE_EVENTS | `GuildEventWithMe` | `GUILD_EVENT_CREATE` `GuildEvent` → guild |
| PATCH `/events/:id` `{title?, startsAt?, endsAt?, channelId?}` | MANAGE_EVENTS in the event's guild | `GuildEventWithMe` | `GUILD_EVENT_UPDATE` `GuildEvent` → guild |
| DELETE `/events/:id` | MANAGE_EVENTS | 204 | `GUILD_EVENT_DELETE {id, guildId}` → guild |
| PUT `/events/:id/rsvp` | member | 204 | `GUILD_EVENT_RSVP {eventId, guildId, userId, going: true, rsvpCount}` → guild |
| DELETE `/events/:id/rsvp` | member | 204 | `GUILD_EVENT_RSVP` with `going: false` |
| GET `/users/@me/blocks` | auth | `BlockedUser[]`, newest first | — |
| PUT `/users/@me/blocks/:userId` | auth; not yourself (400), a known user (404) | 204 | `USER_BLOCK_UPDATE {userId, blocked: true}` → user:{me} only |
| DELETE `/users/@me/blocks/:userId` | auth | 204 | `USER_BLOCK_UPDATE {userId, blocked: false}` → user:{me} only |

- A repeated PUT or DELETE (pin, RSVP, block) changes nothing and publishes nothing.
- The pin PUT locks the channel row, so concurrent pins cannot pass the limit. A message delete removes its pin (cascade) and publishes only `MESSAGE_DELETE`.
- Event rules (400 `ValidationError`): `title` is 1 to 100 characters after trim. `startsAt` and `endsAt` are ISO 8601 times with an offset. A create needs `startsAt` in the future. A PATCH that sets `startsAt` needs it in the future. `endsAt`, when not null, is after `startsAt` (a PATCH checks the merged times). `channelId`, when not null, is a voice channel of the guild. A channel delete sets `channelId` to null and publishes no event update.
- The list holds an event while `endsAt` is in the future, or, with no `endsAt`, until 6 h after `startsAt`. READY does not carry events: the client fetches the list (§10 `fetchGuildEvents`).
- A block in either direction also refuses `POST /users/:id/poke` (§4 Poke).
- A block in either direction refuses `POST /users/@me/channels` with a blocked recipient (a new DM, a group DM, or the reuse of an existing DM) and `POST /channels/:id/messages` in a 1:1 `dm` with 403 `Blocked`. Group DMs that exist and guild channels are not affected: the client hides the messages of blocked users there. The blocked user is not told.

### Soundboard

| Method + path | Permission | Returns | Publishes |
|---|---|---|---|
| GET `/guilds/:id/sounds` | member | `GuildSound[]`, oldest first | — |
| POST `/guilds/:id/sounds` `{id, name, emoji?, uploadId, channelId, envelope}` + `X-Hachiman-Device` | MANAGE_EXPRESSIONS | 201 `GuildSound` | `GUILD_SOUNDS_UPDATE {guildId}` → guild |
| DELETE `/guilds/:id/sounds/:soundId` | MANAGE_EXPRESSIONS | 204 (404 for a sound of another guild) | `GUILD_SOUNDS_UPDATE {guildId}` → guild |

- The client chooses `id` (a UUID): the envelope binds it. A used id gives 409.
- `name` is 1 to 32 characters after trim, `emoji` null or 1 to 32 characters. Neither has control or bidi control characters. A guild has at most 48 sounds (400 `ValidationError`).
- `uploadId` is an unclaimed blob of the caller (`POST /uploads?kind=blob`). The claim sets purpose `sound`. A blob above 560 KiB gives 413 `SoundTooLarge`. Else 400 `UnknownUpload`. The client limits the clip to mp3, ogg or wav, at most 512 KiB and 5 s. The server cannot check the duration.
- `channelId` is a text or pages channel of the guild whose current group is the `public_set` group (§12.6). Else 400 `NotPublicChannel`. Thus every member of the guild can read the envelope.
- `envelope` is a `doc_snapshot` page envelope (§12.20) with `page_id` = `id`. Takusen checks its header as for a snapshot (`acceptDocEnvelope`: size, kind, group, channel, page, epoch, sender device and leaf) and stores `group_id`, `epoch` and `sender_device` (§12.21).
- A delete removes the blob from storage. A guild delete removes the blobs of its sounds.
- USE_SOUNDBOARD is not a server check: the client mixes the sound into the sender's own microphone track, after the noise suppression, so it is SFrame-encrypted like the voice (§12.10). Self-mute drops that track, so the client turns the soundboard off while muted. The client shows the soundboard only with CONNECT, SPEAK and USE_SOUNDBOARD in the voice channel.

### Poke

| Method + path | Permission | Returns | Publishes |
|---|---|---|---|
| POST `/users/:id/poke` | auth; not yourself (400). The two users share a guild, a DM or a group DM, else 404 (also for an unknown user). A block in either direction: 403 `Blocked` | 204 | `POKE {user}` → user:{target} only. `user` is the sender |

- Rate limits (Redis fixed windows, 429 `RateLimited` with `Retry-After`): 1 per 10 s per sender and target, 10 per 60 s per sender.
- A poke has no content. It is not end-to-end encrypted, as a typing event is not: it tells the target only who poked and when.

### Emojis

Custom guild emojis (§1 `GuildEmoji`, table `guild_emojis`). Plaintext metadata and images, like the guild icon (§12.1).

| Method + path | Permission | Returns | Publishes |
|---|---|---|---|
| GET `/guilds/:id/emojis` | member | `GuildEmoji[]`, oldest first | — |
| POST `/guilds/:id/emojis` `{name, uploadId}` | MANAGE_EXPRESSIONS | `GuildEmoji` (201) | `GUILD_EMOJIS_UPDATE {guildId, emojis}` → guild |
| PATCH `/guilds/:id/emojis/:emojiId` `{name}` | MANAGE_EXPRESSIONS | `GuildEmoji` | `GUILD_EMOJIS_UPDATE` → guild |
| DELETE `/guilds/:id/emojis/:emojiId` | MANAGE_EXPRESSIONS | 204. Deletes the upload row and, after commit, the object | `GUILD_EMOJIS_UPDATE` → guild |

- **Emojis.** `name` matches `^[a-z0-9_]{2,32}$` (else 400 `ValidationError`) and is unique in the guild (else 409 `Conflict`). A guild has at most 100 emojis (`MAX_GUILD_EMOJIS`), else 400 `TooManyEmojis`; the create locks the guild row, so concurrent creates cannot pass the cap. `uploadId` is an upload of the caller from `POST /uploads?filename=`, with purpose null and `encrypted = false`, else 400 `UnknownUpload`. Its type must be in `EMOJI_IMAGE_TYPES` (`image/png`, `image/gif`, `image/webp`) and its size at most `MAX_EMOJI_BYTES` (262144), else 400 `InvalidImage`. The claim sets `purpose = 'emoji'` in the transaction of the insert. A guild delete deletes the emoji uploads and their objects. The constants are in `@hachiman/client/files`.
- **Custom emojis in messages.** The server never sees which emoji a message uses. A client writes a custom emoji into the message text as `<:name:id>` (Discord format) and into a reaction (§12.8.1 kind 3) as `name:id`. The receiver shows the image of `id` from the `emojis` of any guild it knows, else the text `:name:`.

### Files

Takusen owns blob storage. Clients never talk to S3: uploads and downloads go through Takusen, so the host CSP
only needs the Takusen origin, and the bucket can stay private.
`// ponytail:` this sends every byte through Takusen. Move to presigned S3 URLs + a CDN when bandwidth matters.

- **Limits.** `TAKUSEN_MAX_UPLOAD_BYTES` (default 26214400 = 25 MiB) applies to every upload. `maxAttachmentsPerMessage` is 10. The defaults are `DEFAULT_LIMITS` in `@hachiman/client`.
- **Upload.** `POST /uploads`. The body is the raw file.
  `Content-Length` is required. A missing length or a length above the limit gives 413 `UploadTooLarge` before Takusen reads the body.
  Takusen stops the stream and gives 413 if the body is longer than `Content-Length`. A shorter body fails the upload and stores nothing.
  - `?kind=blob`: an encrypted attachment or thumbnail (§12.9). Takusen stores `content_type = 'application/octet-stream'`, `filename` null and `encrypted = true`. It ignores the request `Content-Type`.
  - `?filename=<name>`: a plaintext profile image (avatar, icon, banner). `Content-Type` is the MIME type. Takusen stores the lowercased `type/subtype` without parameters, and `application/octet-stream` for a malformed value. `filename` is at most 255 characters.
  The Takusen middleware does not run for this path, because Next.js buffers every body that middleware sees and truncates it at 10 MB.
  The route applies the same CORS policy itself.
- **Key.** `{uploadId}/blob` for blobs. `{uploadId}/{safeName}` for profile images: `safeName` is the filename with every character outside `[A-Za-z0-9._-]` replaced by `_`, cut to 100 characters (`file` if empty). Keys never change, so a key is also a cache key.
- **Claim.** A message, avatar, icon or banner takes upload ids. Each id must belong to the caller, else 400 `UnknownUpload`.
  The first claim sets the upload `purpose`, and the purpose never changes, because a message, channel or guild delete deletes its attachment objects.
  A message claim needs purpose null and `encrypted = true`, and sets `purpose = 'attachment'`, `message_id` and `position`, else 400 `UnknownUpload`.
  An avatar, icon or banner claim needs purpose null or `'image'` and `encrypted = false`, and sets `purpose = 'image'`. An `'attachment'` upload or a blob gives 400 `UnknownUpload`.
  The type must be in `PROFILE_IMAGE_TYPES` (`image/png`, `image/jpeg`, `image/gif`, `image/webp`), else 400 `InvalidImage`.
  An `'image'` upload can be claimed again as an avatar, icon or banner.
  A custom emoji claims a plaintext upload once and sets `purpose = 'emoji'` (Emojis).
  Each claim is one conditional `UPDATE` in the same transaction as the write that uses it.
  Thus, when two claims for different purposes race for one upload, only one claim wins.
  A message create claims all ids in one transaction: one bad id gives 400 `UnknownUpload` and no message. Duplicate ids give 400 `ValidationError`. A message claims at most 20 ids (10 files, each with an optional thumbnail, §12.8.5). Thumbnails are claimed like files, so a message delete also deletes them.
- **Download.** `GET /files/:uploadId/:filename` streams the object. Only the canonical path (the key) resolves, else 404.
  It supports one `bytes=` range (206 + `Content-Range`) for video and audio seeking. A multi-range or malformed `Range` gets the whole file (200).
  A range that starts past the end gets 416 with `Content-Range: bytes */<size>`.
  Headers: `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, `Accept-Ranges: bytes`.
  A blob is `application/octet-stream` with `Content-Disposition: attachment; filename="blob"`. The client decrypts it (§12.9).
  For a profile image, `Content-Disposition` is `inline` only for the embeddable types below. Every other type, including `image/svg+xml`, gets
  `attachment; filename="<filename, ASCII only, quotes replaced>"; filename*=UTF-8''<percent-encoded filename>`.
  The URL is unguessable but not secret. Anyone with the URL can read a profile image. A blob is ciphertext, and the key is only in the envelope.
- **Embeddable types.** Images: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`.
  Video: `video/mp4`, `video/webm`, `video/ogg`. Audio: `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/webm`, `audio/flac`, `audio/mp4`, `audio/aac`.
  The client embeds the same list (`EMBEDDABLE` in `@hachiman/client`) and shows every other type as a file card. For attachments, the client reads the MIME type from the envelope.
  Matching ignores MIME parameters (`; codecs=...`) and case. Takusen decides `inline` for profile images with the same `embedKind` function.
- **Delete.** A message, channel or guild delete removes the upload rows of the deleted messages in its transaction and then, best effort, their objects.
  The FK cascade alone would remove the rows but not the objects, so each of these routes uses the same helper (`deleteAttachmentRows` in `apps/takusen/src/lib/uploads.ts`).
  A channel or guild delete locks its channel rows (and the guild row) first, so a message sent at the same time cannot lose its rows without its objects.
  If Takusen cannot insert the row after the object PUT, it deletes the object, so every object has a row.
  A new avatar, icon or banner leaves the old object in the bucket.
  `// ponytail:` unclaimed uploads and replaced images stay in the bucket. Add a sweeper (unclaimed + older than 1 day) when storage cost matters.

Storage env (Takusen only): `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`.
Takusen sends plain signed requests (no aws-chunked checksum trailers), so S3-compatible stores such as SeaweedFS work.

Kept outside `/api/v1`: `GET /api/regions`, `GET /api/desktop-update/*` (below), `POST /api/servers/recommend-region` (renamed → `POST /api/v1/regions/recommend`), OIDC under `/api/oidc`.

### Desktop updates

The Electron app updates itself from the assets `hachiman-macos.zip` and `hachiman-windows.zip` of the newest release in the release repository (`<owner>/hachiman-release`), which `.github/workflows/desktop.yml` publishes.
The release repository can be private, so Takusen holds a GitHub token (`TAKUSEN_UPDATE_GITHUB_REPO`, `TAKUSEN_UPDATE_GITHUB_TOKEN`: a fine-grained token with read-only "Contents" on that repo) and the app holds none.
Both routes are public, with no auth. `:platform` is `macos` or `windows`. Takusen reads `releases/latest`: the build commit is the line `Commit: <sha>` of the release notes, and the asset must have a `sha256:` digest. Takusen caches the result for 60 s.

| Method + path | Returns |
|---|---|
| GET `/api/desktop-update/:platform` | `{sha, sha256}`: the commit of the build and the hex SHA-256 of its zip. 404 `NotFound` when updates are not configured or there is no build. 502 `UpstreamUnavailable` when GitHub fails |
| GET `/api/desktop-update/:platform/download` | 302 to GitHub's signed asset URL (valid for about a minute). 404 and 502 as above |

The app (`apps/hachiman-electron/src/main/updater.ts`) checks at start and every 4 h when it was built with `MAIN_VITE_BUILD_SHA` (CI sets the commit).
When `sha` differs from its own, it downloads the zip, drops it unless its SHA-256 is `sha256`, unpacks it and asks to restart.
After "Later", the timer does not ask again for that build. User settings → Desktop app checks at once (`IPlatformService.checkForUpdate`, IPC `hachiman:check-for-update` from the top frame of the app page only) and asks again for a build that was put off. The timer and the button share one check at a time.
Windows runs the NSIS installer with `/S --force-run`. macOS (unsigned builds, so no Squirrel.Mac) copies the `.app` from the dmg over its own bundle after it quits. When the install folder is not writable, it opens the dmg instead.

### Pages

A `pages` channel holds a tree of pages (§1 `Page`). The content of a page is a Yjs document. The server stores and relays only envelopes (§12.20): it cannot merge edits, so the clients merge with the CRDT. A pages channel uses the MLS group of a text channel (§12.6): `public_set` when it is public, else its own `channel` group. Its chat uses the message routes as a text channel does.

Every route needs VIEW_CHANNEL on the channel of the page (a page that the caller cannot view gives 404 `NotFound`). The routes marked **W** also need SEND_MESSAGES. There is no other edit permission: an overwrite that denies SEND_MESSAGES makes the pages read-only. The routes marked **D** need `X-Hachiman-Device` and its proof (§12.12).

| Method + path | | Body | Returns | Publishes |
|---|---|---|---|---|
| GET `/channels/:id/pages` | | — | `Page[]` (all pages of the channel, any order) | — |
| GET `/channels/:id/pages/heads` | | — | `PageHead[]` (all pages of the channel, any order) | — |
| POST `/channels/:id/pages` | W D | `{id, parentId: string \| null, position, titleEnvelope}` | `Page` (201). 409 `PageExists` when `id` is taken | `PAGE_CREATE` |
| PATCH `/pages/:pageId` | W D | `{parentId?, position?, titleEnvelope?, ifUpdatedAt?: string}` | `Page`. 409 `PageConflict` when `ifUpdatedAt` is not the `updatedAt` of the page | `PAGE_UPDATE` |
| DELETE `/pages/:pageId` | W | — | 204 | `PAGE_DELETE` |
| GET `/pages/:pageId/state` | | — | `PageState` | — |
| GET `/pages/:pageId/updates?after=&limit=` | | — | `{updates: DocUpdate[], latestSeq}`, `seq > after` ascending. `limit` ≤ 500 (default 200) | — |
| POST `/pages/:pageId/updates` | W D | `{envelope}` | `{seq}` (201) | `DOC_UPDATE` |
| POST `/pages/:pageId/snapshots` | W D | `{baseSeq, uploadId, envelope, mediaUploadIds: string[]}` | `DocSnapshot` (201), also for a re-wrap. 409 `SnapshotConflict {baseSeq}` | — |
| POST `/pages/:pageId/media` | W | `{uploadIds: string[]}` (1 to 20) | 204. 413 `StorageQuotaExceeded` | — |

- **Channel type.** The page routes need a channel of type `pages`, else 400 `NotPagesChannel`. A new pages channel has no page. The client that creates the channel then creates one root page ("Untitled"), because only a client can encrypt the title.
- **Create.** `id` is a new UUID that the client chooses, because the title envelope binds the page id (§12.20). `parentId` is null or a page of the same channel, else 400 `ValidationError`.
- **Envelope checks.** Takusen decodes only the header (§12.20 "Server checks"). `titleEnvelope` needs kind `doc_title`, the updates route kind `doc_update`, the snapshots route kind `doc_snapshot`, else 400 `InvalidEnvelope`. The other checks and codes are those of §12.8.4: 413 `EnvelopeTooLarge`, 409 `GroupPending`, 409 `StaleEpoch {epoch}`, 403 `NotMember`, 400 `InvalidEnvelope`.
- **Move.** A PATCH that sets `parentId` to the page itself or to a page of its subtree gives 400 `PageCycle`. A `parentId` of another channel gives 400 `ValidationError`. Takusen sets `updated_at` on every PATCH. Takusen does not renumber siblings: the client sends the positions it wants.
- **Compare-and-set.** With `ifUpdatedAt` (an ISO 8601 time, as `Page.updatedAt`), Takusen locks the page row and compares the two times to the millisecond. When they differ, it gives 409 `PageConflict` and changes nothing. A title re-wrap (§12.20) sends it, so that it does not undo a rename that came in between.
- **Heads.** `GET /channels/:id/pages/heads` gives, for each page, `latest_seq`, the group and the epoch from the header of the title envelope (Takusen decodes the header only), and the newest snapshot. A re-wrap pass reads it instead of the state of each page.
- **Delete.** Deletes the page and its subtree in one transaction. It deletes the upload rows of these pages (`deletePageUploadRows`), then (best effort) their objects, and subtracts their bytes from `guilds.page_storage_bytes`. `PAGE_DELETE.ids` lists the page and every page of its subtree. A channel delete and a guild delete also delete the page uploads with `deleteAttachmentRows`.
- **Updates.** `POST /pages/:pageId/updates` locks the page row, sets `latest_seq = latest_seq + 1` and inserts the row with that `seq` in one transaction. Thus `seq` has no gaps, also when two senders post at the same time. After the commit, Takusen publishes `DOC_UPDATE`.
- **State.** `GET /pages/:pageId/state` gives the newest snapshot and the first 500 updates after its `baseSeq` (after 0 without a snapshot). The client reads the rest with `GET /pages/:pageId/updates`, downloads the snapshot blob from `/files/{uploadId}/blob` and decrypts it (§12.9).
- **Snapshots.** The client uploads the encrypted state with `POST /uploads?kind=page_snapshot` and then posts the snapshot. `?kind=page_snapshot` is `?kind=blob` with two differences: the cap is `TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES` (`Limits.maxPageSnapshotBytes`, default 104857600 = 100 MiB), and the row gets `purpose = 'page_snapshot'` at once, so no message can claim it. In one transaction, the snapshot route:
  1. Locks the page row. A `baseSeq` equal to the `base_seq` of the newest snapshot is a re-wrap (below). Else it checks that `baseSeq` is above the `base_seq` of the newest snapshot (0 when there is none) and not above `latest_seq`. Else 409 `SnapshotConflict` with the current `baseSeq`. The upload of the loser stays unclaimed.
  2. Claims the upload: it must be of the caller, `encrypted`, `purpose = 'page_snapshot'` and `page_id` null, else 400 `UnknownUpload`. The claim sets `page_id` and adds the size to `guilds.page_storage_bytes` (quota, below).
  3. Inserts the row. `mediaUploadIds` (at most 1000, else 400 `ValidationError`) is stored as given: the server cannot read the page.
  4. Keeps the previous snapshot and the updates after its `base_seq`. It deletes the older snapshot rows, the updates with `seq <=` the `base_seq` of the previous snapshot, and the upload rows of the deleted snapshots (`deletePageUploadRows`, objects after the commit). Thus a page has at most two snapshot objects.
- **Re-wrap.** A re-wrap posts the pointer of the newest snapshot again, in a newer epoch (§12.20 "Access by new members"). The blob does not change, so the client uploads nothing. The route accepts it when `baseSeq` and `uploadId` are those of the newest snapshot, the envelope passes the checks above, and the envelope is of another group than the row (the channel has a new group) or of a higher epoch. Else 409 `SnapshotConflict` with the current `baseSeq`: another member was first. Takusen replaces `envelope`, `group_id`, `epoch` and `sender_device` of the row in place. It claims no upload, changes no quota and deletes nothing. It keeps the stored `media_upload_ids` and ignores the body list, so a re-wrap cannot drop a media reference. The caller does not need to be the uploader.
- **When a client posts a snapshot.** When more than 200 updates follow the newest snapshot, or when the newest snapshot or an update after it has an epoch below the current epoch of the group. The second rule lets a member who joined in a later epoch read the page (§12.20 "Access by new members"). When no update follows the newest snapshot, the client re-wraps its pointer instead of a new snapshot.
- **Media.** A page image, video or file is a §12.9 blob from `POST /uploads?kind=blob`. `POST /pages/:pageId/media` claims each id: the upload must be of the caller and `encrypted`, with purpose null (a new claim: it sets `purpose = 'page_media'` and `page_id`, and adds the size to the quota) or `page_media` of this page (a refresh). Else 400 `UnknownUpload`. Every claim sets `last_referenced_at = now()`. The client claims again each time it inserts the media into the page.
- **Quota.** `guilds.page_storage_bytes` counts the blob bytes of the `page_snapshot` and `page_media` uploads of the guild. A claim that takes it above `TAKUSEN_GUILD_PAGE_STORAGE_BYTES` (default 10737418240 = 10 GiB, 0 = no limit) gives 413 `StorageQuotaExceeded`, and nothing of the request is stored. Each claim and each delete changes the count in its transaction, with the guild row locked.
- **Media sweep.** The daily sweep of the gRPC process deletes a `page_media` upload (in one transaction the row and its bytes from the quota, then the object) when all three are true: no snapshot of its page lists it in `media_upload_ids`, its `created_at` is more than 30 days ago, and its `last_referenced_at` is more than 30 days ago. The 30 days are the window for undo and restore.

### Admin API

Base `/api/admin`. Only deployment admins (`users.role = 'admin'`) can use it. The Takusen dashboard calls it. The Hachiman clients do not.

- **Auth.** `requireAdmin()` in `auth-helpers.ts` accepts only the dashboard cookie. It does not accept a Bearer token, because the Hachiman app holds that token. No session gives 401. A user who is not an admin gets 403. The Auth.js `jwt` callback reads the role from the DB on each request. Thus, a role change applies to a live cookie at once.
- **Origin.** The middleware sends no CORS headers for `/api/admin`. It gives 403 when `Sec-Fetch-Site` is `same-site` or `cross-site`, preflights included. The Hachiman app origins are often same-site with Takusen, so the SameSite=Lax cookie alone does not stop a simple POST from them. Without `Sec-Fetch-Site`, a request that is not GET or HEAD gets 403 if its `Origin` is not the Takusen origin. A request with neither header comes from a client that is not a browser. The middleware accepts it.
- **Errors.** The envelope is the same as in `/api/v1`. 409 `Conflict` has a `message`.
- **Lists.** `GET` lists take `?query=&cursor=&limit=` and return `Page<T> = { items: T[], nextCursor: string | null }`. The newest row comes first (`created_at DESC, id DESC`). `limit` is 1 to 100 (default 50). `query` is at most 100 characters and is a case-insensitive substring match. To get the next page, send `nextCursor` back as `cursor`. A bad cursor gives 400.
- **Admin guard.** An admin cannot demote or delete their own account (409). The caller must be an admin, so this rule alone keeps at least one admin. Each change locks the admin rows in its transaction. Thus, two admins cannot remove each other at the same time.
- **Bootstrap.** `pnpm -F @hachiman/takusen admin:grant <email>` makes an existing user an admin.

| Method + path | Body | Returns | Publishes |
|---|---|---|---|
| GET `/overview` | — | `AdminOverview` | — |
| GET `/search?query=` | — | `AdminSearchResult`: at most 5 of each kind. Users match the email or the display name, guilds the name, media nodes the node id or the region, regions the code or the display name. An empty query gives empty lists | — |
| GET `/users?query=&role=user\|admin&filter=unverified\|signed_in&cursor=&limit=` | — | `Page<AdminUser>`. `query` matches the email or the display name. `filter=unverified`: no verified email. `filter=signed_in`: at least one live Hachiman session | — |
| PATCH `/users/:id` | `{role?: 'user'\|'admin', displayName?}` (1–64 characters) | `AdminUser` | a new `displayName` publishes `USER_UPDATE` → user:{id} and `GUILD_MEMBER_UPDATE` → guild:{g} for each guild of the user |
| DELETE `/users/:id` | — | 204 | `GUILD_DELETE` → each owned guild; `GUILD_MEMBER_REMOVE` → each other guild; `GUILD_UPDATE` → each guild that lost its icon or banner |
| POST `/users/:id/sign-out` | — | 204 | — |
| POST `/users/:id/reset-keys` | — | 204 | the DS events of a password reset (§12.4 "Password reset") |
| GET `/guilds?query=&cursor=&limit=` | — | `Page<AdminGuild>`. `query` matches the guild name | — |
| GET `/guilds/:id` | — | `AdminGuildDetail` | — |
| DELETE `/guilds/:id` | — | 204 | `GUILD_DELETE {id}` → guild (the same delete as the owner delete) |
| DELETE `/guilds/:id/invites/:code` | — | 204. 404 if the guild has no such invite | `INVITE_DELETE` → guild (the same revoke as `DELETE /api/v1/invites/:code`, without the `MANAGE_GUILD` check) |
| GET `/media-nodes` | — | `AdminMediaNode[]`, sorted by region, then by node id | — |
| PATCH `/media-nodes/:nodeId` | `{status: 'active'\|'draining'}` | `AdminMediaNode` | — |
| DELETE `/media-nodes/:nodeId` | — | 204 | — |
| GET `/regions` | — | `AdminRegion[]` | — |
| POST `/regions` | `{code, displayName, lat?, lon?, probeHost?, probePort?}` | `AdminRegion` (201). 409 if the code exists | — |
| PATCH `/regions/:code` | `{displayName?, lat?, lon?, probeHost?, probePort?}` | `AdminRegion` | — |
| DELETE `/regions/:code` | — | 204 | `GUILD_UPDATE` → each guild that had this region |
| GET `/oidc-clients` | — | `AdminOidcClient[]` (read-only, no secret) | — |
| POST `/sessions/revoke-all` | — | `{oidcRowsDeleted: number}` | — |

The shapes are in `apps/takusen/src/lib/admin.ts`:

```ts
type AdminUser = { id; email; displayName; role: 'user' | 'admin'; avatar: string | null; emailVerified: boolean;
  activeSessions: number; createdAt }   // activeSessions: live OIDC grants of the user (one per Hachiman sign-in)
type AdminGuild = { id; name; icon: string | null; region: string | null; owner: { id; email; displayName; avatar: string | null };
  memberCount: number; channelCount: number; createdAt }   // channelCount leaves out categories and threads
type AdminInvite = { code; uses: number; maxUses: number | null; expiresAt: string | null; hasHistory: boolean;
  createdBy: { id; displayName }; createdAt }
type AdminGuildDetail = AdminGuild & { banner: string | null; onlineCount: number; pageCount: number; invites: AdminInvite[] }
  // onlineCount: members with a presence that is not offline. invites: the usable ones, newest first
type AdminMediaNode = { nodeId; region; status: string; adminDrain: boolean; stale: boolean; signalingUrl; version;
  activeSessions: number; maxSessions: number; cpuFraction: number; lastHeartbeatAt }
type AdminRegion = { code; displayName; lat: number | null; lon: number | null; probeHost: string | null; probePort: number;
  guildCount: number; createdAt }   // guildCount: guilds homed in the region
type AdminOidcClient = { id; clientId; isPublic: boolean; redirectUris: string[]; scopes: string[];
  activeUsers: number; activeSessions: number; createdAt }   // users with a live grant of the client; its live grants
type AdminSearchResult = { users: AdminUser[]; guilds: AdminGuild[]; mediaNodes: AdminMediaNode[]; regions: AdminRegion[] }
type AdminOverview = {
  counts: { users; admins; unverifiedUsers; signedInUsers; newUsers7d; guilds; channels; mediaNodes; regions; oidcClients;
    messages; uploads; uploadBytes }                                            // numbers
  mediaNodes: { total; active; draining; stale; sessions; capacity }            // numbers
  regionLoad: { region; nodes: { total; active; draining; stale; sessions; capacity } }[]   // nodes: as mediaNodes, per region
  onlineUsers: number
  server: { version: string; nodeVersion: string; uptimeSeconds: number; maxUploadBytes: number }
}
```

Behavior:

- **User delete.** One transaction deletes the guilds that the user owns, with the same steps as an owner delete. It also calls `onMembershipChange({ kind: 'user_deleted' })` (§12.18), which queues Removes in the groups of the user and deletes the DS rows of the user. It also deletes all uploads of the user and the OIDC rows of the user. A guild icon or banner that used one of these uploads becomes null. The FK cascades delete the memberships, messages, DM participants and invites of the user. After the commit, Takusen publishes the events and then deletes the objects (best effort). No event goes out for the cascaded messages in guilds that the user did not own, or for the DM channels of the user. Thus, clients get no `MESSAGE_DELETE`, and the other DM participant gets no event.
- **Reset keys.** The DS change of a password reset (§12.4 "Password reset"): every device of the user is revoked with reason `password_reset`, and the current master key is superseded. Then Takusen signs the user out (as Sign-out). The password and the account stay. At the next sign-in, the app wipes the revoked device and offers the recovery key or new keys.
- **Sign-out.** Takusen sets the Redis key `takusen:sessions_revoked_at:{userId}` to the current Unix ms, without a TTL. A dashboard cookie that the user got before that time stops working. Takusen also deletes the OIDC rows of the user: rows where `payload.accountId` is the user, and all rows of their grants. Thus, the Bearer tokens of the user stop working.
- **Revoke-all.** Takusen sets `takusen:sessions_revoked_at` and deletes all `oidc_adapter_payloads` rows. This signs out every user, the caller included. `pnpm sessions:revoke` does the same.
- **Media nodes.** `stale` is true when the last heartbeat is 30 s old or older (`HEARTBEAT_STALE_AFTER_MS`). `draining` sets `media_nodes.admin_drain`. Then the status stays `draining` through heartbeats and new registrations, and placement skips the node. Sessions on the node continue. `active` clears the flag. DELETE removes the registry row and its `admin_drain` flag. A node that still runs registers again after its next heartbeat fails, and its status is then `active`. To keep a node out of placement, stop the node first.
- **Regions.** The regions table is admin data. A region delete sets `region` to null on its guilds. Media nodes keep their region string. `db:seed` writes the four seed regions again.
- **Live grants.** A live grant is an `oidc_adapter_payloads` row of model `Grant` that has not expired. Each Hachiman sign-in has its own grant (§12.12 "Device binding"), so the live grants of a user are its Hachiman sessions. `AdminUser.activeSessions`, `filter=signed_in`, `counts.signedInUsers` and the `AdminOidcClient` counts use them.
- **Overview.** `counts.unverifiedUsers` counts users with neither `email_verified` nor `email_verified_at`. `counts.newUsers7d` counts users created in the last 7 days. `regionLoad` has one entry for each region of the table (in display-name order), then one for each other region that a media node names. Its `nodes` is the `mediaNodes` summary of the nodes of that region. `onlineUsers` counts the `presence:*` keys that are not `offline`. `mediaNodes.sessions` is the sum of `activeSessions` on fresh nodes, which is the number of live voice connections. `mediaNodes.capacity` is the sum of `maxSessions` on fresh `active` nodes.

`// ponytail:` a sign-out or user delete does not close open gateway connections. The user stays connected until the next reconnect fails. Add a gateway kick event if that matters.

## 5. Event bus (Redis pub/sub)

Takusen `PUBLISH`es. Every gateway node `PSUBSCRIBE`s `guild:*`, `user:*` and `device:*`.

Channels: `guild:{guildId}`, `user:{userId}`, `device:{deviceId}`. DM events go to `user:{id}` of every participant. `device:{id}` events go to every session of that device (§12.13).

Envelope (JSON): `{ "t": "<EVENT_NAME>", "d": <payload>, "channelId"?: "<guild channel id>" }`.
The publisher sets `channelId` for events scoped to one guild channel (MESSAGE_*, TYPING_START, CHANNEL_UPDATE/DELETE, PAGE_*, DOC_UPDATE, DOC_AWARENESS).
For an event of a thread, `channelId` is the parent channel, so the gateway can filter it without the thread in its view.
The gateway only forwards those to sessions with VIEW_CHANNEL on it (CHANNEL_CREATE carries it too). For a `thread` Channel, the gateway uses the overwrites of the parent (§2). A CHANNEL_UPDATE of a parent that changes its visibility also sends CHANNEL_CREATE / CHANNEL_DELETE for its threads. When a CHANNEL_UPDATE changes
overwrites, the gateway re-evaluates visibility. It then sends CHANNEL_CREATE / CHANNEL_DELETE to sessions that gained / lost view.

Other Redis keys (owned by the gateway unless noted):

| Key | Type | Contents / TTL |
|---|---|---|
| `session:{sessionId}` | hash | `userId`, `deviceId`, `seq`, `owner` (gateway process id — seq/buffer appends are Lua-guarded on ownership; RESUME takes ownership atomically), `voiceJti` (the `jti` of the voice token of the current call; RESUME restores it with the voice state); TTL 90 s, refreshed on each heartbeat |
| `device_online:{deviceId}` | string | the live session id. TTL 90 s, refreshed on each heartbeat, deleted when the session ends. The Takusen batch scheduler reads it (§12.7.5) |
| `device_nonce:{deviceId}:{nonce}` | string | gateway-owned. A `deviceProof` nonce of IDENTIFY or RESUME that the gateway accepted (§12.13). `SET NX`, TTL 10 min |
| `user_sessions:{userId}` | set | live session ids (TTL 90 s) — a user goes offline only when the last session ends |
| `events:{sessionId}` | list | last 500 dispatched frames (JSON, newest first) for RESUME. Same TTL |
| `presence:{userId}` | string | status. TTL 90 s, refreshed on heartbeat. Absent ⇒ offline |
| `custom_status:{userId}` | string | `CustomStatus` JSON (§1), written by op 3. No TTL without `expiresAt` (it survives sign-out), else it expires at `expiresAt`. Readers also drop a value whose `expiresAt` has passed. Sent only with a presence that is not `offline` |
| `voice:{guildId}` | hash | userId → `VoiceState` JSON. Readers drop entries whose `session:{sessionId}` is gone |
| `voice_dm:{channelId}` | hash | the same for the call of one DM or group DM channel (§6 "DM calls") |
| `voice_user:{userId}` | string | the scope the user is in voice for (one voice session per user globally): the guildId, or `dm:{channelId}` for a DM call |
| `voice_room:{channelId}` | string | mediaNodeId hosting that channel (sticky; SET NX, EX 24 h, deleted when the last user leaves). The endpoint comes from `media_nodes.signaling_url`. A missing node row drops the key and re-places |
| `takusen:sessions_revoked_at` | string | Takusen-owned. Unix ms: every dashboard cookie from before it is dead (§4 Admin API, `sessions:revoke`). No TTL |
| `takusen:sessions_revoked_at:{userId}` | string | Takusen-owned. The same cut-off for one user (admin sign-out, password change, the dashboard's "Sign out everywhere else"). No TTL. "Sign out everywhere else" first gives the current cookie a new `authTime`, then sets the cut-off to a time from before it, so the current cookie stays |
| `takusen:password_attempts:{userId}` | string (counter) | Takusen-owned. Current-password checks on the dashboard password change. Takusen increments it before it checks the password, so parallel checks cannot go past the limit. TTL 15 min from the first check. After 5 checks without a correct password, the form refuses until the key expires. A correct password deletes it |
| `takusen:device_nonce:{key}:{nonce}` | string | Takusen-owned. A device proof nonce that Takusen accepted (§12.12 "Device proof"). `{key}` is the base64url device MLS public key. `SET NX`, TTL 10 min |
| `takusen:mls_wakeup` | pub/sub | Takusen-owned. Takusen → its gRPC process: `{ "groupId": "<base64url>" }` when a Remove is queued (§12.7.5) |
| `takusen:mls_false_reject:{deviceId}` | string (counter) | Takusen-owned. The number of false `not_reader` rejection reports of a committer device (§12.12 "Batch rejections"). At 3, the batch scheduler skips the device. TTL 30 days, set again on each report |
| `media:{nodeId}` | pub/sub | gateway → media: `{ "op": "kick", "sessionId": "...", "channelId": "..." }` — media only closes a conn whose token channelId matches (a late kick must not kill a newer connection of the same session). `{ "op": "mute", "sessionId", "channelId", "mute": bool }` — server mute or deafen (§6 "Voice moderation"): media drops (or forwards again) the mic and screen share audio RTP of that session, with the same channelId check |
| `user:{userId}` | pub/sub | Takusen → gateway, internal: the envelope `{ "t": "VOICE_MOVE", "d": { "guildId", "channelId": string \| null } }` after a PATCH of the member with `channelId` (§6 "Voice moderation"). Not forwarded to clients |
| `device:{deviceId}` | pub/sub | media → gateway, internal: the envelope `{ "t": "VOICE_DISCONNECTED", "d": { "sessionId", "channelId", "jti" } }` when a call ends without a kick (§8 "Call end"). Not forwarded to clients |

## 6. Gateway WebSocket (`hachiman-gateway`)

URL: `ws(s)://<host>/gateway` (dev `ws://localhost:8080/gateway`). Text frames, JSON:
`{ "op": number, "d": any, "s"?: number, "t"?: string }`. `s`/`t` occur only on op 0.

| op | Name | Direction | `d` |
|---|---|---|---|
| 0 | DISPATCH | S→C | event payload; `s` = seq, `t` = event name |
| 1 | HEARTBEAT | C→S | last seq received or null |
| 2 | IDENTIFY | C→S | `{ token, deviceId, capabilities: string[], clientVersion, deviceProof: { ts, nonce, sig } }` (Takusen access token, §12.13) |
| 3 | PRESENCE_UPDATE | C→S | `{ status?, customStatus?: { text, expiresAt?: string \| null } \| null }` (below) |
| 4 | VOICE_STATE_UPDATE | C→S | `{ guildId: string \| null, channelId: string \| null, selfMute, selfDeaf, selfStream }`. `guildId` null: a DM call (below) |
| 5 | DOC_AWARENESS | C→S | `{ channelId, pageId, envelope }`: a doc_awareness envelope (§12.20), base64url |
| 6 | RESUME | C→S | `{ token, sessionId, seq, deviceId, deviceProof: { ts, nonce, sig } }` |
| 7 | RECONNECT | S→C | null — client should reconnect + RESUME |
| 9 | INVALID_SESSION | S→C | `resumable: boolean` |
| 10 | HELLO | S→C | `{ heartbeatInterval }` (ms, 41250) |
| 11 | HEARTBEAT_ACK | S→C | null |

**Read limit.** The gateway reads at most 65536 bytes per frame (`SetReadLimit`). A larger frame closes the socket (1009).

**Op 5 DOC_AWARENESS.** The presence of an open page: user, color, cursor and selection, as an encrypted y-protocols awareness update. The gateway stores nothing. It drops the frame (no close, no answer) when the session is not READY, when `envelope` is longer than 8192 characters, when the session sent more than 20 op 5 frames in the last second (a token bucket of 20, refilled at 20/s), when the channel is not a guild channel of type `pages`, or when the session cannot VIEW_CHANNEL it. It does not check that `pageId` exists. A `d` that does not decode gives close 4002. Else it publishes `DOC_AWARENESS { channelId, guildId, pageId, userId, deviceId, envelope }` to `guild:{guildId}` with `channelId`, with the user and device of the session. Every session that can view the channel gets it, the sending session included. The client ignores frames with its own `deviceId`. A client sends its state when it opens a page, when its cursor moves (at most every 100 ms), and every 15 s. It drops a peer after 30 s without a frame.

**Ephemeral dispatches.** The gateway sends `DOC_UPDATE` and `DOC_AWARENESS` as op 0 without `s`. They do not take a sequence number and do not go in `events:{sessionId}`, so they cannot push message events out of the resume buffer. The gateway decides by the event name. After READY or RESUMED, a client reads `GET /pages/:pageId/updates?after=<its highest seq>` for each open page. It also reads the tail when a `DOC_UPDATE` skips a `seq`. Yjs ignores an update that it already has.

Close codes: 4000 unknown error, 4001 unknown opcode, 4002 decode error, 4003 not authenticated,
4004 authentication failed, 4005 already authenticated, 4007 invalid seq, 4009 session timed out,
4012 client unsupported (no `e2ee/1` capability, or the version is below `GATEWAY_MIN_CLIENT_VERSION`), 4013 device unknown or revoked.
Clients do not reconnect after 4012 or 4013.

Flow: connect → HELLO → client IDENTIFY within 10 s (else 4003) → gateway calls
`GET {TAKUSEN_URL}/api/v1/users/@me` with the bearer token (non-200 ⇒ 4004) → capability and version check (⇒ 4012) →
device check in Postgres (⇒ 4013) → device proof check (⇒ 4004) → READY.
Client heartbeats every `heartbeatInterval`. No heartbeat for 1.5× interval ⇒ close 4009.

Token lifetime: the gateway checks the token only at IDENTIFY/RESUME. A live socket outlives token expiry
(Discord semantics). Clients must fetch a fresh token before every IDENTIFY/RESUME.

Dispatch events:

| t | d |
|---|---|
| READY | `{ v: 1, sessionId, deviceId, user: User, guilds: GuildFull[], privateChannels: Channel[], privateVoiceStates: VoiceState[] /* the live DM calls, guildId null */, presences: Presence[] /* DM partners */, readStates: ReadState[] }`. `readStates` has one entry for each text and pages channel that the user can VIEW and for each DM and group DM. The gateway reads them from Postgres in one query |
| RESUMED | `{}` |
| GUILD_CREATE | `GuildFull` |
| GUILD_UPDATE | `Guild` |
| GUILD_DELETE | `{ id }` |
| CHANNEL_CREATE / CHANNEL_UPDATE / CHANNEL_DELETE | `Channel`. Also for threads (type `thread`): there are no thread events |
| MESSAGE_CREATE / MESSAGE_UPDATE | `Message` (ciphertext, §1) |
| MESSAGE_DELETE | `{ id, channelId, guildId }` |
| TYPING_START | `{ channelId, guildId, userId, timestamp }` |
| READ_STATE_UPDATE | `{ channelId, lastReadMessageId }` — a session of the current user acked a channel (to user:{me} only). The other sessions clear their unread marks |
| GUILD_MEMBER_ADD / GUILD_MEMBER_UPDATE | `Member` |
| GUILD_MEMBER_REMOVE | `{ guildId, user: User }` |
| USER_UPDATE | `User` — the current user changed (to user:{me} only). Other users see the change through GUILD_MEMBER_UPDATE. `// ponytail:` DM recipients stay stale until the next READY |
| GUILD_ROLE_CREATE / GUILD_ROLE_UPDATE | `{ guildId, role: Role }` |
| GUILD_ROLE_DELETE | `{ guildId, roleId }` |
| INVITE_DELETE | `{ guildId, code, inviteId }` — an invite was revoked (§4): by `DELETE /invites/:code`, or because its creator lost ADMINISTRATOR. To every member of the guild. The crypto Worker also gets it (§12.13) |
| PRESENCE_UPDATE | `Presence` (published to guild:{g} for every guild of the user, and user:{p} for DM partners). When a session gets GUILD_CREATE (the user joined or created a guild), the gateway also publishes the current presence to that guild:{g}, so that the members see the new member online |
| VOICE_STATE_UPDATE | `VoiceState` (`channelId: null` = left). A guild state goes to guild:{g}, a DM call state to user:{p} of each participant |
| VOICE_SERVER_UPDATE | `{ guildId: string \| null, channelId, endpoint, token, iceServers: RTCIceServer[], expiresAt, moved?: true }` — to the requesting session only. `moved`: a move by a moderator (§6 "Voice moderation"), not an answer to op 4 |
| CALL_RING | `{ channelId, userId /* the caller */, ringing: string[] /* user ids */, at /* RFC 3339 */ }` — a DM call started (§6 "DM calls"). To user:{p} of each user in `ringing` |
| PAGE_CREATE / PAGE_UPDATE | `Page & { guildId }` |
| PAGE_DELETE | `{ id, channelId, guildId, ids: string[] }` (`ids`: the page and its subtree) |
| DOC_UPDATE | `DocUpdate & { channelId, guildId }` (ephemeral, above) |
| DOC_AWARENESS | `{ channelId, guildId, pageId, userId, deviceId, envelope }` (ephemeral, above) |
| CHANNEL_PINS_UPDATE | `{ channelId, guildId }` (`guildId` null in a DM). Bus envelope with `channelId`: VIEW_CHANNEL filtered like a message. The client refetches `GET /channels/:id/pins` |
| GUILD_EMOJIS_UPDATE | `{ guildId, emojis: GuildEmoji[] }` — the full list after a create, rename or delete. To every member of the guild |
| GUILD_EVENT_CREATE / GUILD_EVENT_UPDATE | `GuildEvent` (no `me`) — to every member of the guild |
| GUILD_EVENT_DELETE | `{ id, guildId }` |
| GUILD_EVENT_RSVP | `{ eventId, guildId, userId, going, rsvpCount }` |
| USER_BLOCK_UPDATE | `{ userId, blocked }` — to user:{me} only (the blocker's sessions) |
| GUILD_SOUNDS_UPDATE | `{ guildId }` — to every member of the guild. The client refetches `GET /guilds/:id/sounds` |
| POKE | `{ user: User }` — to user:{target} only. No content (§4 Poke) |
| MLS_HANDSHAKE, MLS_GROUP_UPDATE, MLS_BATCH_ASSIGN, MLS_JOIN_UPDATE, DEVICE_INBOX, DEVICE_LINK, USER_KEYS_UPDATE, KEY_PACKAGES_LOW, KT_TREE_HEAD | §12.13 |

Detached sessions: when a socket closes with any code but 1000, the session stays resumable for 60 s. Events keep buffering,
and the voice state stays. After that, or immediately on a clean 1000 close, the session does these steps:
- It leaves voice.
- It publishes offline if no other session of the user is live.
- It deletes `session:`/`events:`.

After INVALID_SESSION, the socket stays open for a fresh IDENTIFY.
The gateway re-materializes GUILD_CREATE on `user:{me}` from Postgres (it needs hidden channels for later visibility diffs).
Visibility diffs (synthetic CHANNEL_CREATE/DELETE) also follow GUILD_ROLE_*, GUILD_MEMBER_UPDATE for the viewer, and GUILD_UPDATE.

Resume: on RESUME, the gateway first runs check 1 (token, else 4004), check 3 (device, else 4013) and check 4 (device proof, else 4004) of §12.13. It does not run check 2: the session passed it at IDENTIFY.
A RESUME without `deviceId` fails check 3 and gives 4013. Then the gateway loads `session:{id}`. A missing session, a user mismatch, or a valid `deviceId` that differs from the stored session ⇒ INVALID_SESSION(false).
Otherwise, the gateway replays frames from `events:{id}` with `s > seq` (gap ⇒ INVALID_SESSION(false)), then sends RESUMED.
Sessions are not pinned to a node.
After IDENTIFY and after RESUME, the gateway subscribes the session and then does the device check again, before READY or RESUMED (§12.13).

Presence: IDENTIFY sets `online` (or the last client-requested status). The session TTL expiring ⇒ offline.
Op 3: an absent `status` keeps the status, an absent `customStatus` keeps the custom status, `customStatus: null` clears it.
The gateway removes control characters (Unicode Cc) and the bidi embedding, override and isolate characters (U+202A–U+202E, U+2066–U+2069) from `text`, then trims it.
An empty result clears, and so does an `expiresAt` that is not in the future.
It drops the frame (no close, no answer) when `status` is not a `PresenceStatus`, when `text` is longer than 64 characters (code points), when `expiresAt` is not RFC 3339, or when `customStatus` is not an object or null.
Else it writes `custom_status:{userId}` (§5) and publishes PRESENCE_UPDATE with the current status and custom status, also when only the custom status changed.
The gateway publishes `offline` itself when a socket closes without resuming within 60 s (in-process timer).
`// ponytail:` the users of a crashed node flip to offline only when readers notice that the key is gone. Add a sweeper if that matters.

### Voice join (gateway side)

On op 4 with a `channelId`:
1. Require channel.type == voice and CONNECT + VIEW_CHANNEL. (A DM call: "DM calls" below.)
2. If `voice_user:{me}` names another guild, remove that voice state first (publish VOICE_STATE_UPDATE with channelId null + kick).
3. HSET `voice:{guildId}`, SET `voice_user:{me}`, publish VOICE_STATE_UPDATE to guild.
4. If the channel changed (not a mute, deafen or stream toggle): resolve media node = GET `voice_room:{channelId}`, else
   `PlaceMediaSession{channelId, guildId, homeRegion: guild.region}` through Takusen gRPC, and SET NX.
   Kick the old media session if the user was elsewhere.
5. Mint a voice token (§7) with the session's `deviceId` and a `jti` that the gateway picks. Keep the `jti` on the session and in `session:{sessionId}` `voiceJti`. Send VOICE_SERVER_UPDATE with the `signalingUrl` of the node as `endpoint`.

Clients send op 4 with `channelId: null` when their media connection drops unexpectedly. Thus, a re-join is a fresh join.

On the internal `VOICE_DISCONNECTED {sessionId, channelId, jti}` on `device:{id}` (§8 "Call end"): the session with that id leaves voice as for op 4 with `channelId: null`, but only when `channelId` and `jti` are those of its current call, and only on the gateway node that owns the session (`owner`; after a RESUME on another node the old session object lives on until its grace ends). Thus, a late event of an earlier call does not end a re-join. The gateway does not forward the event. A client whose op 4 leave was dropped (the gateway connection was down too) thus does not stay in the channel until the session ends.

On op 4 with `channelId: null`, or session end: HDEL, DEL `voice_user`, publish VOICE_STATE_UPDATE(null),
publish kick to `media:{nodeId}`, and DEL `voice_room:{channelId}` if HLEN of occupants in that channel hits 0.

ICE servers: if TURN is configured (`--turn-secret`, `--turn-urls`), mint coturn REST credentials (`pkg/coturn`), else
`[{ "urls": ["stun:stun.l.google.com:19302"] }]`.

Not in v1 (explicitly deferred): camera video, a STREAM permission.

### Voice moderation

Server mute and deafen are the `mute` and `deaf` of the Member (`guild_members`), set by `PATCH /guilds/:id/members/:userId` (§4). They stay across calls. The gateway keeps them for the user of each session (READY, then GUILD_MEMBER_UPDATE). Each voice state carries them as `mute` and `deaf`. The voice token of a member with either one has the claim `mute: true` (§7). When a GUILD_MEMBER_UPDATE of the user changes them, the session that holds the call of the user (its voice state names the session, and the session hash names this gateway as `owner`) writes the voice state, publishes VOICE_STATE_UPDATE and publishes `{op: "mute", sessionId, channelId, mute: mute || deaf}` to `media:{nodeId}`. The gateway writes the voice state only while it still names this session (compare-and-set), so a join from another device in between wins. The media node then drops the mic RTP of the session (m-line 0) and relays no `speaking: true` of it, until the next `mute` op. It also drops the screen share audio of the session (m-line 2), so a muted user cannot talk through a share. The screen video is not affected. The last op wins over the token claim, also for a session that is still joining when the op comes. The client also gates its media (§10). The media node does not stop the remote audio of a deafened session: the client mutes its playback.

Move and disconnect: `PATCH` with `channelId` publishes the internal `VOICE_MOVE {guildId, channelId}` to `user:{userId}` (§5). The session that holds the call in that guild acts, as above. With `channelId: null` it leaves voice as for op 4 with `channelId: null` (VOICE_STATE_UPDATE null, kick). Else it runs the join steps above for the new channel with the self mute and deafen of the call, `selfStream` false, and sends VOICE_SERVER_UPDATE with `moved: true`. The client then opens the media connection of that channel without op 4. A kick (4010) from media does not make the client send an op 4 leave: the gateway already changed the voice state.

The gateway does not examine `selfStream`. It stores and publishes the value only. Any member in a voice channel can share a screen.

### DM calls

A `dm` or `group_dm` channel is also a voice room: a call with voice and screen share, as in a guild voice channel. Op 4 with `guildId: null` and the DM channel id joins its call. Differences from a guild join:
1. The gateway reads the participants of the channel from Postgres (`dm_participants`, channel type `dm` or `group_dm`). The user must be a participant. There is no permission check. Else the frame is dropped (no close, no answer).
2. The state goes in `voice_dm:{channelId}`, and `voice_user:{me}` is `dm:{channelId}`. A state in another scope (a guild, or another DM call) is removed first, as in step 2.
3. VOICE_STATE_UPDATE goes to user:{p} of every participant (the joiner included), not to a guild. A leave reads the participants again.
4. **Ring.** When the joiner was not in the call and no live session of another user is in it, the gateway publishes `CALL_RING { channelId, userId, ringing, at }` to user:{p} of every other participant (`ringing`). A mute, deafen or stream toggle, a device switch or a join into a call with people in it does not ring. The gateway keeps no ring state.
5. Placement: `PlaceMediaSession{channelId, guildId: "", homeRegion: ""}` (any region). The voice token has `guildId` "" (§7). VOICE_SERVER_UPDATE has `guildId: null`.
6. READY `privateVoiceStates` holds the live states of every DM call of the user.

The client stops ringing locally (no wire message): when the user joins the call (a VOICE_STATE_UPDATE of the user in that channel, from any device), when no state is left in the call (the caller left), when the user declines, or 30 s after `at`. In a 1:1 DM, a join of the other user also stops it. `// ponytail:` a decline is local to the device. The other devices of the user ring until the timeout.

`// ponytail:` a participant removed from a group DM keeps its voice state until it leaves. The gateway does not re-check membership during a call.

## 7. Voice token (PASETO v4.public, `pkg/voicetoken`)

Claims:

```go
type Claims struct {
    SessionID   string    `json:"sessionId"`   // gateway session id
    UserID      string    `json:"userId"`
    DeviceID    string    `json:"deviceId"`    // the gateway session's device (§12.13). Media gives it to members in e2ee_roster
    GuildID     string    `json:"guildId"`     // "" for a DM call (§6 "DM calls")
    ChannelID   string    `json:"channelId"`   // = media room id
    MediaNodeID string    `json:"aud"`         // must equal the verifying node's id
    JTI         string    `json:"jti"`
    IssuedAt    time.Time `json:"iat"`
    ExpiresAt   time.Time `json:"exp"`         // 60–120 s after iat
    Mute        bool      `json:"mute"`        // optional, only true is sent: server muted or deafened at mint time (§6 "Voice moderation")
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
| identify | C→M | `{ token, e2ee: { version: 1, keyPackage } }` — must be the first frame, within 10 s. A missing `e2ee` or another version closes 4012. A `keyPackage` that is not base64url closes 4014. A voice token without `deviceId` closes 4004 |
| ready | M→C | `{ sessionId, ssrc }` |
| offer | M→C | `{ sdp }` (initial + every renegotiation) |
| answer | C→M | `{ sdp }` |
| candidate | both | `{ candidate: RTCIceCandidateInit \| null }` (null = end of candidates) |
| peers | M→C | `{ peers: [{ userId, ssrc }] }` — full snapshot of other room members; sent on join and on every change |
| speaking | C→M | `{ speaking: boolean }` |
| speaking | M→C | `{ userId, speaking }` — relayed to other room members |
| screen_subscribe | C→M | `{ userIds: string[] }` — the users whose screen share media forwards to this session. It replaces the previous set. The set is empty at join. Media keeps it for the session, also when a named user joins later or rejoins. More than 256 ids, or more than 10 frames in a second: media ignores the frame. See "Screen share" below |
| e2ee_roster | M→C | `{ groupId, epoch: number \| null, committer: sessionId \| null, create: boolean, members: [{sessionId, userId, deviceId, leafIndex: number \| null}], pending: [{sessionId, userId, deviceId}], departed: [{sessionId, userId, deviceId, leafIndex: number \| null}] }` — to every session, on join and on every change. `create: true` tells the committer to create the group (epoch 0). `members[].leafIndex` is null for a session that a commit added and that did not send `e2ee_ready` yet. `departed[].leafIndex` is null when the session left before it reported its leaf: the committer then finds the leaf by the device id of the leaf credential |
| e2ee_key_package | M→C | `{ sessionId, userId, deviceId, keyPackage }` — to the committer, for each pending joiner (again after a committer change) |
| e2ee_commit | C→M | `{ epoch, commit, welcome: string \| null, added: sessionId[], removed: sessionId[] }` — `epoch` is the epoch that the commit applies to. When `welcome` is not null, the next `e2ee_*` frame from that session is `e2ee_ratchet_tree` (other ops, such as `candidate` or `speaking`, may come between) |
| e2ee_ratchet_tree | C→M | `{ epoch, ratchetTree }` — epoch = commit epoch + 1. A separate frame, so the Welcome stays small |
| e2ee_commit_rejected | M→C | `{ epoch, currentEpoch: number \| null }` — the media node did not accept the commit: another commit won the epoch, an earlier transition is not executed yet (`currentEpoch` is then the new epoch), `added` names a session that is no longer pending, or `removed` names a session that is not departed. This is not a violation. The committer tries again from the latest roster |
| e2ee_prepare_transition | M→C | `{ transitionId, epoch, commit }` — the winning commit, to every member. The committer merges its pending commit when it gets its own commit back |
| e2ee_welcome | M→C | `{ transitionId, epoch, welcome }` — to each added session |
| e2ee_ratchet_tree | M→C | `{ transitionId, epoch, ratchetTree }` — to each added session, after `e2ee_welcome` |
| e2ee_ready | C→M | `{ transitionId: number \| null, epoch, leafIndex }` — after the client applied the transition. `transitionId: null` comes only from the creator after create: the media node then sets the room epoch from null to 0 |
| e2ee_execute_transition | M→C | `{ transitionId, epoch }` — when every member of the new epoch sent `e2ee_ready`, or after 3 s. Senders switch keys now |
| e2ee_invalid | C→M | `{ transitionId: number \| null, reason, committerLeaf: number \| null }` — the client cannot apply the transition. `committerLeaf` is the sender leaf of the commit that failed. See the rule below the table |

E2EE (§12.10): the media node relays and orders. It never signs, proposes or commits. It accepts the first `e2ee_commit` whose epoch is the room epoch, after the commit parse of §12.10.1, from any member (not only the selected committer) whose own reported leaf equals the `leaf_index` in the commit header. The first such commit for the room epoch wins. A committer that sends no commit within 5 s of new work loses the role: the timer starts at the first new work, and more work does not start it again. Before the group exists, the failover gives the create role to the next joiner. A member that sends no `e2ee_ready` within 10 s is closed with 4013. When the committer sent a commit with a `welcome` and its `e2ee_ratchet_tree` did not arrive 10 s after the commit, the media node closes the committer with 4014, and the room stays in the previous epoch.

`e2ee_invalid` closes the sender with 4013 (a resync) when `transitionId` is null, when it names an unknown or resolved transition, a transition that does not include the sender, or a transition that the sender committed. When no live participant holds the group state but participants remain, the room starts a new group: a new room session id and group id, epoch null, and an empty `departed` list.

**Bad commits.** For one `transitionId`, when at least two members send `e2ee_invalid`, or every other member when fewer than two other members exist, the media node closes the committer of that transition with 4014. It keeps the other members, selects a new committer and sends the roster again. The members drop the pending transition and stay in the previous epoch. A single `e2ee_invalid` while the other members send `e2ee_ready` closes only that member with 4013. Frames on m-lines 0 to 2 and on every peer track are SFrame (§12.10.2).

**Call end.** When a joined session closes for any reason except 4010 (kick), 4011 (replaced) or a node shutdown (1001), the media node publishes `VOICE_DISCONNECTED {sessionId, channelId, jti}` (the claims of its voice token) to `device:{deviceId}` (§5). The gateway then removes the voice state at once (§6 "Voice join"), and does not wait for the end of the gateway session. The gateway caused a kick or a replace, so those send nothing. On a shutdown the clients get 1001 and leave themselves.

Keepalive: media pings every ~20 s and drops sockets silent for 60 s. Media closes 1011 if an offer goes unanswered ~15 s or the PC is not `connected` ~30 s after join. Media rejects frames above `MEDIA_WS_READ_LIMIT` (default 1 MiB). The send queue holds 256 frames.

Close codes: 4004 bad token (incl. replayed jti — clients need a fresh VOICE_SERVER_UPDATE token per voice-WS connect — and a token without `deviceId`), 4009 token expired / identify timeout,
4010 kicked (Redis `media:{nodeId}` kick), 4011 replaced (same sessionId connected again), 4012 E2EE required (no or unsupported `e2ee` in identify),
4013 E2EE resync (`e2ee_invalid`, or no `e2ee_ready` in 10 s), 4014 E2EE protocol violation (a malformed op or identify `keyPackage`, a commit for another group or with a false leaf, a commit that the members reject, above, or no `e2ee_ratchet_tree` 10 s after a commit with a Welcome),
1011 ICE/negotiation failure, 1008 client send queue overflow, 1001 shutdown.

`ssrc` in `ready`/`peers` is a node-unique id from `SSRCPool`, **not** the on-wire RTP SSRC (pion v3 picks those). Map tracks by msid (below).
Codecs: Opus (payload type 111) for audio, VP8 (payload type 96) for screen video.
Upload slots: the recvonly transceivers at m-line 0 (mic, audio), m-line 1 (screen, video) and m-line 2 (screen audio, audio) of the initial offer. They are stable across renegotiations. A client finds m-line 2 to be a slot only when the offer marks it `a=recvonly`: a media node without the screen audio slot has a peer track there, and the client then sends no screen audio.
Peer tracks ride separate sendonly transceivers. Frame order on join: `ready` → `peers` → `e2ee_roster` → `offer`.

Track labeling: for each peer, the media node creates three output tracks:

| Track | Stream id | Track id |
|---|---|---|
| Mic | `<userId>` | `audio-<userId>` |
| Screen | `screen-<userId>` | `screen-<userId>` |
| Screen audio | `screen-<userId>` | `screen-audio-<userId>` |

Clients map remote tracks to users through `ontrack` → `event.streams[0].id`. A stream id `screen-<userId>` with a video track is the screen of `<userId>` (SFrame track `video`). With an audio track it is the screen audio (SFrame track `screen-audio`). Every other stream id is the user id, with the mic (SFrame track `audio`).

Screen share:
- Every room member has a screen track and a screen audio track for every peer (transceivers in the SDP). Media forwards a peer's screen and screen audio to a viewer only while the viewer's last `screen_subscribe` names that peer. Else the tracks are silent. They are also silent until the peer shares.
- Each (sharer, viewer) pair has its own output tracks on the media node. A `screen_subscribe` only starts or stops the writes to those tracks. No renegotiation occurs.
- Media rewrites the RTP sequence numbers of each viewer's screen tracks, so they stay contiguous over the gaps while the viewer is not subscribed. Payloads stay unchanged (§12.10.2).
- When a subscription starts, media sends a PLI to the sharer, so the video starts at a keyframe. The 500 ms limit below applies: a PLI that it drops is not sent later, and the viewer's own keyframe request then starts the video.
- The voice state field `selfStream` (§1, op 4) tells clients when a share is live. No media frame carries it.
- To start or stop a share, the client replaces the track on its m-line 1 sender, and the share audio on its m-line 2 sender. A share without audio leaves m-line 2 empty. No renegotiation occurs. Media never sends a client's own tracks back to it.
- The sharer sets the resolution, frame rate and bitrate. All subscribed viewers get the same quality (no simulcast).
- Media relays a viewer's PLI (picture loss indication) or FIR (full intra request) to the sharer as a PLI. Both ask for a keyframe. Media sends at most one PLI to a sharer each 500 ms. A viewer that joins or subscribes during a share also gets its first keyframe this way.

SFU keys: session = `Claims.SessionID` (string), room = `Claims.ChannelID`. Media allocates SSRCs per node from
`SSRCPool` keyed by session string. A client receives output tracks **only** for peers in its own room.

Media flags/env: `--node-id` (`MEDIA_NODE_ID`), `--region` (`MEDIA_REGION`), `--listen :8090`, `--signaling-url ws://localhost:8090/voice`,
`--takusen-grpc-addr` (`TAKUSEN_GRPC_ADDR`), `--redis-url` (`REDIS_URL`), `--voice-pubkey` (`VOICE_PUBKEY`) or `--voice-key` (`VOICE_KEY`, seed path shared with the gateway),
`--public-ip` (pion NAT 1:1), `--udp-port-min/max`. Media calls Takusen `RegisterMediaNode` at start and
`MediaNodeHeartbeat` every 10 s (via `pkg/takusenclient`). No gateway↔media gRPC sidechannel exists anymore.

## 9. Takusen management gRPC (`apps/hachiman-server/pkg/management/management.proto`)

Package `hachiman.management.v1`, service `Management` (Takusen serves it, and media + gateway call it):

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

Heartbeat status: `dead` stays `dead`. A node with `admin_drain` stays `draining`. Else `accepting` gives `active` or `draining`. Register sets `active`, or `draining` when `admin_drain` is set.

Takusen placement ignores `channel_id`/`guild_id` (`guild_id` is empty for a DM call). It returns the least-loaded fresh node in `home_region`, or in any region when `home_region` is empty (guilds default to no region). Channel stickiness comes from the gateway key `voice_room:{channelId}`.

Create/DeleteVirtualServer: deleted. Takusen loads the proto dynamically (`@grpc/proto-loader`), so the
TS handler names follow the proto (`Management`, `hachiman.management.v1`).

## 10. Client library surface (`@hachiman/client`)

Browser-safe only (fetch, WebSocket, RTCPeerConnection). No Node imports, no rxjs, no protobuf.
`package.json` `exports` points at `./src/index.ts` (consumed as source, like `@hachiman/hachiman`).

```ts
export * from './types'          // §1 + gateway frame/event types (GatewayEvents map: event name → payload)
export * from './permissions'    // Permissions, DEFAULT_EVERYONE, ALL, computeBasePermissions, computeChannelPermissions, has(perms, bit), permissionChannel(channel, lookup) (thread → parent, §2)
export { TypedEventEmitter } from './typed-event-emitter'

type TokenProvider = () => Promise<string>   // must return a fresh, valid Takusen access token

export class RestClient {
  // getDeviceId: the current device id, sent as X-Hachiman-Device on every request when not null (§12.12)
  // proveDevice: signs each request that sends X-Hachiman-Device, and POST /devices: X-Hachiman-Device-Ts/-Nonce/-Sig (§12.12 "Device proof")
  constructor(opts: { baseUrl: string /* e.g. http://localhost:3000/api/v1 */; getToken: TokenProvider; getDeviceId?: () => string | null; proveDevice?: DeviceProver })
  // one method per §4 row, e.g.:
  // opts?: SignedActionOptions = { signedAction?: string } — the encoded AdminAction(s) for X-Hachiman-Signed-Action (§12.16, Phase 4)
  getMe(); createGuild(body); getGuild(id); updateGuild(id, body, opts?); deleteGuild(id)
  createChannel(guildId, body); reorderChannels(guildId, body); updateChannel(id, body, opts?); deleteChannel(id)
  createThread(parentId, { name, startMessageId? }); listThreads(parentId)   // rename / delete a thread: updateChannel / deleteChannel
  putOverwrite(channelId, targetId, body, opts?); deleteOverwrite(channelId, targetId, opts?)
  getMessages(channelId, { before?, limit? }); editMessage(...); deleteMessage(...); triggerTyping(channelId); ackMessage(channelId, messageId)
  getMembers(guildId); updateMember(guildId, userId, body, opts?); kickMember(guildId, userId); leaveGuild(guildId)
  getBans(guildId); banMember(guildId, userId, {reason?}?); unbanMember(guildId, userId)
  getRoles(guildId); createRole(guildId, body, opts?); reorderRoles(guildId, positions, opts?); updateRole(guildId, roleId, body, opts?); deleteRole(guildId, roleId, opts?)
  getInvites(guildId); createInvite(guildId, { maxAgeSeconds?, maxUses?, acknowledgedPermanent?, record? }); deleteInvite(code); previewInvite(code); acceptInvite(code)
  getDmChannels(); openDm(recipientIds); getUser(id)
  // §4 Pins, guild events and blocks
  getPins(channelId); pinMessage(channelId, messageId); unpinMessage(channelId, messageId)
  getGuildEmojis(guildId); createGuildEmoji(guildId, { name, uploadId }); renameGuildEmoji(guildId, emojiId, name); deleteGuildEmoji(guildId, emojiId)
  getGuildEvents(guildId); createGuildEvent(guildId, { title, startsAt, endsAt?, channelId? }); updateGuildEvent(eventId, body); deleteGuildEvent(eventId)
  setEventRsvp(eventId, going: boolean)   // PUT or DELETE /events/:id/rsvp
  getBlocks(); blockUser(userId); unblockUser(userId)
  // §4 Soundboard and Poke
  getGuildSounds(guildId); createGuildSound(guildId, { id, name, emoji?, uploadId, channelId, envelope }); deleteGuildSound(guildId, soundId)
  poke(userId)
  updateMe({ avatar? }); getLimits()
  // §4 Pages
  getPages(channelId); getPageHeads(channelId); createPage(channelId, { id, parentId, position, titleEnvelope }); updatePage(pageId, { parentId?, position?, titleEnvelope?, ifUpdatedAt? }); deletePage(pageId)
  getPageState(pageId); getPageUpdates(pageId, { after, limit? }); postPageUpdate(pageId, { envelope })
  postPageSnapshot(pageId, { baseSeq, uploadId, envelope, mediaUploadIds }); claimPageMedia(pageId, uploadIds)
  sendMessage(channelId, { envelope, nonce?, attachments?: string[] /* upload ids */ }); editMessage(channelId, messageId, { envelope })
  // XHR, because fetch has no upload progress. Rejects with RestError (413 UploadTooLarge, ...) or an AbortError.
  uploadBlob(blob: Blob, opts?: { signal?: AbortSignal; onProgress?(loaded: number, total: number): void }): Promise<Attachment>   // ?kind=blob
  uploadSnapshot(blob: Blob, opts?: { signal?: AbortSignal; onProgress?(loaded: number, total: number): void }): Promise<Attachment>   // ?kind=page_snapshot
  uploadImage(file: Blob, opts: { filename: string; signal?: AbortSignal; onProgress?(loaded: number, total: number): void }): Promise<{ id: string; key: string; size: number }>
  fileUrl(key: string): string   // `${baseUrl}/files/${key}`, each path segment URI-encoded
  fetchBlob(key: string, opts?: { signal?: AbortSignal }): Promise<Blob>
  // §12.12, one method per row, with the shapes of §12.12:
  registerDevice(body); listDevices(); renameDevice(id, name); putDeviceCertificate(id, body); revokeDevice(id, body)
  getUserKeys(userId); putMasterKey(body); putDeviceSigningKey(body)
  getDsInfo(); uploadKeyPackages(body); countKeyPackages()
  listMlsGroups(); getMlsGroup(groupId); getChannelMlsGroup(channelId); getMlsGroupState(groupId, epoch?); createMlsGroup(body)
  postCommit(groupId, body /* resolves 409 EpochConflict as { ok: false, epoch } */); getHandshakes(groupId, { after, limit? })
  postJoinRequest(groupId, body); getJoinRequest(id); declineBatch(batchId, reason)
  getInbox({ after, limit? }); ackInbox(id); postInbox(deviceId, body)
  getBackups(); putIdentityBackup(body); postHistoryBackup(body); getBackup(id); deleteBackups()
  postHistoryBundle(groupId, body); getHistoryBundles(groupId, epoch)
  createLinkSession(body); listLinkSessions(); postLinkMessage(id, body); getLinkMessages(id, after); deleteLinkSession(id)
  ktTreeHead(); ktInclusion(index, treeSize); ktConsistency(from, to); ktEntries(query); getAdminActions(guildId, after); report(body)
  inviteRecords(guildId); postInviteBundle(inviteId, { groupId, epoch, blob }); inviteBundles(code)
}
export const EMBEDDABLE: { image: readonly string[]; video: readonly string[]; audio: readonly string[] }   // src/files.ts
export function embedKind(contentType: string): 'image' | 'video' | 'audio' | 'file'   // ignores MIME parameters (`; codecs=...`) and case
export const blobKey: (uploadId: string) => string   // `${uploadId}/blob`: the file key of an encrypted blob (§4 Files), for fileUrl / fetchBlob
export class RestError extends Error {
  status: number; code: string
  details: Readonly<Record<string, unknown>>   // the other fields of the error body, e.g. { epoch } or { userIds }
  retryAfterSec: number | null                 // from Retry-After (429 RateLimited), else null
}
export function parseRetryAfter(value: string | null, now?: number): number | null   // RFC 9110 delay-seconds or HTTP date → whole seconds

export class GatewayClient extends TypedEventEmitter<GatewayClientEvents> {
  // device: sent in IDENTIFY and RESUME (§12.13). Close 4012 or 4013 → state 'closed', no reconnect, event 'fatal' ({ code })
  // proveDevice: signs `deviceProof` of IDENTIFY and RESUME (§12.13). A rejection counts as a failed attempt
  constructor(opts: { url: string; getToken: TokenProvider; device: () => { deviceId: string; capabilities: string[]; clientVersion: string }; proveDevice?: DeviceProver })
  connect(): void          // auto-reconnect with backoff; RESUME when possible, else fresh IDENTIFY
  disconnect(): void
  retryNow(): void         // a reconnect waits for its backoff: connect now (the shared UI calls it on the window 'online' event)
  readonly state: 'idle' | 'connecting' | 'ready' | 'resuming' | 'closed'
  readonly sessionId: string | null
  readonly latencyMs: number | null   // HEARTBEAT → ACK RTT
  updatePresence(status: PresenceStatus): void
  setCustomStatus(text: string, expiresAt?: string | null): void   // op 3 customStatus; an empty text sends null (clear)
  updateVoiceState(d: { guildId: string | null; channelId: string | null; selfMute: boolean; selfDeaf: boolean }): void
  sendDocAwareness(d: { channelId: string; pageId: string; envelope: string }): void   // op 5. Dropped while not connected
  // events: 'state' (state), 'dispatch' ({t, d}), and each event name from §6 with its typed payload
}

// The crypto side of a call. The UI implements it with the @hachiman/crypto Worker (CryptoApi.voice*).
// The client library stays free of crypto code: it only moves ops and installs the transforms.
export interface VoiceE2eeDelegate {
  start(): Promise<{ keyPackage: string }>                      // for identify
  handle(op: VoiceE2eeServerOp): Promise<VoiceE2eeClientOp[]>   // §8 e2ee_* ops. Send the result in order
  senderTransform(track: 'audio' | 'video' | 'screen-audio'): RTCRtpScriptTransform   // once per call and track: m-lines 0, 1, 2
  receiverTransform(userId: string, track: 'audio' | 'video' | 'screen-audio'): RTCRtpScriptTransform
  // The receiver of a receiverTransform result ended: its track ended, its peer left the roster, or
  // ontrack gave the receiver a new transform. The UI detaches its frame key port (voiceDetachTransform)
  releaseTransform(transform: RTCRtpScriptTransform): void
  close(): void                                                 // releases the rest
}

export class VoiceConnection extends TypedEventEmitter<VoiceEvents> {
  // e2ee is required: media closes 4012 without it. Transforms go on the m-line 0 and 1 senders and on each ontrack receiver
  constructor(opts: { endpoint: string; token: string; iceServers: RTCIceServer[]; e2ee: VoiceE2eeDelegate })
  connect(): Promise<void>
  close(): void
  readonly closeCode: number | null   // the code of an unexpected close ('close' event); null while open or after close()
  setMicrophone(stream: MediaStream | null): Promise<void>   // null = stop sending
  setMuted(muted: boolean): Promise<void>                    // gates the outgoing track; the mic stream stays open
  setSpeaking(speaking: boolean): void                       // sends op speaking
  setDeafened(deafened: boolean): void                       // mutes all remote playback locally
  setOutputDevice(deviceId: string | null): Promise<void>    // null = system default
  setOutputVolume(userId: string, volume: number): void     // local playback of one user, 0..2 (1 = unchanged); kept for the call. Above 1 a WebAudio GainNode plays the user
  setScreen(track: MediaStreamTrack | null, encoding?: { maxBitrate: number; maxFramerate: number } | null): Promise<void>   // null = stop sending
  setMicBitrate(maxBitrate: number | null): Promise<void>   // mic (m-line 0) encodings[0].maxBitrate in bit/s, null = browser default; setParameters, no renegotiation; kept for the call
  setScreenAudio(track: MediaStreamTrack | null): Promise<void>   // the share audio on m-line 2; null = none. replaceTrack, no renegotiation; the caller owns the track
  setScreenVolume(userId: string, volume: number): void      // local playback of one user's share audio, 0..2, as setOutputVolume
  setScreenSubscriptions(userIds: Iterable<string>): void   // §8 screen_subscribe: the users whose screen media forwards to us. Replaces the set; sent on a change and again on 'ready'. Empty at start
  getStats(): Promise<{ rttMs: number | null; jitterMs: number | null; packetLoss: number | null }>
  // events: 'state' (RTCPeerConnectionState), 'speaking' ({userId, speaking}), 'peers' ({userId, ssrc}[]),
  //         'screen' ({userId, stream: MediaStream | null}), 'resync' ({code, reason}: media closed 4013, fires just before 'close'),
  //         'close' ({code, reason}: the media close code, or 1006 'ice failed' when the RTCPeerConnection state becomes 'failed')
}

export class HachimanClient extends TypedEventEmitter<HachimanClientEvents> {
  constructor(opts: {
    apiUrl: string; gatewayUrl: string; getToken: TokenProvider
    device: () => { deviceId: string; capabilities: string[]; clientVersion: string } | null   // null: no device yet (onboarding). connect() waits:
                                                                                                // it polls device() every 250 ms. There is no 'device ready' signal
    proveDevice?: DeviceProver                                                                  // to RestClient and GatewayClient. The shared UI passes CryptoApi.proveDevice
    voiceE2ee: () => VoiceE2eeDelegate                                                          // one per joinVoice
  })
  readonly rest: RestClient
  readonly gateway: GatewayClient
  readonly cache: {
    user: User | null
    guilds: Map<string, Guild>
    channels: Map<string, Channel>               // guild channels + DMs
    roles: Map<string, Map<string, Role>>        // guildId → roleId → Role
    members: Map<string, Map<string, Member>>    // guildId → userId → Member
    presences: Map<string, PresenceStatus>       // userId → status
    customStatuses: Map<string, CustomStatus>    // userId → custom status of an online user; check expiresAt when showing it
    voiceStates: Map<string, Map<string, VoiceState>>  // voiceScopeId → userId → state. voiceScopeId(vs) = vs.guildId ?? vs.channelId (a DM call: the DM channel id)
    readStates: Map<string, ReadState>           // channelId → state. From READY. READ_STATE_UPDATE sets lastReadMessageId and unreadCount 0
    emojis: Map<string, GuildEmoji[]>            // guildId → custom emojis. From READY / GUILD_CREATE, replaced by GUILD_EMOJIS_UPDATE
    events: Map<string, Map<string, GuildEventWithMe>>  // guildId → eventId; filled by fetchGuildEvents, kept by GUILD_EVENT_*
    blocks: Set<string>                          // blocked user ids; filled by fetchBlocks, kept by USER_BLOCK_UPDATE
  }
  fetchGuildEvents(guildId): Promise<GuildEventWithMe[]>   // GUILD_EVENT_* for a guild that was not fetched do not fill the cache. A result that arrives after a READY, or after its guild left the cache, does not fill it
  fetchBlocks(): Promise<BlockedUser[]>                    // fills cache.blocks (not after a READY that came meanwhile); resolves the list with the users
  // Pins are not cached: CHANNEL_PINS_UPDATE is re-emitted only.
  connect(): void; disconnect(): void
  permissionsFor(channelId: string): number      // for the current user
  guildPermissions(guildId: string): number
  joinVoice(guildId: string | null, channelId: string): Promise<VoiceConnection>   // joins with the current selfVoice. guildId null: a DM call (§6 "DM calls")
  leaveVoice(): void
  readonly selfVoice: SelfVoiceState             // { ownMute, selfMute, selfDeaf }
  setSelfVoice(change: Partial<SelfVoice>): SelfVoiceState   // SelfVoice = { selfMute, selfDeaf }
  readonly serverVoice: { mute: boolean; deaf: boolean }   // server mute and deafen of the user in the guild of the call (§6 "Voice moderation"): from its VoiceState, else its Member. They gate the media as selfMute / selfDeaf do (deaf also mutes), op 4 does not carry them, and the client applies a change at once
  setCustomStatus(text: string, expiresAt?: string | null): void   // gateway.setCustomStatus; the cache changes on the PRESENCE_UPDATE echo
  setScreen(track: MediaStreamTrack | null, encoding?: ScreenEncoding | null): Promise<void>   // null = stop; sets selfStream
  readonly voice: VoiceConnection | null
  // A media close 4010 (kick) drops the call without an op 4 leave: the gateway already ended or moved it. A VOICE_SERVER_UPDATE with
  // `moved` while no join is pending opens the media connection of that channel (a move by a moderator), and emits 'voice'.
  // When the gateway becomes 'ready' (before the 'state' event), a voice state of this session that the client is not in
  // (a leave dropped while the socket was down, then RESUME) is left with op 4 channelId null.
  // events: 'ready', 'state', 'update' (fired after any cache mutation with { t, d }), 'voice' (VoiceConnection | null),
  //         'fatal' ({ code }: the gateway closed 4012 or 4013 and does not reconnect),
  //         'voiceResync' (VoiceTarget { guildId: string | null, channelId }: media closed the call 4013; the client left voice, call joinVoice with the same target),
  //         'voiceMoved' (VoiceTarget, Promise<VoiceConnection>: a moderator moved the user; fires before 'voice' null, then 'voice' gives the new call, and the promise resolves to it once connected, as joinVoice does),
  //         plus every gateway event re-emitted after the cache is updated
  // The cache keeps Message as ciphertext. The shared UI decrypts with @hachiman/crypto before messagesStore.upsert.
  // PAGE_* and DOC_* are not cached. The shared UI (services/docs) keeps the page tree and the Yjs docs.
  // INVITE_DELETE is not cached. The invite list of the guild settings removes the revoked invite.
}
```

`types.ts` also exports the §12.12 shapes (`Device`, `UserKeys`, `DsInfo`, `MlsGroup`, `GroupState`, `CreateGroupRequest`, `CommitRequest`, `Handshake`, `JoinRequest`, `InboxItem`, `BackupIndex`, `HistoryBundle`, `LinkSession`, `LinkMessage`, `KtTreeHead`, `KtInclusionProof`, `KtConsistencyProof`, `KtEntry`, `AdminAction`, `InviteRecord`, `InviteBundles`), the §12.13 events in `GatewayEvents`, and `VoiceE2eeServerOp` / `VoiceE2eeClientOp` (§8). The shapes are structurally equal to the `Wire*` types and the voice op types of `@hachiman/crypto` (`src/api.ts`). The shared UI typechecks the two against each other where it joins them.

`setSelfVoice` is the only place that sets self mute and deafen. The rules follow Discord:
- Deafen mutes the outgoing audio and all remote playback. Op 4 then sends `selfMute: true`.
- Undeafen restores the mute state that the user set before the deafen.
- `selfMute: false` while deafened also undeafens.

`selfVoice` and the return value of `setSelfVoice` give the full state. `selfMute` and `selfDeaf` are the values that op 4 sends. `ownMute` is the mute state that the user set. Deafen does not change `ownMute`, and undeafen restores it.

Each call sends exactly one op 4 when the client is in voice. Outside voice, it sends nothing, and the next `joinVoice` uses the new state.
Mute does not release the microphone. It only stops the outgoing track (`VoiceConnection.setMuted`).

`setScreen` is the only place that sets `selfStream`. A share needs a live voice connection. Outside voice, `setScreen` does nothing. A start or a stop sends one op 4, and a new `encoding` for the live track sends no op 4. Leaving voice, or joining another channel, ends the share. The caller owns the track and stops it.

## 11. Shared UI ↔ host seam (`apps/hachiman/src/shared/IPlatformService.ts`)

```ts
export interface IPlatformService {
  readonly platform: 'electron' | 'browser'
  /** The host hides the native title bar, so the UI draws a draggable strip (Electron on macOS). */
  readonly insetTitleBar: boolean
  /** OAuth `redirect_uri` for this host. Takusen's client registration must allow it. */
  readonly oauthRedirectUri: string
  /** Opens the OAuth authorization page. Browser: same-tab redirect. Electron: system browser. */
  beginOAuth(url: string): void
  /** Invite links (`takusen://invite/<code>` or `https://<takusen>/invite/<code>`, `#k=<key>` with history) → code and key. Returns unsubscribe. */
  onInviteLink(cb: (link: InviteLink) => void): () => void
  /** OAuth redirect URLs delivered by the host (Electron custom scheme / browser callback route). */
  onOAuthCallback(cb: (url: string) => void): () => void
  /** Electron: TCP-connect RTT probe from main. Browser: resolves []. */
  probeRegions(targets: { region: string; host: string; port: number }[]): Promise<{ region: string; rttMs: number | null }[]>
  /** Electron: screens and windows for the in-app share picker. Browser: null (it has its own picker). */
  getScreenSources(): Promise<{ id: string; name: string; kind: 'screen' | 'window'; thumbnail: Blob }[] | null>
  /** Electron: the listed source that the next screen share captures, with system audio when `audio` and screenShareAudio. Browser: no-op. */
  selectScreenSource(id: string, audio: boolean): Promise<void>
  /** The in-app picker can capture system audio with a share (Electron on Windows: loopback). Else false. */
  readonly screenShareAudio: boolean
  /** Electron: check for a new build now, and offer it (also one that the user put off). Browser: not-available. */
  checkForUpdate(): Promise<UpdateCheckResult>
  /** Electron: the close button hides the window to the tray (default on); main keeps the value. Browser: null. */
  readonly closeToTray: ICloseToTray | null
  /** Electron: registers `shortcuts` with the OS in place of the previous set ([] lets all go). Resolves with the refused actions. Browser: null. */
  setGlobalShortcuts(shortcuts: GlobalShortcut[]): Promise<string[] | null>
  /** Electron: a global shortcut fired, with its action. Browser: never. Returns unsubscribe. */
  onGlobalShortcut(cb: (action: string) => void): () => void
  /** The wrap key of the encrypted crypto store (§12.17). */
  readonly secureStorage: ISecureStorage
}

// Electron: IPC `hachiman:close-to-tray-get` / `hachiman:close-to-tray-set` (a boolean), from the top
// frame of the app page only. Main keeps the value in `<userData>/app-prefs.json`, so it applies before
// the renderer loads. Cmd+Q, the tray menu "Quit Hachiman" and an update install still quit.
export interface ICloseToTray {
  get(): Promise<boolean>
  set(on: boolean): Promise<void>
}

export interface GlobalShortcut {
  action: string        // the UI's own name, e.g. 'toggleMute'
  accelerator: string   // an Electron accelerator, e.g. 'CommandOrControl+Shift+M'
}

// `build` and `latest` are short commits (§4 Desktop updates).
export type UpdateCheckResult =
  | { status: 'up-to-date'; build: string }
  | { status: 'offered'; build: string; latest: string }   // downloaded; the host showed its restart prompt
  | { status: 'not-available'; reason: string }            // a dev build, the web app, or no build published
  | { status: 'failed'; reason: string }

export interface ISecureStorage {
  readonly backend: 'os-keychain' | 'browser-indexeddb'
  /**
   * The store wrap key of this install and user: AES-GCM 256, non-extractable, usages encrypt/decrypt.
   * The host creates it on the first call. Rejects with SecureStorageUnavailable when no OS keystore exists.
   * The error is an `Error` whose `name` and `code` are a `SecureStorageErrorCode`.
   */
  getWrapKey(userId: string): Promise<CryptoKey>
  /** Deletes the wrap key. The store of that user becomes unreadable. */
  clear(userId: string): Promise<void>
}

// The values are CryptoErrorCode values of @hachiman/crypto, so the UI handles them like crypto errors.
export type SecureStorageErrorCode = 'SecureStorageUnavailable' | 'StoreCorrupt' | 'Malformed'
export function secureStorageErrorCode(e: unknown): SecureStorageErrorCode | null

// @hachiman/client/invite-link: the one invite link grammar. The hosts import it as @hachiman/hachiman/invite-link
// (a re-export). The root of @hachiman/hachiman exports parseInviteLink and parseInviteCode too.
export interface InviteLink {
  code: string
  key: string | null   // the invite seed of an invite with history (§12.11.4): 43 canonical base64url characters
}
export function parseInviteLink(input: string): InviteLink | null
export function parseInviteCode(input: string): string | null
export function parseInviteKeyFragment(fragment: string): { key: string | null } | null  // fragment without '#'; '' → key null
export function inviteKeyFragment(key: string): string  // '#k=' + key
```

Global shortcuts (the user's keybinds that work while the app is in the background):
- The shared UI sends the mute and deafen keybinds (`lib/keybinds.ts`) when they change, when the user turns the setting off (`[]`), while the Keybinds page records a key (`[]`), and on sign-out (`[]`).
- Electron: the preload script invokes `hachiman:set-global-shortcuts`. The main process answers only the top frame of the app page. It checks the payload (`main/global-shortcuts.ts`): at most 8 entries, an action of letters and digits, and an accelerator from a short key list that holds `CommandOrControl`, `Control` or `Alt` (an F-key needs none), so a page script cannot take a typing key from other apps. It replaces every registration with `globalShortcut`, and returns the actions that the OS refused. A fired shortcut goes to the main window on `hachiman:global-shortcut` with its action. The main process lets all keys go when the main window closes and on `will-quit`.
- `globalShortcut` has no key-up event. Push to talk therefore works only in the focused window (keydown and keyup in the renderer).

`secureStorage` (§12.17):
- Electron: the main process keeps 32 random bytes per user, encrypted with `safeStorage`, in `userData/keys/<userId>.bin`. On Linux it refuses the `basic_text` and `unknown` backends (`safeStorage.getSelectedStorageBackend()`), and `getWrapKey` rejects with `SecureStorageUnavailable`. The preload script gives the bytes to the renderer over IPC on the channels `hachiman:secure-storage-get` and `hachiman:secure-storage-clear`. The main process answers only the top frame of the app page (else `Malformed`). The renderer imports the bytes as a non-extractable `CryptoKey` and overwrites them.
- Errors: a rejection is an `Error` whose `name` and `code` are `SecureStorageUnavailable` (no OS keystore, or no IndexedDB), `StoreCorrupt` (the stored key does not decrypt or decode) or `Malformed` (a bad user id or caller). `secureStorageErrorCode(e)` reads the code.
- Residual risk (Electron): the main process zeroes the buffers that it holds, but it cannot zero every copy of the wrap key bytes (`safeStorage` results, IPC serialization, V8 copies).
- Browser: the host makes a non-extractable `CryptoKey` with `crypto.subtle.generateKey` and stores the key object in its own IndexedDB database (`hachiman-wrap`). The raw bytes never exist in JavaScript.
- The shared UI gives the key to the crypto Worker in `CryptoApi.init`. A `CryptoKey` is structured-cloneable.

The shared UI must not examine `window`, `navigator.userAgent`, or `window.location` to identify the host. It reads the host facts from this interface.

Each host declares its title bar. The Electron main process hides the native title bar on macOS only. The preload script gives this fact to the renderer as `window.hachiman.insetTitleBar`. The browser host sets `insetTitleBar` to `false`.

`beginOAuth` is the only way to start sign-in. The UI gives `oauthRedirectUri` to `takusenService.beginSignIn`. The pending PKCE flow keeps the URI, and `completeSignIn` sends the same URI in the token exchange. The two hosts use different redirect URIs:

- Browser: `${location.origin}/oauth/callback`. The host replaces the current page, so the callback comes back to the same app instance.
- Electron: `${issuerOrigin}/oauth/electron-bridge`. A system browser cannot show an `app.hachiman://` URL. Thus the Takusen bridge page receives the code and opens `app.hachiman://oauth-callback?…`. The main process then sends that URL to the renderer.

`VITE_HACHIMAN_OIDC_REDIRECT` replaces the default URI on either host.

When the user starts sign-in from an invite dialog, the pending PKCE flow also keeps the invite code. After the callback, the UI opens the invite dialog again. It does this also when sign-in fails. The browser host needs this step: the redirect loads the page again, and the host removed `/invite/<code>` from the URL at start-up. When the callback fails, the UI shows the cause and tells the user to sign in again. The sign-in screen and the invite dialog show this message.

The key of an invite with history does not go into the pending flow, because the Takusen store keeps the flow in `localStorage`. In the browser host, the UI keeps the key in `sessionStorage` (`hachiman-invite-key:<code>`, this tab only) during the redirect, and moves it back into memory at the callback. At start-up, after the callback of the load URL, the UI deletes every other `hachiman-invite-key:` entry. Thus a sign-in that did not finish (the user left the sign-in page, for example) leaves no key. The Electron renderer keeps the key in memory.

Invite links:
- The forms are `takusen://invite/<code>`, `https://<Takusen issuer origin>/invite/<code>`, the web client path `/invite/<code>`, and a bare code. The link of an invite with history ends in `#k=<key>` (§12.11.4). `parseInviteLink` reads all of them.
- **Fail closed.** A link with a fragment other than `k=` and 43 base64url characters gives null, and the host drops the link. The last character must be canonical (one of `AEIMQUYcgkosw048`): 32 bytes use only 4 bits of it, and the crypto Worker refuses other bits. Thus a damaged link cannot join without the history by accident.
- Browser host: it reads `/invite/<code>[#k=<key>]` at start-up (`src/platforms/browser/launch-url.ts`). Then it replaces the URL with `/`, also when the link does not parse. This also removes the key from the address bar and the history entry.
- Electron: the main process checks the deep link (`apps/hachiman-electron/src/main/deep-link-route.ts`). It rebuilds the link from the URL parts, checks it with `parseInviteLink`, and sends it on the IPC channel `hachiman:invite-link`. The renderer parses the link again.
- The Takusen page `/invite/<code>` links to `${HACHIMAN_WEB_URL}/invite/<code>` and to `takusen://invite/<code>`. A browser does not send the fragment to the server. Thus a script on the page adds the fragment to both links. It forwards only a well-formed `#k=` (`src/lib/invite-fragment.ts`, with `parseInviteKeyFragment`), and it removes any fragment from the address bar with `history.replaceState`. **Residual risk:** Takusen serves this script, so a hostile Takusen can read the key in either host (§12.17 "Browser host").
- The shared UI keeps the key only in memory (`InviteService`) and in component state, never in a store (§12.17). The join window says "This invite includes history" when the preview has `hasHistory` and the link has a key. When the link has no key, it tells the user to open the full link. A pasted link with a key also opens the join window. When the join window closes without a join, also when another window takes its place, the UI forgets the key.
- The join of an invite with history uses the invite, but the redemption needs the crypto Worker of this window. When the Worker cannot start (`LockHeld`: Hachiman runs in another tab, or another start error, or a fatal state), the join window shows a warning, and the user must select "Join without the history" before the join.
- After `POST /invites/:code`, the UI calls `redeemInvite` when the crypto Worker is ready and the client cache has this user in the members of the guild. It tries at once, when the status becomes ready, and on `READY` and `GUILD_CREATE`. `GroupPending` makes it wait for the next of these. A `Transport` error other than 404 `UnknownInvite` (a network error, a 5xx, a 429) makes it try again after 5 s, then after a wait that doubles up to 5 min, while the next try comes before `INVITE_BUNDLE_FETCH_WINDOW_MS` after the join. Another failure, or the end of that window, loses only the history: the user stays a member, and a security notice tells the user. The notice holds the guild id only.
- The invite window of an administrator has the switch "Include history" (off by default), with the scope: the text and pages channels that @everyone can view, from the REST roles, with each `joined` channel marked. Switching it on sets one use. The window then calls `prepareHistoryInvite`, `POST /guilds/:id/invites` with the record, and `sendInviteBundles`. `sendInviteBundles` fails when a bundle post fails. When it fails, the window revokes the invite. When it sends no bundle (`groups` 0: this device holds no group of the scope, for example because the channels have no messages yet), the window keeps the invite and shows a warning: the link then gives only the history that other members send at their commits (§12.11.4). The link shows once: the invite list cannot copy the link of an invite with history (`hasHistory`).

Screen share source selection:
- Browser: `getScreenSources` gives null. `getDisplayMedia` then shows the picker of the browser. The UI asks for audio too, and the browser picker offers it where it can (a tab, or the system audio on some systems).
- Electron: the UI shows its own picker with the screens and windows from `getScreenSources`. When the user picks one, the UI calls `selectScreenSource`, then `getDisplayMedia`.
- Share audio: where `screenShareAudio` is true, the picker shows "Share audio" (default on, kept in the prefs). The main process then answers with `audio: 'loopback'` (system audio). The installed Electron supports loopback on Windows only, so on macOS and Linux the share is video only. The UI asks for the audio with `restrictOwnAudio`, so the call that the page plays is not in the capture where Chromium supports it.
- The main process captures only the selected source. It accepts only an id from the last list, and it uses each selection one time. A new list clears a selection that no capture used.
- Without a selection, or when the request does not come from the top frame of the app page, `getDisplayMedia` fails.
- Thumbnails are JPEG `data:` URLs. The CSP allows `data:` images.
- Accepted risk: script in the app page (for example, after an XSS attack) can list and select a source itself. It can then capture a window, and the user sees no picker.

The guild region pickers use `probeRegions`. They send the measured RTTs to `POST /api/v1/regions/recommend` and show the result as "Automatic (recommended: <region>)". The browser host measures nothing, so the picker shows only "Automatic".

Hosts render `<PlatformProvider value={platformService}><ThemeProvider><App /></ThemeProvider></PlatformProvider>`. `ThemeProvider` applies the theme from `prefsStore` to `<html>`. The config comes from
the existing Vite env read in `TakusenService.ts` (`VITE_TAKUSEN_OIDC_ISSUER`, `VITE_TAKUSEN_OIDC_CLIENT_ID`,
`VITE_TAKUSEN_API_BASE` default `<issuer-origin>/api`) plus the new
`VITE_HACHIMAN_GATEWAY_URL` (default `ws://localhost:8080/gateway`). REST base = `${apiBase}/v1`.

### Packaged renderer origin

The packaged Electron app does not load the renderer from `file://`. A `file://` page sends `Origin: null`, and Takusen rejects that origin. The main process serves the built renderer from the privileged scheme `hachiman` (`apps/hachiman-electron/src/main/renderer-protocol.ts`). The window loads `hachiman://app/index.html`, so the page origin is `hachiman://app`. The dev build loads the electron-vite dev server URL.

- The handler serves only files in the built renderer directory. Other paths get a 404 response. The renderer has no client-side routes, thus there is no `index.html` fallback.
- `hachiman` is not an OS deep-link scheme. The deep-link schemes stay `takusen://` and `app.hachiman://`.
- The main process blocks navigation to all URLs outside the app origin. `window.open` gives `http(s)` URLs to the system browser and opens no window.
- The main process sends the Content-Security-Policy (CSP) as a response header. The rules are in `apps/hachiman-electron/src/main/csp-policy.ts` (`cspFromEndpoints`). `csp.ts` resolves the endpoints and applies the header. The Electron `index.html` has no CSP meta tag. In the packaged app, the `hachiman` handler sends the header. In dev, the header goes on the responses from the dev server.
- The browser host imports the same rules (`apps/hachiman-browser/csp.ts`). It sends the policy as a header from the Vite dev server and from `vite preview`. The built `index.html` has the policy as a meta tag, without the header-only directives. A production server must send the policy as a response header, because a meta tag covers neither Worker scripts nor `frame-ancestors`.
- `worker-src` is `'self'` (plus the dev server origin in dev), for the crypto Worker and the transform Worker (§12.17). `img-src` and `media-src` also allow `blob:`: the local preview of a picked file, and the object URL of a decrypted attachment.
- `connect-src` gets the origins of `VITE_TAKUSEN_OIDC_ISSUER`, `VITE_TAKUSEN_API_BASE` and `VITE_HACHIMAN_GATEWAY_URL`, plus `wss:` for the media nodes. The main process and the renderer use the same resolver (`@hachiman/hachiman/takusen-env`) and the same defaults.
- `connect-src` also allows `ws:` when one of these endpoints, or the dev server, uses `ws:` or `http:`. Thus a local stack keeps voice in `electron-vite preview` too.
- `script-src` is `'self' 'wasm-unsafe-eval'`. `'wasm-unsafe-eval'` lets the RNNoise mic AudioWorklet (a built module file of the app) compile its bundled wasm. It allows no JS eval. With the dev server only, `script-src` also allows `'unsafe-inline'`, because the React Fast Refresh preamble is an inline script.
- The policy also sets `object-src 'none'`, `form-action 'none'` and `frame-ancestors 'none'`.

### Takusen allowed origins

`apps/takusen/src/lib/allowed-origins.ts` holds one CORS allowlist. The `/api/*` middleware and the per-client CORS of the OIDC provider both use it.

- `TAKUSEN_ALLOWED_ORIGINS` (comma-separated) replaces the default list.
- The default list has the Vite dev origins and `hachiman://app`.
- Takusen never allows the origin `null`.
- The middleware is the only source of CORS headers under `/api/*`, `/api/oidc` included. It answers all preflights. The OIDC route removes the CORS headers and the `Vary` header that the OIDC provider sets.
- On the token, userinfo and revocation endpoints, the OIDC provider also examines the origin with the same allowlist. It rejects a different origin with a 400 response.

Deep link scheme: `takusen://invite/<code>[#k=<base64url invite seed>]` (replaces `takusen://join#<signed payload>`). OAuth callback scheme unchanged (`app.hachiman://oauth-callback`).

## 12. End-to-end encryption

This section is normative for E2EE. `docs/e2ee-plan.md` gives the reasons. `pkgs/hachiman-crypto/src/constants.ts` holds the constants, and `src/api.ts` holds the typed API. If this section and those files disagree, fix one of them in the same change.

### 12.1 Scope and rollout

- Every channel type uses E2EE: DMs, group DMs, guild text channels, voice, video and screen share. There is no plaintext mode and no mixed mode.
- Takusen, the gateway and the media nodes relay ciphertext. Only member devices hold keys.
- The gateway accepts only clients that send the capability `e2ee/1` and a version at or above the minimum (§12.13).
- There is no migration from plaintext data.
- Avatars, guild icons and banners stay plaintext. They are public profile data.
- Metadata stays visible to the server: membership, sender, time, sizes, typing, presence, voice state and speaking state.
- Plaintext like a channel topic: guild event titles, times, voice channel and RSVPs (§4 Pins, guild events and blocks), the pinned message ids of a channel (not their content), and user blocks.
- Each device is a separate MLS member. One device has one MLS signature key for all of its groups.
- The library is ts-mls 1.6.4 (pure TypeScript, MIT). No one has audited it. The Phase 4 audit covers it (`docs/e2ee-plan.md`, Implementation notes).

### 12.2 Encodings

**Binary objects.** Every Hachiman binary object uses the RFC 9420 §2.1 presentation language. `pkgs/hachiman-crypto/src/codec.ts` is the one implementation:
- Integers (`uint8`, `uint16`, `uint32`, `uint64`) are big-endian and fixed width.
- `opaque x[N]` is N bytes. `opaque x<V>` has the RFC 9420 §2.1.2 variable-length prefix. The prefix must be minimal.
- `T x<V>` is a vector: a `<V>` length prefix, then the items.
- `optional<T>` is a `uint8` flag (0 or 1), then T when the flag is 1. Thus `optional<opaque> x[16]` is a flag byte, then 16 fixed bytes when the flag is 1.
- A struct is its fields in order. A decoder rejects trailing bytes.
- UUIDs are 16 bytes in binary objects. Their text form is canonical lowercase.
- Each top-level object starts with `uint8 version = 1`, except `Envelope` (magic `0x4801`) and the attachment blob (magic `HAT1`).

The format is deterministic. Thus a hash or a signature over an encoding is stable.

**JSON wires.** Bytes on every JSON wire (REST, gateway, voice WS, Redis) are base64url (RFC 4648 §5) without padding. A decoder rejects padding, other alphabets and non-zero trailing bits. The empty string is the encoding of zero bytes. Each field has its own length rule, and most fields must not be empty. The media node decoder (`decodeB64url` in `cmd/hachiman-media`) rejects the empty string, and the TypeScript decoders accept it. No voice WS field (§8) can be empty, so this difference has no effect (`docs/e2ee-audit-scope.md`, FZ-6). Epochs and sequence numbers are JSON numbers. They stay below 2^53.

**Signatures.** All Hachiman signatures are Ed25519 with a label, in the style of the MLS `SignWithLabel`:

```
struct {
  opaque label<V>;      // "Hachiman 1.0 " + Label
  opaque content<V>;
} SignContent;

SignWithLabel(key, Label, Content) = Ed25519.sign(key, encode(SignContent))
```

The labels are `MasterKey`, `DeviceSigningKey`, `DeviceCertificate`, `DeviceRevocation`, `Envelope`, `HistoryBundle`, `DeviceMessage`, `AdminAction`, `TreeHead`, `DocEnvelope` (§12.20), `InviteRecord`, `InviteBundle` and `InviteAuth` (§12.11.4).

### 12.3 Crypto constants

| Item | Value |
|---|---|
| Default MLS cipher suite | 1, `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` |
| Phase 4 MLS cipher suite | 83, `MLS_256_XWING_AES256GCM_SHA512_Ed25519` (§12.15) |
| MLS framing for handshakes | PublicMessage. The DS reads commits and proposals. |
| MLS application messages | Not used. Messages use the envelope (§12.8). |
| Message exporter | `S_e = MLS-Exporter("hachiman message v1", group_id, 32)` |
| SFrame exporter | `MLS-Exporter("SFrame 1.0 Base Key", "", 32)` (RFC 9605 §5.2) |
| History exporter | `K_hist = MLS-Exporter("hachiman history v1", group_id ‖ uint64(epoch), 32)` |
| Hachiman KDF | HKDF-SHA256 for every Hachiman derivation, for every MLS suite |
| Envelope AEAD | AES-256-GCM, 16-byte tag |
| Attachment AEAD | AES-256-GCM STREAM, 64 KiB segments |
| SFrame suite | `AES_128_GCM_SHA256_128` (0x0004), full 16-byte tag |
| Device message and invite bundle HPKE | RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001, AES-128-GCM 0x0001. Invite bundles use the info `hachiman invite bundle v1` (§12.11.4) |
| Leaf extension `DEVICE_CHAIN` | 0xF1A0 (private range) |
| Group context extension `GROUP_DESCRIPTOR` | 0xF1A1 (private range) |

HKDF info strings: `hachiman msg key v1`, `hachiman doc key v1`, `hachiman franking v1`, `hachiman backup key v1`, `hachiman backup id v1`, `hachiman link sas v1`, `hachiman link key v1`, `hachiman sealed v1`, `hachiman invite hpke v1`, `hachiman invite sign v1`.

### 12.4 Identity

Each user has three key levels:

1. **Master key** (Ed25519). The first device makes it. It lives only on a primary device and in the identity backup (§12.11). No key comes from the Takusen password.
2. **Device-signing key** (DSK, Ed25519). The master key certifies it. Every device of the user holds it.
3. **Device keys.** Each device has an MLS signature key (Ed25519) and an HPKE key (X25519). The DSK certifies both in the device certificate.

```
struct {
  uint8 version = 1;
  opaque user_id[16];
  opaque public_key[32];
  uint32 generation;               // 1, 2, ... A new key after a reset gets the next value
  uint64 created_at_ms;
} MasterKeyTBS;

struct {
  MasterKeyTBS tbs;
  optional<opaque> prev_signature<V>;   // SignWithLabel(previous master, "MasterKey", encode(tbs)); null on the first key and after a reset
  opaque signature<V>;                  // SignWithLabel(this master, "MasterKey", encode(tbs))
} MasterKeyRecord;

struct {
  uint8 version = 1;
  opaque user_id[16];
  opaque public_key[32];
  uint32 generation;
  uint32 master_generation;
  uint64 issued_at_ms;
} DeviceSigningKeyTBS;

struct {
  DeviceSigningKeyTBS tbs;
  opaque signature<V>;             // SignWithLabel(master, "DeviceSigningKey", encode(tbs))
} DeviceSigningKeyCert;

struct {
  uint8 version = 1;
  opaque user_id[16];
  opaque device_id[16];
  opaque mls_signature_key<V>;     // 32 bytes (Ed25519)
  opaque hpke_key[32];             // X25519
  uint32 dsk_generation;
  uint64 issued_at_ms;
  opaque display_name<V>;          // UTF-8, 1 to 64 bytes
} DeviceCertificateTBS;

struct {
  DeviceCertificateTBS tbs;
  opaque signature<V>;             // SignWithLabel(DSK, "DeviceCertificate", encode(tbs))
} DeviceCertificate;

struct {
  MasterKeyRecord master;
  DeviceSigningKeyCert dsk;
  DeviceCertificate device;
} DeviceChain;

struct {
  uint8 version = 1;
  opaque user_id[16];
  opaque device_id[16];
  uint64 revoked_at_ms;
  uint8 reason;                    // 1 user, 2 lost, 3 password_reset, 4 compromised, 5 signed_out
  uint32 master_generation;        // reason 5: the master generation that the device chain uses
} DeviceRevocationTBS;

struct {
  DeviceRevocationTBS tbs;
  opaque signature<V>;             // reasons 1, 2, 4: SignWithLabel(master, "DeviceRevocation", encode(tbs))
                                   // reason 5: SignWithLabel(the device's own MLS signature key, "DeviceRevocation", encode(tbs))
} DeviceRevocation;
```

Reason 3 (`password_reset`) is a server revocation only. No device signs it. A `signed_out` revocation is signed by the device that signs out. Thus a stolen bearer token cannot sign out other devices.

**MLS credential.** The credential of a leaf is a BasicCredential. Its identity is the UTF-8 text `{userId}:{deviceId}` (two canonical lowercase UUIDs, 73 bytes). The leaf node carries the extension `DEVICE_CHAIN` (0xF1A0) with `encode(DeviceChain)`. The leaf capabilities list the extensions 0xF1A0 and 0xF1A1 and the credential type `basic`. ts-mls cannot decode custom credential types (`smoke.spec.ts`), so Hachiman does not use them.

**Chain check.** A client accepts a leaf only when all of these are true (`IdentityModule.verifyChain`):

1. The credential identity parses as `{userId}:{deviceId}`. The three structs in the chain have the same `user_id`, and the device certificate has the same `device_id`.
2. `master.signature` is valid under `master.public_key`.
3. The master key is the pinned key for the user (TOFU, §12.5). On first sight, the client pins it. A different key is a key change (§12.5).
4. `dsk.signature` is valid under the master key, and `dsk.master_generation` is the master generation.
5. `device.signature` is valid under `dsk.public_key`, and `device.dsk_generation` is `dsk.generation`.
6. `device.mls_signature_key` is the leaf signature key.
7. The device is not revoked (a `DeviceRevocation` or a server revocation, §12.12). Exception: a joiner or a resyncing device accepts a revoked leaf that is already in the tree when a Remove for its leaf index is queued (a DS Remove proposal, §12.7.4). It commits that Remove before it sends (§12.7.6).
8. A leaf that enters a group now (Add or external commit, a resync included) has the current DSK generation. A leaf that is already in the group can keep a superseded DSK generation for 30 days after the newer DSK cert was issued (`DSK_ROTATION_GRACE_MS`).
9. The current DSK generation that the DS reports is not below the highest generation that the client saw for the user (store table `contacts`, `dskGeneration`). A lower value is a downgrade: the check fails and the client raises `keyChange`.

The chain check is synchronous, because ts-mls calls its commit callback synchronously. Clients also run the check before `processMessage` on every Add key package, every update path leaf and every external commit leaf.

**Revocation.** Only a device with the master key can sign a `DeviceRevocation`. After a revocation:
1. The primary device makes a new DSK (generation + 1) and publishes its cert.
2. It certifies each remaining device again under the new DSK and publishes the certificates (`PUT /devices/:id/certificate`).
3. It sends the new DSK private key to each remaining device as a `dsk_transfer` device message (§12.5).
4. Each remaining device resyncs its leaf in each group by external commit (`joinExternal`, `resync = true`), with a new key package that carries the new chain. It does this within `DSK_ROTATION_GRACE_MS`. ts-mls copies the old leaf extensions into an update path (`createUpdatePath`), so a normal commit cannot change the chain (`smoke.spec.ts`).
5. Takusen queues Removes for the revoked device in every group (§12.7).

**Known limitation (ts-mls 1.6.4).** The only member of a group cannot resync its leaf: `removeLeafNode` condenses the tree to nothing (`mls.spec.ts`). Thus, after a DSK rotation, a group with one member keeps the leaf with the old chain. After `DSK_ROTATION_GRACE_MS`, a joiner of that group fails the chain check of the old leaf (rule 8, `dsk_superseded`).

A device accepts a `dsk_transfer` only when its DSK generation is above the stored generation and the DSK cert verifies under the pinned own master key. Thus a replayed old `dsk_transfer` has no effect.

**Password reset.** A reset revokes all sessions and all devices of the user on the server (reason `password_reset`). It deletes their key packages. It sets `superseded_at` on the current master key, so the user has no current master key. The user then restores the master key from the recovery key (the same record), or makes a new master key (`generation + 1`, `prev_signature` null). Contacts see "security key changed" for a new master key. Old history stays unreadable without the recovery key. A user who has lost the recovery key and all devices does a password reset first. An admin can do the same without the password: `POST /api/admin/users/:id/reset-keys` (§4) makes the DS change of a reset and signs the user out. The password stays. A bearer token alone cannot replace the master key.

**A removed device.** A revocation while the app runs shows "This device was signed out", and the app signs out. A device that the DS revoked while the app was closed learns it at the next start: the Worker reads its own row with `GET /users/:id/keys`, and waits at most 5 s. Such a device starts locked (`revoked`), set up or not. The UI wipes a locked start with `signOutDevice` and starts again at `needs_identity`, where the user links the device (as a new device) or restores it. A failed wipe fails the start. Thus a removed device never loops between sign-in and "signed out". A half-linked device starts over the same way. The existing device certified it on the DS (`active`), but the transfer never came, so its store has no certificate. Its link keys were in memory only, and the DS starts no link for an active device. At start it is locked. The wipe sends a `signed_out` revocation, signed with its MLS key, which verifies under the certificate on the DS. Thus no active device is left that no store holds.

### 12.5 Verification, linking and device messages

**TOFU.** A client pins the first master key that it sees for a user. A change shows a blocking warning for a verified contact and a quiet notice for an unverified contact. Users verify accounts, not devices. The client also stores the highest DSK generation that it saw for each user (§12.4 rule 9), and never accepts a lower current generation.

**Device names.** The UI shows the certificate `display_name` for the devices of other users. It gets them from `CryptoApi.listContactDevices(userId)`, which returns only the devices whose chain the Worker verified (pinned master key, DSK, device certificate) and leaves out revoked devices. It shows the REST `Device.name` only in the user's own device list. A rename (`PATCH /devices/:id`) changes only the REST name. It does not certify the device again.

**Safety number.** For one user:

```
I_0 = uint16(0) ‖ master_public_key ‖ user_id(16 bytes)
I_k = SHA-512(I_(k-1) ‖ master_public_key)      for k = 1 … 5200
F   = first 30 bytes of I_5200
digits(F) = for j in 0..5: uint40(F[5j .. 5j+5]) mod 100000, as 5 digits with leading zeros
```

The safety number of a pair is `digits(F_a) ‖ digits(F_b)`, where `a` has the lower `user_id` bytes. It has 60 digits in 12 groups of 5. Both users see the same number.

**Verify QR code.** `hachiman-verify:1:` + base64url of:

```
struct {
  uint8 version = 1;
  opaque user_id[16];          // the user who shows the code
  opaque master_public_key[32];
  opaque peer_user_id[16];
  opaque peer_master_public_key[32];
} VerifyQr;
```

The scanner checks that both keys match its own pins. A match sets the contact to `verified`.

**Trust state.** `CryptoApi.getTrust(userId)`, `setVerified` and `acknowledgeKeyChange` return `TrustInfo { userId, state, masterKeyGeneration, changedAt, verifiedAt }`. `state` is `verified`, `tofu`, `changed` or `unknown`. `changedAt` is the ISO time of a key change that the user did not acknowledge. `verifiedAt` is the ISO time when this device verified the contact:
- `setVerified(userId, true)` and a matching `verifyQr` set it to the current time. A new verification sets a new time.
- `setVerified(userId, false)`, an acknowledged key change and a new master key that is not a signed rotation (state `changed`) set it to null.
- A signed rotation of the master key (`prev_signature`, §12.4) keeps the state and `verifiedAt`.
- The Worker keeps it in the encrypted store with the contact (`contacts.verifiedAtMs`). A contact row of an older version has no such field: `verifiedAt` is null and the state stays `verified`. The UI then shows "Verified" without a date.
- It is null when the state is not `verified`, and for the own user. The time is local to the device and is not sent to the server or to other devices.

**Epoch code.** The 30-digit code of a group is `digits(first 30 bytes of epoch_authenticator)`, in 6 groups of 5. All members of one epoch see the same code. The call UI shows it.

**Device linking.** A new device gets the DSK from an existing device of the same user. Both devices are signed in to the same account. They talk through a link session on Takusen (`/devices/link-sessions`, §12.12). Link sessions expire after 10 minutes.

```
struct {
  uint8 version = 1;
  opaque user_id[16];
  opaque device_id[16];            // the new device (status pending)
  uint8 mode;                      // 1 qr, 2 sas
  opaque commitment<V>;            // sas: SHA-256(e_new_public). qr: empty
  opaque mls_signature_key<V>;
  opaque hpke_key[32];
  opaque device_name<V>;           // UTF-8, 1 to 64 bytes
  uint8 platform;                  // 1 electron, 2 browser
} LinkOffer;

struct {
  LinkOffer offer;
  opaque session_id[16];
  opaque e_new_public[32];         // X25519
  opaque link_secret[16];
} LinkQr;                          // QR text: "hachiman-link:1:" + base64url(encode(LinkQr))

struct {
  uint8 type;                      // 1 accept, 2 reveal, 3 transfer, 4 done, 5 abort
  select (type) {
    case 1: opaque existing_device_id[16]; opaque e_existing_public[32];
    case 2: opaque e_new_public[32];
    case 3: opaque sealed<V>;      // nonce(12) ‖ AES-256-GCM(K_link, nonce, aad = th, encode(LinkTransfer))
    case 4: opaque confirmation[32];   // HMAC-SHA256(K_link, "done" ‖ th)
    case 5: uint8 reason;          // 1 sas_mismatch, 2 cancelled, 3 error
  };
} LinkMessage;

struct {
  MasterKeyRecord master;
  DeviceSigningKeyCert dsk;
  opaque dsk_private_key[32];
  DeviceCertificate device;        // the new device, certified by the existing device
  HistoryBatch history<V>;         // optional epoch secrets, one HistoryBatch (§12.11.3) per group:
                                   // a HistoryKey alone has no group id
} LinkTransfer;
```

Key derivation (both sides):

```
shared = X25519(own ephemeral private, peer ephemeral public)
th     = SHA-256(encode(offer) ‖ e_existing_public ‖ e_new_public)
ikm    = shared ‖ link_secret          (QR mode)
ikm    = shared                        (SAS mode)
sas    = HKDF-SHA256(salt = th, ikm, info = "hachiman link sas v1", L = 6)
K_link = HKDF-SHA256(salt = th, ikm, info = "hachiman link key v1", L = 32)
```

The SAS is 7 emoji. Emoji i is the index `sas` bits `6i … 6i+5` (the first 42 bits, most significant bit first) in the 64-emoji table of the Matrix specification (client-server API, "SAS method: emoji", index 0 is Dog, index 63 is Pin).

QR mode:
1. The new device registers (`POST /devices`, status `pending`). It makes its ephemeral key and the link secret.
2. It creates the link session with the offer and shows the QR code.
3. The existing device scans the code. It checks that `offer.user_id` is its own user. It posts `accept`.
4. The existing device certifies the new device under the current DSK. It calls `PUT /devices/:newId/certificate` and posts `transfer`.
5. The new device opens the transfer. It checks that the certificate holds its own keys. It posts `done`.

SAS mode:
1. The new device creates the session with an offer that carries the commitment. It does not show a QR code.
2. The existing device lists link sessions, and the user selects one. The existing device posts `accept`.
3. The new device posts `reveal`. The existing device checks the commitment.
4. Both devices show the 7 emoji. The user compares them and confirms on the existing device.
5. The existing device certifies the new device and posts `transfer`, as in QR mode. A mismatch sends `abort` with reason 1.

**Transfer size.** The DS takes a link message of at most 256 KiB (`LINK_MESSAGE_MAX_BYTES`). The transfer carries the history keys that fit: the newest keys of each group first (at most 4096 per group). The existing device fixes this cut before the certificate PUT, so the transfer post cannot fail on size after the new device is `active`. It then sends the other keys to the new device as `history_keys` device messages (type `response`, one per group, at most `HISTORY_BUNDLE_MAX_EPOCHS` keys each) through the inbox. It waits and tries again after a `RateLimited`. The new device opens them from its inbox once it is ready.

The existing device sends the transfer only after the user confirms. A server that changes a key cannot make both SAS values equal, because the new device committed to its key first.

**Device messages.** Devices of one user send secrets to each other through the device inbox (§12.7.6):

```
struct {
  uint8 version = 1;
  uint8 kind;                      // 2 dsk_transfer, 3 history_keys
  opaque sender_device_id[16];
  opaque enc[32];                  // HPKE encapsulated key
  opaque ciphertext<V>;            // HPKE seal to the recipient DeviceCertificate.hpke_key
} SealedDeviceMessage;
// info = "hachiman sealed v1" ‖ uint8(kind) ‖ recipient_device_id(16)
// aad  = sender_device_id(16)

struct {
  opaque payload<V>;
  opaque signature<V>;             // SignWithLabel(sender MLS signature key, "DeviceMessage", enc ‖ payload)
} DeviceMessagePlaintext;
```

The recipient checks that the sender device belongs to the same user and has a valid chain. Payloads:
- `dsk_transfer`: `struct { DeviceSigningKeyCert dsk; opaque dsk_private_key[32]; DeviceCertificate device; }`.
- `history_keys`: `struct { uint8 type; /* 1 request, 2 response */ opaque group_id<V>; uint64 epoch_from; uint64 epoch_to; HistoryKey keys<V>; }`.

### 12.6 Groups

**Kinds.**

| Kind | Byte | Scope (16 bytes) | Members | Who may Add |
|---|---|---|---|---|
| `public_set` | 1 | guild id | all guild members (readers of every public channel) | the DS proposes, a member commits |
| `channel` | 2 | channel id | `channelReaders(channelId)` | a member commits by value |
| `dm` | 3 | channel id (dm and group_dm) | the participants | the creator first, then a member for new devices of participants |
| `voice` | 4 | room session id (16 random bytes from the media node) | connected participants | the committer of the room (§12.10) |

**Public channel.** A guild text or pages channel is public when the guild `@everyone` role permissions, with the channel `@everyone` overwrite applied, include VIEW_CHANNEL, and no role or member overwrite on the channel denies VIEW_CHANNEL. All public channels of a guild share the `public_set` group. Each other guild text or pages channel has its own `channel` group. Voice channels have no text group. Takusen tests the two types with one helper, `hasTextGroup(type)`.

**Thread.** A thread has no group. It uses the current group of its parent text channel: the `public_set` group or the `channel` group. The DS resolves the thread to its parent at read time (`MlsRepo.getChannel` gives the `mlsGroupId` of the parent, `getChannelOverwrites` the overwrites of the parent), so a group change of the parent applies to its threads at once. `channelReaders(threadId)` is `channelReaders(parentId)`. A message envelope of a thread names the thread in `channelId` and the group of the parent in `groupId` (§12.8.4). `GET /channels/:threadId/mls-group` gives the group of the parent. The `Channel` of a thread has `mlsGroupId` and `historyVisibility` null (§1): a client resolves the thread to its parent, so a group change of the parent needs no `CHANNEL_UPDATE` of its threads.

`channelReaders(channelId)` is the set of guild members whose `computeChannelPermissions` (§2) includes VIEW_CHANNEL. For a DM it is the set of participants. Takusen implements it once in `apps/takusen/src/lib/mls/readers.ts`. Clients compute the same set from their cache with `computeChannelPermissions`.

**Group id.**

```
struct {
  uint8 version = 1;
  uint8 kind;                      // the byte above
  opaque scope[16];
  uint32 generation;               // Takusen allocates 0, 1, 2 ... per (kind, scope)
} GroupId;                         // 22 bytes. JSON: base64url (30 characters)
```

A new generation replaces a group when a channel moves (below), when all members lose their state, or when the suite changes (§12.15).

**Group context extensions.** In this order:
1. `external_senders` with exactly one ExternalSender: the DS key (§12.7.1). Voice groups have no external sender. ts-mls encodes this extension as one ExternalSender without the RFC 9420 vector prefix, and indexes senders by extension position. The extension is first and has one sender, so index 0 is the same in both readings.
2. `required_capabilities`: extension types 0xF1A0 and 0xF1A1, no proposal types, credential type `basic`.
3. `GROUP_DESCRIPTOR` (0xF1A1):

```
struct {
  uint8 version = 1;
  uint8 kind;
  optional<opaque> guild_id[16];
  optional<opaque> channel_id[16];       // null for public_set and a guild voice call
  uint8 history_visibility;              // 1 joined, 2 shared
  opaque created_by_user_id[16];
} GroupDescriptor;
```

`guild_id` is the guild for `public_set` and `channel`, and null for `dm`. `channel_id` is the channel for `channel` and `dm`, and null for `public_set`. A `voice` descriptor has exactly one of them: `guild_id` for a call in a guild voice channel, `channel_id` (the DM or group DM channel) for a DM call (§6 "DM calls"). A voice group has `history_visibility = joined`.

The descriptor is authenticated by MLS. Clients read `history_visibility` from the descriptor, not from REST. A member changes it with a GroupContextExtensions (GCE) commit. Members accept that commit only from a user with MANAGE_CHANNELS on the channel (MANAGE_GUILD for `public_set`). In Phase 4, the change also needs a signed admin action (§12.16).

A GCE commit keeps `external_senders` and `required_capabilities` byte-identical and keeps the extension order. In the descriptor, only `history_visibility` may change. `version`, `kind`, `guild_id`, `channel_id` and `created_by_user_id` stay the same. Clients and the DS reject every other GCE.

**History visibility.** `joined` (no past history) or `shared` (new members get a history bundle, §12.11). Defaults: `shared` for `public_set`, `joined` for `channel` and `dm`. REST mirrors the value in `Channel.historyVisibility` and `Guild.publicHistoryVisibility`.

**Channel moves.**
- A public channel gets its own readers (an overwrite change): Takusen creates a `channel` group (status `pending`) and assigns the create (§12.7.7). New messages go to the new group when it is active. Old messages stay in the `public_set` group.
- A channel becomes public again: `channels.mls_group_id` points to the `public_set` group. The old `channel` group becomes `retired`. Members keep it for history.
- Until the new group is active, `POST /channels/:id/messages` gives 409 `GroupPending`.

### 12.7 Delivery service (Takusen)

Takusen is the delivery service (DS) for `public_set`, `channel` and `dm` groups. The media node relays voice groups (§12.10). The DS never makes a commit. It orders commits, holds proposals and GroupInfo, and checks membership.

#### 12.7.1 DS key

- Takusen signs external proposals with an Ed25519 key. `TAKUSEN_DS_SIGNING_KEY` is the path of a raw 32-byte seed (default `.dev/keys/takusen-ds.ed25519`).
- The Next process and the gRPC process both load the seed. When the file is missing, a process creates it with `O_EXCL` (mode 0600) and then reads the file again. Thus two processes that start together use one key. A deployment with more than one Takusen instance must share the seed file. The KT key (§12.14) uses the same rules.
- The external sender credential is BasicCredential `takusen:ds`.
- `GET /mls/ds` returns the encoded ExternalSender. Clients pin it per Takusen origin (TOFU). A group context with a different external sender fails the client policy.

#### 12.7.2 Key packages

- Each device keeps 100 one-time key packages per suite on the DS (`KEY_PACKAGE_TARGET`), plus one last-resort key package.
- A key package uses the device MLS signature key and carries `DEVICE_CHAIN`. Its lifetime is at most 90 days.
- Upload checks: the package decodes, the suite is enabled (`TAKUSEN_MLS_SUITES`), the identity is the caller's `{userId}:{deviceId}`, the leaf key is `mls_signature_key` of the device certificate, and the signature is valid. A device keeps at most 200 one-time packages per suite.
- Claim is an atomic pop: `DELETE … WHERE id = (SELECT id … WHERE device_id = $1 AND cipher_suite = $2 AND NOT last_resort ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING`. When none is left, the claim returns the last-resort package and does not delete it.
- When a device has fewer than 10 one-time packages for a suite, Takusen publishes `KEY_PACKAGES_LOW` to `device:{id}`.
- Takusen claims key packages itself for the Adds that it queues (§12.7.5). Clients never claim key packages of other devices.
- Takusen claims a key package in the suite of the group (`mls_groups.cipher_suite`). It never queues an Add for a device that has no key package in that suite (the join request gets `rejected`, reason `no_key_package`).
- **DSK rotation.** On `PUT /users/@me/device-signing-key`, Takusen deletes every key package of the user whose chain has a lower `dsk_generation` than the new DSK. It publishes `KEY_PACKAGES_LOW` (`remaining: 0`) to each device of the user. Each device uploads new key packages after it has the new chain (`dsk_transfer`, §12.4).

#### 12.7.3 Handshake upload and checks

All handshakes are PublicMessage. A client uploads a commit with `POST /mls/groups/:groupId/commits`. Takusen runs `DsModule.checkCommit` with the stored GroupInfo and tree of the current epoch (`previous`). It checks, in this order:

1. The device is active and the user reads the group (`channelReaders`, or a guild member for `public_set`).
2. `commit` decodes as an MLSMessage, wire format `mls_public_message`, content type `commit`. Its group id is the route group. Its epoch is the body `epoch` and the stored epoch. A different epoch gives 409 `EpochConflict` with the stored epoch.
3. The sender is `member` with a leaf in the DS roster, or `new_member_commit` (external commit). The credential of the sender leaf (or of the new leaf of an external commit) is the `{userId}:{deviceId}` of the request: the device of `X-Hachiman-Device`.
4. `groupInfo` decodes, has the group id and epoch + 1, and has the `external_pub` extension. `treeHashRoot(ratchetTree)` equals `groupContext.tree_hash`. The GroupInfo signature is valid under the signer leaf key. The signer is the committer.
5. **Roster transition.** `checkCommit` applies the proposals of the commit to the leaves of `previous`: Adds by value, proposals by reference, Removes, and the external init and resync Remove of an external commit. The result must equal the leaves of the uploaded tree (credential identity and signature key per leaf index). Else 400 `InvalidCommit`. Thus a tree cannot hide an Add.
6. **Proposal references.** Each proposal by reference is a DS proposal that Takusen published for this epoch (`mls_pending.proposal_ref` with `proposal_epoch` = epoch). Members cannot reference their own proposals (the policy rejects Update, PSK and ReInit proposals by reference). Else 400 `InvalidCommit`.
7. **New and changed leaves.** Every leaf that is new or changed in the uploaded tree (not byte-equal to the leaf of `previous` at the same index) has a valid credential identity and a valid chain (signatures only). Its device is registered, belongs to the user and is not revoked.
8. **Unchanged leaves** are not checked again, with one exception. A leaf whose device is revoked or deleted, whose user is deleted, or whose user is not a reader, is allowed only while a Remove for its leaf index is queued (`mls_pending`). Else 403 `IllegalMembership`. The non-reader case is necessary for the external-commit fallback of §12.7.5 step 7: an external commit cannot carry the Remove. A new or changed leaf of a non-reader always gives 403 `IllegalMembership`.
9. The next roster passes the policy (below). Else 403 `IllegalMembership` (a user who must not be a member) or 403 `IllegalRemove` / `IllegalAdd`. An external commit of a user without a leaf into a `channel` group passes only with a valid `InviteAuth` in its `authenticated_data` (§12.11.4 "Join authorization"). Else 403 `IllegalAdd`.
10. Compare-and-set: `UPDATE mls_groups SET epoch = E + 1, … WHERE group_id = $1 AND epoch = E`. Zero rows gives 409 `EpochConflict`.
11. In the same transaction: append the handshake (next `seq`), store GroupInfo and tree for epoch + 1 (keep 8 epochs), replace the DS roster, write the Welcome to the inbox of each new device, and delete the pending items that the commit applied.

After the commit, Takusen publishes `MLS_HANDSHAKE` (§12.13) and wakes the scheduler.

**Policy.** Takusen and clients both apply it. Clients apply it in the ts-mls callback and in the pre-check of §12.4. Takusen applies it to `voice` only through the clients, because the media node relays voice groups (§12.10).

| Rule | `public_set` | `channel` | `dm` | `voice` |
|---|---|---|---|---|
| DS (external sender) proposals | Add and Remove | Remove only | Remove only | none (no external sender) |
| Adds by value | reader devices | reader devices | participant devices | only key packages whose identity is a roster `pending` entry |
| External commit (join) | any reader device | only a user who already has a leaf (own new device), or a reader device with a valid `InviteAuth` (§12.11.4) | only a user who already has a leaf (own new device) | rejected |
| External commit (resync of own leaf) | yes | yes | yes | rejected |
| Member Removes by value | own devices, non-readers, revoked devices | the same | the same | only leaves whose device is in `departed` |
| GroupContextExtensions | `history_visibility` only (§12.6), MANAGE_GUILD | `history_visibility` only, MANAGE_CHANNELS | rejected (DMs stay `joined`) | rejected |
| Other proposal types (PSK, ReInit, Update by reference) | rejected | rejected | rejected | rejected |

Clients reject a DS Add proposal in any group except `public_set`. Clients reject every Add whose key package fails the chain check, and every Add of a user who is not a reader in their own permission computation. For a DM, the readers are the participants of the channel.

**Invite joins and older clients.** A client checks the `InviteAuth` of an external commit itself (§12.11.4). A client without this rule (a version before invites with history) rejects a valid invite join: it raises a fork alert (`commit_rejected`) and resyncs its own leaf (§12.7.9). This is detection only, and the joiner stays in the tree. To stop these alerts, set `GATEWAY_MIN_CLIENT_VERSION` to the first version with the rule.

#### 12.7.4 Proposals and pending Removes

- Takusen signs exactly one external proposal per pending item and epoch (`proposeExternal`): a Remove for each queued Remove, and an Add for each queued `public_set` Add. It stores the bytes in `mls_pending.proposal`, `proposal_epoch` and `proposal_ref`.
- It appends each proposal to `mls_handshakes` (kind `proposal`) and publishes `MLS_HANDSHAKE`. Every member stores it. Takusen does this before it puts the proposal in a batch, so `MLS_BATCH_ASSIGN.proposals` lists only bytes that are already in the handshake stream.
- When the epoch changes and the item is still pending, Takusen signs a new proposal for the new epoch, appends it and publishes it again. The batch reuses these bytes. Takusen never signs a second proposal for one item in one epoch.
- `MlsModule.commit` removes duplicate Removes of one leaf index (a stored proposal and a Remove by value). RFC 9420 makes a commit with two Removes of one leaf invalid.
- **A client that holds a Remove proposal that no commit applied commits it before it encrypts.** Until that commit is accepted, the client does not send. This closes the window in which a removed device can still derive keys.

#### 12.7.5 Batch scheduler

The scheduler runs in the Takusen gRPC process (`apps/takusen/src/grpc/main.ts`), because Next.js has no background jobs.

1. Takusen queues Add and Remove items per group in `mls_pending`. A Remove queues immediately and publishes `takusen:mls_wakeup` (Redis pub/sub).
2. Every `TAKUSEN_MLS_BATCH_INTERVAL_MS` (default 2000), and on each wakeup, the scheduler takes each group that has queued items and no live batch.
3. It selects the committer: the online member device with the lowest leaf index. A device is online when the gateway key `device_online:{deviceId}` exists. The scheduler skips devices that are in the batch as Removes and devices that timed out on this group in the last 60 s. The timeout cooldown uses the expired batch rows: a batch row stays 60 s after its deadline, and the scheduler skips its device while the row exists. Then the scheduler deletes the row. The scheduler also skips a device that has 3 or more false rejection reports (§12.12 "Batch rejections").
4. It makes a batch with at most 100 Adds and all queued Removes. `proposals` holds the stored proposals of §12.7.4 for the current epoch (Removes, and `public_set` Adds). `joins` holds the Adds by value (`channel` and `dm`). It publishes `MLS_BATCH_ASSIGN` to `device:{committer}` with a deadline of `TAKUSEN_MLS_BATCH_TIMEOUT_MS` (default 5000).
5. The device checks each item, makes one commit for the batch, sends the Welcome in the commit upload, and lists the items that it rejected: joins in `rejected`, DS proposals in `rejectedProposals` (§12.12 "Batch rejections"). It does this automatically. The user takes no action.
6. If the deadline passes without an accepted commit, the scheduler marks the device as timed out and sends the batch to the next online device. A device that cannot commit (for example, it is not caught up) calls `POST /mls/batches/:id/decline` to skip the wait. A decline sets the deadline of the batch to now, so the declining device is in the cooldown too. A second decline of the same batch gives 410 `BatchExpired`.
7. When no member device is online:
   - A queued Add in `public_set` gets `MLS_JOIN_UPDATE` status `external_commit`. The joiner joins by external commit.
   - A queued Add in another kind gets status `waiting`. It stays queued. A redeemer of an invite with history does not wait for a `channel` group of the scope: it joins by external commit with an `InviteAuth` (§12.11.4).
   - A queued Remove stays queued. The next member that sends must commit it (§12.7.4).
8. Any accepted commit, with or without a batch id, removes the pending items that it applied. A live batch for an older epoch is cancelled and made again on the next tick.

#### 12.7.6 Welcome delivery and the device inbox

- The committer puts the Welcome in the commit upload. Takusen writes one inbox item per new device and publishes `DEVICE_INBOX` to `device:{id}`.
- The Welcome does not carry the ratchet tree. The joiner fetches `GET /mls/groups/:groupId/state?epoch=E`. Takusen keeps the state of the last 8 epochs. When the epoch is no longer kept, the joiner resyncs by external commit. This is allowed, because the device has a leaf.
- A joiner or a resyncing device can find a revoked leaf in the tree. It accepts that leaf when a Remove for its leaf index is queued (§12.4 rule 7), and it commits that Remove before it sends (§12.7.4).
- Inbox item bodies:
  - `welcome`: `struct { uint8 version = 1; opaque group_id<V>; uint64 epoch; opaque welcome<V>; /* MLSMessage */ } WelcomeItem`.
  - `dsk_transfer`, `history_keys`: `SealedDeviceMessage` (§12.5). Only devices of the same user can post them.
- Limits: 1 MiB per item, 8 MiB per device in total (`InboxFull` when full), 30 days retention. The device acks each item with `DELETE /devices/@me/inbox/:id`.
- On the client, `GroupService` owns the inbox. It fetches with `after` = the stored cursor (store table `inbox`, `lastSeq`), acks each item, and moves the cursor. It handles `welcome` and `history_keys` itself and gives `dsk_transfer` to `IdentityService.handleInboxItem`.

#### 12.7.7 Group creation

- Takusen creates a `mls_groups` row with status `pending` and a new generation when a group is needed: a new guild (`public_set`), a new private channel, a channel that moves (§12.6), or a new DM or group DM.
- It assigns the create in an `MLS_BATCH_ASSIGN` with `create` set. The assignee is the device that made the request (`X-Hachiman-Device`), when it is online. Else it is an online device of a reader, in device id order. The same timeout and failover rules apply.
- The DS selects `create.cipherSuite` (§12.15). The assignee creates the group at epoch 0 with only its own leaf and the extensions of §12.6. It calls `POST /mls/groups` with GroupInfo and tree. The group becomes `active`.
- `POST /mls/groups` checks (`DsModule.inspectGroupInfo`):
  - The row exists with status `pending`, and the caller is the assignee of `assignmentId`. Else 403 `IllegalAdd`. A group that is already `active` gives 409 `GroupExists`.
  - The group id is the allocated (kind, scope, generation) of the row, and the suite is the row suite. Else 400 `InvalidCommit`.
  - The GroupInfo has epoch 0, a valid signature, and a tree hash that matches the tree. Else 400 `InvalidCommit`.
  - The tree has exactly one leaf, and its credential is the caller device. Its chain is valid. Else 403 `IllegalAdd`.
  - The group context extensions are in the order of §12.6. `external_senders` is byte-equal to the DS ExternalSender. `required_capabilities` is the §12.6 value. Else 400 `InvalidCommit`.
  - The descriptor matches the row: kind, guild, channel and `history_visibility`, and `created_by_user_id` is the caller. Else 400 `InvalidCommit`.
- Takusen then queues Adds for the other reader devices (`channel`, `dm`). It claims their key packages. A `public_set` group gets no Adds at create time. Devices join when they first open a public channel (§12.7.8).

#### 12.7.8 Join requests

- A device posts `POST /mls/groups/:groupId/join-requests { keyPackage }` when it needs a leaf: the first open of a public channel, or a new own device that catches up on the groups of its user.
- Takusen checks that the user reads the group. It queues an Add (`public_set`: as a DS proposal, other kinds: by value). Statuses: `queued`, `committed`, `rejected`, `external_commit`, `waiting`. Takusen publishes `MLS_JOIN_UPDATE` to `device:{id}` on each change.
- In `channel` and `dm` groups, when the user already has a leaf in the group, Takusen sets the status `external_commit` at once, and the new device joins by external commit. A join request of a user without a leaf stays queued for a member to commit.
- `GroupService.sync()` posts a join request for each group of `GET /mls/groups` with `member = false`, except `public_set` groups. A `public_set` join waits for the first open of a public channel (`ensureChannelGroup`).
- **Invite joins.** For a `channel` group whose channel a redeemed invite with history names, `sync()` and `ensureChannelGroup` first join by external commit with an `InviteAuth`, with no join request (§12.11.4). When the device cannot make the `InviteAuth`, or the DS refuses the commit, they post the join request.
- A `public_set` group has at most `TAKUSEN_PUBLIC_SET_MAX_MEMBERS` leaves (default `PUBLIC_SET_MAX_MEMBERS`, 500). Above the cap, a join request gets 403 `GroupFull`. There is no plaintext fallback. The Phase 3 load test (`docs/e2ee-load-test.md`) set this value: at 500 leaves, a full batch of Adds takes the committer 0.43 s (deadline 5 s), and a join by Welcome takes 2.2 s (budget 10 s). The Welcome join time grows about with the square of the leaves. Fewer Adds per `public_set` batch and an empty commit with a path after each join would allow a higher cap. Both are contract changes that are not made yet (`docs/e2ee-load-test.md`, "How to increase the cap").

#### 12.7.9 Retention and catch-up

- Takusen keeps handshakes for 30 days. A daily sweep in the gRPC process deletes older rows.
- A client fetches handshakes by sequence number (`GET /mls/groups/:groupId/handshakes?after=seq`). The gateway resume buffer does not carry them.
- A client that is further behind gets 410 `HandshakesExpired`. It resyncs by external commit and gets the missed history keys from its own devices (`history_keys` device message) or from its backup.
- A client buffers envelopes of an epoch that it has not reached (store table `buffered`). `MessageService` writes the table. `GroupService` drains it after it fetches the handshakes, and emits `epochKeysAvailable`. The UI then calls `decryptMessages` again.
- **Rejected commits.** A client that rejects a commit that the DS accepted stops the group and resyncs automatically (§12.8.7, `commit_rejected`).
- **Own commits after a crash.** Before a client posts a commit, it stores the next state in the store table `pendingCommits` (key: group id, with the epoch). When the DS accepts, the client adopts the state and deletes the row. When the client sees a commit in the stream with `senderDevice` = itself and the stored epoch, it adopts the stored state, because ts-mls cannot process its own commit. When no stored state matches, the client resyncs by external commit. On 409, it deletes the row. It also deletes the row when the DS refuses an external commit with a code of the §12.7.3 checks (for example 403 `IllegalAdd`): the DS did not store that commit. After a network error or a 5xx, the row stays, because the DS can have accepted the commit.

### 12.8 Message envelopes

#### 12.8.1 Format

```
struct {
  uint16 magic = 0x4801;
  opaque group_id<V>;              // 22 bytes
  opaque channel_id[16];
  uint64 epoch;
  uint32 sender_leaf;
  opaque sender_device_id[16];
  opaque client_msg_id[16];        // 128 random bits from the sender
  opaque salt[32];                 // random per message
  opaque franking_tag[32];         // §12.16
} EnvelopeHeader;

struct {
  EnvelopeHeader header;
  opaque ciphertext<V>;            // AES-256-GCM(K_msg, nonce = 12 zero bytes, aad = encode(header), encode(EnvelopePlaintext))
} Envelope;

struct {
  uint8 type;                      // 1 user, 2 role, 3 everyone
  opaque id[16];                   // 16 zero bytes for everyone
} Mention;

struct {
  opaque upload_id[16];
  opaque key[32];
  opaque sha256[32];               // SHA-256 of the whole blob
  uint64 size;                     // plaintext bytes
  uint64 blob_size;
  opaque mime<V>;                  // at most 127 bytes
  uint32 width;
  uint32 height;
} ThumbnailPointer;

struct {
  opaque upload_id[16];
  opaque key[32];
  opaque sha256[32];
  uint64 size;                     // plaintext bytes
  uint64 blob_size;                // blob bytes
  opaque mime<V>;                  // lowercase type/subtype, at most 127 bytes
  opaque name<V>;                  // UTF-8, 1 to 255 bytes
  uint32 width;                    // 0 = none
  uint32 height;                   // 0 = none
  uint32 duration_ms;              // 0 = none
  optional<opaque> blurhash<V>;    // ASCII, at most 100 bytes
  optional<ThumbnailPointer> thumbnail;
} AttachmentPointer;

struct {
  optional<opaque> edit_of[16];    // kind 2: the client_msg_id of the original
  opaque text<V>;                  // UTF-8, at most 8000 bytes
  Mention mentions<V>;             // at most 100
  AttachmentPointer attachments<V>;  // at most maxAttachmentsPerMessage (10)
  optional<opaque> reply_to[16];   // a client_msg_id in the same channel
} MessageBody;

struct {
  opaque target[16];               // the client_msg_id of a message in the same channel
  opaque emoji<V>;                 // UTF-8, 1 to 72 UTF-16 code units, no control character
  uint8 remove;                    // 0 add, 1 remove
} ReactionBody;

struct {
  opaque page_id[16];              // a page of a pages channel (§12.20)
  uint32 changes;                  // 1 to 10000
} PageActivityBody;

struct {
  uint8 kind;                      // 1 message, 2 edit, 3 reaction, 4 page_activity
  select (kind) {
    case 1, 2: MessageBody body;
    case 3:    ReactionBody body;
    case 4:    PageActivityBody body;
  };
  uint64 sent_at_ms;               // sender clock, display only
  optional<opaque> kt_tree_head<V>;  // SignedTreeHead gossip (§12.14)
} EnvelopeContent;

struct {
  EnvelopeContent content;
  opaque franking_key[32];
  opaque signature<V>;             // SignWithLabel(sender MLS signature key, "Envelope",
                                   //   SHA-256(encode(header)) ‖ SHA-256(encode(content)))
} EnvelopePlaintext;
```

A message must have text or at least one attachment. `channel_id` stops the server from moving a message to another channel of the same `public_set` group.

**Kinds.** The kind byte is the first byte of `EnvelopeContent`. It is inside the ciphertext, the signature and the franking tag cover it, and the body layout follows from it. Thus a changed kind byte gives `aead`, `bad_signature`, `bad_franking` or `malformed`. The bytes of kind 1 and kind 2 are the same as before kinds 3 and 4.

| Kind | Name | `CryptoApi` content | Rules |
|---|---|---|---|
| 1 | `message` | `MessageContent` | Text or at least one attachment. |
| 2 | `edit` | `MessageContent` | §12.8.6. |
| 3 | `reaction` | `ReactionContent { target, emoji, remove, sentAtMs }` | `emoji` has 1 to 72 UTF-16 code units (`MAX_REACTION_EMOJI_LENGTH`), at most 216 UTF-8 bytes (`MAX_REACTION_EMOJI_BYTES`), a Unicode emoji or a custom emoji key `name:id` (§4 Emojis), no control character (Unicode `Cc`) and no lone surrogate. `remove` is 0 or 1. `target` is not the header `client_msg_id`. |
| 4 | `page_activity` | `PageActivityContent { pageId, changes, sentAtMs }` | `changes` is 1 to 10000 (`MAX_PAGE_ACTIVITY_CHANGES`). `pageId` is a lowercase UUID. |

- A reaction and a page activity are new messages: each has a new `client_msg_id`, no `edit_of`, no attachments and no `reply_to`. The server stores them as normal message rows and cannot tell them apart from kind 1. They count toward history pages and toward the server unread count. SEND_MESSAGES covers them.
- A reaction is one event: user U added or removed `emoji` on `target`. The receiver folds the reactions of a channel into the target message. For each (sender user, target, emoji), the event with the highest `sent_at_ms` wins. A reaction is not a chat row and does not count as unread on the client.
- A page activity tells the channel that the sender edited a page (§12.20). The sender sends at most one per page per 10 minutes. The client shows it as an activity line, not as a chat row.
- **Old clients.** A client that does not know a kind gives `malformed` at step 3 (§12.8.5) and changes no state. It does not count toward the fork alert. Thus a reaction or a page activity shows as one undecryptable row on an older client, and does no other harm. The same holds for a reaction emoji of more than 32 UTF-16 code units (a custom emoji key) on a client from before the limit of 72.

#### 12.8.2 Message key

```
PRK   = HKDF-Extract(salt = header.salt, IKM = S_e)
K_msg = HKDF-Expand(PRK, info = "hachiman msg key v1" ‖ uint32(sender_leaf), L = 32)
```

`S_e` is the message exporter of the header epoch (§12.3). Each message has its own key, so the nonce is zero. There is no counter state, so a reload or a second device cannot reuse a nonce.

#### 12.8.3 Send

1. The client calls `GroupService.sendState(channelId)`. This fetches missed handshakes and commits pending Removes (§12.7.4).
2. It builds the content, a random franking key and the franking tag (§12.16).
3. It builds the header, signs, and encrypts.
4. It posts `POST /channels/:id/messages { envelope, nonce?, attachments? }`. On 409 `StaleEpoch`, it catches up and encrypts again with a new `client_msg_id`.

The content of a message must encode to an envelope of at most `Limits.maxEnvelopeBytes`. Else `encryptMessage` throws `CryptoError('TooLarge')` before it seals.

#### 12.8.4 Server checks on send and edit

Takusen decodes only the header (`acceptEnvelope`). It checks:
- The envelope has at most `TAKUSEN_MAX_ENVELOPE_BYTES` (default 32768) bytes. Else 413 `EnvelopeTooLarge`. The largest valid content (8000 text bytes, 100 mentions, 10 full pointers with thumbnails, KT gossip) is about 18.3 KB, so the default leaves room. The client checks the same limit from `Limits.maxEnvelopeBytes` before it posts (`CryptoError('TooLarge')`).
- `magic` is 0x4801. `group_id` is the current group of the channel and the group is `active`. Else 409 `GroupPending` or 400 `InvalidEnvelope`.
- `channel_id` is the route channel. Else 400 `InvalidEnvelope`.
- `epoch` is the stored epoch. One exception: `epoch` may be the stored epoch − 1 when the commit that started the current epoch removed no leaf of another device and is less than 10 s old. A resync of the committer's own leaf counts as add-only. Else 409 `StaleEpoch` with the stored epoch.
- `sender_device_id` is the `X-Hachiman-Device` of the request, that device has a leaf in the DS roster, and `sender_leaf` is that leaf (the roster of the header epoch). Else 403 `NotMember`.
- A new message (`edit: false`): `client_msg_id` is unique in the channel. Else 409 `DuplicateMessage`.
- An edit (`edit: true`): `client_msg_id` equals the `client_msg_id` of the row. Else 400 `InvalidEnvelope`. Takusen skips the uniqueness check. `group_id` is the current group of the channel, which can differ from the group of the original after a channel move.

On send, Takusen stores `group_id`, `epoch`, `sender_device`, `client_msg_id`, `franking_tag`, `size` and the envelope. On edit (`PATCH`), it replaces `envelope`, `group_id`, `epoch`, `sender_device`, `franking_tag` and `size`, and sets `edited_at`. `client_msg_id`, `author_id` and the attachment rows stay. It never decrypts.

#### 12.8.5 Receive

For each message, in history order (`MessageService.decryptMessages`). Each step gives one result code (`DecryptFailure` in `src/api.ts`):

1. **Header.** Decode the header. It does not decode: `malformed`. `channel_id` differs from the row: `wrong_channel`. `group_id` or `epoch` differs from the row: `wrong_group`. `client_msg_id` differs from the row: `replay`. `sender_device_id` differs from the row `senderDevice`: `device_mismatch`.
2. **Epoch secret.** Get `S_e`. The epoch is ahead of the local state: buffer the message, `pending` `epoch_ahead`. The client never held the group and has no bundle or backup key for it: `pending` `group_unknown` (a Welcome can still come). The client knows the group but has no key for that old epoch: `pending` `no_history_key`. A DS call for this message failed (`CryptoError` `Transport`): `pending` `transport`. This is not a verdict on the message. The UI decrypts it again later.
3. **Decrypt.** A failed tag: `failed` `aead`, and the failure counts toward the fork alert. A plaintext that does not decode, or that breaks a §12.8.1 limit: `malformed`.
4. **Sender.** Get the verified `DeviceCertificate` of `sender_device_id`, revoked devices included (`IdentityService.deviceOwnerCertificate`). The lookup tries the keys of the row author first, then the keys of each user that the Worker already fetched and verified, and then fetches the keys of the author again. It fetches the keys of one user again at most once per `KEY_REFRESH_MIN_MS` (10 s). Thus a device of another user is found, and gives `device_mismatch` or `edit_not_author`, not `invalid_chain`. No certificate, or the chain check fails: `invalid_chain`. The certificate user is not the row author: `edit_not_author` (kind 2) or `device_mismatch` (all other kinds). **Revoked sender.** When this client processed the Remove of the device in this group, it stores the first epoch without the leaf (`membership.removedAtEpoch`, `GroupService.removedAt`). An Add of the device clears it. An envelope from a revoked device at that epoch or later: `invalid_chain`. **Residual risk:** a revoked device can still sign envelopes for older epochs, in which it was a member. The server sets the order and `created_at`, so such a forged message can show anywhere in the history of those epochs. A client that never processed the Remove (history from a bundle or a backup) has no bound.
5. **Signature.** Check the signature with the certificate `mls_signature_key`. Else `bad_signature`.
6. **Franking.** Compute the HMAC of §12.16 from the decrypted `franking_key`, the header `channel_id` and `client_msg_id`, and the received `encode(EnvelopeContent)`. It must equal the header `franking_tag`. Else `bad_franking`. Thus a report can always prove the content that the recipients saw.
7. **Kind.** Kind 1 has no `edit_of`. Kind 2 has `edit_of` = the header `client_msg_id` = the row `clientMsgId`. Kinds 3 and 4 have no `edit_of` field. A kind 3 `target` is not the header `client_msg_id`. A row with `editedAt` holds no kind 3 or kind 4 envelope, because a reaction and a page activity are never edited. Else `malformed`.
8. **Attachments.** The list of pointer upload ids (for each pointer: the file id, then the thumbnail id when it has one) equals the row attachment ids, in order. Each `blob_size` equals the row `size` of that id. Else `attachments_mismatch`. This rule is the same for kind 1 and kind 2, so an edit cannot change the attachments. Kinds 3 and 4 have no pointers, so their row must have no attachments.
9. **Membership.** `membershipVerified` is true when the client saw the device hold `sender_leaf` at that epoch (store table `membership`). Messages from a history bundle or a backup have `membershipVerified` false. The UI shows "membership at that time not verified".
10. **Dedupe and rollback.** The key is `(channel_id, client_msg_id)`. The store table `seen` maps it to the server message id and the highest `sent_at_ms` that the client accepted for it. A different message id with the same key: `replay`. A lower `sent_at_ms` than the stored value: `stale_edit`. Thus the server cannot serve an older edit, or the original, after the client saw a newer edit. The UI keeps the newer content that it has. The same `sent_at_ms` is the same envelope again, and is accepted.
11. **Gossip.** A `kt_tree_head` goes to `IdentityService.observeTreeHead`.

#### 12.8.6 Edits and deletes

- An edit is a new envelope with kind 2. It carries the full new content, the attachment pointers of the original included. Its header `client_msg_id` is the `client_msg_id` of the original, and `edit_of` repeats it. `sent_at_ms` is above the value of the version that it replaces.
- The edit uses the current group and epoch of the channel. After a channel move (§12.6), that is the new group, so the header group differs from the group of the original. A device of the author other than the original sender may edit.
- `PATCH /channels/:id/messages/:mid { envelope }` replaces the stored envelope and the header fields (§12.8.4). The server allows only the author. The client retries a 409 `StaleEpoch` with the same `client_msg_id`.
- A delete is the REST `DELETE` only. It removes the ciphertext and the attachment and thumbnail blobs. There is no delete envelope.
- The author can `PATCH` a reaction or page activity row with a kind 2 envelope. The row then shows as a message with the content of the edit. This is the same as a new message from the author, so the client accepts it. A client that saw the reaction before keeps the fold of it.
- **API.** `CryptoApi.encryptMessage(input)` takes `EncryptMessageInput = { channelId } & KindedContentInput`: `{ kind: 'message' | 'edit', editOf, content: MessageContent without sentAtMs }`, `{ kind: 'reaction', editOf: null, content: { target, emoji, remove } }` or `{ kind: 'page_activity', editOf: null, content: { pageId, changes } }`. The Worker sets `sentAtMs`. An `ok` `DecryptResult` (`DecryptedMessage`) carries the same `kind`, `editOf` and `content` union. The UI checks `kind` before it reads `content`.

#### 12.8.7 Fork alert

- After each commit, the client compares its new `tree_hash` and `confirmed_transcript_hash` with `next` of the `MLS_HANDSHAKE` event or the handshake row. A difference raises `forkAlert` (`group_info_mismatch`).
- A client that has `S_e` for an epoch counts AEAD failures per group. Three failures in 10 minutes raise `forkAlert` (`aead_failures`) and start an automatic resync. The header is not authenticated before decryption, so the count does not use the sender device: a server can insert rows that fail.
- **Rate limit.** At most one automatic `aead_failures` resync runs per group in 10 minutes (`FORK_RESYNC_MIN_INTERVAL_MS`). Each further resync doubles the wait, up to 24 h (`FORK_RESYNC_MAX_INTERVAL_MS`). After 24 h without a resync, the wait is 10 minutes again. When the wait has not ended, failures raise no alert and start no resync. Thus inserted rows cannot cause a loop of resyncs and alerts.
- The DS accepted a commit that this client rejects (the policy or the chain check fails): the group stops on this device (fail closed) and the client raises `forkAlert` (`commit_rejected`). A rejected proposal does not stop the group.
- The `forkAlert` event carries `groupId`, `channelId`, `epoch` (the epoch of the local state when the alert fired, or null) and `reason`.
- After a fork alert, the client resyncs by external commit (`resync = true`). For `commit_rejected`, the resync is automatic: the Worker tries it after waits of 1, 2, 4, 8 and 16 s (`COMMIT_REJECTED_RESYNC_DELAYS_MS`). A successful resync enters the DS epoch and asks the own devices for the keys of the skipped epochs (`history_keys`). When all five attempts fail, the group stays stopped, and the next `GroupService.sync()` (READY, RESUMED) starts the attempts again.

### 12.9 Attachments

**Blob format.**

```
header      = "HAT1" (4 bytes) ‖ uint8 version = 1 ‖ uint8 segment_log2 = 16 ‖ nonce_prefix[7]   // 13 bytes
P           = file ‖ 0x80 ‖ 0x00 × (Padmé(L + 1) − L − 1)       // L = file length
segments    = P split into 65536-byte parts. The last part has 1 to 65536 bytes.
nonce_i     = nonce_prefix ‖ uint32(i) ‖ uint8(last)               // 12 bytes. last = 1 only for the final segment
ciphertext_i = AES-256-GCM(key, nonce_i, aad = header, segment_i)
blob        = header ‖ ciphertext_0 ‖ … ‖ ciphertext_n
```

- `key` is 32 random bytes per file. `nonce_prefix` is 7 random bytes.
- The receiver checks the blob length first: `13 + len(P) + 16 × (number of segments)`, with `len(P) = Padmé(size + 1)` and `size` from the pointer (file or thumbnail). It checks SHA-256 of the blob against the pointer. It then decrypts each segment. It must decrypt the final segment with `last = 1` and every other segment with `last = 0`. This stops truncation and reordering. It strips the padding: trailing zero bytes, then one 0x80 byte. The result must have `size` bytes. Any failure throws `CryptoError('Malformed')`.
- The SHA-256 is incremental (`@noble/hashes` `sha256.create()`), because WebCrypto `digest` is one-shot. Encrypt and decrypt read the input in `Blob.slice` segments and return a `Blob`, so memory stays bounded by a few segments.
- **Padmé.** For L < 2, Padmé(L) = L. Else E = ⌊log2 L⌋, S = ⌊log2 E⌋ + 1, z = E − S, m = 2^z − 1, Padmé(L) = (L + m) & ~m.
- `TAKUSEN_MAX_UPLOAD_BYTES` applies to the blob size. The client checks the blob size before upload.
- **Metadata.** File name, MIME type, dimensions, duration, plaintext size and blurhash are only in the envelope. The server stores the blob size and the uploader.
- **Thumbnails.** An image or video gets an optional thumbnail of at most 320 px per edge. It is a separate blob with its own key, in the same format.
- **Delivery.** The client uploads with `POST /uploads?kind=blob` (§4). It downloads `/files/{uploadId}/blob`, decrypts the whole file in the Worker, and shows a blob URL. Streaming playback through a service worker comes later.

### 12.10 Voice, video and screen share

#### 12.10.1 Voice group and committer

- Each voice room session has its own MLS group of kind `voice`. The media node chooses 16 random bytes as the room session id when the room goes from empty to not empty. The group id is `GroupId{kind 4, scope = room session id, generation 0}`. The descriptor of a guild call has `guild_id` = the guild of the voice channel and `channel_id` null. The descriptor of a DM call (§6 "DM calls") has `guild_id` null and `channel_id` = the DM or group DM channel. Both have `history_visibility = joined` and no external sender. The UI passes `CryptoApi.voiceStart({channelId, guildId})`, with `guildId` null for a DM call. The creator writes the scope into the descriptor, and a joiner rejects a Welcome whose descriptor has another `guild_id` or `channel_id` (`e2ee_invalid`).
- The room epoch is null until the creator sends `e2ee_ready` with `transitionId: null`. The media node then sets the epoch to 0.
- The media node has no MLS library. It signs nothing and proposes nothing. It relays key packages, Welcomes, commits and roster changes, and it orders commits.
- **Committer.** The member session with the lowest leaf index, from the `leafIndex` values that clients report in `e2ee_ready`. The committer commits Adds for pending joiners and Removes for departed participants. If no commit arrives 5 s after the media node gave the committer work, the media node selects the next member and sends the roster again. The 5 s timer starts at the first new work, and more work does not start it again. Before the group exists, the committer is the earliest joiner (it creates the group), and the failover gives the create role to the next joiner.
- **Any member can commit.** The media node accepts a commit from any member, not only from the selected committer, when the `leaf_index` of the commit header equals the leaf that this member reported. The first such commit for the room epoch wins.
- **Leaf indexes in the roster.** `members[].leafIndex` is null for a session that a commit added and that did not send `e2ee_ready` yet. `departed[].leafIndex` is null when the session left before it reported its leaf. The committer then finds the leaf by the device id of the leaf credential.
- A client can report a false `leafIndex`. Its commit then carries that leaf, and the other members reject it (wrong signer). The members report `e2ee_invalid` with the `committerLeaf` that they saw, and the media node closes the committer with 4014 (§8, "Bad commits").
- The committer adds a key package only when the chain is valid and the credential `{userId}:{deviceId}` equals the roster entry (from the voice token claims). It does not check the gateway voice states (`DsTransport` has no voice-state query). It trusts the media roster, as Implementation note 2 of `docs/e2ee-plan.md` accepts. It removes the leaves whose credential device id is in `departed`.
- The UI shows the participants from the MLS tree, not from the server roster.
- **Ordering.** The media node accepts the first `e2ee_commit` whose epoch is the room epoch. It reads the group id and the epoch from the commit bytes (below). It answers other commits with `e2ee_commit_rejected`. It also sends `e2ee_commit_rejected` while an earlier transition is not executed yet (`currentEpoch` is then the new epoch), and when `added` names a session that is no longer pending or `removed` names a session that is not departed. A rejection is not a violation. The losers process the winning commit and try again from the latest roster.
- **One key package, one use.** A joiner uses its identify key package for one Welcome only (RFC 9420). When a roster reverts the Welcome transition of the joiner, the joiner sends `e2ee_invalid` with `transitionId` null (a resync, 4013). It does not wait for a second Welcome, because the media node would relay the same key package to the next committer. The rejoin calls `voiceStart`, which makes a new key package. The UI rejoins after 1, 2, 4, 8 and 16 s, and after five rejoins without an active epoch it stops and shows an error.
- **No ratchet tree.** When the `e2ee_ratchet_tree` of the committer did not arrive 10 s after a commit with a Welcome, the media node closes the committer with 4014. The room stays in the previous epoch.
- **New group.** When no live participant holds the group state but participants remain, the room starts a new group: a new room session id and group id, epoch null, and an empty `departed` list.

Media commit parse (no MLS library): MLSMessage = `uint16 version (1) ‖ uint16 wire_format (1 = public) ‖ FramedContent`. FramedContent starts with `opaque group_id<V> ‖ uint64 epoch ‖ uint8 sender_type (1 = member) ‖ uint32 leaf_index`. The media node checks version, wire format, group id, epoch, `sender_type = 1` and `leaf_index` = the leaf that the sender reported (any member can commit). A mismatch closes the sender with 4014.

The voice ops are in §8.

#### 12.10.2 SFrame

```
sframe_epoch_secret = MLS-Exporter("SFrame 1.0 Base Key", "", 32)
media_index m       = kid_leaf × 2 + track              // track 0 = audio, 1 = video
kid_leaf            = leaf_index                         // mic (m-line 0, track 0) and screen (m-line 1, track 1)
                    | leaf_index + 2^32                  // screen audio (m-line 2, track 0)
base_key(m)         = HKDF-Expand(sframe_epoch_secret, uint32(m), 32)            // HKDF-SHA256; uint64(m) when m >= 2^32
KID                 = (m << 4) | (epoch & 0xF)
sframe_secret       = HKDF-Extract("", base_key(m))
sframe_key          = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret key "  ‖ uint64(KID) ‖ uint16(0x0004), 16)
sframe_salt         = HKDF-Expand(sframe_secret, "SFrame 1.0 Secret salt " ‖ uint64(KID) ‖ uint16(0x0004), 12)
nonce               = sframe_salt XOR uint96(CTR)
```

- The SFrame header is RFC 9605 §4.3 (config byte, then KID and CTR in minimal big-endian bytes).
- Frame on the wire: `clear prefix ‖ SFrame header ‖ ciphertext ‖ tag (16)`. AAD = `SFrame header ‖ clear prefix`. Thus the prefix is authenticated.
- Clear prefix: Opus 0 bytes. VP8: 10 bytes for a key frame (`frame[0] & 0x01 == 0`), else 1 byte. A frame shorter than its prefix + 1 is dropped.
- CTR is a 64-bit counter per KID. It starts at 0 and increases by 1 per frame. A new epoch gives a new key, so (key, CTR) never repeats. The KID repeats every 16 epochs, but the key does not. The mic, the screen and the screen audio have separate media indexes, so they never share a key or a counter, also with one sender transform (and so one key ring) each. Real leaf indexes are below 2^32, so a screen audio KID never equals a mic KID, and the uint64 info of its base key never equals a uint32 one.
- **One sender transform per (call, track).** The client makes the sender transform of each track once per call and never makes it again. `setMicrophone` and `setScreen` replace the track on the sender and keep the transform. If a sender transform or the transform Worker must be made again, the client first asks for a new epoch (an `e2ee_invalid` that makes it rejoin), so a counter that starts again at 0 uses a new key.
- Receivers find the key by KID. The KID leaf must belong to the user of the receiver (from the msid, §8), and the KID track bit must equal the receiver track (`FrameTransformOptions.track`: `video` = 1, `audio` and `screen-audio` = 0). A `screen-audio` receiver takes only a KID leaf from 2^32 (the user's leaf is kid_leaf − 2^32), the others only one below it. Else the frame is dropped (`wrongSender`), so the SFU cannot swap the mic and the screen audio. Receivers drop a CTR that they saw in the last 1024 frames of the KID.
- Keys of the previous epoch stay valid for 10 s after `e2ee_execute_transition`. There is no plaintext passthrough.
- The SFU forwards RTP payloads unchanged and never parses them. It rewrites only the SSRC, the payload type and, on screen tracks, the sequence number (§8). The SSRC does not identify the sender. The KID and the leaf credential do.
- **Client.** One transform Worker per call (`pkgs/hachiman-crypto/src/media/transform-worker.ts`), with `RTCRtpScriptTransform` on the senders of m-lines 0 to 2 and on each receiver in `ontrack`. The crypto Worker sends frame keys to it over a `MessagePort` (`FrameKeyMessage` in `src/api.ts`). Each transform has its own port. `voiceAttachTransform` returns the port id. When a receiver ends (its track ends, its peer leaves, or the receiver gets a new transform), the UI calls `voiceDetachTransform(portId)`: the crypto Worker sends `close` on the port and forgets it, and the transform Worker closes the key ring and its end of the port. `voiceStop` closes every port of the call. Sender transforms stay for the whole call. There is no fallback to the legacy encoded-streams API.
- Speaking state stays a client op (§8). It is metadata.
- Server-side recording is out of scope. A recorder would have to be a member.

### 12.11 History keys, backups and recovery

#### 12.11.1 Epoch secrets

A client keeps `S_e` of every epoch that it was a member of (store table `epochSecrets`), so it can decrypt history again after a reload. A leaked device store exposes the history of that device.

- An import (`importHistoryKeys`: an own device, a backup, a history or invite bundle) never replaces a stored secret.
- The secret that a device derives from its own MLS state of an epoch replaces a stored secret of that epoch that differs, and the device emits `epochKeysAvailable`. Thus a wrong imported key (any member can sign an invite bundle, §12.11.4) stops working in each epoch that the device enters. A send always uses the secret from the MLS state.
- An import reads and writes in one store transaction. After an upload, a backup (§12.11.3) marks a row as backed up only when the row still has the uploaded secret. Thus a secret that the MLS state replaced during the upload stays not backed up, and the next backup uploads it.

#### 12.11.2 History bundles

When the group descriptor says `shared`, the committer of a commit that added a device of a new user sends a history bundle in the new epoch. When the committer does not send it, the next `MLS_BATCH_ASSIGN` for the group lists the epoch in `historyBundleEpochs`.

```
struct {
  uint64 epoch;
  opaque secret[32];               // S_e of that epoch
} HistoryKey;

struct {
  uint8 version = 1;
  opaque group_id<V>;
  uint64 epoch;                    // the epoch of the bundle (the join epoch)
  uint32 sender_leaf;
  opaque sender_device_id[16];
  opaque nonce[12];
  opaque ciphertext<V>;            // AES-256-GCM(K_hist, nonce, aad = encode(the fields above), encode(HistoryBundleContent))
} HistoryBundle;

struct {
  HistoryKey keys<V>;              // ascending epochs, all below the bundle epoch, at most 4096
  opaque signature<V>;             // SignWithLabel(sender MLS signature key, "HistoryBundle", SHA-256(aad) ‖ SHA-256(encode(keys)))
} HistoryBundleContent;
```

- `K_hist` is the history exporter of the bundle epoch (§12.3).
- Cap: 4096 keys and 512 KiB (`HISTORY_BUNDLE_MAX_BYTES`). The bundle covers the most recent epochs.
- Receivers check the signature, the sender chain and the sender leaf. Messages that decrypt with bundle keys have `membershipVerified` false.
- **`public_set` bundles go to DS members.** In a `public_set` group the readers are the guild members that the DS gives (`guildMembers`). Signed admin actions do not cover guild membership. Thus, when the descriptor says `shared`, a committer sends a bundle to each new user that the DS adds. A malicious server can add an account that it controls and get the history of the public channels. The UI timeline shows the Add. This agrees with the threat model: public channels accept membership that the server controls. Private history belongs in `channel` groups, where the signed admin chain checks each Add (§12.16).

#### 12.11.3 Recovery key and backups

- **Recovery key.** The first device makes 32 random bytes `rk` and shows the key one time. Text form: `HRK1-` followed by Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`) of `rk ‖ SHA-256(rk)[0..2]`: 55 characters in 11 groups of 5, separated by `-`.
  - Encoding: the 34 bytes are one big-endian bit string (272 bits). Three zero bits go at the end (275 bits). Each 5 bits, most significant first, give one character.
  - Parsing: the parser removes spaces and `-`, and accepts the `HRK1` prefix in any case. It maps lowercase letters to uppercase. The only aliases are `O` → `0`, and `I` and `L` → `1`. Every other character outside the alphabet (`U` included) is an error (`InvalidRecoveryKey`). It needs exactly 55 characters, rejects non-zero pad bits, and checks the 2 checksum bytes.
  - Test vector: `rk` = bytes 0x00, 0x01, … 0x1f. SHA-256(rk)[0..2] = `630d`. Text: `HRK1-000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FP638`.
- There is no passphrase backup. A self-hosted server has no HSM to stop an offline brute-force attack.
- A leaked recovery key exposes all history. The UI says so.
- `K_backup = HKDF-SHA256(salt = "", IKM = rk, info = "hachiman backup key v1", 32)`. `key_id = HKDF-SHA256(salt = "", IKM = rk, info = "hachiman backup id v1", 16)`.

```
struct {
  uint8 version = 1;
  uint8 kind;                      // 1 identity, 2 history
  opaque key_id[16];
  opaque nonce[12];
  opaque ciphertext<V>;            // AES-256-GCM(K_backup, nonce, aad = uint8(version) ‖ uint8(kind) ‖ key_id, plaintext)
} BackupBlob;

struct {
  MasterKeyRecord master;
  opaque master_private_key[32];
  DeviceSigningKeyCert dsk;
  opaque dsk_private_key[32];
} IdentityBackup;                  // kind 1. One per user, replaced on change

struct {
  opaque group_id<V>;
  HistoryKey keys<V>;              // at least 1 key, strictly ascending epochs
} HistoryBatch;                    // kind 2. One blob per batch of epochs of one group
```

- A `HistoryBatch` has at least one key, and its `group_id` is not empty. The epochs are strictly ascending. The decoder rejects a batch with epochs out of order or a duplicate epoch. The encoder sorts the keys by epoch and keeps only the last key for each epoch, so it always writes a batch that decodes. In `LinkTransfer`, two `HistoryBatch` items must not have the same `group_id`.

- A client uploads a history blob per group when it has 64 epochs without a backup, and at most every 24 h.
- Limits: 64 KiB for the identity blob, 1 MiB per history blob, 256 MiB per user.
- A recovery key rotation uploads all blobs again under the new key and then deletes the old ones.

#### 12.11.4 Invites with history

An administrator can make an invite that carries history. The link of the invite holds a secret seed. Member devices seal epoch secrets to the keys of the seed. A user who has the full link reads the history of the scope with no member online. The server stores the signed record and the sealed bundles. It never gets the seed. `pkgs/hachiman-crypto/src/invites/` holds the codecs, the keys and the signatures.

**Seed and keys.** The creator device makes 32 random bytes, the `invite_seed` (`INVITE_SEED_BYTES`). Two key pairs come from the seed:

```
hpke_priv = HKDF-SHA256(salt = "", IKM = invite_seed, info = "hachiman invite hpke v1", 32)   // X25519: hpke_public = X25519(hpke_priv)
sign_priv = HKDF-SHA256(salt = "", IKM = invite_seed, info = "hachiman invite sign v1", 32)   // the Ed25519 seed of the key pair: sign_public
```

- The derivation does not use the RFC 9180 `DeriveKeyPair`.
- `sign_public` is the **invite key id** (`keyId`, base64url on a JSON wire).
- Test vector: `invite_seed` = bytes 0x00, 0x01, … 0x1f. `hpke_public` = `f2e52868376523060a03d6ddcbaee000ddffe9f0fe3fec04a5d139a432c19873`. `sign_public` = `249ff29357de4ced21fd2e49eaca9944bb1957c2ef0b9b30e79220fef2c75d86`.
- The link is `https://<Takusen issuer origin>/invite/<code>#k=<base64url(invite_seed)>` (43 characters, no padding). `parseInviteKeyFragment` of `@hachiman/client/invite-link` checks the fragment. A browser does not send the fragment to the server. A script of the Takusen page hands it on to the app (§11 "Invite links").

**Record.** The creator device signs the record. The client sends it in the body of `POST /guilds/:id/invites` (§12.12).

```
struct {
  uint8  version = 1;
  opaque guild_id[16];
  opaque hpke_public[32];          // X25519
  opaque sign_public[32];          // Ed25519, the invite key id
  opaque channel_ids<V>;           // the scope: 16 bytes each, strictly ascending, 0 to 500
  uint64 admin_chain_seq;          // the seq of the admin state that the creator used (§12.16)
  uint64 expires_at_ms;            // 0 = permanent
  uint32 max_uses;                 // 0 = no limit
  opaque creator_user_id[16];
  opaque creator_device_id[16];
} InviteRecord;

struct {
  opaque record<V>;                // encode(InviteRecord)
  opaque signature<V>;             // SignWithLabel(creator device MLS signature key, "InviteRecord", record)
} SignedInviteRecord;
```

- The record has no invite code, because Takusen makes the code after the creator signs the record. The key id identifies the invite in all crypto objects.
- `channel_ids` are the text and pages channels that @everyone can view at creation, at most 500 (`INVITE_MAX_SCOPE_CHANNELS`). The order is the unsigned byte order of the 16-byte ids. A decoder rejects ids out of order and duplicate ids.
- A member accepts a record only after the checks of §12.16 ("Invite records").

**Scope.** Each member decides from its own MLS-authenticated group descriptor (§12.6), never from REST data:
- The `public_set` group of the guild is in the scope of each invite with history of that guild. Each channel of `public_set` is visible to @everyone (§12.6).
- A `channel` group is in the scope when its descriptor `channel_id` is in `channel_ids` and @everyone still has VIEW_CHANNEL on that channel in the current admin state (§12.16).
- A `dm` group is never in the scope.
- The redeemer holds the state of few groups. It decides from the group id of the bundle: the group id names the kind and the scope of the descriptor, and every member checks that it does (§12.6). The `public_set` group id must name the guild of the record. A `channel` group id must name a channel of `channel_ids` that @everyone still views. A channel id does not name its guild. Thus, in a group that the redeemer holds, the descriptor must also be in the scope, as for a member. For a group that it does not hold, the redeemer relies on Takusen: Takusen accepts only a record whose `channel_ids` are channels of its guild (§4 "Invite limits"), and refuses a bundle for a group of another guild (§12.12). The creator device does not check this: its admin state has no list of the channels of the guild. **Residual risk:** an administrator and a server that act together can give the redeemer wrong secrets for the channel group of another guild that the redeemer does not hold yet. When it joins that group later, an import never replaces these secrets (§12.11.1).

**Bundles.**

```
struct {
  uint8  version = 1;
  opaque sign_public[32];          // the invite key id
  opaque group_id<V>;
  HistoryKey keys<V>;              // §12.11.2: S_e, strictly ascending epochs, 1 to 4096 keys
  opaque sender_user_id[16];
  opaque sender_device_id[16];
} InviteBundleTBS;

struct {
  opaque tbs<V>;                   // encode(InviteBundleTBS)
  opaque signature<V>;             // SignWithLabel(sender device MLS signature key, "InviteBundle", tbs)
} InviteBundleContent;

struct {
  uint8  version = 1;
  opaque enc[32];
  opaque ciphertext<V>;            // HPKE base mode, §12.3 suite: Seal(pkR = hpke_public, info = "hachiman invite bundle v1",
                                   //   aad = sign_public ‖ group_id, pt = encode(InviteBundleContent))
} InviteBundle;
```

- The AAD and the signed TBS bind a bundle to one invite and one group. A server cannot move a bundle to another invite or to another group.
- Limits: 640 KiB for one bundle (`INVITE_BUNDLE_MAX_BYTES`). Takusen keeps at most 4 MiB of bundles per invite (`INVITE_BUNDLES_MAX_BYTES`) and deletes the oldest bundles above that. One sender user keeps at most 1 MiB of them, for all its devices together, unless it is the creator (§12.12). The redeemer gets the bundles only during 1 h after its guild join with the invite (`INVITE_BUNDLE_FETCH_WINDOW_MS`).

**Member devices.** The invite service of the crypto Worker (`src/invites/service.ts`) sends the bundles. Before each bundle, the device checks the record (§12.16) and decides the scope of the group from its own descriptor.
- **At creation.** After `POST /guilds/:id/invites`, the creator device sends one bundle for each scope group that it holds. The bundle has the stored epoch secrets of the group, at most `HISTORY_BUNDLE_MAX_EPOCHS` (the newest).
- **After each own commit.** The DS accepted a commit of this device in a scope group: a batch commit, a commit before a send, an own external commit (join or resync), or a commit that the device adopted after a crash. Then the device sends one bundle for each active invite of the guild (`GET /guilds/:id/invite-records`). The device keeps that list for 60 s, and `INVITE_DELETE` deletes it. The bundle has the secret of the new epoch. It also has the stored secrets of the epochs that are above the newest of two values and below the new epoch: `bundled` of the group in the list, and the newest epoch that this device sent for the group. Thus a bundle fills the epochs of a committer that sent no bundle (an old client).
- The device always sends the new epoch, also when `bundled` already has it: any reader can raise `bundled` with a bundle that does not open (§12.12). The device does not send an epoch again after it sent it.
- **Revoke.** `INVITE_DELETE` goes to the crypto Worker (§12.13). A device that has a row for the invite (it accepted the record before) marks the row revoked, and deletes the seed of a redeemer. Then it sends no more bundles for the invite, also when a server lists the invite again. A device with no row keeps nothing: it relies on Takusen, which lists the invite no more and deletes its bundles in the revoke transaction (§4). A server that ignores a revoke can as well not send `INVITE_DELETE`, so a mark on more devices adds no protection.
- **Timeline.** When a device accepts a record for the first time, it adds the event `invite_with_history` (actor: the creator, no subjects, `inviteKeyId`: the invite key id) to the membership timeline of each scope group that it holds. The key id keeps two invites of one epoch apart.
- After an own commit, a failure for one invite does not stop the others. The device reports it as an `error` event. At creation, the first failure stops `sendInviteBundles` (**API** below).

**Redeemer checks.** The redeemer runs these steps after `POST /invites/:code` (§4 accept). Before that join, it shares no guild with the creator, so it cannot get the keys of the creator (`GET /users/:id/keys`) or the admin chain of the guild. The client calls `redeemInvite` when the guild members are in its cache: the check needs the creator in `guildMembers`. While `guildMembers` does not have the redeemer itself, `redeemInvite` fails with `GroupPending`, and the client tries again after `GUILD_CREATE`. The redeemer gets `GET /invites/:code/bundles` and derives the two key pairs from the seed. It accepts the record only when `sign_public` and `hpke_public` of the record are the derived keys, and the record passes the checks of §12.16 (with the expiry grace of the redeemer). Thus the record, the seed and the bundles are bound: a server cannot give another record. For each bundle, the redeemer first requires that the group is in the scope (above: from the group id, and from the descriptor of a group that it holds). Then it opens the HPKE ciphertext with the AAD of the invite and the group, and requires all of these:
- `sign_public` of the TBS is the derived `sign_public`, and `group_id` of the TBS is the group of the AAD.
- The certificate of the sender device has a valid chain (§12.4), the device is not revoked, the trust of the sender is not `changed`, and the certificate names the sender ids of the TBS.
- The sender user is a guild member (`guildMembers`).
- The signature verifies under the MLS key of that certificate.

A bundle that fails a check is dropped alone. Any member reads `public_set` and can sign a bundle with wrong keys. A reader of a private channel can sign one for the group of that channel, but Takusen refuses a group outside the scope of the record (§12.12), and the redeemer drops it. Thus the redeemer limits the keys of each bundle that passes:
- It keeps only the epochs up to the bundle `epoch`. Takusen accepted that `epoch` only when it was not above the epoch of the group (§12.12). Thus a member alone cannot set the keys of a later epoch. A server that gives a wrong `epoch` can, and §12.11.1 limits that.
- In a group that the redeemer already holds, it keeps only the epochs below its current epoch. It gets the other secrets from its MLS state.
- When two bundles give a secret for one epoch, the bundle of the creator device wins, then the first bundle (the bundles come oldest first). A later bundle never replaces it.

The redeemer imports the keys that stay (`importHistoryKeys`, source `bundle`). Keys from an invite bundle give `membershipVerified` false, as keys from a history bundle (§12.11.2). **Residual risk:** a member can post a wrong secret for an epoch of a scope group that has no earlier stored bundle. These cases give such an epoch:
- The committer of the epoch did not post its bundle yet.
- An old client committed the epoch, or a member whose record list predates the invite. Their commits send no bundle, so the epoch waits for the bundle of a later commit.
- A cap of Takusen deleted the bundle of the committer (§12.12). Takusen accepts any epoch up to the epoch of the group, so a member can post wrong keys for a past epoch.
- A server that lies gives the bundles in another order.

The secret from the MLS state replaces a wrong one in each epoch that the redeemer enters (§12.11.1), so its sends and the later epochs stay correct. For the earlier epochs, the wrong secret has these effects:
- The redeemer cannot read the messages of that epoch. Each decrypt with the wrong secret is an AEAD failure. These failures count toward the fork alert and the automatic resync (§12.8.7), so a member can cause false fork alerts on the redeemer.
- The redeemer shares an imported secret as its own: in its backups (§12.11.3), in the history keys for its own new devices, in the history bundles that it sends (§12.11.2), and in the bundles of later invites. Thus a wrong secret can reach other devices and users. An import never replaces a stored secret, so a later import of the right secret does not repair a device that got the wrong one first.

**Later bundles.** At the redemption, some epochs can have no bundle yet: the epoch of a commit just before the redemption, of a commit between the redemption and the MLS join of the redeemer, or of a commit that sent no bundle (above). The bundle of a later commit fills them. Often that is the bundle of the commit that adds the redeemer, which comes after the redemption. Thus the redeemer gets `GET /invites/:code/bundles` again, with the same checks, 10 s after the redemption and 10 s after each own MLS join of a scope group (a Welcome, or an own external commit that is not a resync). A new cause in these 10 s moves the fetch. The redeemer keeps the invite code in its row for this. It fetches again only during `INVITE_BUNDLE_FETCH_WINDOW_MS` after the redemption, while it keeps the seed, and while the invite is not revoked. In a group with the history visibility `joined`, the redeemer cannot read an epoch that no bundle gives in that time.

The redeemer keeps the seed in its store for `INVITE_AUTH_WINDOW_MS` after the redemption (for the join authorization below), then deletes it: a timer at that time, and a check at each start of the Worker. `INVITE_DELETE` also deletes it (above).

**Join authorization.**

```
struct {
  uint8  version = 1;
  opaque signed_record<V>;         // SignedInviteRecord
  opaque signature<V>;             // SignWithLabel(invite sign key, "InviteAuth",
                                   //   encode(struct { opaque group_id<V>; opaque leaf_signature_key<V>; }))
} InviteAuth;
```

- The redeemer puts `InviteAuth` in the MLS `authenticated_data` of its external commit into a `channel` group of the scope. The FramedContent signature of the new leaf covers it. Nothing stays in the tree.
- The signature binds the group and the leaf key, so nobody can use it for another group or another leaf. Only a holder of the seed can sign it.
- The signature does not cover `signed_record`. A verifier checks the record separately: a member with the checks of §12.16, Takusen by a byte compare with the record that it stored for the invite. The signature key is `sign_public` of that record.
- A join with `InviteAuth` must come in the 24 h after the guild join of the redeemer with the invite (`INVITE_AUTH_WINDOW_MS`).
- **Why.** A user without a leaf gets into a `channel` group only by the Add of a member (§12.7.3). With no member online, the redeemer would wait. Most channels of a scope are in `public_set`, which any reader joins by external commit. A `channel` group is in the scope when @everyone views the channel but an overwrite hides it from a role (§12.6).
- **Redeemer.** After the import, `redeemInvite` syncs the groups (`GroupService.sync`). `sync()` and `ensureChannelGroup` take a `channel` group without state and with `member = false` (§12.7.8): when a redeemed invite of the guild names the channel, the device makes the `InviteAuth` for the group and its own MLS key, and joins by external commit at once. It does this only while it keeps the seed, the invite is not revoked, the record passes the checks of §12.16 now (with the expiry), and @everyone still views the channel in `S`. Else, or when the DS refuses the commit, the device posts a join request (§12.7.8). After a refusal with 403 `IllegalAdd` (for example a revoke that the device did not get, or a later guild join with another invite), the device does not try the `InviteAuth` for that group again until the Worker starts again. A resync does not carry the `InviteAuth`.
- **Takusen** accepts the external commit of a user without a leaf into a `channel` group only when all of these are true (§12.7.3 check 9). Else 403 `IllegalAdd`. It does not check the admin state of the record.
  - `DsModule.verifyInviteAuth` verifies the `InviteAuth` for the group and the key of the new leaf.
  - The invite with `key_id` = `sign_public` is of the guild of the group, and its stored record is byte-equal to `signed_record`.
  - The invite is not revoked and not expired. `exhausted_at` does not matter: the redeemer itself used the last use.
  - `channel_ids` of the record has the channel of the group.
  - The caller joined the guild with this invite (`guild_members.invite_id`), at most `INVITE_AUTH_WINDOW_MS` ago.
- **Members** check the `InviteAuth` before they apply the commit (`ProposalPolicy.inviteJoinKey`, `InvitePort.checkJoin`): the signature for the group and the new leaf key, the record with the checks of §12.16 without the expiry, the revoke mark of the device, and the scope (the channel of the descriptor is in `channel_ids`, and @everyone still views it in `S`). A member can process the commit long after the upload, and Takusen checked the expiry at the upload. The joiner must also be a reader (`channelReaders`, and `adminReaders` when the device has them). A failed fetch during the check (keys, guild members, admin chain) is not a verdict: the member does not apply the commit and processes it again at the next catch-up. The first check of a record adds the timeline event `invite_with_history` (above). The member gets the invite id for its row from `GET /guilds/:id/invite-records`, so that `INVITE_DELETE` marks the row.
- **A member that rejects the join only detects it.** It raises a fork alert (`commit_rejected`) and resyncs its own leaf, and the joiner stays in the tree (§12.7.9). The check of Takusen keeps a user without the seed out. A member rejects a valid join when it got a revoke of the invite or a demotion of the creator after the upload, and when it is an older client (§12.7.3 "Invite joins and older clients").

**API.** `CryptoApi.prepareHistoryInvite` makes the seed and signs the record. `CryptoApi.sendInviteBundles` sends the bundles of the creator device after `POST /guilds/:id/invites`. It rejects with the error of the first post that fails, so that the caller can revoke the invite. It returns the number of groups that it sent: 0 when the device holds no group of the scope. `CryptoApi.redeemInvite` runs after `POST /invites/:code`: it checks the record, opens the bundles and imports the keys. The Worker calls the routes through `DsTransport.inviteRecords`, `DsTransport.postInviteBundle` and `DsTransport.inviteBundles` (§12.12).

### 12.12 REST routes (Takusen, base `/api/v1`)

Every route here needs `Authorization`. The routes marked **D** also need the header `X-Hachiman-Device: <deviceId>` and its device proof (below). Takusen checks that the device belongs to the user and is not revoked (400 `DeviceRequired`, 403 `DeviceNotActive`), then the proof (401 `DeviceProofInvalid`), then the device binding of the bearer token. A `pending` device may call only these **D** routes (every other **D** route gives 403 `DeviceNotActive`):
- the device routes: `PATCH /devices/:id`, `PUT /devices/:id/certificate`, `POST /devices/:id/revoke`
- the link routes: `/devices/link-sessions` and its sub-routes
- `PUT /users/@me/master-key` (first device, and a new identity or a restore after a password reset)
- `GET /backups`, `GET /backups/:id` and `PUT /users/@me/device-signing-key`: a restore from the recovery key runs before the device has its certificate

**Device proof.** `X-Hachiman-Device` is only an id. Thus a stolen bearer token could name any device of the user. To prevent this, the device signs each request with its MLS signature key: the key of its device certificate, stored in `devices.mls_signature_key`. The client sends three headers:
- `X-Hachiman-Device-Ts`: the Unix time in milliseconds.
- `X-Hachiman-Device-Nonce`: 16 random bytes, base64url (22 characters).
- `X-Hachiman-Device-Sig`: the Ed25519 signature (base64url) of the message below.

The message is UTF-8 text. Its lines are joined by `\n`: `hachiman-device-proof/1`, `ds`, the device id, the HTTP method (upper case), the path and query as the server receives them (for example `/api/v1/devices/@me/inbox?after=3`), the ts, the nonce, and base64url(SHA-256(body bytes)). A request without a body hashes zero bytes. `deviceProofMessage` in `@hachiman/crypto` (`src/device-proof.ts`) builds it.

Takusen gives 401 `DeviceProofInvalid` when a header is missing or malformed, when the ts is more than 5 minutes from its clock, when the signature does not verify under `devices.mls_signature_key` (or the device has no key), or when the nonce was used before. Takusen remembers a nonce only after the signature verifies (Redis `takusen:device_nonce:{key}:{nonce}`, `SET NX`, TTL 10 min).

`POST /devices` is the only route that has a proof but no device id. Its body presents `mlsSignatureKey`, and the request must carry a proof by that key with the device id `""` in the message. Takusen stores the key in the new row. The certificate of the device must certify the same key later (`PUT /devices/:id/certificate` gives 400 `InvalidCertificate` for another key).

**Device binding.** Takusen binds each OIDC grant to the first device that the grant presents (Redis `takusen:grant_device:{grantId}`). After that, the grant can claim only that device, else 403 `DeviceNotActive`. One exception: a grant whose device is not active can move to a pending device, so a client that lost its store can register again. Each sign-in gets its own grant: the provider's `loadExistingGrant` loads only the grant of the current consent, not the grant of the browser session. The web app and the desktop app sign in through the same browser with the same client, so a shared grant bound the desktop's device to the web device. Thus every sign-in shows the consent screen.

The client signs in the crypto Worker (`CryptoApi.proveDevice`). The UI thread never holds the key. RestClient sends the proof on every request that sends `X-Hachiman-Device`, and on `POST /devices`.

Bytes are base64url. Errors use the §4 envelope with the codes of §12.19. Rate limits give 429 `RateLimited` with `Retry-After`.

CORS (§4) allows the request headers `X-Hachiman-Device` and `X-Hachiman-Signed-Action` and exposes `Retry-After`. Next route folders: `/devices/@me/inbox` and `/devices/@me/inbox/:id` live under `devices/[id]/inbox`, and the `[id]` handler accepts `@me` (as `users/[id]` does for `/users/@me`).

**Devices and keys**

| Method + path | D | Body | Returns | Publishes |
|---|---|---|---|---|
| POST `/devices` | | `{name, platform: 'electron'\|'browser', clientVersion, mlsSignatureKey}` (32 bytes) + a device proof by `mlsSignatureKey` | `Device` (201, status `pending`). At most 20 non-revoked devices (409 `TooManyDevices`) | — |
| GET `/devices` | | — | `Device[]` (own, revoked included) | — |
| PATCH `/devices/:id` | D | `{name}` | `Device` | — |
| PUT `/devices/:id/certificate` | D | `{certificate}` | `Device` (status `active`) | `USER_KEYS_UPDATE device_added` |
| POST `/devices/:id/revoke` | D | `{revocation: b64url \| null, reason}` (null only for a `pending` device) | 204 | `USER_KEYS_UPDATE device_revoked`; `DEVICE_REVOKED` → device:{id} |
| GET `/users/:id/keys` | | — | `UserKeys` | — |
| PUT `/users/@me/master-key` | D | `{record, dskCert}` | 204 | `USER_KEYS_UPDATE master_key_changed` |
| PUT `/users/@me/device-signing-key` | D | `{cert}` | 204 | `USER_KEYS_UPDATE dsk_rotated` |

- `PUT /devices/:id/certificate`: the caller is the device itself or another active device of the user. The certificate must verify under the current DSK. Thus a device can certify itself whenever it holds the DSK (first device, or a restore from the recovery key while old devices exist). Its keys must equal the keys of the link offer when a link session exists.
- `POST /devices/:id/revoke`: `revocation` is required. Reasons `user`, `lost` and `compromised` must verify under the current master key. Reason `signed_out` must be for the caller's own device and verify under the `mls_signature_key` of that device certificate (§12.4). Else 400 `InvalidRevocation`. Takusen deletes the key packages of the device, queues Removes in every group (§12.18), and the gateway closes the sessions of the device with 4013. Exception: a `pending` device has no certificate. It can revoke itself with `revocation: null` and reason `signed_out`. This affects only a device that holds no keys.
- `PUT /users/@me/master-key`: allowed in three cases. (1) The user has no master key row (first device). (2) The user has no current master key (after a password reset), and the record is either the most recent superseded record, byte-equal (restore), or generation + 1 with `prev_signature` null (new identity). (3) `record.prev_signature` verifies under the current master key (rotation). Else 409 `MasterKeyExists`. The DSK cert in the body must verify under the record.
- `PUT /users/@me/device-signing-key`: the cert must verify under the current master key and have generation + 1. Takusen deletes the stale key packages of the user and publishes `KEY_PACKAGES_LOW` (§12.7.2).
- `PATCH /devices/:id`: changes only the REST name (§12.5 "Device names").
- `GET /users/:id/keys`: the caller must share a guild or a DM with the user, or be the user. Else 404 `NotFound`. A client treats the 404 as a user without keys: a group can still hold a leaf of a former member until its Remove is committed (§12.7.5). Each `ktIndex` has the encoded `KtEntry` beside it (`ktEntry`), so the client can compute the leaf hash (§12.14).

**Batch rejections** (`POST /mls/groups/:groupId/commits` and `POST /mls/batches/:id/decline`):
- `rejected` names the joins of `MLS_BATCH_ASSIGN.joins` that the committer left out, by `pendingId`. Only the commit body has it.
- `rejectedProposals` names the DS proposals of `MLS_BATCH_ASSIGN.proposals` that the committer refused (a bad chain or a malformed key package), by `proposalRef`: base64url of the RFC 9420 ProposalRef of the proposal MLSMessage (`mls_pending.proposal_ref`). The proposals carry no `pendingId`, so the ref is the name. Both bodies can have it. `DsTransport.declineBatch` of `@hachiman/crypto` does not send it yet.
- Takusen accepts a report only from the assigned committer of the batch, and only for items of that batch that the commit did not apply. It ignores other entries. It marks only Adds as rejected: a DS Remove is a Takusen decision, so it ignores the ref of a Remove proposal. A rejected Add of a join request gets `MLS_JOIN_UPDATE` status `rejected` with the reason. The next batch leaves the rejected items out.
- Takusen checks each `not_reader` rejection of an Add. It computes the readers of the group itself (`channelReaders`, or the guild members for `public_set`, §12.6). When the user of the Add is a reader, the rejection is false. Takusen does not reject the Add: the Add goes back to `queued`, and its join request stays open. The report gets one strike for the committer device in `takusen:mls_false_reject:{deviceId}` (§5). The next batch goes to the next committer: on a decline, the decline puts the device in the cooldown (§12.7.5 step 6). On a commit, Takusen keeps an expired batch row for the device, so the device is in the cooldown for 60 s. The scheduler gives no more batches to a device with 3 strikes (`FALSE_REJECTION_LIMIT`) and logs it. Takusen accepts the other reasons as the committer gives them.
- On a commit, Takusen marks the rejections in the transaction of the commit. On a decline, it marks them before it expires the batch.
- `@hachiman/crypto` (`WireCommitRequest.rejected: BatchRejection[]`) and `@hachiman/client` (`CommitRequest.rejected`) accept both forms in one list: `{pendingId, reason}` or `{proposalRef, reason}`. `RestClient.postCommit` sends the `proposalRef` entries as `rejectedProposals` on the wire.
- **Body size.** The Takusen middleware does not run for `POST /mls/groups/:groupId/commits`, because Next.js truncates every body that middleware sees at 10 MB, and the ratchet tree can be 8 MiB (about 10.7 MB as base64url). The route applies the same CORS policy itself, as `POST /uploads` does (§4).

**MLS**

| Method + path | D | Body | Returns | Publishes |
|---|---|---|---|---|
| GET `/mls/ds` | | — | `DsInfo` | — |
| POST `/mls/key-packages` | D | `{cipherSuite, keyPackages: b64url[] (≤ 100), lastResort: b64url \| null}` | `{stored, total}` | — |
| GET `/mls/key-packages/count` | D | — | `{cipherSuite, count, lastResort}[]` | — |
| GET `/mls/groups` | D | — | `MlsGroup[]` that the user reads, `member` per the caller's device | — |
| GET `/mls/groups/:groupId` | D | — | `MlsGroup` | — |
| GET `/channels/:id/mls-group` | D | — | `MlsGroup` (the current group of the channel), or 404 `UnknownGroup` | — |
| GET `/mls/groups/:groupId/state?epoch=` | D | — | `GroupState` (latest when no epoch). 410 `EpochNotKept` | — |
| POST `/mls/groups` | D | `CreateGroupRequest` | `MlsGroup` (201). 409 `GroupExists` | `MLS_GROUP_UPDATE` |
| POST `/mls/groups/:groupId/commits` | D | `CommitRequest` | `{epoch, seq}` (201). 409 `EpochConflict {epoch}` | `MLS_HANDSHAKE`; `DEVICE_INBOX` per Welcome |
| GET `/mls/groups/:groupId/handshakes?after=&limit=` | D | — | `{handshakes: Handshake[], latestSeq}`. `limit` ≤ 200 (default 100). 410 `HandshakesExpired` | — |
| POST `/mls/groups/:groupId/join-requests` | D | `{keyPackage}` | `JoinRequest` (202). 403 `GroupFull` (§12.7.8) | `MLS_JOIN_UPDATE` |
| GET `/mls/join-requests/:id` | D | — | `JoinRequest` | — |
| POST `/mls/batches/:id/decline` | D | `{reason: 'not_synced'\|'busy', rejectedProposals?}` | 204. 410 `BatchExpired` | `MLS_BATCH_ASSIGN` → next device; `MLS_JOIN_UPDATE` per rejected Add |
| POST `/mls/groups/:groupId/history-bundles` | D | `{epoch, blob}` | 201. One per (group, epoch, sender) | — |
| GET `/mls/groups/:groupId/history-bundles?epoch=` | D | — | `HistoryBundle[]` | — |

**Device inbox, backups, linking**

| Method + path | D | Body | Returns | Publishes |
|---|---|---|---|---|
| GET `/devices/@me/inbox?after=&limit=` | D | — | `InboxItem[]` (ascending `seq`, `limit` ≤ 100) | — |
| DELETE `/devices/@me/inbox/:id` | D | — | 204 | — |
| POST `/devices/:id/inbox` | D | `{kind: 'dsk_transfer'\|'history_keys', body}` | 204. Same user only. 413 `InboxFull` | `DEVICE_INBOX` → device:{id} |
| GET `/backups` | D | — | `BackupIndex` | — |
| PUT `/backups/identity` | D | `{keyId, blob}` | 204 | — |
| POST `/backups/history` | D | `{keyId, groupId, epochFrom, epochTo, blob}` | `{id}` (201). 409 `WrongBackupKey` when `keyId` differs from the stored key id | — |
| GET `/backups/:id` | D | — | `{blob}` | — |
| DELETE `/backups` | D | — | 204 | — |
| POST `/devices/link-sessions` | D | `{offer}` (by the new device) | `{id, expiresAt}` (201) | `DEVICE_LINK` → user:{me} |
| GET `/devices/link-sessions` | D | — | `LinkSession[]` (open sessions of the user) | — |
| POST `/devices/link-sessions/:id/messages` | D | `{body}` | `{seq}`. 410 `LinkExpired` | `DEVICE_LINK` → device:{peer} |
| GET `/devices/link-sessions/:id/messages?after=` | D | — | `LinkMessage[]` | — |
| DELETE `/devices/link-sessions/:id` | D | — | 204 | — |

**Key transparency, admin actions, reports** (Phase 4, §12.14, §12.16)

| Method + path | D | Body | Returns |
|---|---|---|---|
| GET `/kt/tree-head` | | — | `KtTreeHead` |
| GET `/kt/inclusion?index=&treeSize=` | | — | `KtInclusionProof` |
| GET `/kt/consistency?from=&to=` | | — | `KtConsistencyProof` |
| GET `/kt/entries?userId=&after=&limit=` | | — | `KtEntry[]` (`limit` ≤ 1000) |
| GET `/kt/entries?start=&end=` | | — | `KtEntry[]` (auditors, at most 1000 per call) |
| GET `/guilds/:id/admin-actions?after=&limit=` | | — | `AdminAction[]` with `seq > after`, ascending (member only). `after` default -1 (from the genesis). `limit` default 100, at most 1000 |
| POST `/reports` | D | `{messageId, content, frankingKey, reason}` | `{id, verified}` (201) |

**Invites with history** (§12.11.4). Takusen stores the records and the sealed bundles. It cannot open a bundle. The record of an invite comes with `POST /guilds/:id/invites` (§4 "Invite limits").

| Method + path | D | Body | Returns |
|---|---|---|---|
| GET `/guilds/:id/invite-records` | | — | `InviteRecord[]` (member only): the invites of the guild with a record that are not revoked, expired or exhausted |
| POST `/invite-records/:inviteId/bundles` | D | `{groupId, epoch, blob}` (`blob`: an `InviteBundle`, at most 640 KiB) | 204 |
| GET `/invites/:code/bundles` | | — | `InviteBundles` |

- `GET /guilds/:id/invite-records`: `bundled` gives the newest stored bundle epoch of each group of the invite. A member device sends only the epochs after it. `bundled` is only a hint: any reader of the group can raise it with a bundle that does not open. Thus the device that made the commit of an epoch always sends the bundle of that epoch, also when `bundled` already has the epoch.
- `POST /invite-records/:inviteId/bundles`: the caller reads the group (else 404 `UnknownGroup`), and `epoch` is not above the epoch of the group (else 400 `ValidationError`). The group is of the guild of the invite, and the invite is active and has a record, else 404 `UnknownInvite`. The group is in the scope of the stored record (`DsModule.parseInviteRecord`), else 400 `ValidationError`: the `public_set` group, or a `channel` group whose channel is in `channel_ids`. Without this check, a reader of a private channel could post wrong keys for its group. Members also check that @everyone still views the channel, and the redeemer checks the scope again (§12.11.4). Takusen locks the invite row (`FOR NO KEY UPDATE`), so a revoke cannot leave a bundle behind, and two posts cannot pass the caps together. After the insert, Takusen deletes the oldest bundles of the sender user until they are at most 1 MiB together (`INVITE_BUNDLES_SENDER_MAX_BYTES` in `lib/invite-history.ts`), unless the caller is the creator of the invite. The share counts the bundles of all devices of the user, also of revoked devices. Thus more devices, or a new device, do not give more space. Every member reads `public_set`, so without this share one member could push the bundles of the creator out of the cap. Then Takusen deletes the oldest bundles of the invite until they are at most 4 MiB together (`INVITE_BUNDLES_MAX_BYTES`). **Residual risk:** members who act together can still push the bundles of the creator out. Four users always can, and fewer users can when the creation bundles are large.
- `GET /invites/:code/bundles`: only for a member whose membership row names the invite (`guild_members.invite_id`, §4 accept), during 1 h after the join (`INVITE_BUNDLE_FETCH_WINDOW_MS`), and only while the invite is not revoked. An exhausted or expired invite still gives its bundles in that hour. Every other case is 404 `UnknownInvite`. The bundles come oldest first.
- Retention: a revoke deletes the bundles of the invite (§4). The daily sweep of the gRPC process deletes the bundles of revoked invites, and of invites that expired or were exhausted more than 1 h before.

**Wire shapes.** These are the TS types in `pkgs/hachiman-crypto/src/api.ts` (`Wire*`). `@hachiman/client` exports the same shapes without the `Wire` prefix (§10).

```ts
interface Device { id; userId; status: 'pending' | 'active' | 'revoked'; name; platform: 'electron' | 'browser'; clientVersion;
  certificate: string | null; revocation: string | null; revokeReason: 'user' | 'lost' | 'password_reset' | 'compromised' | 'signed_out' | null;
  createdAt; lastSeenAt: string | null; revokedAt: string | null }
interface UserKeys { userId; masterKey: { generation; record; ktIndex: number | null; ktEntry: string | null } | null;
  deviceSigningKey: { generation; cert; ktIndex: number | null; ktEntry: string | null } | null;
  devices: { id; status; certificate: string | null; revocation: string | null;
    ktIndex: number | null; ktEntry: string | null; revocationKtIndex: number | null; revocationKtEntry: string | null }[] }
interface DsInfo { externalSender; cipherSuites: number[]; ktPublicKey; ktRequired: boolean;
  limits: { maxEnvelopeBytes; maxInboxItemBytes; maxHistoryBundleBytes; maxBackupBlobBytes; keyPackageTarget; keyPackageLowWater } }
interface MlsGroup { groupId; kind: 'public_set' | 'channel' | 'dm'; guildId: string | null; channelId: string | null; generation: number;
  cipherSuite: number; status: 'pending' | 'active' | 'retired'; epoch: number | null; historyVisibility: 'joined' | 'shared';
  latestSeq: number; member: boolean }
interface GroupState { groupId; epoch; groupInfo; ratchetTree }
interface CreateGroupRequest { groupId; kind; guildId: string | null; channelId: string | null; cipherSuite; groupInfo; ratchetTree; assignmentId: string | null }
type BatchRejectReason = 'invalid_chain' | 'not_reader' | 'revoked' | 'policy' | 'malformed'
interface CommitRequest { epoch; commit; groupInfo; ratchetTree; welcome: string | null; batchId: string | null;
  rejected: { pendingId; reason: BatchRejectReason }[]                 // joins (Adds by value), at most 200
  rejectedProposals?: { proposalRef; reason: BatchRejectReason }[] }   // DS proposals, at most 200, default []
interface Handshake { seq; epoch; kind: 'commit' | 'external_commit' | 'proposal'; senderDevice: string | null; message;
  next: { treeHash; confirmedTranscriptHash } | null; createdAt }
interface JoinRequest { id; groupId; deviceId; status: 'queued' | 'committed' | 'rejected' | 'external_commit' | 'waiting'; reason: string | null; createdAt }
interface InboxItem { id; seq; kind: 'welcome' | 'dsk_transfer' | 'history_keys'; senderDevice: string | null; body; createdAt }
interface BackupIndex { keyId: string | null; items: { id; kind: 'identity' | 'history'; groupId: string | null; epochFrom: number | null; epochTo: number | null; size; createdAt }[] }
interface HistoryBundle { id; groupId; epoch; senderDevice; blob; createdAt }
interface LinkSession { id; newDeviceId; offer; createdAt; expiresAt }
interface LinkMessage { seq; fromDevice; body; createdAt }
interface KtTreeHead { treeSize; timestamp; rootHash; signed }
interface KtInclusionProof { leafIndex; treeSize; auditPath: string[] }
interface KtConsistencyProof { from; to; proof: string[] }
interface KtEntry { index; userId; type: 1 | 2 | 3 | 4; entry; createdAt }
interface AdminAction { guildId; seq; action; createdAt }
interface InviteRecord { inviteId; keyId /* sign_public */; record /* SignedInviteRecord */; expiresAt: string | null; bundled: { groupId; epoch }[] }
interface InviteBundles { inviteId; record /* SignedInviteRecord */; bundles: { groupId; epoch; blob /* InviteBundle */; senderDevice }[] }
```

**Rate limits** (per device unless noted): key package upload 10/min, commits 30/min, join requests 30/min, inbox posts 60/min, link messages 30/min, link sessions 5/hour per user, reports 10/hour per user, backups 60/hour, invite bundle posts 120/min. Each per-device limit also has a per-user limit for all devices of the user together: key package upload 30/min, commits 90/min, join requests 90/min, inbox posts 180/min, link messages 90/min, backups 120/hour, invite bundle posts 360/min. Thus a user cannot get more requests with more devices. A request must be in both limits.

### 12.13 Gateway

**IDENTIFY** `d`: `{ token, deviceId, capabilities: string[], clientVersion: string, deviceProof: { ts, nonce, sig } }`. **RESUME** `d`: `{ token, sessionId, seq, deviceId, deviceProof: { ts, nonce, sig } }`.

The gateway checks, in this order:
1. The token (non-200 from Takusen gives 4004).
2. `capabilities` includes `e2ee/1`, and `clientVersion` is a semver at or above `GATEWAY_MIN_CLIENT_VERSION` (default `0.1.0`). Else close 4012. The shared UI sends the `version` of `apps/hachiman/package.json` (now `1.0.0`).
3. The `devices` row exists, belongs to the user and is not `revoked`. Else close 4013. `pending` devices are allowed (linking). A missing or malformed `deviceId` fails this check.
4. `deviceProof` verifies under `devices.mls_signature_key` (the key of the §12.12 device proof). Else close 4004. The message is UTF-8 text. Its lines are joined by `\n`: `hachiman-device-proof/1`, `identify`, the device id, the session id (RESUME) or `""` (IDENTIFY), the ts, the nonce, and base64url(SHA-256(token)). `ts` is Unix milliseconds, and the gateway rejects a ts more than 5 minutes from its clock. `nonce` is 16 random bytes, base64url. The gateway rejects a nonce that it saw before (Redis `device_nonce:{deviceId}:{nonce}`, `SET NX`, TTL 10 min, set only after the signature verifies). A device without a key fails this check. Close 4004 makes the client connect again with a new token and a new proof.

RESUME runs checks 1, 3 and 4 only (the session passed check 2 at IDENTIFY). A RESUME without `deviceId` gives 4013. A `deviceId` that passes check 3 but differs from the `deviceId` of the stored session gives INVALID_SESSION(false). A missing session also gives INVALID_SESSION(false). READY adds `deviceId`.

**Revocation race.** Check 3 can pass just before Takusen commits a revocation. Thus, on IDENTIFY and on RESUME, the gateway does check 3 again after it subscribes the session (it then receives `DEVICE_REVOKED`) and before it sends READY or RESUMED. Either this lookup sees the revocation (close 4013), or the session gets the `DEVICE_REVOKED` event. If the lookup fails (a database error), the gateway closes with 4000, so the client tries again.

**Close codes:** 4012 client unsupported (no `e2ee/1`, or the version is too old). 4013 device unknown or revoked. Clients do not reconnect after 4012 or 4013.

**Device scope.**
- The gateway stores `deviceId` in `session:{sessionId}`. It sets `device_online:{deviceId}` (string, the session id, TTL 90 s, refreshed on each heartbeat) and deletes it when the session ends.
- It `PSUBSCRIBE`s `device:*` and delivers each event to every session of that device.
- The internal event `DEVICE_REVOKED {deviceId}` on `device:{id}` is not forwarded. The gateway closes the sessions of the device with 4013.
- The internal event `VOICE_DISCONNECTED {sessionId, channelId, jti}` on `device:{id}` comes from a media node (§8 "Call end"). It is not forwarded.

**Dispatch events.**

| t | d | Published to |
|---|---|---|
| MLS_HANDSHAKE | `{ groupId, seq, epoch, kind, senderDevice, message: string \| null /* null above 32 KiB */, next }` | `public_set`: guild:{g}. `channel`: guild:{g} with `channelId` (VIEW_CHANNEL filter). `dm`: user:{p} for each participant |
| MLS_GROUP_UPDATE | `MlsGroup` | the same as MLS_HANDSHAKE |
| MLS_BATCH_ASSIGN | `{ batchId, groupId, epoch, proposals: string[], joins: {pendingId, userId, deviceId, keyPackage}[], create: {...} \| null, historyBundleEpochs: number[], deadline }`. `proposals` are DS proposals that are already in the handshake stream (§12.7.4). `joins` are Adds by value (`channel`, `dm`) | device:{committer} |
| MLS_JOIN_UPDATE | `{ requestId, groupId, status, reason }` | device:{joiner} |
| DEVICE_INBOX | `{ id, seq, kind }` | device:{recipient} |
| DEVICE_LINK | `{ sessionId, seq, fromDevice }` | user:{me} on session create, then device:{peer} |
| USER_KEYS_UPDATE | `{ userId, kind: 'device_added' \| 'device_revoked' \| 'master_key_changed' \| 'dsk_rotated', deviceId: string \| null }` | user:{owner}, guild:{g} for each guild of the owner, user:{p} for DM partners |
| KEY_PACKAGES_LOW | `{ deviceId, cipherSuite, remaining }` | device:{id} |
| KT_TREE_HEAD | `KtTreeHead` | user:{owner} of each entry that the head covers for the first time. The gRPC process publishes it after it signs the head (Phase 4) |
| INVITE_DELETE | `{ guildId, code, inviteId }` (§6). The shared UI also gives it to the crypto Worker: the Worker marks the invite revoked and sends no more bundles for it (§12.11.4) | guild:{g} |

### 12.14 Key transparency (Phase 4)

Takusen keeps an append-only Merkle log (RFC 6962 hashing) of every key change. Clients check that the keys they use are in the log, and that the log is consistent.

```
struct {
  uint8 version = 1;
  uint8 type;                      // 1 master key, 2 DSK cert, 3 device certificate, 4 device revocation
  opaque user_id[16];
  uint64 timestamp_ms;
  opaque object<V>;                // the encoded signed object
} KtEntry;

leaf_hash  = SHA-256(0x00 ‖ encode(KtEntry))
node_hash  = SHA-256(0x01 ‖ left ‖ right)          // RFC 6962 §2.1 MTH

struct {
  uint8 version = 1;
  uint64 tree_size;
  uint64 timestamp_ms;
  opaque root_hash[32];
} TreeHeadTBS;

struct {
  TreeHeadTBS tbs;
  opaque signature<V>;             // SignWithLabel(KT key, "TreeHead", encode(tbs))
} SignedTreeHead;
```

- Takusen appends an entry in the same transaction as each `PUT /users/@me/master-key`, `PUT /users/@me/device-signing-key`, `PUT /devices/:id/certificate` and `POST /devices/:id/revoke`. `ktIndex` in `UserKeys` points to the entry, and `ktEntry` holds its encoding (the leaf hash covers `timestamp_ms`, which only the entry gives).
- The append takes the transaction advisory lock `pg_advisory_xact_lock(<KT lock id>)` and then allocates `idx = max(idx) + 1`. Thus two appends never get the same index, and the log has no gaps.
- The KT key is `TAKUSEN_KT_SIGNING_KEY` (seed path, default `.dev/keys/takusen-kt.ed25519`, the seed rules of §12.7.1). `GET /mls/ds` returns its public key. Clients pin it.
- **KT is required.** `GET /mls/ds` also returns `ktRequired`. It is true when the DS has a KT signing key. Takusen always has one (it makes a seed when none exists), so Takusen always sends true. The client pins `ktRequired` per origin with the KT key. The pin is sticky: a later `false` does not turn KT off. When the pin is true, KT fails closed:
  - The client pins the first signed tree head that it gets (TOFU). Each later head must be consistent with it.
  - Each master key record, DSK cert and active device certificate that the client accepts needs a `ktEntry` and an inclusion proof. A key object without a KT entry is rejected (`InvalidChain`) and raises `ktAlert` (`kt_missing`).
  - When the client has no stored head and the DS sends none (404 or no `KT_TREE_HEAD`) after two waits, the key object is rejected and the client raises `ktAlert` (`kt_missing`).
  - A client that pinned `ktRequired: false` (a DS without KT) skips the proofs until it stores its first head. From then on, the proofs are required.
- **Residual risk.** An inclusion proof shows that an object is in the log. It does not show that the object is the newest entry of the user. A DS can serve an old DSK cert or hide a revocation entry. Self-monitoring finds this for the own user only.
- Only the gRPC process signs tree heads. A timer runs every 10 s. When entries were appended after the newest head, it signs a head that covers all of them, stores it in `kt_tree_heads`, and publishes `KT_TREE_HEAD` to the owners of the new entries (§12.13). The Next process never signs heads.
- A new entry is in no signed head for up to 10 s. A client that gets no inclusion proof for an entry (the index is not below the newest `tree_size`) waits for the next `KT_TREE_HEAD` and tries again. It does not trust the key object until the proof passes. In Phase 4, a failed proof after two heads raises `ktAlert` (`bad_proof`).
- Inclusion and consistency proofs are RFC 6962 §2.1.1 and §2.1.2 audit paths.
- **Client checks.**
  - Before a client trusts a fetched key object, it gets an inclusion proof against a signed tree head at least as new as its stored head.
  - It checks consistency from its stored head to each newer head, and stores the newer head.
  - **Self-monitoring:** every 24 h and on each `USER_KEYS_UPDATE` or `KT_TREE_HEAD` for its own user, a device reads `GET /kt/entries?userId=<self>&after=<last index>`. An entry that no own device made raises `ktAlert` (`self_unknown_entry`).
  - **Gossip:** a sender puts its latest signed tree head in `EnvelopeContent.kt_tree_head`, at most once per hour per group. A receiver checks consistency with its own head. Two heads of the same size with different roots, or a failed consistency proof, raise `ktAlert` (`split_view`).

### 12.15 X-Wing suite (Phase 4)

- `TAKUSEN_MLS_SUITES` lists the enabled suites (default `1`, Phase 4 `1,83`). `GET /mls/ds` returns the list.
- Devices upload key packages for each enabled suite that they support. ts-mls supports suite 83 (`smoke.spec.ts`).
- Each group records its suite (`mls_groups.cipher_suite`). The DS selects it, because clients cannot see the key packages of other devices. It selects 83 when the DS enables it and every reader device has a suite-83 key package (`key_packages` counts), else 1. The assignment `create.cipherSuite` carries the choice, and the creator uses it.
- The DS never queues an Add of a device that has no key package in the suite of the group (§12.7.2).
- A group never changes suite. To upgrade, Takusen makes a new generation of the group (as a channel move, §12.6). The daily sweep of the gRPC process starts an upgrade for a suite-1 group when suite 83 is enabled and every reader device has a suite-83 key package.
- X-Wing protects key agreement against a future quantum attack. Signatures stay Ed25519. The Hachiman derivations (§12.3) do not depend on the suite.

### 12.16 Signed admin actions and message franking (Phase 4)

**Signed admin actions.** Role data is not signed today, so a malicious server can trick a member device into an Add. Signed actions close this gap.

```
struct {
  uint8 version = 1;
  opaque guild_id[16];
  uint64 seq;                      // 0 = genesis, then +1
  uint8 type;                      // 0 genesis, 1 role_create, 2 role_update, 3 role_delete, 4 role_reorder,
                                   // 5 overwrite_put, 6 overwrite_delete, 7 member_roles, 8 channel_history_visibility
  opaque actor_user_id[16];
  opaque actor_device_id[16];
  uint64 timestamp_ms;
  opaque prev_hash[32];            // SHA-256(encode(previous AdminAction)), zero bytes for seq 0
  opaque payload<V>;               // the new state, below
  opaque signature<V>;             // SignWithLabel(actor MLS signature key, "AdminAction", encode(all fields above))
} AdminAction;
```

Payloads: genesis `{opaque owner_id[16]}`. Role: `{opaque role_id[16]; uint64 permissions; uint32 position}` (delete: `role_id` only). Reorder: `{RolePosition positions<V>}` with `struct { opaque role_id[16]; uint32 position; } RolePosition`. Overwrite: `{opaque channel_id[16]; opaque target_id[16]; uint8 target_type /* 1 role, 2 member */; uint64 allow; uint64 deny}` (delete: no `allow`/`deny`). Member roles: `{opaque user_id[16]; opaque role_ids<V> /* 16-byte ids */}`. History visibility: `{opaque channel_id[16]; uint8 history_visibility}`.

- The client sends the encoded action in the header `X-Hachiman-Signed-Action` on the matching route (§4: roles, overwrites, member roles, channel PATCH). The header holds one base64url action, or two separated by a comma: the genesis, then the action of the request. The two-action form is for the first signed request of a guild. Takusen checks the signature under the actor device certificate, that the action matches the request, and that `seq` and `prev_hash` continue the chain. It stores the action in `admin_actions` in the same transaction. Else 409 `AdminActionConflict` or 400 `InvalidAdminAction`. The header is optional until the guild has a genesis action, then it is required on each request that changes signed state.
- **Which requests change signed state.** `POST /guilds/:id/roles` (`role_create`), a role PATCH only when it has `permissions` (`role_update`), the role reorder (`role_reorder`), a role DELETE (`role_delete`), an overwrite PUT or DELETE (`overwrite_put`, `overwrite_delete`), a member PATCH only when it has `roles` (`member_roles`), and a channel PATCH with `historyVisibility` (`channel_history_visibility`). Other fields of these routes are not signed. `hoist` changes no permission: a role PATCH with only `name`, `color` or `hoist` needs no `X-Hachiman-Signed-Action`, and the `role_create` payload does not carry `hoist`.
- **Match rules.** A signed `role_create` names the role id, and `POST /guilds/:id/roles` creates the role with that id (it must be a new UUID). The `role_reorder` positions and the `member_roles` role ids match the request as sets: the order does not matter. The `target_type` of an `overwrite_delete` payload is the type of the existing overwrite.
- **History visibility.** `PATCH /channels/:id` `historyVisibility` and `PATCH /guilds/:id` `publicHistoryVisibility` write `mls_groups.history_visibility`. That column is only the REST mirror. Members change the group descriptor with a GCE commit (§12.6). The guild `publicHistoryVisibility` has no admin action type, and it is not signed.
- **No permission replay on Takusen.** Takusen does not replay the permissions of signed actions. The REST permission checks on the unsigned state stay authoritative. Takusen checks only the signature, the chain continuity and the match with the request.
- The guild owner's client writes the genesis action when it creates the guild: it calls `CryptoApi.signAdminAction` after `POST /guilds` and posts the action with the first signed request, or with `PATCH /guilds/:id` and no other change.
- `@hachiman/crypto` holds the codecs, `sign`, `verify`, `hash` and `replay` (`AdminActionModule`, `src/admin/`). Takusen verifies with `DsModule.verifyAdminAction`. The client signs with `CryptoApi.signAdminAction(guildId, type, payload)`, which fetches the chain head and fills `seq` and `prev_hash`.
- **Client check.** A client replays the chain from genesis. Each action needs a valid signature, a valid actor chain, and an actor that had the permission in the state before the action (§2 rules, owner from genesis). Before a client commits an Add in a `channel` group, it checks that the replayed state gives the joiner VIEW_CHANNEL (`ProposalPolicy.adminReaders`). The replay applies the §2 rules through `@hachiman/client/permissions`, so each language keeps one permission implementation. The replay accepts actions from an actor device that was revoked later: it does not check revocations. `// ponytail:` the Phase 4 audit must decide if an action of a device that is now revoked stays valid.
- **Unchecked bits.** The replay treats USE_SOUNDBOARD as a bit that every actor holds: a grant of it never fails the "grants only held bits" check. The genesis @everyone role has `DEFAULT_EVERYONE`, which includes USE_SOUNDBOARD. A state that a device cached before the bit joined `DEFAULT_EVERYONE` has an @everyone role without it, and the server gave the bit to the existing @everyone roles with no signed action (§2). Without this rule, such a cached state, or a signed @everyone `role_update` from before the change, would reject a later honest grant of the bit by a non-administrator, and the chain would fail on some devices only. No client check reads USE_SOUNDBOARD from the signed state: REST is authoritative for it. Thus the signed state and REST can disagree on this bit only. A future bit that joins `DEFAULT_EVERYONE` and that no signed check reads gets the same rule. A bit that a signed check reads must not join `DEFAULT_EVERYONE` with a server-side backfill: the guild administrators grant it with a signed `role_update`.
- **Signed permissions in the UI.** `CryptoApi.adminGuildPermissions(guildId, userId)` returns the §2 guild permissions of a user in the verified admin state `S`, or null when the guild has no verified genesis. The UI uses it for a check that the server must not decide: the MANAGE_EXPRESSIONS of a sound pointer sender (§12.21). MANAGE_EXPRESSIONS is in the signed role payloads like every other bit, so a server cannot grant it to a user without a signed action of an actor who holds it.
- **No genesis: fail closed.** Every guild is created with E2EE, so the owner genesis action must be present. A device that has no cached admin state can get an empty chain from the DS. The device does not fall back to the unsigned REST readers for its own commits. When the device has no verified genesis for the guild, it does not commit an Add in a `channel` group. It rejects each Add of the batch (`policy`) and reports `admin_chain_missing` (`error` event). The device still processes commits of other devices with the unsigned REST state, and the UI timeline shows "A added B". `public_set` groups do not use the admin chain (§12.11.2).
- **Invite records.** A device checks a `SignedInviteRecord` (§12.11.4) against its current verified admin state `S` of the guild (`adminState`). It does not replay a historic state. It accepts the record only when all of these are true:
  - `guild_id` is the guild of the check: for a member, the guild of the record list (`inviteRecords(guildId)`); for a redeemer, the guild of the record that the seed binds, which is the guild that it joined with the invite (the admin chain is for members only). `S` and the scope groups come from that guild only.
  - `S` exists (a guild with no verified genesis fails closed), and `admin_chain_seq` ≤ `S.seq`.
  - The creator has ADMINISTRATOR in `S`, and the creator is a guild member.
  - The certificate of the creator device has a valid chain (§12.4, key transparency on first contact, §12.14). The device is not revoked, and the trust of the creator is not `changed`. The signature verifies under the MLS key of the certificate, and the certificate names `creator_user_id` and `creator_device_id`.
  - `expires_at_ms` is 0 or in the future, and the device did not get a revoke of the invite. The redeemer also accepts a record that expired less than `INVITE_BUNDLE_FETCH_WINDOW_MS` ago: Takusen gives the bundles of an expired invite for 1 h after the join (§12.12).
- A device runs these checks before each bundle that it sends, and the redeemer before it imports bundles. The redeemer runs them before it joins with an `InviteAuth`, and a member before it applies such a join, without the expiry (§12.11.4 "Join authorization"). The signature check is cached per key id and `S.seq`. The other checks run each time.
- **Invite scope.** A scope channel counts only while @everyone has VIEW_CHANNEL on it in `S`: the @everyone role and the @everyone overwrite only, with no other role and no member overwrite (`AdminPermissionModel.everyoneChannelPermissions`). The signed `channel_ids` limit the scope, and a later role or overwrite change can only remove channels from it. A creator who loses ADMINISTRATOR stops the invite on the next check. The "at `admin_chain_seq`" state adds nothing: an administrator could sign a new record now.

**Message franking.**

```
franking_tag = HMAC-SHA256(franking_key, "hachiman franking v1" ‖ channel_id(16) ‖ client_msg_id(16) ‖ encode(EnvelopeContent))
```

- Every envelope carries `franking_tag` in the header and `franking_key` in the plaintext. Takusen stores the tag with the message.
- **Report.** `POST /reports {messageId, content, frankingKey, reason}`: `content` is the encoded `EnvelopeContent` and `frankingKey` the key. Takusen computes the HMAC and compares it with the stored tag in constant time. `verified` is the result. It stores the report with the revealed content. A match proves that the author's device sent this content in this channel, because only the sender chose the key and the tag is bound to the message.
- The reporter forwards the content. There is no client-side scanning.

### 12.17 Clients, hosts and deferred items

- **DsTransport adapter.** The main thread implements `DsTransport` over `RestClient`. It maps 404 `UnknownGroup` from `GET /channels/:id/mls-group` to `null` (`getGroupForChannel`).
- **Worker.** All key material lives in the `@hachiman/crypto` Worker. The UI thread never holds private keys. The UI holds decrypted content and attachment pointers.
- **Exception: the invite seed** (§12.11.4). It crosses the UI thread as opaque base64url text, as the recovery key does. `prepareHistoryInvite` returns it once, and `redeemInvite` takes it. The UI keeps it only in component state or in an in-memory map, and puts it only in the link fragment `#k=`. It never goes into a Zustand store or `localStorage`. Only the browser sign-in redirect keeps it in `sessionStorage`, until the sign-in callback. The next start-up deletes a key that no callback used (§11). The creator Worker does not store the seed.
- **One tab per device.** The bridge takes the Web Lock `hachiman-crypto:{origin}:{userId}`. A second tab gets `CryptoError` `LockHeld` and shows "open in another tab". Two Workers on one store would fork the group state.
- **Store.** IndexedDB, one database per (origin, user). Each record is AES-256-GCM under the non-extractable wrap key from `IPlatformService.secureStorage` (§11), with a random 12-byte nonce. The AAD is `encode(struct { opaque table<V>; opaque key<V>; })`, so the AAD is injective. The wrap key is used directly. There is no HKDF step, because a non-extractable AES-GCM key cannot be an HKDF input.
- **Store table `invites`** (key: the invite key id). The records that the device accepted, the newest epoch that it sent per group (`bundled`), the revoke flag, and for a redeemer the invite code and the seed. The seed stays until `INVITE_AUTH_WINDOW_MS` after the redemption, or until `INVITE_DELETE`. The device deletes the row 30 days after the expiry of the invite (`HANDSHAKE_RETENTION_MS`: Takusen keeps handshakes for 30 days, §12.7.9). Until then, an invite join that the DS accepted before the expiry can come in the handshake stream: the row keeps the revoke mark, and the timeline event of the record goes only once into each group. The table came with database version 2: an upgrade adds the table and keeps the other records.
- **Browser host.** The browser host shows the label "trusts the server's code", because a hostile server can send hostile JavaScript. The Electron host is the strong client. `CryptoStatus.hostTrust` gives the value. One exception applies to both hosts: a clicked invite link opens the Takusen page `/invite/<code>` in a browser, and a script of that page reads the invite seed (§11). Only a link that the user pastes into the Electron app does not go through Takusen.
- **CSP.** Electron (rules in `apps/hachiman-electron/src/main/csp-policy.ts`, applied by `csp.ts`, §11) adds `worker-src 'self'`, and `blob:` to `img-src` and `media-src` (decrypted attachments are object URLs). It does not add `blob:` to `script-src` or `worker-src`. The browser host sends the same policy. ts-mls, @noble and @hpke are pure TypeScript on WebCrypto and use no wasm. `script-src` has `'wasm-unsafe-eval'` only for the RNNoise mic worklet (§11), which holds no key material. Both hosts build the crypto Worker and the transform Worker with Vite (`new Worker(new URL(…, import.meta.url), { type: 'module' })`).
- **Light clients.** Deferred until ts-mls supports partial trees: joining with a membership proof, and processing commits without the full ratchet tree (IETF MLS light clients draft). The condition is testable: the `smoke.spec.ts` case "needs the full ratchet tree to join" fails when support exists. Until then, every member holds the full tree, and the Phase 3 load test measures its size.
- **Later:** search (a local index), sender-made link previews, content-free push.

### 12.18 Takusen internal seams

The DS lives in `apps/takusen/src/lib/mls/`. The storage seam is `MlsRepo` (`lib/mls/repo.ts`) with a Drizzle and an in-memory implementation, as `MediaNodesRepo` (§9). Other Takusen code calls only these exports:

```ts
// lib/mls/readers.ts — a thread id gives the result of its parent (§12.6 Thread)
export async function channelReaders(executor: Executor, channelId: string): Promise<Set<string>>   // user ids
export async function isPublicChannel(executor: Executor, channelId: string): Promise<boolean>      // §12.6 rule
export async function groupReaders(executor: Executor, groupId: Uint8Array): Promise<Set<string>>

// lib/mls/device-auth.ts
export async function requireDevice(req: Request, userId: string, opts?: { allowPending?: boolean }): Promise<DeviceRow>

// lib/mls/membership.ts — call inside the route transaction, after the write
export type MembershipChange =
  | { kind: 'guild_created'; guildId: string }
  | { kind: 'guild_member_added' | 'guild_member_removed' | 'member_roles_changed'; guildId: string; userId: string }
  | { kind: 'role_changed' | 'role_deleted'; guildId: string; roleId: string }
  | { kind: 'overwrites_changed' | 'channel_created'; channelId: string }
  | { kind: 'channel_deleted'; guildId: string; channelId: string }
  | { kind: 'guild_deleted'; guildId: string }
  | { kind: 'dm_created'; channelId: string }
  | { kind: 'user_deleted'; userId: string }
  | { kind: 'devices_revoked'; userId: string; deviceIds: string[] | 'all'; reason: RevocationReason }
export async function onMembershipChange(tx: Tx, change: MembershipChange, actorDeviceId: string | null): Promise<void>
export async function wakeScheduler(tx: Tx): Promise<void>    // after the transaction commits: flushes the work of that transaction only
export function discardMembershipWork(tx: object): void       // after a rollback: drops the work of that transaction unpublished

// lib/mls/envelopes.ts
type EnvelopeInputBase = { channelId: string; userId: string; deviceId: string /* X-Hachiman-Device */; envelope: Uint8Array }
export type EnvelopeInput =
  | (EnvelopeInputBase & { edit: false })                               // a send
  | (EnvelopeInputBase & { edit: true; rowClientMsgId: Uint8Array })    // an edit: the client_msg_id of the stored row
export async function acceptEnvelope(tx: Tx, input: EnvelopeInput):
  Promise<{ groupId: Uint8Array; epoch: number; senderDeviceId: string; clientMsgId: Uint8Array; frankingTag: Uint8Array; size: number }>   // throws ApiError (§12.8.4)
// The page envelope header checks (§12.20). doc_awareness never reaches Takusen
export type DocEnvelopeInput = { channelId: string; pageId: string; userId: string; deviceId: string; kind: 'doc_update' | 'doc_snapshot' | 'doc_title'; envelope: Uint8Array }
export async function acceptDocEnvelope(tx: Tx, input: DocEnvelopeInput):
  Promise<{ groupId: Uint8Array; epoch: number; senderDeviceId: string; size: number }>   // throws ApiError (§4 Pages)

// lib/errors.ts + lib/api-helpers.ts
export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, message?: string, readonly extra?: Record<string, unknown>, readonly retryAfterSec?: number)
}
// errorResponse(err) maps ApiError to `{ error: code, message?, ...extra }` (for example `{epoch}` or `{userIds}`) and sets `Retry-After`.
```

- `onMembershipChange` recomputes the readers of each affected group. It queues Removes for devices of users who lost VIEW_CHANNEL, and Adds for new reader devices of `channel` and `dm` groups. It reclassifies channels that moved between public and private (§12.6), and it retires the groups of deleted guilds and channels.
- `user_deleted` runs before the user row is deleted, in the same transaction. It queues a Remove (keyed by leaf index, §3) for every leaf of every device of the user in every group. The `mls_pending` and `mls_group_members` rows keep their leaf index when the FKs set the device and user to null. The Removes stay valid, and §12.7.3 check 8 accepts the orphan leaves until a commit removes them.
- `guild_deleted` retires the groups of the guild and deletes their DS rows in the same transaction. The FK cascades delete the rest.
- `devices_revoked` with `'all'` is the password reset path (`lib/password-reset.ts`). The reset also calls `revokeUserSessions`. A password change (`account/actions.ts`) revokes the other sessions of the user and keeps the devices.
- **Password reset seam.** The reset calls `onMembershipChange(tx, { kind: 'devices_revoked', userId, deviceIds: 'all', reason: 'password_reset' }, null)` in the transaction that sets the password. After the commit it calls `wakeScheduler(tx)`. After a rollback it calls `discardMembershipWork(tx)`, so nothing of a rolled-back transaction is published.
- **Outbox per transaction.** `onMembershipChange` records its events and wakeups in an outbox keyed by the transaction handle. `wakeScheduler(tx)` publishes only that outbox. `discardMembershipWork(tx)` drops it. Each route that calls `onMembershipChange` calls one of the two.
- An edit passes `rowClientMsgId`: the edit header must repeat that `client_msg_id` (§12.8.6), and the uniqueness check is skipped.
- `DsModule.checkCommit` takes `masterKeys(userId)`: the current raw 32-byte master public key of the user, or null. `DsModule.verifyMasterKeyRecord(record, prev)` takes as `prev` the encoded previous `MasterKeyRecord` (not a public key), or null.
- `DsModule.verifyInviteRecord(signedRecord, creatorCertificate)` decodes a `SignedInviteRecord` (§12.11.4) and verifies its signature under the encoded `DeviceCertificate` of the creator device. The certificate must name the creator ids of the record. It returns the record as `InviteRecordView` (ids as text, keys as base64url, `keyId` = `sign_public`), or null. Takusen does not check the admin state of the record: members do (§12.16).
- `DsModule.parseInviteRecord(signedRecord)` decodes a `SignedInviteRecord` without the signature check and returns the `InviteRecordView`. It throws `CryptoError` `Malformed`. Takusen uses it only for a record that it verified before it stored it: the scope check of a bundle post (§12.12).
- `DsModule.checkCommit` returns `authenticatedData`: the `authenticated_data` of the commit, which the commit signature covers (empty for most commits). `DsModule.verifyInviteAuth({ authenticatedData, groupId, leafSignatureKey })` decodes an `InviteAuth` (§12.11.4) and verifies its signature for the group and the new leaf key under `sign_public` of its record. It returns `{ keyId, signedRecord, record }` (`record` as `InviteRecordView`), or null. It does not verify the creator signature of the record: Takusen compares `signedRecord` with the stored record of the invite (`MlsRepo.getInviteByKeyId`, `MlsRepo.inviteJoinedBy`).
- The scheduler, the KT tree-head timer and the daily sweeps run in `apps/takusen/src/grpc/main.ts`. The gRPC process subscribes to `takusen:mls_wakeup`. The payload on that channel is raw JSON `{ groupId }` (base64url), not a `{t, d}` event envelope.
- Takusen imports `@hachiman/crypto/ds` as TypeScript source. Other code can import the pure entry points `@hachiman/crypto/admin` (§12.16, Takusen uses it), `@hachiman/crypto/franking`, `@hachiman/crypto/constants` and `@hachiman/crypto/codec`. They use no Worker-only or ts-mls code. `apps/takusen/next.config.ts` lists `@hachiman/crypto` in `transpilePackages`. The import graph of `src/mls/ds.ts` uses only `globalThis.crypto` and excludes `src/attachments`, `src/store`, `src/worker`, `src/bridge` and `src/media`.

**Env (Takusen):** `TAKUSEN_DS_SIGNING_KEY`, `TAKUSEN_KT_SIGNING_KEY`, `TAKUSEN_MLS_SUITES` (default `1`), `TAKUSEN_MAX_ENVELOPE_BYTES` (default 32768), `TAKUSEN_PUBLIC_SET_MAX_MEMBERS` (default 500, `docs/e2ee-load-test.md`), `TAKUSEN_MLS_BATCH_INTERVAL_MS` (default 2000), `TAKUSEN_MLS_BATCH_TIMEOUT_MS` (default 5000), `TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES` (default 104857600), `TAKUSEN_GUILD_PAGE_STORAGE_BYTES` (default 10737418240, 0 = no limit). **Gateway:** `GATEWAY_MIN_CLIENT_VERSION` (default `0.1.0`). **Media:** `MEDIA_WS_READ_LIMIT` (default 1048576). Add each one to `.env.example`.

### 12.19 Error codes

| Code | Status | When |
|---|---|---|
| `DeviceRequired` | 400 | the route needs `X-Hachiman-Device` and the header is missing |
| `DeviceNotActive` | 403 | the device is pending (for a route that needs active), revoked, or of another user |
| `DeviceProofInvalid` | 401 | the device proof (§12.12) is missing or malformed, its ts is more than 5 minutes off, its signature does not verify under the device MLS key, or its nonce was used before |
| `UnknownDevice` | 404 | no such device |
| `TooManyDevices` | 409 | 20 non-revoked devices |
| `InvalidCertificate` | 400 | a certificate, DSK cert or master record does not decode or verify |
| `InvalidRevocation` | 400 | the revocation is missing or does not verify (master key, or the device key for `signed_out`) |
| `MasterKeyExists` | 409 | a master key exists and the new record has no valid `prev_signature` |
| `StaleDeviceSigningKey` | 409 | the certificate uses a DSK generation that is not current |
| `InvalidKeyPackage` | 400 | decode, suite, identity, key or signature check failed |
| `NoKeyPackage` | 404 | a device has no one-time and no last-resort key package |
| `UnknownGroup` | 404 | no such group, or the caller cannot read it |
| `GroupExists` | 409 | `POST /mls/groups` for a group id that exists |
| `GroupPending` | 409 | the group of the channel is not active yet |
| `GroupRetired` | 410 | the group is retired |
| `GroupFull` | 403 | a `public_set` join above `TAKUSEN_PUBLIC_SET_MAX_MEMBERS` leaves |
| `EpochConflict` | 409 | another commit won the epoch. Body: `{error, epoch}` |
| `EpochNotKept` | 410 | the state of that epoch is gone |
| `InvalidCommit` | 400 | a §12.7.3 structure check failed. `message` names the check |
| `IllegalMembership` | 403 | the next roster has a user who must not be a member. Body: `{error, userIds}` |
| `IllegalAdd` | 403 | an Add or external commit that the policy forbids |
| `IllegalRemove` | 403 | a Remove that the policy forbids |
| `HandshakesExpired` | 410 | `after` is older than the retained handshakes |
| `UnknownBatch` | 404 | no such batch, or it is not assigned to the caller |
| `BatchExpired` | 410 | the batch deadline passed or the epoch changed |
| `InboxFull` | 413 | the recipient inbox is above 8 MiB, or the item is above 1 MiB |
| `InvalidEnvelope` | 400 | the envelope header does not decode or does not match the route |
| `EnvelopeTooLarge` | 413 | above `TAKUSEN_MAX_ENVELOPE_BYTES` |
| `StaleEpoch` | 409 | the envelope epoch is not accepted (§12.8.4). Body: `{error, epoch}` |
| `NotMember` | 403 | the sender device has no leaf in the group |
| `DuplicateMessage` | 409 | `client_msg_id` exists in the channel |
| `BackupTooLarge` | 413 | a backup limit of §12.11.3 |
| `WrongBackupKey` | 409 | the `keyId` differs from the stored backup key id |
| `LinkExpired` | 410 | the link session is gone |
| `UnknownInvite` | 404 | an invite bundle route (§12.12) for an unknown invite, or one that the caller may not use |
| `InvalidAdminAction` | 400 | the action does not decode, verify or match the request |
| `AdminActionConflict` | 409 | `seq` or `prev_hash` does not continue the chain |
| `RateLimited` | 429 | a §12.12 rate limit. Header `Retry-After` |
| `NotPagesChannel` | 400 | a page route on a channel that is not of type `pages` (§4 Pages) |
| `PageExists` | 409 | `POST /channels/:id/pages` with an `id` that is taken |
| `PageCycle` | 400 | a page move into its own subtree |
| `SnapshotConflict` | 409 | the snapshot `baseSeq` is not above the current one, or above `latest_seq`. A re-wrap with another `uploadId`, or not in a newer epoch (§4 Pages). Body: `{error, baseSeq}` (the current one) |
| `PageConflict` | 409 | `PATCH /pages/:pageId` with an `ifUpdatedAt` that is not the `updatedAt` of the page |
| `StorageQuotaExceeded` | 413 | a page upload claim above `TAKUSEN_GUILD_PAGE_STORAGE_BYTES` |
| `TooManyPins` | 400 | a pin past 50 pins in the channel (§4 Pins, guild events and blocks) |
| `Blocked` | 403 | a DM open or a 1:1 DM message with a block in either direction (§4 Pins, guild events and blocks) |
| `Banned` | 403 | `POST /invites/:code` of a user who is banned from the guild (§4 Bans) |

**Client error codes.** The `@hachiman/crypto` Worker rejects with `CryptoError` (`CryptoErrorCode` in `src/api.ts`). `dsCode` holds the REST code above when the cause was a DS response. Two codes have no REST cause:
- `LockHeld`: the Web Lock refused the store, because it is open in another tab (§12.17).
- `Internal`: an exception inside the Worker that carried no `CryptoErrorCode` (a bug).

### 12.20 Page envelopes

A pages channel (§4 Pages) sends its titles, edits, snapshot pointers and presence as page envelopes in the MLS group of the channel (§12.6). The format is that of §12.8.1, with its own magic, a kind byte and the page id in the header:

```
struct {
  uint16 magic = 0x4802;           // DOC_ENVELOPE_MAGIC. A message envelope (0x4801) never decodes as one
  uint8 kind;                      // 1 doc_update, 2 doc_snapshot, 3 doc_awareness, 4 doc_title
  opaque group_id<V>;              // 22 bytes
  opaque channel_id[16];
  opaque page_id[16];
  uint64 epoch;
  uint32 sender_leaf;
  opaque sender_device_id[16];
  opaque salt[32];                 // random per envelope
} DocEnvelopeHeader;

struct {
  DocEnvelopeHeader header;
  opaque ciphertext<V>;            // AES-256-GCM(K_doc, nonce = 12 zero bytes, aad = encode(header), encode(DocPlaintext))
} DocEnvelope;

struct {
  opaque body<V>;                  // by kind, below
  uint64 sent_at_ms;               // sender clock, display only
} DocContent;

struct {
  DocContent content;
  opaque signature<V>;             // SignWithLabel(sender MLS signature key, "DocEnvelope",
                                   //   SHA-256(encode(header)) ‖ SHA-256(encode(content)))
} DocPlaintext;
```

**Bodies.**
- `doc_update`: one Yjs update (`Y.encodeStateAsUpdate` form, often a `Y.mergeUpdates` of the edits of 100 ms).
- `doc_snapshot`: UTF-8 JSON of `DocSnapshotPointer { uploadId, fileKey, sha256, size }`. `fileKey` (32 bytes) and `sha256` (of the whole blob) are base64url, and `size` is the plaintext bytes of the state. The blob is the Yjs state (`Y.encodeStateAsUpdate`) in the §12.9 format.
- `doc_awareness`: one y-protocols awareness update. The state holds the user id, display name, color, cursor and selection.
- `doc_title`: the UTF-8 title, 1 to 200 bytes (`MAX_PAGE_TITLE_BYTES`).

Page labels ("RFC", "Draft") are page content: they are in the Y.Doc (`Y.Map` `meta`, key `labels`, at most 5 strings of at most 24 characters), so `doc_update` and `doc_snapshot` carry them encrypted, and no route or event carries them.

**Key.** The derivation of §12.8.2 with another label:

```
PRK   = HKDF-Extract(salt = header.salt, IKM = S_e)
K_doc = HKDF-Expand(PRK, info = "hachiman doc key v1" ‖ uint32(sender_leaf), L = 32)
```

The labels differ, so `K_doc` never equals a `K_msg`. Each envelope has its own salt and key, so the nonce is zero.

**Send.** `CryptoApi.encryptDoc({ channelId, pageId, kind, bytes })` runs `GroupService.sendState(channelId)` first, as a message send does (pending Removes are committed, §12.7.4). It returns `{ envelope, groupId, epoch }`. An envelope above `Limits.maxEnvelopeBytes` (8192 base64url characters for `doc_awareness`) throws `CryptoError('TooLarge')`. A Yjs update that does not fit goes into a snapshot instead. On 409 `StaleEpoch`, the client catches up and encrypts again.

**Server checks.** Takusen decodes only the header (`acceptDocEnvelope`, §12.18), as `acceptEnvelope` does for messages (§12.8.4): the size, `magic` 0x4802, the kind of the route (§4 Pages), the current and active group of the channel, `channel_id` = the route channel, `page_id` = the route page (the body `id` on create), the epoch rule of §12.8.4, and the sender device and leaf. It stores `group_id`, `epoch`, `sender_device` and the envelope. Takusen never sees `doc_awareness` envelopes: the gateway relays them (§6 op 5) and checks only their size.

**Receive.** `CryptoApi.decryptDoc(items)` gives one `DocDecryptResult` per `EncryptedDocItem { id, channelId, pageId, kind, senderDevice, envelope }`, in order:
1. **Header.** It does not decode, or the magic is wrong: `malformed`. `channel_id` differs from the item: `wrong_channel`. `page_id` differs: `wrong_page`. The kind differs from the item kind: `wrong_kind`. The item `senderDevice` is not null and differs from `sender_device_id`: `device_mismatch`.
2. **Epoch secret.** As §12.8.5 step 2: `pending` with `epoch_ahead`, `group_unknown`, `no_history_key` or `transport`.
3. **Decrypt.** A failed tag: `failed` `aead`, and the failure counts toward the fork alert (§12.8.7). A plaintext that does not decode, or a body that breaks the rules above: `malformed`.
4. **Sender.** The verified certificate of `sender_device_id`, with the revoked-sender rule of §12.8.5 step 4: else `invalid_chain`.
5. **Signature.** Else `bad_signature`.

An `ok` result has `{ id, kind, bytes, sender }`: the body bytes and the `DecryptedSender`. The UI thread gets decrypted content only, never a key.

**Access by new members.** A member that joined in epoch N has no `S_e` for older epochs when the group is `joined`. Thus the members encrypt the current state of each page again in the current epoch. The new member then needs only the newest snapshot and the updates after it. It does not get the edit history before the snapshot. The snapshot blob has its own `fileKey`, so a member re-wraps the small pointer envelope, not the blob.
- **Trigger.** `GroupService` emits the Worker event `usersAdded { groupId, kind, guildId, channelId, epoch, userIds, byMe }` after a commit in a `public_set` or `channel` group that adds a leaf of a user that had no leaf before (an Add, or an external commit join). It emits it for a commit of another device (`byMe: false`), for an own batch commit (`byMe: true`) and for an own commit that it adopts from the stream (§12.7.9). It does not emit it for an own join, a Welcome, a create, a resync or a new device of a member. The UI finds the pages channels of the group (`Channel.mlsGroupId`, type `pages`) in which the user has VIEW_CHANNEL and SEND_MESSAGES.
- **Who and when.** The committer runs the pass at once, and again after `ADD_ONLY_EPOCH_GRACE_MS` + 2 s, because a member can still post in the old epoch for that time (§12.8.4). Every other member that processes the commit runs the pass after a random 12 to 20 s. When no member is online (an external commit join), the first member that processes the commit runs it. One pass per group runs at a time. A pass skips the pages that are current, and Takusen accepts one re-wrap per page and epoch.
- **The pass**, for each pages channel: `ensureChannelGroup` gives the current group and epoch, and `GET /channels/:id/pages/heads` (§4 Pages) gives the pages. For each page:
  1. An open page resyncs, and its provider does step 2 or 3 for it.
  2. Updates after the newest snapshot (`latestSeq` above the snapshot `baseSeq`, 0 without a snapshot), and no snapshot or a snapshot of an older epoch or group: the client loads the page without showing it and posts a full snapshot when the snapshot or an update after it is of an older epoch or group. An update of the old epoch can follow a snapshot of the current epoch only inside the epoch grace. Thus only the second pass of the committer also loads a page whose snapshot is of the current epoch. In an external commit join no member commits, and step 1 on the open pages does this work.
  3. No update after the newest snapshot, and the snapshot is of an older epoch or group: a pointer re-wrap. The client decrypts the pointer, and continues only when the result is `ok` and the pointer `uploadId` is the `uploadId` of the row. It encrypts the same bytes again and posts them with the same `baseSeq` and `uploadId` (§4 Pages "Re-wrap"). 409 `SnapshotConflict` means that another member was first.
  4. A title envelope of an older epoch or group (from the heads): the client decrypts the title, encrypts the same bytes again and sends `PATCH /pages/:pageId { titleEnvelope, ifUpdatedAt }` with the `updatedAt` that it read with `GET /channels/:id/pages`. The client reads the page list first, then the heads again, and re-wraps only the titles that are still of an older epoch or group. Thus a rename before the second heads read gives a current title, and a rename after the list read gives 409 `PageConflict`, which skips the page.
- **Verified content only.** The re-wrapper signs each envelope as its sender. Thus it re-wraps only a pointer or a title that is `ok` on its device. A `pending` or `failed` result is skipped.
- **The new member.** Until a member re-wraps a page, the client of the new member shows "Waiting for a member to share this page". A waiting page loads again after a random 10 to 30 s, then after twice the last wait, at most every 5 min. A `PAGE_UPDATE` of the page (for example a title re-wrap) also makes it load again, and does not make the next wait longer. A load reads the state (`GET /pages/:pageId/state`) again, so a newer snapshot that covers an update without a key opens the page. A page that already shows its content and gets an update without a key (an update of the old epoch inside the epoch grace) stays open and retries the same way. A page that shows its content and finds a newer snapshot that does not open (a failed decrypt, or a pointer of another `uploadId`) skips that snapshot and keeps its content and status. When the snapshot blob of such a reload fails, the next load also uses the slow retry.
- **Titles of the new member.** A title re-wrap can come before the device of the new member joins the group. The title then stays `pending` `group_unknown`. Doc envelopes do not go into the `buffered` table, so no `epochKeysAvailable` follows the join. Thus the client decrypts its pending titles again when the Worker reports a `membership` event that names this device (a Welcome, an own external join or a create).
- **The other members.** A re-wrapped title is of the new epoch. A member whose Worker did not apply the commit yet gets `pending` `epoch_ahead` for it. Doc envelopes do not go into the `buffered` table, so no `epochKeysAvailable` follows. Thus the client calls `ensureChannelGroup` once for the channel (it fetches the handshakes) and then decrypts the pending titles again. Until a title decrypts, the client shows the title that it decrypted before. A channel that is still ahead after this gets no new catch-up until a decrypt of its titles finds none ahead, or until READY or RESUMED. Thus a title that stays ahead does not cause a loop.
- A removed member gets no new envelope, because the re-wrap is in an epoch without its leaf.

**Page activity in a channel.** An editor can tell a text channel that it edited a page. It sends a message envelope of kind 4 `page_activity { pageId, changes }` (§12.8.1) in that channel, not a page envelope. The sender sends at most one per page per 10 minutes. `changes` counts the local Yjs updates of that time (1 to 10000). The receiver shows the line only for a page that it can open, and decrypts the title with `decryptDoc` as for the page list. The server sees a normal message row.

**Residual risk.** The server can withhold updates, or serve an older title envelope (a rollback of a rename). It cannot forge, change or move an envelope to another page or channel, because the header is the AAD and the sender signs it. A replayed update does no harm, because Yjs ignores an update that it already has. A member who can edit can damage a page. This includes a re-wrap with a false pointer for the `uploadId` of the newest snapshot: the page then does not open until a member posts a new snapshot. The previous snapshot (§4 Pages) is the recovery path. A re-wrap does not change the blob. Thus a removed member that kept an old `fileKey` can open that blob when the server gives it the blob.

### 12.21 Sound pointers

A soundboard sound (§4 Soundboard) is a clip in the §12.9 blob format with its own random file key. The pointer to the blob is a page envelope (§12.20) of kind `doc_snapshot` in the `public_set` group of the guild:

- `channel_id` is a public text or pages channel of the guild (its current group is the `public_set` group). `page_id` is the sound id.
- The body is UTF-8 JSON of `SoundPointer { uploadId, fileKey, sha256, size, mime }`: `fileKey` (32 bytes) and `sha256` (of the whole blob) base64url, `size` the plaintext bytes, `mime` `audio/mpeg`, `audio/ogg` or `audio/wav`.
- **Send.** The uploader calls `encryptDoc({ channelId, pageId: soundId, kind: 'doc_snapshot', bytes })` and posts the envelope with the sound (§4).
- **Receive.** A member calls `decryptDoc` with `{ id: soundId, channelId, pageId: soundId, kind: 'doc_snapshot', senderDevice, envelope }` of the `GuildSound`. It uses the pointer only when the result is `ok`, its `uploadId` is the `uploadId` of the sound, the sender is a guild member in the cache, and the sender has MANAGE_EXPRESSIONS in the verified admin state (`CryptoApi.adminGuildPermissions`, §12.16). The REST roles do not count: else a malicious server could give MANAGE_EXPRESSIONS to an account that it added to the `public_set` group, and members would play its pointers. A guild with no verified genesis fails closed: the soundboard shows the sound as unavailable. It then decrypts the blob with `decryptAttachment`. The UI keeps the decrypted audio in memory only.
- **Why this group.** The `public_set` group has every guild member, so one envelope serves the whole guild, and the server never sees the file key. No new crypto API or envelope kind is necessary. The page id of a sound never names a page: the page routes bind the page id of the route, so the server cannot serve a sound pointer as a page snapshot, and the decrypt check `wrong_page` refuses the reverse.
- **Residual risk.** The envelope is of the epoch of the upload. A member who joined later reads it with the epoch secrets of a history bundle (`shared` history, the `public_set` default). With `joined` history, or a device without the bundle, the result is `pending` `no_history_key`, and the soundboard shows the sound as unavailable. No member re-wraps a sound pointer (a later change). A removed member that kept the file key can decrypt the blob when the server gives it the blob. A sound plays inside the SFrame-encrypted microphone track of the sender (§12.10), so the media node does not see it either.
