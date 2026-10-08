// Takusen REST client. Contract: docs/gateway-protocol.md §4 and §12.12.
import type {
  AdminAction,
  CreateGuildSoundRequest,
  GuildSound,
  Attachment,
  B64url,
  BackupIndex,
  Ban,
  BlockedUser,
  Channel,
  CipherSuiteId,
  CommitRequest,
  CommitResult,
  CreateGroupRequest,
  CreateGuildEventRequest,
  Device,
  DevicePlatform,
  DeviceProver,
  DocSnapshot,
  DocUpdatePage,
  DsInfo,
  GroupState,
  Guild,
  GuildEventWithMe,
  GuildFull,
  HandshakePage,
  HistoryBundle,
  HistoryVisibility,
  InboxItem,
  InboxKind,
  Invite,
  InviteBundles,
  InvitePreview,
  InviteRecord,
  JoinRequest,
  KtConsistencyProof,
  KtEntry,
  KtInclusionProof,
  KtTreeHead,
  Limits,
  LinkMessage,
  LinkSession,
  Member,
  Message,
  MlsGroup,
  Page,
  PageHead,
  PageState,
  ProposalRejection,
  RevocationReason,
  Role,
  UpdateGuildEventRequest,
  User,
  UserKeys,
} from './types'

/** Must resolve to a fresh, valid Takusen access token. */
export type TokenProvider = () => Promise<string>

/**
 * Non-2xx response. `code` is the body's `error` field (e.g. `MissingPermissions`) or `HTTP_<status>`.
 * `details` holds the other body fields (e.g. `{ epoch }` or `{ userIds }`, §12.19).
 * `retryAfterSec` comes from the `Retry-After` header (429 RateLimited), else null.
 */
export class RestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    readonly retryAfterSec: number | null = null,
  ) {
    super(message ?? code)
    this.name = 'RestError'
  }
}

function restError(status: number, body: unknown, retryAfter: string | null): RestError {
  const obj =
    body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const { error, message, ...details } = obj
  return new RestError(
    status,
    typeof error === 'string' ? error : `HTTP_${status}`,
    typeof message === 'string' ? message : undefined,
    details,
    parseRetryAfter(retryAfter),
  )
}

/** RFC 9110 §10.2.3: delay-seconds or an HTTP date. Returns whole seconds, or null. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v)
  // IMF-fixdate and RFC 850 dates end in GMT. Date.parse alone accepts "-1" as a year.
  if (!v.endsWith(' GMT')) return null
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

// `| undefined` on optionals so callers can spread partial form state under exactOptionalPropertyTypes.
type Opt<T> = T | undefined

/** Phase 4 (§12.16): the encoded AdminAction for the header X-Hachiman-Signed-Action. */
export interface SignedActionOptions {
  signedAction?: Opt<B64url>
}

export interface CreateGuildBody {
  name: string
  region?: Opt<string>
}
export interface UpdateMeBody {
  /** Upload id, or null to clear. */
  avatar?: Opt<string | null>
}
export interface UpdateGuildBody {
  name?: Opt<string>
  /** Upload id, or null to clear. */
  icon?: Opt<string | null>
  /** Upload id, or null to clear. */
  banner?: Opt<string | null>
  region?: Opt<string | null>
  publicHistoryVisibility?: Opt<HistoryVisibility>
}
export interface CreateChannelBody {
  name: string
  type: 'text' | 'voice' | 'category' | 'pages'
  parentId?: Opt<string | null>
  topic?: Opt<string | null>
}
export interface UpdateChannelBody {
  name?: Opt<string>
  topic?: Opt<string | null>
  parentId?: Opt<string | null>
  position?: Opt<number>
  /** Only for a channel with its own group (§4). */
  historyVisibility?: Opt<HistoryVisibility>
}
/** POST /channels/:id/threads (§4 Threads). */
export interface CreateThreadBody {
  name: string
  /** A message in the parent channel that starts the thread. */
  startMessageId?: Opt<string | null>
}
export interface ChannelPosition {
  id: string
  position: number
  parentId?: Opt<string | null>
}
export interface OverwriteBody {
  type: 'role' | 'member'
  allow: number
  deny: number
}
export interface MessageQuery {
  before?: Opt<string>
  limit?: Opt<number>
}
export interface SendMessageBody {
  envelope: B64url
  nonce?: Opt<string>
  /** Upload ids from {@link RestClient.uploadBlob}: per pointer, the file id and then its thumbnail id. */
  attachments?: Opt<string[]>
}
export interface UploadProgressOptions {
  signal?: Opt<AbortSignal>
  onProgress?: Opt<(loaded: number, total: number) => void>
}
export interface UploadImageOptions extends UploadProgressOptions {
  filename: string
}
export interface BanBody {
  /** At most 512 characters. */
  reason?: Opt<string | null>
}
export interface UpdateMemberBody {
  nick?: Opt<string | null>
  roles?: Opt<string[]>
}
export interface CreateRoleBody {
  name: string
  color?: Opt<number>
  hoist?: Opt<boolean>
  permissions?: Opt<number>
}
export interface UpdateRoleBody {
  name?: Opt<string>
  color?: Opt<number>
  /** No X-Hachiman-Signed-Action needed for name, color or hoist alone (§12.16). */
  hoist?: Opt<boolean>
  permissions?: Opt<number>
}
export interface RolePosition {
  id: string
  position: number
}
export interface CreateInviteBody {
  /** 1–86400; an administrator also 0 (permanent) or up to 604800 (§4). */
  maxAgeSeconds?: Opt<number>
  maxUses?: Opt<number>
  /** Required with `maxAgeSeconds: 0`: the user accepted the permanent-invite warning. */
  acknowledgedPermanent?: Opt<boolean>
  /** An invite with history: the encoded SignedInviteRecord (§12.11.4). ADMINISTRATOR only. */
  record?: Opt<B64url>
}
export interface CreatePageBody {
  /** A new UUID that the client chooses: the title envelope binds it (§12.20). */
  id: string
  parentId: string | null
  position: number
  titleEnvelope: B64url
}
export interface UpdatePageBody {
  parentId?: Opt<string | null>
  position?: Opt<number>
  titleEnvelope?: Opt<B64url>
  /** Compare-and-set on `Page.updatedAt`: 409 PageConflict when the page changed. */
  ifUpdatedAt?: Opt<string>
}
export interface PostSnapshotBody {
  baseSeq: number
  /** From {@link RestClient.uploadSnapshot}. */
  uploadId: string
  envelope: B64url
  mediaUploadIds: string[]
}
export type KtEntriesQuery =
  | { userId: string; after: number; limit?: Opt<number> }
  | { start: number; end: number }

const e = encodeURIComponent

/**
 * The CommitRequest wire body (§12.12): `rejected` holds only joins by pendingId, and the
 * DS proposals by proposalRef go in `rejectedProposals` (omitted when empty).
 */
function commitWireBody(body: CommitRequest) {
  const { rejected, rejectedProposals = [], ...rest } = body
  const joins: { pendingId: string; reason: ProposalRejection['reason'] }[] = []
  const proposals: ProposalRejection[] = [...rejectedProposals]
  for (const r of rejected) {
    if ('pendingId' in r) joins.push({ pendingId: r.pendingId, reason: r.reason })
    else proposals.push({ proposalRef: r.proposalRef, reason: r.reason })
  }
  return proposals.length > 0
    ? { ...rest, rejected: joins, rejectedProposals: proposals }
    : { ...rest, rejected: joins }
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

interface ReqOptions {
  auth?: boolean
  signedAction?: Opt<B64url>
  /** POST /devices: a device proof without X-Hachiman-Device (the key of the body signs). */
  proveWithoutDevice?: boolean
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

export class RestClient {
  constructor(
    private readonly opts: {
      baseUrl: string
      getToken: TokenProvider
      /** The current device id, sent as X-Hachiman-Device on every request when not null (§12.12). */
      getDeviceId?: () => string | null
      /**
       * Signs each request that sends X-Hachiman-Device (and POST /devices) with the device key:
       * the headers X-Hachiman-Device-Ts, -Nonce and -Sig (§12.12 "Device proof").
       */
      proveDevice?: DeviceProver | undefined
    },
  ) {}

  getMe = () => this.req<User>('GET', '/users/@me')
  updateMe = (body: UpdateMeBody) => this.req<User>('PATCH', '/users/@me', body)
  getUser = (id: string) => this.req<User>('GET', `/users/${e(id)}`)

  createGuild = (body: CreateGuildBody) => this.req<GuildFull>('POST', '/guilds', body)
  getGuild = (id: string) => this.req<GuildFull>('GET', `/guilds/${e(id)}`)
  updateGuild = (id: string, body: UpdateGuildBody, opts: SignedActionOptions = {}) =>
    this.req<Guild>('PATCH', `/guilds/${e(id)}`, body, opts)
  deleteGuild = (id: string) => this.req<undefined>('DELETE', `/guilds/${e(id)}`)

  createChannel = (guildId: string, body: CreateChannelBody) =>
    this.req<Channel>('POST', `/guilds/${e(guildId)}/channels`, body)
  reorderChannels = (guildId: string, body: ChannelPosition[]) =>
    this.req<undefined>('PATCH', `/guilds/${e(guildId)}/channels`, body)
  updateChannel = (id: string, body: UpdateChannelBody, opts: SignedActionOptions = {}) =>
    this.req<Channel>('PATCH', `/channels/${e(id)}`, body, opts)
  deleteChannel = (id: string) => this.req<undefined>('DELETE', `/channels/${e(id)}`)
  /** Rename or delete a thread with updateChannel / deleteChannel. */
  createThread = (parentId: string, body: CreateThreadBody) =>
    this.req<Channel>('POST', `/channels/${e(parentId)}/threads`, body)
  /** The 50 most recently active threads of a channel, newest activity first. */
  listThreads = (parentId: string) => this.req<Channel[]>('GET', `/channels/${e(parentId)}/threads`)
  putOverwrite = (channelId: string, targetId: string, body: OverwriteBody, opts: SignedActionOptions = {}) =>
    this.req<undefined>('PUT', `/channels/${e(channelId)}/permissions/${e(targetId)}`, body, opts)
  deleteOverwrite = (channelId: string, targetId: string, opts: SignedActionOptions = {}) =>
    this.req<undefined>('DELETE', `/channels/${e(channelId)}/permissions/${e(targetId)}`, undefined, opts)

  getMessages = (channelId: string, q: MessageQuery = {}) =>
    this.req<Message[]>(
      'GET',
      `/channels/${e(channelId)}/messages${query({ before: q.before, limit: q.limit })}`,
    )
  sendMessage = (channelId: string, body: SendMessageBody) =>
    this.req<Message>('POST', `/channels/${e(channelId)}/messages`, body)
  editMessage = (channelId: string, messageId: string, body: { envelope: B64url }) =>
    this.req<Message>('PATCH', `/channels/${e(channelId)}/messages/${e(messageId)}`, body)
  deleteMessage = (channelId: string, messageId: string) =>
    this.req<undefined>('DELETE', `/channels/${e(channelId)}/messages/${e(messageId)}`)
  triggerTyping = (channelId: string) => this.req<undefined>('POST', `/channels/${e(channelId)}/typing`)
  /** Moves the read state of the channel forward to `messageId` (§4). An older message is ignored. */
  ackMessage = (channelId: string, messageId: string) =>
    this.req<undefined>('POST', `/channels/${e(channelId)}/ack`, { messageId })

  /** Ciphertext Messages, newest pin first. Decrypt them as any other message. */
  getPins = (channelId: string) => this.req<Message[]>('GET', `/channels/${e(channelId)}/pins`)
  /** 400 TooManyPins past 50 pins in the channel. */
  pinMessage = (channelId: string, messageId: string) =>
    this.req<undefined>('PUT', `/channels/${e(channelId)}/pins/${e(messageId)}`)
  unpinMessage = (channelId: string, messageId: string) =>
    this.req<undefined>('DELETE', `/channels/${e(channelId)}/pins/${e(messageId)}`)

  getMembers = (guildId: string) => this.req<Member[]>('GET', `/guilds/${e(guildId)}/members`)
  updateMember = (guildId: string, userId: string, body: UpdateMemberBody, opts: SignedActionOptions = {}) =>
    this.req<Member>('PATCH', `/guilds/${e(guildId)}/members/${e(userId)}`, body, opts)
  kickMember = (guildId: string, userId: string) =>
    this.req<undefined>('DELETE', `/guilds/${e(guildId)}/members/${e(userId)}`)
  /** BAN_MEMBERS. */
  getBans = (guildId: string) => this.req<Ban[]>('GET', `/guilds/${e(guildId)}/bans`)
  /** BAN_MEMBERS. Removes a member from the guild, and keeps the user out until `unbanMember`. */
  banMember = (guildId: string, userId: string, body: BanBody = {}) =>
    this.req<undefined>('PUT', `/guilds/${e(guildId)}/bans/${e(userId)}`, body)
  unbanMember = (guildId: string, userId: string) =>
    this.req<undefined>('DELETE', `/guilds/${e(guildId)}/bans/${e(userId)}`)
  leaveGuild = (guildId: string) => this.req<undefined>('DELETE', `/users/@me/guilds/${e(guildId)}`)

  getRoles = (guildId: string) => this.req<Role[]>('GET', `/guilds/${e(guildId)}/roles`)
  createRole = (guildId: string, body: CreateRoleBody, opts: SignedActionOptions = {}) =>
    this.req<Role>('POST', `/guilds/${e(guildId)}/roles`, body, opts)
  reorderRoles = (guildId: string, body: RolePosition[], opts: SignedActionOptions = {}) =>
    this.req<Role[]>('PATCH', `/guilds/${e(guildId)}/roles`, body, opts)
  updateRole = (guildId: string, roleId: string, body: UpdateRoleBody, opts: SignedActionOptions = {}) =>
    this.req<Role>('PATCH', `/guilds/${e(guildId)}/roles/${e(roleId)}`, body, opts)
  deleteRole = (guildId: string, roleId: string, opts: SignedActionOptions = {}) =>
    this.req<undefined>('DELETE', `/guilds/${e(guildId)}/roles/${e(roleId)}`, undefined, opts)

  getGuildEvents = (guildId: string) => this.req<GuildEventWithMe[]>('GET', `/guilds/${e(guildId)}/events`)
  createGuildEvent = (guildId: string, body: CreateGuildEventRequest) =>
    this.req<GuildEventWithMe>('POST', `/guilds/${e(guildId)}/events`, body)
  updateGuildEvent = (eventId: string, body: UpdateGuildEventRequest) =>
    this.req<GuildEventWithMe>('PATCH', `/events/${e(eventId)}`, body)
  deleteGuildEvent = (eventId: string) => this.req<undefined>('DELETE', `/events/${e(eventId)}`)
  /** `going` true: PUT, false: DELETE /events/:id/rsvp. */
  setEventRsvp = (eventId: string, going: boolean) =>
    this.req<undefined>(going ? 'PUT' : 'DELETE', `/events/${e(eventId)}/rsvp`)

  getGuildSounds = (guildId: string) => this.req<GuildSound[]>('GET', `/guilds/${e(guildId)}/sounds`)
  /** MANAGE_EXPRESSIONS. Sends X-Hachiman-Device: the server checks the envelope header (§12.21). */
  createGuildSound = (guildId: string, body: CreateGuildSoundRequest) =>
    this.req<GuildSound>('POST', `/guilds/${e(guildId)}/sounds`, body)
  deleteGuildSound = (guildId: string, soundId: string) =>
    this.req<undefined>('DELETE', `/guilds/${e(guildId)}/sounds/${e(soundId)}`)

  getInvites = (guildId: string) => this.req<Invite[]>('GET', `/guilds/${e(guildId)}/invites`)
  createInvite = (guildId: string, body: CreateInviteBody = {}) =>
    this.req<Invite>('POST', `/guilds/${e(guildId)}/invites`, body)
  deleteInvite = (code: string) => this.req<undefined>('DELETE', `/invites/${e(code)}`)
  /** Public, non-consuming — works signed out. */
  previewInvite = (code: string) =>
    this.req<InvitePreview>('GET', `/invites/${e(code)}`, undefined, { auth: false })
  acceptInvite = (code: string) => this.req<GuildFull>('POST', `/invites/${e(code)}`)

  getDmChannels = () => this.req<Channel[]>('GET', '/users/@me/channels')
  /** 403 Blocked when a block exists between the caller and a recipient. */
  openDm = (recipientIds: string[]) => this.req<Channel>('POST', '/users/@me/channels', { recipientIds })

  getBlocks = () => this.req<BlockedUser[]>('GET', '/users/@me/blocks')
  blockUser = (userId: string) => this.req<undefined>('PUT', `/users/@me/blocks/${e(userId)}`)
  unblockUser = (userId: string) => this.req<undefined>('DELETE', `/users/@me/blocks/${e(userId)}`)
  /** 204. 403 Blocked, 404 without a shared guild or DM, 429 RateLimited (RestError.retryAfterSec). */
  poke = (userId: string) => this.req<undefined>('POST', `/users/${e(userId)}/poke`)

  getLimits = () => this.req<Limits>('GET', '/limits')

  // MARK: - Pages (§4 Pages)

  getPages = (channelId: string) => this.req<Page[]>('GET', `/channels/${e(channelId)}/pages`)
  /** Per page: the title epoch and the newest snapshot, without the update log. */
  getPageHeads = (channelId: string) => this.req<PageHead[]>('GET', `/channels/${e(channelId)}/pages/heads`)
  createPage = (channelId: string, body: CreatePageBody) =>
    this.req<Page>('POST', `/channels/${e(channelId)}/pages`, body)
  updatePage = (pageId: string, body: UpdatePageBody) => this.req<Page>('PATCH', `/pages/${e(pageId)}`, body)
  /** Deletes the page and its subtree. */
  deletePage = (pageId: string) => this.req<undefined>('DELETE', `/pages/${e(pageId)}`)
  getPageState = (pageId: string) => this.req<PageState>('GET', `/pages/${e(pageId)}/state`)
  getPageUpdates = (pageId: string, q: { after: number; limit?: Opt<number> }) =>
    this.req<DocUpdatePage>('GET', `/pages/${e(pageId)}/updates${query({ after: q.after, limit: q.limit })}`)
  postPageUpdate = (pageId: string, body: { envelope: B64url }) =>
    this.req<{ seq: number }>('POST', `/pages/${e(pageId)}/updates`, body)
  /** 409 SnapshotConflict rejects (another snapshot won): the upload stays unclaimed. */
  postPageSnapshot = (pageId: string, body: PostSnapshotBody) =>
    this.req<DocSnapshot>('POST', `/pages/${e(pageId)}/snapshots`, body)
  /** Claims page_media uploads, or refreshes their last_referenced_at. 413 StorageQuotaExceeded. */
  claimPageMedia = (pageId: string, uploadIds: string[]) =>
    this.req<undefined>('POST', `/pages/${e(pageId)}/media`, { uploadIds })

  // MARK: - Files (§4 Files)

  /** Public URL of a file key (avatar, icon, banner, Attachment.key). */
  fileUrl = (key: string) => `${this.base}/files/${key.split('/').map(e).join('/')}`

  /** Uploads an encrypted attachment or thumbnail blob (`?kind=blob`). */
  uploadBlob = (blob: Blob, opts: UploadProgressOptions = {}): Promise<Attachment> =>
    this.xhrUpload<Attachment>('?kind=blob', blob, 'application/octet-stream', opts)

  /** Uploads an encrypted page snapshot blob (`?kind=page_snapshot`, cap Limits.maxPageSnapshotBytes). */
  uploadSnapshot = (blob: Blob, opts: UploadProgressOptions = {}): Promise<Attachment> =>
    this.xhrUpload<Attachment>('?kind=page_snapshot', blob, 'application/octet-stream', opts)

  /** Uploads a plaintext profile image (avatar, icon, banner). */
  uploadImage = (file: Blob, opts: UploadImageOptions): Promise<{ id: string; key: string; size: number }> =>
    this.xhrUpload(query({ filename: opts.filename }), file, file.type || 'application/octet-stream', opts)

  /** Downloads a file (an encrypted blob or a profile image). The route is public, so no headers go out. */
  fetchBlob = async (key: string, opts: { signal?: Opt<AbortSignal> } = {}): Promise<Blob> => {
    const res = await fetch(this.fileUrl(key), opts.signal ? { signal: opts.signal } : {})
    if (!res.ok)
      throw restError(res.status, await res.json().catch(() => null), res.headers.get('Retry-After'))
    return res.blob()
  }

  // MARK: - Devices and keys (§12.12)

  registerDevice = (body: { name: string; platform: DevicePlatform; clientVersion: string; mlsSignatureKey: B64url }) =>
    this.req<Device>('POST', '/devices', body, { proveWithoutDevice: true })
  listDevices = () => this.req<Device[]>('GET', '/devices')
  renameDevice = (id: string, name: string) => this.req<Device>('PATCH', `/devices/${e(id)}`, { name })
  putDeviceCertificate = (id: string, body: { certificate: B64url }) =>
    this.req<Device>('PUT', `/devices/${e(id)}/certificate`, body)
  revokeDevice = (id: string, body: { revocation: B64url | null; reason: RevocationReason }) =>
    this.req<undefined>('POST', `/devices/${e(id)}/revoke`, body)
  getUserKeys = (userId: string) => this.req<UserKeys>('GET', `/users/${e(userId)}/keys`)
  putMasterKey = (body: { record: B64url; dskCert: B64url }) =>
    this.req<undefined>('PUT', '/users/@me/master-key', body)
  putDeviceSigningKey = (body: { cert: B64url }) =>
    this.req<undefined>('PUT', '/users/@me/device-signing-key', body)

  // MARK: - MLS (§12.12)

  getDsInfo = () => this.req<DsInfo>('GET', '/mls/ds')
  uploadKeyPackages = (body: {
    cipherSuite: CipherSuiteId
    keyPackages: B64url[]
    lastResort: B64url | null
  }) => this.req<{ stored: number; total: number }>('POST', '/mls/key-packages', body)
  countKeyPackages = () =>
    this.req<{ cipherSuite: CipherSuiteId; count: number; lastResort: boolean }[]>(
      'GET',
      '/mls/key-packages/count',
    )
  listMlsGroups = () => this.req<MlsGroup[]>('GET', '/mls/groups')
  getMlsGroup = (groupId: B64url) => this.req<MlsGroup>('GET', `/mls/groups/${e(groupId)}`)

  /** The current group of the channel. Resolves null on 404 UnknownGroup (no group yet). */
  getChannelMlsGroup = async (channelId: string): Promise<MlsGroup | null> => {
    try {
      return await this.req<MlsGroup>('GET', `/channels/${e(channelId)}/mls-group`)
    } catch (err) {
      if (err instanceof RestError && err.status === 404 && err.code === 'UnknownGroup') return null
      throw err
    }
  }

  /** The latest state when `epoch` is undefined. 410 EpochNotKept rejects. */
  getMlsGroupState = (groupId: B64url, epoch?: number) =>
    this.req<GroupState>('GET', `/mls/groups/${e(groupId)}/state${query({ epoch })}`)
  createMlsGroup = (body: CreateGroupRequest) => this.req<MlsGroup>('POST', '/mls/groups', body)

  /** Resolves 409 EpochConflict as `{ ok: false, epoch }`, so the caller can catch up and retry. */
  postCommit = async (groupId: B64url, body: CommitRequest): Promise<CommitResult> => {
    try {
      const r = await this.req<{ epoch: number; seq: number }>(
        'POST',
        `/mls/groups/${e(groupId)}/commits`,
        commitWireBody(body),
      )
      return { ok: true, epoch: r.epoch, seq: r.seq }
    } catch (err) {
      const epoch = err instanceof RestError ? err.details['epoch'] : undefined
      if (
        err instanceof RestError &&
        err.status === 409 &&
        err.code === 'EpochConflict' &&
        typeof epoch === 'number'
      )
        return { ok: false, code: 'EpochConflict', epoch }
      throw err
    }
  }

  getHandshakes = (groupId: B64url, q: { after: number; limit?: Opt<number> }) =>
    this.req<HandshakePage>(
      'GET',
      `/mls/groups/${e(groupId)}/handshakes${query({ after: q.after, limit: q.limit })}`,
    )
  postJoinRequest = (groupId: B64url, body: { keyPackage: B64url }) =>
    this.req<JoinRequest>('POST', `/mls/groups/${e(groupId)}/join-requests`, body)
  getJoinRequest = (id: string) => this.req<JoinRequest>('GET', `/mls/join-requests/${e(id)}`)
  declineBatch = (
    batchId: string,
    reason: 'not_synced' | 'busy',
    rejectedProposals?: ProposalRejection[],
  ) =>
    this.req<undefined>(
      'POST',
      `/mls/batches/${e(batchId)}/decline`,
      rejectedProposals !== undefined && rejectedProposals.length > 0
        ? { reason, rejectedProposals }
        : { reason },
    )
  postHistoryBundle = (groupId: B64url, body: { epoch: number; blob: B64url }) =>
    this.req<undefined>('POST', `/mls/groups/${e(groupId)}/history-bundles`, body)
  getHistoryBundles = (groupId: B64url, epoch: number) =>
    this.req<HistoryBundle[]>('GET', `/mls/groups/${e(groupId)}/history-bundles${query({ epoch })}`)

  // MARK: - Device inbox, backups, linking (§12.12)

  getInbox = (q: { after: number; limit?: Opt<number> }) =>
    this.req<InboxItem[]>('GET', `/devices/@me/inbox${query({ after: q.after, limit: q.limit })}`)
  ackInbox = (id: string) => this.req<undefined>('DELETE', `/devices/@me/inbox/${e(id)}`)
  postInbox = (deviceId: string, body: { kind: Exclude<InboxKind, 'welcome'>; body: B64url }) =>
    this.req<undefined>('POST', `/devices/${e(deviceId)}/inbox`, body)

  getBackups = () => this.req<BackupIndex>('GET', '/backups')
  putIdentityBackup = (body: { keyId: B64url; blob: B64url }) =>
    this.req<undefined>('PUT', '/backups/identity', body)
  postHistoryBackup = (body: {
    keyId: B64url
    groupId: B64url
    epochFrom: number
    epochTo: number
    blob: B64url
  }) => this.req<{ id: string }>('POST', '/backups/history', body)
  getBackup = (id: string) => this.req<{ blob: B64url }>('GET', `/backups/${e(id)}`)
  deleteBackups = () => this.req<undefined>('DELETE', '/backups')

  createLinkSession = (body: { offer: B64url }) =>
    this.req<{ id: string; expiresAt: string }>('POST', '/devices/link-sessions', body)
  listLinkSessions = () => this.req<LinkSession[]>('GET', '/devices/link-sessions')
  postLinkMessage = (id: string, body: { body: B64url }) =>
    this.req<{ seq: number }>('POST', `/devices/link-sessions/${e(id)}/messages`, body)
  getLinkMessages = (id: string, after: number) =>
    this.req<LinkMessage[]>('GET', `/devices/link-sessions/${e(id)}/messages${query({ after })}`)
  deleteLinkSession = (id: string) => this.req<undefined>('DELETE', `/devices/link-sessions/${e(id)}`)

  // MARK: - Key transparency, admin actions, reports (Phase 4, §12.14, §12.16)

  ktTreeHead = () => this.req<KtTreeHead>('GET', '/kt/tree-head')
  ktInclusion = (index: number, treeSize: number) =>
    this.req<KtInclusionProof>('GET', `/kt/inclusion${query({ index, treeSize })}`)
  ktConsistency = (from: number, to: number) =>
    this.req<KtConsistencyProof>('GET', `/kt/consistency${query({ from, to })}`)
  ktEntries = (q: KtEntriesQuery) =>
    this.req<KtEntry[]>(
      'GET',
      `/kt/entries${'userId' in q ? query({ userId: q.userId, after: q.after, limit: q.limit }) : query({ start: q.start, end: q.end })}`,
    )
  getAdminActions = (guildId: string, after: number, limit?: number) =>
    this.req<AdminAction[]>('GET', `/guilds/${e(guildId)}/admin-actions${query({ after, limit })}`)

  // MARK: - Invites with history (§12.11.4)

  /** Member only. The active invites with history of the guild. */
  inviteRecords = (guildId: string) => this.req<InviteRecord[]>('GET', `/guilds/${e(guildId)}/invite-records`)
  /** `blob`: an encoded InviteBundle. 204. */
  postInviteBundle = (inviteId: string, body: { groupId: B64url; epoch: number; blob: B64url }) =>
    this.req<undefined>('POST', `/invite-records/${e(inviteId)}/bundles`, body)
  /** Only for the redeemer, during 1 h after its join with the invite. Else 404 UnknownInvite. */
  inviteBundles = (code: string) => this.req<InviteBundles>('GET', `/invites/${e(code)}/bundles`)
  report = (body: { messageId: string; content: B64url; frankingKey: B64url; reason: string }) =>
    this.req<{ id: string; verified: boolean }>('POST', '/reports', body)

  // MARK: - Transport

  private get base(): string {
    return this.opts.baseUrl.replace(/\/$/, '')
  }

  private deviceId(): string | null {
    return this.opts.getDeviceId?.() ?? null
  }

  /** Adds the device proof headers. The signed path is the one the server sees (pathname + search). */
  private async prove(headers: Record<string, string>, method: string, url: string, json: string | undefined): Promise<void> {
    const prover = this.opts.proveDevice
    if (!prover) return
    const u = new URL(url, globalThis.location?.href)
    const bodySha256 = await sha256(json ?? '')
    const p = await prover({ kind: 'ds', method, pathAndQuery: u.pathname + u.search, bodySha256 })
    headers['X-Hachiman-Device-Ts'] = String(p.ts)
    headers['X-Hachiman-Device-Nonce'] = p.nonce
    headers['X-Hachiman-Device-Sig'] = p.sig
  }

  private async req<T>(method: string, path: string, body?: unknown, ro: ReqOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const url = this.base + path
    const json = body !== undefined ? JSON.stringify(body) : undefined
    if (ro.auth !== false) {
      headers['Authorization'] = `Bearer ${await this.opts.getToken()}`
      const device = this.deviceId()
      if (device !== null) headers['X-Hachiman-Device'] = device
      if (device !== null || ro.proveWithoutDevice) await this.prove(headers, method, url, json)
    }
    if (ro.signedAction !== undefined) headers['X-Hachiman-Signed-Action'] = ro.signedAction
    if (json !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, {
      method,
      headers,
      ...(json !== undefined && { body: json }),
    })
    if (!res.ok)
      throw restError(res.status, await res.json().catch(() => null), res.headers.get('Retry-After'))
    if (res.status === 204) return undefined as T
    // Some 201 answers (history bundles) have no body.
    const text = await res.text()
    return (text === '' ? undefined : JSON.parse(text)) as T
  }

  /**
   * XHR, because fetch has no upload progress. Rejects with RestError (413 UploadTooLarge, ...),
   * a DOMException 'AbortError' when `signal` aborts, or a TypeError on network failure.
   */
  private async xhrUpload<T>(
    qs: string,
    file: Blob,
    contentType: string,
    opts: UploadProgressOptions,
  ): Promise<T> {
    const { signal } = opts
    const aborted = () => new DOMException('Upload aborted', 'AbortError')
    if (signal?.aborted) throw aborted()
    const token = await this.opts.getToken()
    if (signal?.aborted) throw aborted()
    const device = this.deviceId()

    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const onAbort = () => {
        xhr.abort()
      }
      const fail = (err: Error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      }
      xhr.open('POST', `${this.base}/uploads${qs}`)
      xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      if (device !== null) xhr.setRequestHeader('X-Hachiman-Device', device)
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.setRequestHeader('Content-Type', contentType)
      const { onProgress } = opts
      if (onProgress)
        xhr.upload.onprogress = ev => {
          onProgress(ev.loaded, ev.lengthComputable ? ev.total : file.size)
        }
      xhr.onload = () => {
        let body: unknown = null
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          // Non-JSON error body (e.g. a proxy's 413 page): fall back to HTTP_<status>.
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(restError(xhr.status, body, xhr.getResponseHeader('Retry-After')))
          return
        }
        signal?.removeEventListener('abort', onAbort)
        resolve(body as T)
      }
      xhr.onerror = () => {
        fail(new TypeError('upload: network error'))
      }
      xhr.onabort = () => {
        fail(aborted())
      }
      signal?.addEventListener('abort', onAbort)
      xhr.send(file)
    })
  }
}
