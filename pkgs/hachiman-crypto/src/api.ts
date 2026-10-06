/**
 * The typed public API of @hachiman/crypto. docs/gateway-protocol.md §12 is normative.
 *
 * Four layers:
 *   1. Wire shapes: the JSON bodies of the §12 REST routes and gateway events.
 *   2. DsTransport: the main thread implements it with @hachiman/client and the
 *      Worker calls it over the bridge. The Worker never calls fetch itself.
 *   3. CryptoApi + CryptoEvents: the Worker RPC surface that the UI calls.
 *   4. Module contracts: the internal modules (identity, kt, mls, ds, envelope,
 *      attachments, franking, media, store). Each module exports one const that
 *      satisfies its interface, so implementers can work in parallel.
 *
 * Every value that crosses the Worker boundary is structured-cloneable:
 * no classes, no functions, no bigint in wire shapes (epochs are JS-safe numbers).
 */
import type {
  AdminActionType,
  BackupKind,
  CipherSuiteId,
  DeviceRevocationReason,
  GroupKindName,
  HistoryVisibilityName,
  KtEntryType,
} from './constants'
import type { DeviceProof, DeviceProofInput } from './device-proof'

// MARK: - 0. Primitives

/** RFC 4648 §5 base64url without padding. All bytes on JSON wires use it. */
export type B64url = string
/** Canonical lowercase UUID text. */
export type UserId = string
export type DeviceId = string
export type ChannelId = string
export type GuildId = string
export type MessageId = string
export type UploadId = string
/** base64url of the 22-byte group id (§12.6). */
export type GroupIdB64 = B64url
/** base64url of 16 random bytes (§12.8). */
export type ClientMsgIdB64 = B64url

export interface Ed25519KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface X25519KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export type CryptoErrorCode =
  | 'NotInitialized'
  | 'NoIdentity'
  | 'DeviceRevoked'
  | 'SecureStorageUnavailable'
  | 'StoreCorrupt'
  | 'InvalidRecoveryKey'
  | 'WrongRecoveryKey'
  | 'InvalidChain'
  | 'UnknownGroup'
  | 'GroupPending'
  | 'NotMember'
  | 'EpochConflict'
  | 'PendingRemoves'
  | 'Transport'
  | 'LinkAborted'
  | 'LinkExpired'
  | 'SasMismatch'
  | 'Malformed'
  | 'TooLarge'
  | 'Unsupported'
  /** Web Lock refusal: the crypto store is open in another tab (§12.17). */
  | 'LockHeld'
  /** An exception inside the Worker that carried no CryptoErrorCode (a bug). */
  | 'Internal'

/** The error shape that crosses the Worker boundary. */
export interface CryptoErrorShape {
  code: CryptoErrorCode
  message: string
  /** REST error code (§4/§12.19) when the cause was a DS response. */
  dsCode?: string | undefined
}

export class CryptoError extends Error implements CryptoErrorShape {
  override readonly name = 'CryptoError'
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
    readonly dsCode?: string,
  ) {
    super(message)
  }
}

// MARK: - 1. Wire shapes (§12.12 REST, §12.13 gateway)

export type DeviceStatus = 'pending' | 'active' | 'revoked'
export type DevicePlatform = 'electron' | 'browser'
export type RevocationReasonName = 'user' | 'lost' | 'password_reset' | 'compromised' | 'signed_out'
export type RevocationReasonId = (typeof DeviceRevocationReason)[keyof typeof DeviceRevocationReason]
export type AdminActionTypeId = (typeof AdminActionType)[keyof typeof AdminActionType]

/** GET /devices (own devices). */
export interface WireDevice {
  id: DeviceId
  userId: UserId
  status: DeviceStatus
  name: string
  platform: DevicePlatform
  clientVersion: string
  certificate: B64url | null
  revocation: B64url | null
  revokeReason: RevocationReasonName | null
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

/**
 * GET /users/:id/keys. Each ktIndex has the encoded KtEntry beside it (§12.14):
 * the leaf hash covers timestamp_ms, which only the entry gives.
 */
export interface WireUserKeys {
  userId: UserId
  masterKey: { generation: number; record: B64url; ktIndex: number | null; ktEntry: B64url | null } | null
  deviceSigningKey: { generation: number; cert: B64url; ktIndex: number | null; ktEntry: B64url | null } | null
  devices: {
    id: DeviceId
    status: DeviceStatus
    certificate: B64url | null
    revocation: B64url | null
    ktIndex: number | null
    ktEntry: B64url | null
    revocationKtIndex: number | null
    revocationKtEntry: B64url | null
  }[]
}

/** GET /mls/ds. */
export interface WireDsInfo {
  externalSender: B64url
  cipherSuites: CipherSuiteId[]
  ktPublicKey: B64url
  /**
   * True when the DS signs KT tree heads (§12.14). The client pins it per origin with the KT key.
   * Once pinned true, KT fails closed: every master key and DSK cert the client accepts needs an
   * inclusion proof.
   */
  ktRequired: boolean
  limits: {
    maxEnvelopeBytes: number
    maxInboxItemBytes: number
    maxHistoryBundleBytes: number
    maxBackupBlobBytes: number
    keyPackageTarget: number
    keyPackageLowWater: number
  }
}

export type GroupStatus = 'pending' | 'active' | 'retired'

/** GET /mls/groups/:groupId. */
export interface WireMlsGroup {
  groupId: GroupIdB64
  kind: GroupKindName
  guildId: GuildId | null
  /** The channel for kind 'channel' | 'dm'. Null for 'public_set'. */
  channelId: ChannelId | null
  generation: number
  cipherSuite: CipherSuiteId
  status: GroupStatus
  epoch: number | null
  historyVisibility: HistoryVisibilityName
  latestSeq: number
  /** True when the caller's device has a leaf (DS roster). */
  member: boolean
}

export interface WireGroupState {
  groupId: GroupIdB64
  epoch: number
  /** MLSMessage (mls_group_info) with external_pub, without ratchet_tree. */
  groupInfo: B64url
  /** RFC 9420 ratchet_tree encoding. */
  ratchetTree: B64url
}

export interface WireCreateGroupRequest {
  groupId: GroupIdB64
  kind: Exclude<GroupKindName, 'voice'>
  guildId: GuildId | null
  channelId: ChannelId | null
  cipherSuite: CipherSuiteId
  groupInfo: B64url
  ratchetTree: B64url
  assignmentId: string | null
}

export interface WireCommitRequest {
  /** The epoch the commit applies to (the current DS epoch). */
  epoch: number
  /** MLSMessage (mls_public_message, content type commit). */
  commit: B64url
  /** GroupInfo of epoch + 1, signed by the committer. */
  groupInfo: B64url
  ratchetTree: B64url
  /** MLSMessage (mls_welcome) or null. */
  welcome: B64url | null
  batchId: string | null
  /** What the committer of an MLS_BATCH_ASSIGN leaves out of the commit, and why. */
  rejected: BatchRejection[]
}
export type BatchRejectReason = 'invalid_chain' | 'not_reader' | 'revoked' | 'policy' | 'malformed'
/**
 * A join by value (`pendingId` of WireBatchAssign.joins), or a DS proposal of
 * WireBatchAssign.proposals by `proposalRef`: base64url of the RFC 9420 ProposalRef of the
 * MLSMessage (the value Takusen stores in mls_pending.proposal_ref).
 */
export type BatchRejection = { pendingId: string; reason: BatchRejectReason } | { proposalRef: B64url; reason: BatchRejectReason }

export type WireCommitResult =
  | { ok: true; epoch: number; seq: number }
  | { ok: false; code: 'EpochConflict'; epoch: number }

export type HandshakeKind = 'commit' | 'external_commit' | 'proposal'

export interface WireHandshake {
  seq: number
  /** The epoch in which the message is valid (before the commit). */
  epoch: number
  kind: HandshakeKind
  senderDevice: DeviceId | null
  message: B64url
  /** Commits only: from the GroupInfo of epoch + 1, for the fork check (§12.8.7). */
  next: { treeHash: B64url; confirmedTranscriptHash: B64url } | null
  createdAt: string
}

export interface WireHandshakePage {
  handshakes: WireHandshake[]
  latestSeq: number
}

export type JoinRequestStatus = 'queued' | 'committed' | 'rejected' | 'external_commit' | 'waiting'

export interface WireJoinRequest {
  id: string
  groupId: GroupIdB64
  deviceId: DeviceId
  status: JoinRequestStatus
  reason: string | null
  createdAt: string
}

/** MLS_BATCH_ASSIGN payload. */
export interface WireBatchAssign {
  batchId: string
  groupId: GroupIdB64
  epoch: number
  /**
   * DS proposals for this epoch: MLSMessage (mls_public_message). Removes in every kind,
   * Adds in public_set. Takusen appended each one to the handshake stream before this
   * assignment (§12.7.4), so every member already holds it.
   */
  proposals: B64url[]
  /** Adds that the member commits by value: 'channel' and 'dm' only (public_set Adds are in `proposals`). */
  joins: { pendingId: string; userId: UserId; deviceId: DeviceId; keyPackage: B64url }[]
  /** Kind 'create': the device creates the group (§12.7.7). */
  create: { groupId: GroupIdB64; kind: Exclude<GroupKindName, 'voice'>; guildId: GuildId | null; channelId: ChannelId | null; cipherSuite: CipherSuiteId; historyVisibility: HistoryVisibilityName } | null
  /** Epochs of this group that need a history bundle (§12.11.2). */
  historyBundleEpochs: number[]
  deadline: string
}

export type InboxKind = 'welcome' | 'dsk_transfer' | 'history_keys'

export interface WireInboxItem {
  id: string
  seq: number
  kind: InboxKind
  senderDevice: DeviceId | null
  /** welcome: WelcomeItem bytes (§12.7.6). Other kinds: SealedDeviceMessage (§12.5). */
  body: B64url
  createdAt: string
}

export interface WireBackupIndex {
  keyId: B64url | null
  items: { id: string; kind: 'identity' | 'history'; groupId: GroupIdB64 | null; epochFrom: number | null; epochTo: number | null; size: number; createdAt: string }[]
}
export type BackupKindId = (typeof BackupKind)[keyof typeof BackupKind]

export interface WireHistoryBundle {
  id: string
  groupId: GroupIdB64
  epoch: number
  senderDevice: DeviceId
  blob: B64url
  createdAt: string
}

export interface WireLinkSession {
  id: string
  newDeviceId: DeviceId
  offer: B64url
  createdAt: string
  expiresAt: string
}

export interface WireLinkMessage {
  seq: number
  fromDevice: DeviceId
  body: B64url
  createdAt: string
}

export interface WireKtTreeHead {
  treeSize: number
  timestamp: string
  rootHash: B64url
  /** The encoded SignedTreeHead (§12.14). */
  signed: B64url
}

export interface WireKtInclusionProof {
  leafIndex: number
  treeSize: number
  auditPath: B64url[]
}

export interface WireKtConsistencyProof {
  from: number
  to: number
  proof: B64url[]
}

export interface WireKtEntry {
  index: number
  userId: UserId
  type: (typeof KtEntryType)[keyof typeof KtEntryType]
  /** The encoded KtEntry (§12.14). */
  entry: B64url
  createdAt: string
}

export interface WireAdminAction {
  guildId: GuildId
  seq: number
  action: B64url
  createdAt: string
}

/** An active invite with history of a guild (GET /guilds/:id/invite-records, §12.11.4). */
export interface WireInviteRecord {
  inviteId: string
  /** sign_public of the record: the invite key id. */
  keyId: B64url
  /** The encoded SignedInviteRecord. */
  record: B64url
  expiresAt: string | null
  /** The newest stored bundle epoch of each group. */
  bundled: { groupId: GroupIdB64; epoch: number }[]
}

/** The bundles of an invite for its redeemer (GET /invites/:code/bundles, §12.11.4). */
export interface WireInviteBundles {
  inviteId: string
  /** The encoded SignedInviteRecord. */
  record: B64url
  /** `blob`: an encoded InviteBundle. */
  bundles: { groupId: GroupIdB64; epoch: number; blob: B64url; senderDevice: DeviceId }[]
}

/** The ciphertext Message of §1, as the crypto Worker consumes it. */
export interface EncryptedMessage {
  id: MessageId
  channelId: ChannelId
  guildId: GuildId | null
  authorId: UserId
  senderDevice: DeviceId | null
  groupId: GroupIdB64
  epoch: number
  clientMsgId: ClientMsgIdB64
  envelope: B64url
  /**
   * The upload rows of the message, in position order: for each pointer, the file
   * and then its thumbnail (§12.8.5 step 8). `size` is the stored blob size.
   */
  attachments: { id: UploadId; size: number }[]
  createdAt: string
  editedAt: string | null
}

// MARK: - 1b. Gateway events that the crypto Worker consumes (§12.13)

export type CryptoGatewayEvent =
  | { t: 'MLS_HANDSHAKE'; d: { groupId: GroupIdB64; seq: number; epoch: number; kind: HandshakeKind; senderDevice: DeviceId | null; message: B64url | null; next: WireHandshake['next'] } }
  | { t: 'MLS_BATCH_ASSIGN'; d: WireBatchAssign }
  | { t: 'MLS_JOIN_UPDATE'; d: { requestId: string; groupId: GroupIdB64; status: JoinRequestStatus; reason: string | null } }
  | { t: 'MLS_GROUP_UPDATE'; d: WireMlsGroup }
  | { t: 'DEVICE_INBOX'; d: { id: string; seq: number; kind: InboxKind } }
  | { t: 'DEVICE_LINK'; d: { sessionId: string; seq: number; fromDevice: DeviceId } }
  | { t: 'USER_KEYS_UPDATE'; d: { userId: UserId; kind: 'device_added' | 'device_revoked' | 'master_key_changed' | 'dsk_rotated'; deviceId: DeviceId | null } }
  | { t: 'KEY_PACKAGES_LOW'; d: { deviceId: DeviceId; cipherSuite: CipherSuiteId; remaining: number } }
  | { t: 'KT_TREE_HEAD'; d: WireKtTreeHead }
  /** §6: an invite was revoked. The InviteService stops its bundles (§12.11.4). */
  | { t: 'INVITE_DELETE'; d: { guildId: GuildId; code: string; inviteId: string } }

// MARK: - 2. DsTransport (main thread → Takusen REST, §12.12)

/**
 * Implemented on the main thread over @hachiman/client's RestClient. Every call
 * sends `X-Hachiman-Device`. A non-2xx answer rejects with
 * CryptoErrorShape { code: 'Transport', dsCode: <REST error code> }, except
 * postCommit, which resolves 409 EpochConflict as a value.
 */
export interface DsTransport {
  // devices
  /** `mlsSignatureKey`: the device MLS public key. The request carries a device proof by this key (§12.12). */
  registerDevice(body: { name: string; platform: DevicePlatform; clientVersion: string; mlsSignatureKey: B64url }): Promise<WireDevice>
  putDeviceCertificate(deviceId: DeviceId, body: { certificate: B64url }): Promise<WireDevice>
  listOwnDevices(): Promise<WireDevice[]>
  revokeDevice(deviceId: DeviceId, body: { revocation: B64url | null; reason: RevocationReasonName }): Promise<void>
  renameDevice(deviceId: DeviceId, name: string): Promise<WireDevice>
  // identity keys
  getUserKeys(userId: UserId): Promise<WireUserKeys>
  putMasterKey(body: { record: B64url; dskCert: B64url }): Promise<void>
  putDeviceSigningKey(body: { cert: B64url }): Promise<void>
  // key packages
  getDsInfo(): Promise<WireDsInfo>
  uploadKeyPackages(body: { cipherSuite: CipherSuiteId; keyPackages: B64url[]; lastResort: B64url | null }): Promise<{ stored: number; total: number }>
  countKeyPackages(): Promise<{ cipherSuite: CipherSuiteId; count: number; lastResort: boolean }[]>
  // groups and handshakes
  listGroups(): Promise<WireMlsGroup[]>
  getGroup(groupId: GroupIdB64): Promise<WireMlsGroup>
  /** Resolves null on 404 UnknownGroup (the channel has no group yet). */
  getGroupForChannel(channelId: ChannelId): Promise<WireMlsGroup | null>
  getGroupState(groupId: GroupIdB64, epoch?: number): Promise<WireGroupState>
  createGroup(body: WireCreateGroupRequest): Promise<WireMlsGroup>
  postCommit(groupId: GroupIdB64, body: WireCommitRequest): Promise<WireCommitResult>
  fetchHandshakes(groupId: GroupIdB64, after: number, limit?: number): Promise<WireHandshakePage>
  postJoinRequest(groupId: GroupIdB64, body: { keyPackage: B64url }): Promise<WireJoinRequest>
  getJoinRequest(id: string): Promise<WireJoinRequest>
  declineBatch(batchId: string, reason: 'not_synced' | 'busy'): Promise<void>
  // device inbox
  fetchInbox(after: number, limit?: number): Promise<WireInboxItem[]>
  ackInbox(id: string): Promise<void>
  postInbox(deviceId: DeviceId, body: { kind: Exclude<InboxKind, 'welcome'>; body: B64url }): Promise<void>
  // backups and history
  getBackups(): Promise<WireBackupIndex>
  putIdentityBackup(body: { keyId: B64url; blob: B64url }): Promise<void>
  postHistoryBackup(body: { keyId: B64url; groupId: GroupIdB64; epochFrom: number; epochTo: number; blob: B64url }): Promise<{ id: string }>
  getBackup(id: string): Promise<{ blob: B64url }>
  deleteBackups(): Promise<void>
  postHistoryBundle(groupId: GroupIdB64, body: { epoch: number; blob: B64url }): Promise<void>
  getHistoryBundles(groupId: GroupIdB64, epoch: number): Promise<WireHistoryBundle[]>
  // device linking
  createLinkSession(body: { offer: B64url }): Promise<{ id: string; expiresAt: string }>
  listLinkSessions(): Promise<WireLinkSession[]>
  postLinkMessage(sessionId: string, body: { body: B64url }): Promise<{ seq: number }>
  fetchLinkMessages(sessionId: string, after: number): Promise<WireLinkMessage[]>
  deleteLinkSession(sessionId: string): Promise<void>
  // key transparency (Phase 4)
  ktTreeHead(): Promise<WireKtTreeHead>
  ktInclusion(index: number, treeSize: number): Promise<WireKtInclusionProof>
  ktConsistency(from: number, to: number): Promise<WireKtConsistencyProof>
  ktEntries(query: { userId: UserId; after: number }): Promise<WireKtEntry[]>
  // signed admin actions (Phase 4)
  adminActions(guildId: GuildId, after: number): Promise<WireAdminAction[]>
  // invites with history (§12.11.4)
  /** Any guild member. Active invites with a record only. */
  inviteRecords(guildId: GuildId): Promise<WireInviteRecord[]>
  /** `blob`: an encoded InviteBundle. The caller is a reader of the group. */
  postInviteBundle(inviteId: string, body: { groupId: GroupIdB64; epoch: number; blob: B64url }): Promise<void>
  /** The redeemer, within INVITE_BUNDLE_FETCH_WINDOW_MS of its guild join with the invite. */
  inviteBundles(code: string): Promise<WireInviteBundles>
  // permission data for channelReaders checks (from the HachimanClient cache)
  channelReaders(channelId: ChannelId): Promise<UserId[]>
  guildMembers(guildId: GuildId): Promise<UserId[]>
}

// MARK: - 3a. Content types

export type MentionKind = 'user' | 'role' | 'everyone'
export interface Mention {
  type: MentionKind
  /** User or role id. Null for 'everyone'. */
  id: string | null
}

export interface ThumbnailPointer {
  uploadId: UploadId
  key: B64url
  sha256: B64url
  /** Plaintext bytes. */
  size: number
  blobSize: number
  mime: string
  width: number
  height: number
}

export interface AttachmentPointer {
  uploadId: UploadId
  /** 32-byte file key. */
  key: B64url
  /** SHA-256 of the whole encrypted blob. */
  sha256: B64url
  /** Plaintext bytes. */
  size: number
  /** Encrypted blob bytes (what the server stores). */
  blobSize: number
  mime: string
  name: string
  width: number | null
  height: number | null
  durationMs: number | null
  blurhash: string | null
  thumbnail: ThumbnailPointer | null
}

export interface MessageContent {
  text: string
  mentions: Mention[]
  attachments: AttachmentPointer[]
  replyTo: ClientMsgIdB64 | null
  /** Sender wall clock, Unix ms. Display only. */
  sentAtMs: number
}

export type SenderTrust = 'verified' | 'tofu' | 'changed' | 'unknown'

export interface DecryptedSender {
  userId: UserId
  deviceId: DeviceId
  leafIndex: number
  trust: SenderTrust
  /** False when the message came from a history bundle or backup: membership at that time is not verified. */
  membershipVerified: boolean
}

/** One code per §12.8.5 step. */
export type DecryptFailure =
  /** Step 1, 3, 7: the header or plaintext does not decode, breaks a limit, or has a bad kind/edit_of. */
  | 'malformed'
  /** Step 1: header channel_id differs from the row. */
  | 'wrong_channel'
  /** Step 1: header group_id or epoch differs from the row. */
  | 'wrong_group'
  /** Step 1: header client_msg_id differs from the row. Step 10: a second message id for one (channel, client_msg_id). */
  | 'replay'
  /** Step 3: the AEAD tag failed (counts toward the fork alert). */
  | 'aead'
  /** Step 4: no certificate, or the chain check failed. */
  | 'invalid_chain'
  /** Step 1: header sender_device_id differs from the row. Step 4 (kind 1): the certificate user is not the author. */
  | 'device_mismatch'
  /** Step 4 (kind 2): the certificate user is not the author of the original. */
  | 'edit_not_author'
  /** Step 5. */
  | 'bad_signature'
  /** Step 6: the franking tag does not match the content. */
  | 'bad_franking'
  /** Step 8: the pointer upload ids or blob sizes differ from the row. */
  | 'attachments_mismatch'
  /** Step 10: sent_at_ms below the newest version this client accepted (rollback). */
  | 'stale_edit'

export type DecryptResult =
  | {
      status: 'ok'
      messageId: MessageId
      clientMsgId: ClientMsgIdB64
      kind: 'message' | 'edit'
      /** For kind 'edit': the client_msg_id of the original. */
      editOf: ClientMsgIdB64 | null
      content: MessageContent
      sender: DecryptedSender
    }
  /**
   * Step 2. epoch_ahead: buffered until the handshakes arrive. group_unknown: this device
   * never held the group and has no bundle or backup key (a Welcome can still come).
   * no_history_key: a known group, but no key for that old epoch. transport: a DS call failed
   * (CryptoError 'Transport'): try this message again later, it is not a verdict.
   */
  | { status: 'pending'; messageId: MessageId; reason: 'epoch_ahead' | 'group_unknown' | 'no_history_key' | 'transport' }
  | { status: 'failed'; messageId: MessageId; reason: DecryptFailure }

export interface EncryptMessageInput {
  channelId: ChannelId
  kind: 'message' | 'edit'
  /** For kind 'edit': the original's client_msg_id. The content must keep its attachments. */
  editOf: ClientMsgIdB64 | null
  content: Omit<MessageContent, 'sentAtMs'>
}

export interface EncryptMessageOutput {
  envelope: B64url
  clientMsgId: ClientMsgIdB64
  groupId: GroupIdB64
  epoch: number
}

export interface AttachmentInput {
  file: Blob
  name: string
  mime: string
  width: number | null
  height: number | null
  durationMs: number | null
  blurhash: string | null
  /** An image of at most THUMBNAIL_MAX_EDGE px per edge, or null. */
  thumbnail: { blob: Blob; mime: string; width: number; height: number } | null
}

/** A pointer before upload: the UI fills the upload ids after POST /uploads?kind=blob. */
export type AttachmentDraft = Omit<AttachmentPointer, 'uploadId' | 'thumbnail'> & {
  thumbnail: Omit<ThumbnailPointer, 'uploadId'> | null
}

export interface EncryptedAttachment {
  blob: Blob
  thumbnailBlob: Blob | null
  draft: AttachmentDraft
}

// MARK: - 3b. Identity, trust, verification

export type CryptoState =
  /** No store yet: call setupFirstDevice, linkAsNewDevice or restoreFromRecoveryKey. */
  | 'needs_identity'
  /** A device row exists but no certificate: linking is in progress. */
  | 'linking'
  | 'ready'
  /**
   * The DS or the master key revoked this device. A revocation that verifies (signed by the master
   * key, or a signed_out by this device) clears the store. An unsigned server revocation
   * (password_reset) only locks the device: the store stays until signOutDevice wipes it.
   */
  | 'revoked'

export interface CryptoStatus {
  state: CryptoState
  userId: UserId | null
  deviceId: DeviceId | null
  /** True when this device holds the master key. */
  primary: boolean
  /** True when a recovery key backup exists. */
  recoveryConfigured: boolean
  /** Browser host: 'trusts the server's code' label (§12.17). */
  hostTrust: 'strong' | 'server_code'
}

export interface InitOptions {
  userId: UserId
  /** From IPlatformService.secureStorage.getWrapKey(). */
  wrapKey: CryptoKey
  platform: DevicePlatform
  clientVersion: string
  deviceName: string
  /** Takusen origin. The store and the DS key pin are per origin. */
  origin: string
}

export interface SafetyNumber {
  /** 60 digits. */
  digits: string
  /** 12 groups of 5 digits. */
  groups: string[]
  /** VERIFY_QR_PREFIX + base64url(...) (§12.5). */
  qrPayload: string
}

export interface TrustInfo {
  userId: UserId
  state: SenderTrust
  masterKeyGeneration: number | null
  /** ISO time of the last unacknowledged key change, or null. */
  changedAt: string | null
}

export interface SasEmoji {
  index: number
  emoji: string
  name: string
}

export type LinkRole = 'new_device' | 'existing_device'

export interface LinkStart {
  sessionId: string
  /** QR mode only. LINK_QR_PREFIX + base64url(LinkQr). */
  qrPayload: string | null
}

export interface DeviceSummary {
  id: DeviceId
  name: string
  platform: DevicePlatform
  status: DeviceStatus
  current: boolean
  primary: boolean
  lastSeenAt: string | null
  createdAt: string
}

/** A device of a contact whose chain verified in the Worker (§12.4, §12.5). */
export interface ContactDevice {
  deviceId: DeviceId
  /** From the signed DeviceCertificate (not the REST name). */
  displayName: string
  dskGeneration: number
  issuedAtMs: number
}

export interface KtSelfCheckResult {
  ok: boolean
  treeSize: number
  /** Entries for this user that no own device made. */
  unknownEntries: { index: number; type: number; deviceId: DeviceId | null }[]
}

export interface MembershipEvent {
  groupId: GroupIdB64
  channelId: ChannelId | null
  epoch: number
  /** The user whose device committed. Null for an external commit. 'invite_with_history': the creator of the invite. */
  actorUserId: UserId | null
  /**
   * 'invite_with_history': this device checked the record of an invite with history whose scope has
   * this group (§12.11.4). `subjects` is empty. Once per record and group.
   */
  kind: 'added' | 'removed' | 'joined_external' | 'resynced' | 'created' | 'invite_with_history'
  subjects: { userId: UserId; deviceId: DeviceId }[]
  /** 'invite_with_history' only: the invite key id. Two invites in one epoch give two events. */
  inviteKeyId?: B64url
}

// MARK: - 3c. Voice (§8, §12.10)

export interface VoiceRosterEntry {
  sessionId: string
  userId: UserId
  deviceId: DeviceId
  leafIndex: number | null
}

/** Media → client e2ee ops (§8). */
export type VoiceE2eeServerOp =
  | { op: 'e2ee_roster'; d: { groupId: GroupIdB64; epoch: number | null; committer: string | null; create: boolean; members: VoiceRosterEntry[]; pending: Omit<VoiceRosterEntry, 'leafIndex'>[]; departed: VoiceRosterEntry[] } }
  | { op: 'e2ee_key_package'; d: { sessionId: string; userId: UserId; deviceId: DeviceId; keyPackage: B64url } }
  | { op: 'e2ee_commit_rejected'; d: { epoch: number; currentEpoch: number } }
  | { op: 'e2ee_prepare_transition'; d: { transitionId: number; epoch: number; commit: B64url } }
  | { op: 'e2ee_welcome'; d: { transitionId: number; epoch: number; welcome: B64url } }
  | { op: 'e2ee_ratchet_tree'; d: { transitionId: number; epoch: number; ratchetTree: B64url } }
  | { op: 'e2ee_execute_transition'; d: { transitionId: number; epoch: number } }

/** Client → media e2ee ops (§8). */
export type VoiceE2eeClientOp =
  | { op: 'e2ee_commit'; d: { epoch: number; commit: B64url; welcome: B64url | null; added: string[]; removed: string[] } }
  | { op: 'e2ee_ratchet_tree'; d: { epoch: number; ratchetTree: B64url } }
  | { op: 'e2ee_ready'; d: { transitionId: number | null; epoch: number; leafIndex: number } }
  /** committerLeaf: the sender leaf of the commit that failed (§8 "Bad commits"). */
  | { op: 'e2ee_invalid'; d: { transitionId: number | null; reason: string; committerLeaf: number | null } }

export interface VoiceSessionStart {
  handle: string
  /** For the identify frame: `{ token, e2ee: { version: 1, keyPackage } }`. */
  keyPackage: B64url
}

/** Options of `new RTCRtpScriptTransform(worker, options, [port])` (§12.10). */
export interface FrameTransformOptions {
  role: 'send' | 'recv'
  track: 'audio' | 'video'
  codec: 'opus' | 'vp8'
  /** recv only: the remote user of this receiver (from the msid). */
  userId: UserId | null
  /** The port from CryptoApi.voiceAttachTransform. */
  port: MessagePort
}

/** Crypto Worker → transform Worker messages on the MessagePort. */
export type FrameKeyMessage =
  /** A new epoch. secret = MLS-Exporter("SFrame 1.0 Base Key", "", 32). */
  | { type: 'epoch'; epoch: number; secret: Uint8Array; selfLeaf: number; leaves: { leafIndex: number; userId: UserId }[] }
  /** Senders switch to this epoch now (e2ee_execute_transition). */
  | { type: 'activate'; epoch: number }
  /** Receivers drop the keys of this epoch (SFRAME_OLD_EPOCH_RETENTION_MS after the next activate). */
  | { type: 'retire'; epoch: number }
  | { type: 'close' }

/** Transform Worker → crypto Worker (and the UI) on the same port. */
export type FrameStatsMessage = {
  type: 'stats'
  encrypted: number
  decrypted: number
  /** Frames dropped: unknown KID, failed tag, replay, or a KID leaf that is not userId. */
  dropped: { unknownKey: number; authFailed: number; replay: number; wrongSender: number }
}

// MARK: - 3c2. Page envelopes (§12.20)

export type PageId = string
export type DocEnvelopeKindName = 'doc_update' | 'doc_snapshot' | 'doc_awareness' | 'doc_title'

/**
 * `bytes` is the body: a Yjs update (doc_update), the encoded DocSnapshotPointer (doc_snapshot),
 * a y-protocols awareness update (doc_awareness), or the UTF-8 title (doc_title, 1 to
 * MAX_PAGE_TITLE_BYTES bytes).
 */
export interface EncryptDocInput {
  channelId: ChannelId
  pageId: PageId
  kind: DocEnvelopeKindName
  bytes: Uint8Array
}

export interface EncryptDocOutput {
  envelope: B64url
  groupId: GroupIdB64
  epoch: number
}

/**
 * The doc_snapshot body (§12.20): UTF-8 JSON of this object. `fileKey` and `sha256` are base64url,
 * `size` is the plaintext bytes of the Yjs state. The blob is the §12.9 format.
 */
export interface DocSnapshotPointer {
  uploadId: UploadId
  fileKey: B64url
  sha256: B64url
  size: number
}

export interface EncryptedDocItem {
  /** Chosen by the caller and echoed in the result (for example `${pageId}:${seq}`). */
  id: string
  channelId: ChannelId
  pageId: PageId
  /** The kind that the caller expects. Another kind in the header gives 'wrong_kind'. */
  kind: DocEnvelopeKindName
  /** The row or dispatch value. When not null, the header must name it ('device_mismatch'). */
  senderDevice: DeviceId | null
  envelope: B64url
}

/** One code per §12.20 receive step. */
export type DocDecryptFailure =
  | 'malformed'
  | 'wrong_channel'
  | 'wrong_page'
  | 'wrong_kind'
  | 'device_mismatch'
  | 'aead'
  | 'invalid_chain'
  | 'bad_signature'

export type DocDecryptResult =
  | { status: 'ok'; id: string; kind: DocEnvelopeKindName; bytes: Uint8Array; sender: DecryptedSender }
  /** The §12.8.5 step 2 reasons: decrypt again after `epochKeysAvailable`, or later for 'transport'. */
  | { status: 'pending'; id: string; reason: 'epoch_ahead' | 'group_unknown' | 'no_history_key' | 'transport' }
  | { status: 'failed'; id: string; reason: DocDecryptFailure }

// MARK: - 3d. CryptoApi: the Worker RPC surface

export interface CryptoApi {
  // lifecycle
  init(opts: InitOptions): Promise<CryptoStatus>
  status(): Promise<CryptoStatus>
  /**
   * Forget this device: revokes it on the DS (reason signed_out) and deletes the store. On a
   * locked device (state 'revoked' after an unsigned server revocation) this is the explicit wipe.
   */
  signOutDevice(): Promise<void>

  // identity setup
  setupFirstDevice(): Promise<{ recoveryKey: string; status: CryptoStatus }>
  restoreFromRecoveryKey(recoveryKey: string): Promise<CryptoStatus>
  /** After a password reset without the recovery key: new master key, old history unreadable. */
  resetIdentity(): Promise<{ recoveryKey: string; status: CryptoStatus }>
  /**
   * Returns the new key only after every blob is uploaded under it. The new key is stored on the
   * device first, so a call after a failed one continues with the same key.
   */
  rotateRecoveryKey(): Promise<{ recoveryKey: string }>

  // device linking (§12.5)
  linkAsNewDevice(mode: 'qr' | 'sas'): Promise<LinkStart>
  /** Existing device, QR mode: the scanned or typed payload. */
  linkScan(qrPayload: string): Promise<{ sessionId: string; newDeviceName: string }>
  /** Existing device, SAS mode: accept a session from listLinkSessions. */
  linkAccept(sessionId: string): Promise<void>
  listLinkSessions(): Promise<{ sessionId: string; newDeviceName: string; platform: DevicePlatform; createdAt: string }[]>
  /** Existing device: the user compared the emoji. True sends the transfer. */
  linkConfirmSas(sessionId: string, matches: boolean): Promise<void>
  linkCancel(sessionId: string): Promise<void>

  // devices
  listDevices(): Promise<DeviceSummary[]>
  /** Primary device only (master key). */
  revokeDevice(deviceId: DeviceId, reason: Exclude<RevocationReasonName, 'password_reset' | 'signed_out'>): Promise<void>
  renameDevice(deviceId: DeviceId, name: string): Promise<void>

  // trust and verification
  getTrust(userId: UserId): Promise<TrustInfo>
  /**
   * The devices of a user whose chain verified in the Worker: the pinned (or TOFU) master key, a
   * DSK signed by it, a device certificate signed by that DSK. Revoked devices are left out.
   * Empty when the user has no identity, or the DS serves another master for this user.
   */
  listContactDevices(userId: UserId): Promise<ContactDevice[]>
  /** During a key change (trust 'changed'): the number of the new master key. */
  getSafetyNumber(userId: UserId): Promise<SafetyNumber>
  /** Scanned VERIFY_QR payload. Sets 'verified' on a match. During a key change, a match accepts the new master key. */
  verifyQr(qrPayload: string): Promise<{ userId: UserId; match: boolean }>
  /** true during a key change accepts the new master key as verified. */
  setVerified(userId: UserId, verified: boolean): Promise<TrustInfo>
  /**
   * Accepts the new master key of a key change ('changed' → 'tofu'). Until then the chain checks
   * keep the old pin, so no device of the user passes them (no Add, no join, no commit).
   */
  acknowledgeKeyChange(userId: UserId): Promise<TrustInfo>
  /** 30 digits from the current epoch authenticator (§12.5). */
  getEpochCode(groupId: GroupIdB64): Promise<string>

  // gateway and group sync
  /** Call on every READY/RESUMED: catches up groups, key packages, inbox, KT. */
  sync(): Promise<void>
  onGatewayEvent(event: CryptoGatewayEvent): Promise<void>
  /** The group a channel sends to. Joins the public set group on first use. */
  ensureChannelGroup(channelId: ChannelId): Promise<WireMlsGroup>
  membershipTimeline(channelId: ChannelId, limit: number): Promise<MembershipEvent[]>

  // messages
  encryptMessage(input: EncryptMessageInput): Promise<EncryptMessageOutput>
  /** In history order. The Worker dedupes and verifies (§12.8). */
  decryptMessages(messages: EncryptedMessage[]): Promise<DecryptResult[]>
  /** Opening for POST /reports (§12.16 franking). */
  buildReport(message: EncryptedMessage): Promise<{ content: B64url; frankingKey: B64url }>

  // pages (§12.20)
  /**
   * Seals one page envelope in the channel's current group (pending Removes are committed first).
   * Throws CryptoError('TooLarge') above Limits.maxEnvelopeBytes (MAX_DOC_AWARENESS_B64_BYTES for doc_awareness).
   */
  encryptDoc(input: EncryptDocInput): Promise<EncryptDocOutput>
  /** One result per item, in order. Returns decrypted content only, never a key. */
  decryptDoc(items: EncryptedDocItem[]): Promise<DocDecryptResult[]>

  // attachments
  encryptAttachment(input: AttachmentInput): Promise<EncryptedAttachment>
  /** Checks the blob length against Padmé(size + 1) and sha256, then decrypts. The Blob has type = pointer.mime. Works for thumbnails too. */
  decryptAttachment(pointer: Pick<AttachmentPointer, 'key' | 'sha256' | 'mime' | 'size'>, blob: Blob): Promise<Blob>

  // backups
  backupNow(): Promise<{ uploaded: number }>

  // key transparency (Phase 4)
  ktSelfCheck(): Promise<KtSelfCheckResult>

  // signed admin actions (Phase 4, §12.16)
  /**
   * Fetches the chain head, fills seq and prev_hash, signs with the device MLS key.
   * Returns the header value for X-Hachiman-Signed-Action. `payload` is the encoded payload
   * (AdminActionModule.encodePayload).
   */
  signAdminAction(guildId: GuildId, type: AdminActionTypeId, payload: Uint8Array): Promise<{ header: B64url; seq: number }>

  // invites with history (§12.11.4)
  /**
   * Makes a new invite seed and signs an InviteRecord with the device MLS key. `record` is the
   * encoded SignedInviteRecord for POST /guilds/:id/invites. `linkSecret` is the seed as base64url.
   * Like the recovery key, it crosses to the UI thread: an exception recorded in §12.17. The UI
   * keeps it only in component state and puts it only in the link fragment. `channelIds` is the
   * scope that the record holds: the input channels that @everyone can view in the verified admin
   * state, sorted. `expiresAtMs` 0 is permanent, `maxUses` 0 is no limit. Throws
   * CryptoError('Unsupported') without an admin state, when this user is not an administrator in
   * it or not a guild member, and when no channel stays.
   */
  prepareHistoryInvite(input: { guildId: GuildId; channelIds: ChannelId[]; expiresAtMs: number; maxUses: number }): Promise<{ record: B64url; linkSecret: string; channelIds: ChannelId[] }>
  /**
   * After POST /guilds/:id/invites: seals the epoch secrets that this device holds for each group
   * of the scope (at most HISTORY_BUNDLE_MAX_EPOCHS each, the newest) and posts one bundle per group.
   * Throws CryptoError('InvalidChain') when the record fails the checks of §12.16.
   */
  sendInviteBundles(input: { guildId: GuildId; inviteId: string; record: B64url }): Promise<{ groups: number }>
  /**
   * After POST /invites/:code: verifies the record against the seed and the admin state, opens
   * each bundle, checks its sender and its group and imports its keys (source 'bundle'). Messages
   * that decrypt with them have `membershipVerified` false. Call it when the guild members are in
   * the client cache (the creator must be in `guildMembers`). Throws CryptoError('GroupPending')
   * while `guildMembers` of the guild does not have this user: the cache does not have the guild
   * yet, so retry after GUILD_CREATE. Throws CryptoError('InvalidChain') when the record fails; a
   * record that expired less than INVITE_BUNDLE_FETCH_WINDOW_MS ago still passes. A bundle that
   * fails is dropped alone (an `error` event), also a bundle of a group outside the scope. Per
   * epoch, the keys of the creator device win, then the first bundle; keys above the bundle epoch
   * are dropped (§12.11.4). The Worker gets the bundles again after the redemption and after each
   * join of a scope group (§12.11.4 "Later bundles").
   */
  redeemInvite(input: { code: string; linkSecret: string }): Promise<{ groups: number; keys: number }>

  // device proof of possession (§12.12, §12.13)
  /**
   * Signs a DS request or an IDENTIFY/RESUME with the device MLS signature key. The Worker adds the
   * device id, the timestamp and the nonce. During POST /devices (no device id yet) it signs with
   * the key that the registration presents, and device id "". NoIdentity when there is no key.
   */
  proveDevice(input: DeviceProofInput): Promise<DeviceProof>

  // voice (§8, §12.10)
  /**
   * guildId: the guild of the voice channel. The creator writes it into the group descriptor and a
   * joiner checks the descriptor against it (§12.10.1). Without it, this device does not create the
   * group (the media node gives the create to the next joiner after 5 s).
   */
  voiceStart(opts: { channelId: ChannelId; guildId?: GuildId | null }): Promise<VoiceSessionStart>
  /** One media op in, zero or more client ops out (send in order). */
  voiceHandle(handle: string, op: VoiceE2eeServerOp): Promise<VoiceE2eeClientOp[]>
  /** Gives the transform Worker a port that receives FrameKeyMessage. Returns the port id for voiceDetachTransform. */
  voiceAttachTransform(handle: string, port: MessagePort): Promise<string>
  /**
   * Sends `close` on the port and forgets it: the transform Worker closes its ring and its end of
   * the port. Call it when the receiver of the transform ends. An unknown id is a no-op.
   */
  voiceDetachTransform(portId: string): Promise<void>
  /** Participants from the MLS tree, not from the server roster. */
  voiceRoster(handle: string): Promise<VoiceRosterEntry[]>
  voiceEpochCode(handle: string): Promise<string | null>
  voiceStop(handle: string): Promise<void>
}

/** Worker → UI events. */
export interface CryptoEvents {
  status: CryptoStatus
  /**
   * The DS serves another master key for a contact, not a valid rotation of the pin. The pin
   * stays until acknowledgeKeyChange (or a new verification). 'blocking' for a verified contact.
   */
  keyChange: { userId: UserId; severity: 'blocking' | 'notice' }
  /**
   * The group state forked (§12.8.7), or this device rejected a commit that the DS accepted
   * ('commit_rejected', §12.7.9). The Worker starts a resync by external commit. `epoch` is the
   * epoch of the local state when the alert fired (null when unknown).
   */
  forkAlert: { groupId: GroupIdB64; channelId: ChannelId | null; epoch: number | null; reason: 'aead_failures' | 'group_info_mismatch' | 'commit_rejected' }
  membership: MembershipEvent
  /** Existing device, SAS mode: show these emoji. */
  linkSas: { sessionId: string; emoji: SasEmoji[] }
  linkDone: { sessionId: string; role: LinkRole; ok: boolean; error: CryptoErrorCode | null }
  /**
   * Messages that were 'pending' can now decrypt: the UI calls decryptMessages again. Also when
   * the secret from the MLS state replaced a stored secret that differed (§12.11.1).
   */
  epochKeysAvailable: { groupId: GroupIdB64; epochs: number[] }
  /** 'kt_missing': KT is required (§12.14) but a key object had no KT entry, or no signed tree head covered it. */
  ktAlert: { kind: 'self_unknown_entry' | 'split_view' | 'bad_proof' | 'kt_missing'; detail: string }
  voiceRoster: { handle: string; roster: VoiceRosterEntry[]; epoch: number }
  /**
   * §12.20 "Access by new members": a commit in a text group added a leaf of a user that had no
   * leaf before. The UI re-wraps the page pointers and titles of the pages channels of the group.
   * `byMe`: this device made the commit. Never for an own join, Welcome or create.
   */
  usersAdded: { groupId: GroupIdB64; kind: 'public_set' | 'channel'; guildId: GuildId | null; channelId: ChannelId | null; epoch: number; userIds: UserId[]; byMe: boolean }
  error: CryptoErrorShape
}

/** The main-thread proxy (src/bridge). */
export interface CryptoClient extends CryptoApi {
  on<K extends keyof CryptoEvents>(event: K, cb: (payload: CryptoEvents[K]) => void): () => void
  /** Terminates the Worker. */
  dispose(): void
}

export interface CreateCryptoClientOptions {
  transport: DsTransport
  /** Default: new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' }), resolved from src/bridge. */
  worker?: Worker
}
export type CreateCryptoClient = (opts: CreateCryptoClientOptions) => CryptoClient

/** Stub for apps/hachiman/src/dev/preview: same surface, no Worker. */
export type CreateCryptoStub = () => CryptoClient

// MARK: - 4. Module contracts

// MARK: 4.1 identity (src/identity, §12.4, §12.5, §12.11)

export interface MasterKeyRecord {
  userId: UserId
  publicKey: Uint8Array
  generation: number
  createdAtMs: number
  /** Signature by the previous master key over this record (rotation with the recovery key), or null (first key or reset). */
  prevSignature: Uint8Array | null
  /** SignWithLabel(masterKey, "MasterKey", MasterKeyTBS). */
  signature: Uint8Array
}

export interface DeviceSigningKeyCert {
  userId: UserId
  publicKey: Uint8Array
  generation: number
  masterGeneration: number
  issuedAtMs: number
  signature: Uint8Array
}

export interface DeviceCertificate {
  userId: UserId
  deviceId: DeviceId
  /** The device's MLS signature key (Ed25519). The same in every group. */
  mlsSignatureKey: Uint8Array
  /** X25519 key for SealedDeviceMessage (§12.5). */
  hpkeKey: Uint8Array
  dskGeneration: number
  issuedAtMs: number
  displayName: string
  signature: Uint8Array
}

export interface DeviceChain {
  master: MasterKeyRecord
  dsk: DeviceSigningKeyCert
  device: DeviceCertificate
}

export interface DeviceRevocation {
  userId: UserId
  deviceId: DeviceId
  revokedAtMs: number
  reason: RevocationReasonId
  masterGeneration: number
  signature: Uint8Array
}

/** What the verifier knows about the user of a chain. */
export interface ChainContext {
  /** The TOFU or verified master key for chain.master.userId, or null on first sight. */
  pinnedMaster: Pick<MasterKeyRecord, 'publicKey' | 'generation'> | null
  /** The current DSK generation per the DS, and when it replaced the previous one. */
  currentDsk: { generation: number; issuedAtMs: number } | null
  /**
   * The highest DSK generation this client saw for the user (store contacts.dskGeneration).
   * A currentDsk below it is a downgrade (§12.4 rule 9): verdict 'dsk_downgrade'.
   */
  highestSeenDskGeneration: number | null
  revokedDeviceIds: ReadonlySet<DeviceId>
  /** The MLS leaf this chain rides on. */
  leaf: { credentialIdentity: string; signatureKey: Uint8Array } | null
  /** True when the leaf enters a group now (Add or external commit, resync included): needs the current DSK. */
  entering: boolean
  nowMs: number
}

export type ChainVerdict =
  | { ok: true; firstSight: boolean }
  | { ok: false; reason: 'bad_signature' | 'user_mismatch' | 'device_mismatch' | 'key_mismatch' | 'master_changed' | 'dsk_superseded' | 'dsk_downgrade' | 'revoked' | 'malformed' }

export interface LinkOffer {
  userId: UserId
  deviceId: DeviceId
  mode: 'qr' | 'sas'
  /** SAS mode: SHA-256(e_pub). QR mode: empty (the QR carries e_pub). */
  commitment: Uint8Array
  mlsSignatureKey: Uint8Array
  hpkeKey: Uint8Array
  deviceName: string
  platform: DevicePlatform
}

export interface LinkTransfer {
  master: MasterKeyRecord
  dskCert: DeviceSigningKeyCert
  dskPrivateKey: Uint8Array
  deviceCertificate: DeviceCertificate
  /** Optional: S_e per (group, epoch) so the new device reads history (§12.11). */
  historyKeys: HistoryKeyEntry[]
}

export interface HistoryKeyEntry {
  groupId: Uint8Array
  epoch: number
  secret: Uint8Array
}

export interface IdentityModule {
  // codecs: encode is deterministic, decode rejects trailing bytes
  encodeMasterKeyRecord(r: MasterKeyRecord): Uint8Array
  decodeMasterKeyRecord(b: Uint8Array): MasterKeyRecord
  encodeDskCert(c: DeviceSigningKeyCert): Uint8Array
  decodeDskCert(b: Uint8Array): DeviceSigningKeyCert
  encodeDeviceCertificate(c: DeviceCertificate): Uint8Array
  decodeDeviceCertificate(b: Uint8Array): DeviceCertificate
  encodeDeviceChain(c: DeviceChain): Uint8Array
  decodeDeviceChain(b: Uint8Array): DeviceChain
  encodeRevocation(r: DeviceRevocation): Uint8Array
  decodeRevocation(b: Uint8Array): DeviceRevocation

  /** Hachiman SignWithLabel (§12.2). */
  signWithLabel(privateKey: Uint8Array, label: string, content: Uint8Array): Uint8Array
  verifyWithLabel(publicKey: Uint8Array, label: string, content: Uint8Array, signature: Uint8Array): boolean

  createMasterKey(userId: UserId, generation: number, prev: Ed25519KeyPair | null): { record: MasterKeyRecord; keyPair: Ed25519KeyPair }
  createDeviceSigningKey(master: { record: MasterKeyRecord; keyPair: Ed25519KeyPair }, generation: number): { cert: DeviceSigningKeyCert; keyPair: Ed25519KeyPair }
  certifyDevice(dsk: { cert: DeviceSigningKeyCert; keyPair: Ed25519KeyPair }, device: Omit<DeviceCertificate, 'signature' | 'dskGeneration' | 'userId'>): DeviceCertificate
  /** Reasons 1, 2, 4: signed by the master key. */
  revoke(master: { record: MasterKeyRecord; keyPair: Ed25519KeyPair }, deviceId: DeviceId, reason: RevocationReasonId, nowMs: number): DeviceRevocation
  /** Reason 5 (signed_out): signed by the device's own MLS signature key (§12.4). */
  signOut(self: { userId: UserId; deviceId: DeviceId; masterGeneration: number; mlsSignatureKey: Ed25519KeyPair }, nowMs: number): DeviceRevocation
  verifyMasterKeyRecord(r: MasterKeyRecord, prevPublicKey: Uint8Array | null): boolean
  /** Reason 5 verifies under device.mlsSignatureKey; reasons 1, 2, 4 under master. Reason 3 is never signed (false). */
  verifyRevocation(r: DeviceRevocation, keys: { master: MasterKeyRecord; device: DeviceCertificate | null }): boolean
  /** Synchronous: ts-mls commit callbacks are synchronous. */
  verifyChain(chain: DeviceChain, ctx: ChainContext): ChainVerdict

  /** "userId:deviceId" (§12.4). */
  credentialIdentity(userId: UserId, deviceId: DeviceId): string
  parseCredentialIdentity(identity: string): { userId: UserId; deviceId: DeviceId } | null

  safetyNumber(self: { userId: UserId; masterKey: Uint8Array }, peer: { userId: UserId; masterKey: Uint8Array }): SafetyNumber
  parseVerifyQr(payload: string): { userId: UserId; masterKey: Uint8Array; peerUserId: UserId; peerMasterKey: Uint8Array }
  epochCode(epochAuthenticator: Uint8Array): string

  // recovery and backups (§12.11)
  generateRecoveryKey(): { bytes: Uint8Array; text: string }
  parseRecoveryKey(text: string): Uint8Array
  deriveBackupKeys(recoveryKey: Uint8Array): { key: Uint8Array; keyId: Uint8Array }
  sealBackup(keys: { key: Uint8Array; keyId: Uint8Array }, kind: BackupKindId, plaintext: Uint8Array): Uint8Array
  openBackup(keys: { key: Uint8Array; keyId: Uint8Array }, blob: Uint8Array): { kind: BackupKindId; plaintext: Uint8Array }
  encodeIdentityBackup(v: { master: MasterKeyRecord; masterPrivateKey: Uint8Array; dskCert: DeviceSigningKeyCert; dskPrivateKey: Uint8Array }): Uint8Array
  decodeIdentityBackup(b: Uint8Array): { master: MasterKeyRecord; masterPrivateKey: Uint8Array; dskCert: DeviceSigningKeyCert; dskPrivateKey: Uint8Array }
  encodeHistoryBatch(entries: HistoryKeyEntry[]): Uint8Array
  decodeHistoryBatch(b: Uint8Array): HistoryKeyEntry[]

  // sealed device messages: HPKE base mode to DeviceCertificate.hpkeKey (§12.5)
  /**
   * The HPKE info binds `opts.recipientDeviceId`. The inner signature uses `opts.signatureKey`,
   * the sender device's MLS signature private key (§12.5).
   */
  sealToDevice(
    recipientHpkeKey: Uint8Array,
    kind: Exclude<InboxKind, 'welcome'>,
    senderDeviceId: DeviceId,
    plaintext: Uint8Array,
    opts: { recipientDeviceId: DeviceId; signatureKey: Uint8Array },
  ): Promise<Uint8Array>
  /**
   * `opts.recipientDeviceId` is this device (HPKE info). `opts.senderSignatureKey` returns the
   * verified MLS signature public key of the sender device, or null (the open then fails).
   * `plaintext` is the verified payload.
   */
  openFromDevice(
    recipientHpkePrivateKey: Uint8Array,
    sealed: Uint8Array,
    opts: { recipientDeviceId: DeviceId; senderSignatureKey: (senderDeviceId: DeviceId, kind: Exclude<InboxKind, 'welcome'>) => Promise<Uint8Array | null> },
  ): Promise<{ kind: Exclude<InboxKind, 'welcome'>; senderDeviceId: DeviceId; plaintext: Uint8Array }>

  // device linking (§12.5): pure steps, the engine moves messages over the DS
  link: LinkProtocol
}

// MARK: 4.1b admin (src/admin, §12.16, Phase 4). Owned by crypto-identity.

/** Decoded payloads, one per AdminActionType. */
export type AdminPayload =
  | { type: 0; ownerId: UserId }
  | { type: 1 | 2; roleId: string; permissions: number; position: number }
  | { type: 3; roleId: string }
  | { type: 4; positions: { roleId: string; position: number }[] }
  | { type: 5; channelId: ChannelId; targetId: string; targetType: 'role' | 'member'; allow: number; deny: number }
  | { type: 6; channelId: ChannelId; targetId: string; targetType: 'role' | 'member' }
  | { type: 7; userId: UserId; roleIds: string[] }
  | { type: 8; channelId: ChannelId; historyVisibility: HistoryVisibilityName }

/** The permission state that a replay of the chain proves. Plain data (structured-cloneable). */
export interface AdminReplayState {
  guildId: GuildId
  /** The last applied seq and the hash of that action (the chain head). */
  seq: number
  headHash: Uint8Array
  ownerId: UserId
  roles: { id: string; permissions: number; position: number }[]
  overwrites: { channelId: ChannelId; targetId: string; targetType: 'role' | 'member'; allow: number; deny: number }[]
  memberRoles: { userId: UserId; roleIds: string[] }[]
  historyVisibility: { channelId: ChannelId; value: HistoryVisibilityName }[]
}

/**
 * The §2 permission rules. The Worker passes an implementation over
 * `@hachiman/client/permissions` (computeBasePermissions / computeChannelPermissions),
 * so each language keeps one permission implementation. Tests pass a fake.
 */
export interface AdminPermissionModel {
  guildPermissions(state: AdminReplayState, userId: UserId): number
  channelPermissions(state: AdminReplayState, channelId: ChannelId, userId: UserId, guildMembers: readonly UserId[]): number
  /** Role hierarchy check for role edits and member-role changes (§4 "Implemented extras"). */
  outranks(state: AdminReplayState, actorUserId: UserId, roleId: string): boolean
  /**
   * The channel permissions of a member with no roles who is not the owner: the @everyone role and
   * the @everyone overwrite only. The scope check of an invite with history (§12.11.4, §12.16).
   */
  everyoneChannelPermissions(state: AdminReplayState, channelId: ChannelId): number
}

export interface AdminActionModule {
  encodeAction(a: AdminAction): Uint8Array
  decodeAction(b: Uint8Array): AdminAction
  encodePayload(p: AdminPayload): Uint8Array
  decodePayload(type: AdminActionTypeId, b: Uint8Array): AdminPayload
  /** SignWithLabel(actor MLS signature key, "AdminAction", encode(all fields but signature)). */
  sign(unsigned: Omit<AdminAction, 'signature'>, actorSignatureKey: Uint8Array): AdminAction
  verify(a: AdminAction, actorCert: DeviceCertificate): boolean
  /** SHA-256(encode(action)): the prev_hash of the next action. */
  hash(a: AdminAction): Uint8Array
  /**
   * Applies actions in seq order from `state` (null = start at genesis). Each action needs a
   * valid signature (actorCert lookup, chain checked by the caller), the right seq and prev_hash,
   * and an actor that had the permission in the state before the action. Throws CryptoError('Malformed')
   * with the failing seq.
   */
  replay(state: AdminReplayState | null, actions: AdminAction[], actorCert: (userId: UserId, deviceId: DeviceId) => DeviceCertificate | null, perms: AdminPermissionModel): AdminReplayState
}

// MARK: 4.1c invites (src/invites, §12.11.4)

/** A decoded InviteRecord. Ids are text, keys are base64url. */
export interface InviteRecordView {
  guildId: GuildId
  /** X25519: the HPKE recipient key of the bundles. */
  hpkePublic: B64url
  /** sign_public (Ed25519): the invite key id. */
  keyId: B64url
  /** Strictly ascending (16-byte order), at most INVITE_MAX_SCOPE_CHANNELS. */
  channelIds: ChannelId[]
  /** The seq of the admin state that the creator used (§12.16). */
  adminChainSeq: number
  /** 0 = permanent. */
  expiresAtMs: number
  /** 0 = no limit. */
  maxUses: number
  creatorUserId: UserId
  creatorDeviceId: DeviceId
}

export interface LinkSecrets {
  ephemeral: X25519KeyPair
  /** QR mode only. */
  linkSecret: Uint8Array | null
}

export interface LinkProtocol {
  encodeOffer(o: LinkOffer): Uint8Array
  decodeOffer(b: Uint8Array): LinkOffer
  /**
   * New device. `qrPayload` is always null: LinkQr.session_id exists only after
   * POST /devices/link-sessions, so the caller builds the QR with encodeQr afterwards.
   */
  createOffer(base: Omit<LinkOffer, 'commitment' | 'mode'>, mode: 'qr' | 'sas'): { offer: LinkOffer; secrets: LinkSecrets; qrPayload: string | null }
  /** New device, QR mode: LINK_QR_PREFIX + base64url(LinkQr) (§12.5). */
  encodeQr(offer: LinkOffer, sessionId: string, ephemeralPublic: Uint8Array, linkSecret: Uint8Array): string
  /** Existing device: the scanned LinkQr, with its session id. */
  parseQr(payload: string): { offer: LinkOffer; ephemeralPublic: Uint8Array; linkSecret: Uint8Array; sessionId: string }
  /** Message bodies on the link session (§12.5): LinkMessage = accept | reveal | transfer | done | abort. */
  encodeMessage(m: LinkMessage): Uint8Array
  decodeMessage(b: Uint8Array): LinkMessage
  /** Both sides, after the public keys are known. Checks the SAS commitment. */
  deriveSession(input: { offer: LinkOffer; existingPublic: Uint8Array; newPublic: Uint8Array; ownPrivate: Uint8Array; linkSecret: Uint8Array | null }): { sas: SasEmoji[]; key: Uint8Array; transcriptHash: Uint8Array }
  sealTransfer(key: Uint8Array, transcriptHash: Uint8Array, t: LinkTransfer): Uint8Array
  openTransfer(key: Uint8Array, transcriptHash: Uint8Array, sealed: Uint8Array): LinkTransfer
}

export type LinkMessage =
  | { type: 'accept'; existingDeviceId: DeviceId; ephemeralPublic: Uint8Array }
  | { type: 'reveal'; ephemeralPublic: Uint8Array }
  | { type: 'transfer'; sealed: Uint8Array }
  | { type: 'done'; confirmation: Uint8Array }
  | { type: 'abort'; reason: 'sas_mismatch' | 'cancelled' | 'error' }

// MARK: 4.2 kt (src/kt, §12.14). Merkle math is shared by the client and Takusen.

export interface KtEntry {
  type: (typeof KtEntryType)[keyof typeof KtEntryType]
  userId: UserId
  timestampMs: number
  /** The encoded signed object: MasterKeyRecord, DeviceSigningKeyCert, DeviceCertificate or DeviceRevocation. */
  object: Uint8Array
}

export interface SignedTreeHead {
  treeSize: number
  timestampMs: number
  rootHash: Uint8Array
  signature: Uint8Array
}

export interface KtModule {
  encodeEntry(e: KtEntry): Uint8Array
  decodeEntry(b: Uint8Array): KtEntry
  encodeTreeHead(h: SignedTreeHead): Uint8Array
  decodeTreeHead(b: Uint8Array): SignedTreeHead
  /** RFC 6962 §2.1: SHA-256(0x00 || entry). */
  leafHash(entry: Uint8Array): Uint8Array
  /** RFC 6962 MTH over leaf hashes. */
  rootHash(leafHashes: readonly Uint8Array[]): Uint8Array
  inclusionProof(leafHashes: readonly Uint8Array[], index: number, treeSize: number): Uint8Array[]
  consistencyProof(leafHashes: readonly Uint8Array[], from: number, to: number): Uint8Array[]
  verifyInclusion(leafHash: Uint8Array, index: number, treeSize: number, proof: readonly Uint8Array[], root: Uint8Array): boolean
  verifyConsistency(from: number, to: number, fromRoot: Uint8Array, toRoot: Uint8Array, proof: readonly Uint8Array[]): boolean
  signTreeHead(ktPrivateKey: Uint8Array, h: Omit<SignedTreeHead, 'signature'>): SignedTreeHead
  verifyTreeHead(ktPublicKey: Uint8Array, h: SignedTreeHead): boolean
}

// MARK: 4.3 mls (src/mls): ts-mls wrapper used by the Worker engine

export interface GroupDescriptor {
  kind: GroupKindName
  guildId: GuildId | null
  channelId: ChannelId | null
  historyVisibility: HistoryVisibilityName
  createdByUserId: UserId
}

export interface GroupIdParts {
  kind: GroupKindName
  /** guild id (public_set), channel id (channel, dm) or 16 random bytes as a UUID (voice). */
  scope: string
  generation: number
}

/** A leaf as the roster sees it. */
export interface LeafEntry {
  leafIndex: number
  userId: UserId
  deviceId: DeviceId
  signatureKey: Uint8Array
  chain: DeviceChain | null
}

/** Opaque handle to a ts-mls ClientState inside the Worker. */
export interface MlsGroupHandle {
  readonly groupId: Uint8Array
  readonly epoch: number
  readonly cipherSuite: CipherSuiteId
  readonly ownLeaf: number
  /** Encoded state bytes (ts-mls encodeGroupState) for the store. */
  readonly state: Uint8Array
}

export interface PendingCommit {
  groupId: Uint8Array
  /** The epoch the commit applies to. */
  epoch: number
  request: Omit<WireCommitRequest, 'batchId' | 'rejected'>
  /** The state after the DS accepts. Discard it on 409. */
  next: MlsGroupHandle
  added: LeafEntry[]
  removed: LeafEntry[]
}

/** The policy the engine applies to incoming commits and proposals (§12.7.3 table, §12.6 GCE rules). */
export interface ProposalPolicy {
  kind: GroupKindName
  /** The pinned DS ExternalSender signature key. Null for 'voice' (no external sender: every DS proposal is rejected). */
  dsExternalSenderKey: Uint8Array | null
  /** Readers per the client's own permission computation. Null when unknown (DM: participants). */
  readers: ReadonlySet<UserId> | null
  /**
   * Phase 4: readers per the replayed signed admin chain (§12.16), or null for a guild
   * without a genesis action. When set, an Add in a 'channel' group also needs the joiner here.
   */
  adminReaders: ReadonlySet<UserId> | null
  /**
   * Set only for this device's own batch commits (§12.16): the guild of a 'channel' group has no
   * verified genesis action. The committer then rejects every Add ('admin_chain_missing'): it does
   * not fall back to the unsigned DS readers.
   */
  adminChainMissing?: boolean
  /** Synchronous (the ts-mls callback is synchronous): prefetch with IdentityService.chainContextFor. */
  chainContextFor(userId: UserId): ChainContext
  /**
   * May this user commit a GCE that changes history_visibility? MANAGE_CHANNELS on the channel
   * ('channel'), MANAGE_GUILD ('public_set'), always false for 'dm' and 'voice'.
   */
  canChangeDescriptor(userId: UserId): boolean
  /** 'voice' only: the media roster. Adds need a `pending` identity, Removes a `departed` device. */
  voice: { pending: ReadonlySet<string>; departedDeviceIds: ReadonlySet<DeviceId> } | null
}

export interface MlsModule {
  groupId(parts: GroupIdParts): Uint8Array
  parseGroupId(id: Uint8Array): GroupIdParts
  encodeGroupDescriptor(d: GroupDescriptor): Uint8Array
  decodeGroupDescriptor(b: Uint8Array): GroupDescriptor

  /** Key packages carry the DEVICE_CHAIN leaf extension and use the device's MLS signature key. */
  generateKeyPackages(input: { chain: DeviceChain; signatureKey: Ed25519KeyPair; cipherSuite: CipherSuiteId; count: number; lastResort: boolean }): Promise<{ publicPackage: Uint8Array; privatePackage: Uint8Array; ref: Uint8Array }[]>

  createGroup(input: { groupId: Uint8Array; descriptor: GroupDescriptor; dsExternalSender: Uint8Array | null; cipherSuite: CipherSuiteId; keyPackage: { publicPackage: Uint8Array; privatePackage: Uint8Array } }): Promise<{ handle: MlsGroupHandle; groupInfo: Uint8Array; ratchetTree: Uint8Array }>
  joinFromWelcome(input: { welcome: Uint8Array; ratchetTree: Uint8Array; keyPackage: { publicPackage: Uint8Array; privatePackage: Uint8Array }; policy: ProposalPolicy }): Promise<MlsGroupHandle>
  joinExternal(input: { groupInfo: Uint8Array; ratchetTree: Uint8Array; keyPackage: { publicPackage: Uint8Array; privatePackage: Uint8Array }; resync: boolean; policy: ProposalPolicy }): Promise<PendingCommit>

  /** Applies one handshake. A rejected message leaves the state unchanged. */
  processHandshake(handle: MlsGroupHandle, message: Uint8Array, policy: ProposalPolicy): Promise<
    | { result: 'applied'; handle: MlsGroupHandle; added: LeafEntry[]; removed: LeafEntry[]; committerLeaf: number | null; selfRemoved: boolean }
    | { result: 'proposal_stored'; handle: MlsGroupHandle; proposal: 'add' | 'remove' | 'other' }
    | { result: 'rejected'; reason: string }
  >
  /**
   * Commits every stored proposal plus the Adds and Removes by value. PublicMessage framing.
   * Drops a Remove by value whose leaf a stored proposal already removes, so no leaf is removed twice.
   * A descriptor change keeps external_senders and required_capabilities byte-identical.
   */
  commit(handle: MlsGroupHandle, input: { adds: Uint8Array[]; removes: number[]; descriptor: GroupDescriptor | null; policy: ProposalPolicy }): Promise<PendingCommit>
  /** True when the state holds a Remove proposal that no commit applied yet (§12.7.5). */
  hasPendingRemoves(handle: MlsGroupHandle): boolean
  roster(handle: MlsGroupHandle): LeafEntry[]
  exporter(handle: MlsGroupHandle, label: string, context: Uint8Array, length: number): Promise<Uint8Array>
  epochAuthenticator(handle: MlsGroupHandle): Uint8Array
  /** GroupInfo with external_pub for the DS (no ratchet_tree extension). */
  groupInfo(handle: MlsGroupHandle): Promise<{ groupInfo: Uint8Array; ratchetTree: Uint8Array }>
  /** Compares a DS GroupInfo with the own state (fork check, §12.8). */
  matchesGroupInfo(handle: MlsGroupHandle, groupInfo: Uint8Array): boolean
  restore(state: Uint8Array): Promise<MlsGroupHandle>

  // history bundles (§12.11)
  sealHistoryBundle(handle: MlsGroupHandle, signatureKey: Uint8Array, senderDeviceId: DeviceId, entries: HistoryKeyEntry[]): Promise<Uint8Array>
  openHistoryBundle(handle: MlsGroupHandle, bundle: Uint8Array, policy: ProposalPolicy): Promise<HistoryKeyEntry[]>
}

// MARK: 4.4 ds (src/mls/ds.ts, exported as @hachiman/crypto/ds): Takusen (Node) helpers

export interface DsSigner {
  publicKey: Uint8Array
  privateKey: Uint8Array
  /** encodeExternalSender({ signaturePublicKey, credential: Basic "takusen:ds" }). */
  externalSender: Uint8Array
}

export interface KeyPackageInspection {
  ref: Uint8Array
  cipherSuite: CipherSuiteId
  userId: UserId
  deviceId: DeviceId
  signatureKey: Uint8Array
  chain: DeviceChain | null
  notAfterMs: number
  signatureValid: boolean
}

export interface CommitInspection {
  groupId: Uint8Array
  /** The epoch in the commit's FramedContent. */
  epoch: number
  sender: { type: 'member'; leafIndex: number } | { type: 'new_member_commit' }
  proposalTypes: ('add' | 'remove' | 'update' | 'external_init' | 'group_context_extensions' | 'psk' | 'reinit' | 'other')[]
  /** Proposals by reference (RFC 9420 ProposalRef). */
  proposalRefs: Uint8Array[]
  /** From the uploaded GroupInfo + ratchet tree of epoch + 1. */
  next: { epoch: number; roster: LeafEntry[]; descriptor: GroupDescriptor | null; signerLeaf: number; hasExternalPub: boolean }
  /** Leaf indexes that are new or not byte-equal to `previous` (§12.7.3 check 7). */
  changedLeaves: number[]
  removedLeaves: number[]
  /** True when the commit changes the group context extensions (only history_visibility may change, §12.6). */
  descriptorChanged: boolean
}

export interface GroupInfoInspection {
  groupId: Uint8Array
  epoch: number
  cipherSuite: CipherSuiteId
  signatureValid: boolean
  treeHashValid: boolean
  roster: LeafEntry[]
  /** Extension types in order, and the raw external_senders / required_capabilities bytes. */
  extensions: { types: number[]; externalSenders: Uint8Array | null; requiredCapabilities: Uint8Array | null }
  descriptor: GroupDescriptor | null
}

export type CommitCheck = { ok: true; inspection: CommitInspection } | { ok: false; reason: string }

export interface EnvelopeHeader {
  groupId: Uint8Array
  channelId: ChannelId
  epoch: number
  senderLeaf: number
  senderDeviceId: DeviceId
  clientMsgId: Uint8Array
  salt: Uint8Array
  frankingTag: Uint8Array
}

/** The decoded DocEnvelopeHeader of a page envelope (§12.20). */
export interface DocEnvelopeHeader {
  kind: DocEnvelopeKindName
  groupId: Uint8Array
  channelId: ChannelId
  pageId: PageId
  epoch: number
  senderLeaf: number
  senderDeviceId: DeviceId
  salt: Uint8Array
}

export interface DsModule {
  loadSigner(seed: Uint8Array): Promise<DsSigner>
  /** proposeExternal(Remove) for the current epoch. Returns MLSMessage bytes. */
  proposeRemove(signer: DsSigner, groupInfo: Uint8Array, leafIndex: number): Promise<Uint8Array>
  /** Public set group only. */
  proposeAdd(signer: DsSigner, groupInfo: Uint8Array, keyPackage: Uint8Array): Promise<Uint8Array>
  /** RFC 9420 ProposalRef of an MLSMessage proposal. */
  proposalRef(message: Uint8Array, cipherSuite: CipherSuiteId): Promise<Uint8Array>
  inspectKeyPackage(bytes: Uint8Array): Promise<KeyPackageInspection>
  /**
   * The §12.7.3 checks that need no database, without group secrets: framing, group id, epoch
   * (2), sender credential = `sender` (3), GroupInfo signature by the signer leaf and tree hash
   * (4), the roster transition from `previous` (5: Adds by value, refs, Removes, external init,
   * resync), every proposal ref against `publishedProposals` (6), and the chain signatures of new
   * or changed leaves (7, no TOFU). Takusen keeps the DB checks (1, device rows in 7, 8, 10, 11)
   * and the policy (9), from `inspection.next.roster`, `changedLeaves` and `removedLeaves`.
   */
  checkCommit(input: {
    groupId: Uint8Array
    epoch: number
    commit: Uint8Array
    groupInfo: Uint8Array
    ratchetTree: Uint8Array
    /** The stored GroupInfo + tree of `epoch`. */
    previous: { groupInfo: Uint8Array; ratchetTree: Uint8Array }
    /** The X-Hachiman-Device of the request. */
    sender: { userId: UserId; deviceId: DeviceId }
    /**
     * The DS proposals that Takusen published for `epoch`: the full MLSMessage (mls_public_message)
     * bytes as stored in mls_pending, not the refs. checkCommit computes each ProposalRef itself and
     * applies the proposal content to the roster transition.
     */
    publishedProposals: readonly Uint8Array[]
    /** The raw 32-byte Ed25519 public key of the user's current master key, or null for an unknown user. */
    masterKeys: (userId: UserId) => Uint8Array | null
  }): Promise<CommitCheck>
  /** For POST /mls/groups (§12.7.7): epoch, signature, tree hash, leaves, extension order and the descriptor. */
  inspectGroupInfo(groupInfo: Uint8Array, ratchetTree: Uint8Array): Promise<GroupInfoInspection>
  /** The roster of a stored GroupInfo + tree. */
  rosterOf(groupInfo: Uint8Array, ratchetTree: Uint8Array): Promise<LeafEntry[]>
  verifyDeviceCertificate(cert: Uint8Array, dsk: Uint8Array, master: Uint8Array): DeviceCertificate | null
  verifyMasterKeyRecord(record: Uint8Array, prev: Uint8Array | null): MasterKeyRecord | null
  verifyDskCert(cert: Uint8Array, master: Uint8Array): DeviceSigningKeyCert | null
  /** Reason 5 verifies under the device certificate; reasons 1, 2, 4 under the master record. */
  verifyRevocation(revocation: Uint8Array, keys: { master: Uint8Array; deviceCertificate: Uint8Array | null }): DeviceRevocation | null
  /** Phase 4 (§12.16): decodes and verifies the signature under the actor certificate. Chain continuity stays in Takusen. */
  verifyAdminAction(action: Uint8Array, actorCertificate: Uint8Array): AdminAction | null
  /** SHA-256(encode(action)), for the next prev_hash. */
  adminActionHash(action: Uint8Array): Uint8Array
  /**
   * §12.11.4: decodes a SignedInviteRecord and verifies its signature under the creator device
   * certificate (the ids must match). Null on any failure. The admin checks stay with the members (§12.16).
   */
  verifyInviteRecord(signedRecord: Uint8Array, creatorCertificate: Uint8Array): InviteRecordView | null
  /**
   * §12.11.4: decodes a SignedInviteRecord without the signature check, for a record that Takusen
   * verified before it stored it (the scope of a bundle post). Throws CryptoError('Malformed').
   */
  parseInviteRecord(signedRecord: Uint8Array): InviteRecordView
  parseEnvelopeHeader(envelope: Uint8Array): EnvelopeHeader
  /** The header of a whole DocEnvelope (§12.20). Throws CryptoError('Malformed'). */
  parseDocEnvelopeHeader(envelope: Uint8Array): DocEnvelopeHeader
  verifyFrankingOpening(input: { frankingTag: Uint8Array; frankingKey: Uint8Array; channelId: ChannelId; clientMsgId: Uint8Array; content: Uint8Array }): boolean
  kt: KtModule
}

// MARK: 4.5 envelope (src/envelope, §12.8)

export interface EnvelopeSealInput {
  header: Omit<EnvelopeHeader, 'salt' | 'frankingTag'>
  kind: 'message' | 'edit'
  editOf: Uint8Array | null
  content: MessageContent
  /** S_e of the header epoch. */
  epochSecret: Uint8Array
  /** The sender's MLS signature private key. */
  signatureKey: Uint8Array
  /** Optional KT gossip (§12.14). */
  ktTreeHead: Uint8Array | null
}

export interface EnvelopeOpenResult {
  header: EnvelopeHeader
  kind: 'message' | 'edit'
  editOf: Uint8Array | null
  content: MessageContent
  frankingKey: Uint8Array
  ktTreeHead: Uint8Array | null
  /** The encoded EnvelopeContent, for franking reports. */
  contentBytes: Uint8Array
}

export interface EnvelopeModule {
  encodeHeader(h: EnvelopeHeader): Uint8Array
  decodeHeader(envelope: Uint8Array): { header: EnvelopeHeader; headerBytes: Uint8Array }
  /** K_msg = HKDF-SHA256(salt, S_e, "hachiman msg key v1" || uint32(sender_leaf)), AES-256-GCM, nonce 0^12. */
  deriveMessageKey(epochSecret: Uint8Array, salt: Uint8Array, senderLeaf: number): Promise<Uint8Array>
  seal(input: EnvelopeSealInput): Promise<Uint8Array>
  /**
   * §12.8.5 steps 3-7 in order. Never throws on bad input: returns { failure } with 'malformed',
   * 'aead', the failure that senderKey returns, 'bad_signature' or 'bad_franking'.
   * senderKey is async (IdentityService.deviceCertificate) and runs after the decrypt, with the
   * decoded kind, so the service can return 'device_mismatch' or 'edit_not_author'.
   */
  open(
    envelope: Uint8Array,
    epochSecret: Uint8Array,
    senderKey: (header: EnvelopeHeader, kind: 'message' | 'edit') => Promise<{ signatureKey: Uint8Array } | { failure: DecryptFailure }>,
  ): Promise<EnvelopeOpenResult | { failure: DecryptFailure }>
  encodeContent(kind: 'message' | 'edit', editOf: Uint8Array | null, content: MessageContent, ktTreeHead: Uint8Array | null): Uint8Array
  decodeContent(b: Uint8Array): { kind: 'message' | 'edit'; editOf: Uint8Array | null; content: MessageContent; ktTreeHead: Uint8Array | null }
}

// MARK: 4.6 attachments (src/attachments, §12.9)

export interface AttachmentModule {
  /** Padmé(L) (§12.9). */
  padme(length: number): number
  /** Returns the blob and its SHA-256 (incremental @noble/hashes sha256). Reads Blob.slice segments. */
  encrypt(plaintext: Blob, key: Uint8Array): Promise<{ blob: Blob; sha256: Uint8Array }>
  /**
   * Checks the blob length (header + Padmé(size + 1) + 16 per segment), then the SHA-256, then
   * decrypts segment by segment. Throws CryptoError('Malformed') on any failure, including
   * truncation, reordering, a missing last flag, bad padding or a size mismatch.
   */
  decrypt(blob: Blob, key: Uint8Array, sha256: Uint8Array, size: number, mime: string): Promise<Blob>
  generateKey(): Uint8Array
}

// MARK: 4.7 franking (src/franking, §12.16)

export interface FrankingModule {
  generateKey(): Uint8Array
  /** HMAC-SHA256(key, "hachiman franking v1" || channel_id || client_msg_id || content). */
  tag(input: { frankingKey: Uint8Array; channelId: ChannelId; clientMsgId: Uint8Array; content: Uint8Array }): Promise<Uint8Array>
  verify(input: { frankingTag: Uint8Array; frankingKey: Uint8Array; channelId: ChannelId; clientMsgId: Uint8Array; content: Uint8Array }): Promise<boolean>
}

// MARK: 4.8 media (src/media, §12.10)

export interface SFrameKeyId {
  mediaIndex: number
  epochBits: number
}

export interface SFrameModule {
  /** KID = (leaf * 2 + track) << SFRAME_EPOCH_BITS | (epoch & 0xF). */
  packKid(leafIndex: number, track: 0 | 1, epoch: number): bigint
  unpackKid(kid: bigint): { leafIndex: number; track: 0 | 1; epochBits: number }
  /** RFC 9605 §4.3 header. */
  encodeHeader(kid: bigint, ctr: bigint): Uint8Array
  decodeHeader(frame: Uint8Array, offset: number): { kid: bigint; ctr: bigint; length: number }
  /** base_key = HKDF-Expand(sframe_epoch_secret, uint32(media_index), 32); then RFC 9605 §4.4.2 key + salt. */
  deriveKey(epochSecret: Uint8Array, mediaIndex: number, kid: bigint): Promise<{ key: CryptoKey; salt: Uint8Array }>
  clearPrefixLength(codec: 'opus' | 'vp8', frame: Uint8Array): number
  /** out = clear prefix || SFrame header || ciphertext || tag. AAD = header || clear prefix. */
  encryptFrame(input: { frame: Uint8Array; codec: 'opus' | 'vp8'; kid: bigint; ctr: bigint; key: CryptoKey; salt: Uint8Array }): Promise<Uint8Array>
  decryptFrame(input: { frame: Uint8Array; codec: 'opus' | 'vp8'; keyFor: (kid: bigint) => Promise<{ key: CryptoKey; salt: Uint8Array } | null> }): Promise<{ frame: Uint8Array; kid: bigint; ctr: bigint } | { failure: 'unknown_key' | 'auth' | 'malformed' }>
}

// MARK: 4.9 store (src/store): IndexedDB records sealed under the wrap key

export interface StoreSchema {
  /** One row, key 'self'. */
  identity: {
    userId: UserId
    deviceId: DeviceId
    deviceCertificate: Uint8Array
    mlsSignatureKey: Ed25519KeyPair
    hpkeKey: { publicKey: Uint8Array; privateKey: Uint8Array }
    dsk: { cert: Uint8Array; privateKey: Uint8Array } | null
    master: { record: Uint8Array; privateKey: Uint8Array | null } | null
    recoveryKeyId: Uint8Array | null
    /** K_backup and its key id (not the recovery key), so this device can upload history blobs (§12.11.3). */
    backupKey: { key: Uint8Array; keyId: Uint8Array } | null
    dsExternalSender: Uint8Array | null
    ktPublicKey: Uint8Array | null
    /** The pinned `DsInfo.ktRequired` (§12.14). Sticky: once true, it stays true. Absent on rows from before the field. */
    ktRequired?: boolean | null
    /** A rotateRecoveryKey that has not finished: the new key, stored before the first upload. */
    pendingRecoveryKey?: string | null
    /** Set when an unsigned server revocation locked this device (state 'revoked', store kept). */
    lockedAtMs?: number | null
  }
  /** Key: groupId base64url. */
  groups: { groupId: Uint8Array; state: Uint8Array; channelId: ChannelId | null; kind: GroupKindName; lastSeq: number; status: GroupStatus }
  /** Key: groupId base64url + ':' + epoch. S_e kept for history. */
  epochSecrets: HistoryKeyEntry & { backedUp: boolean }
  /** Key: ref base64url. */
  keyPackages: { ref: Uint8Array; cipherSuite: CipherSuiteId; publicPackage: Uint8Array; privatePackage: Uint8Array; lastResort: boolean; createdAtMs: number }
  /**
   * Key: channelId + ':' + clientMsgId base64url (§12.8.5 step 10). Value: the server message id
   * and the highest sent_at_ms accepted for it (rollback check, 'stale_edit').
   */
  seen: { messageId: MessageId; sentAtMs: number }
  /** Key: userId. dskGeneration: the highest DSK generation seen (§12.4 rule 9). */
  contacts: {
    userId: UserId
    masterKey: Uint8Array
    generation: number
    dskGeneration: number
    trust: SenderTrust
    changedAtMs: number | null
    /** trust 'changed': the master key that the DS serves now. It replaces the pin only on acknowledgement. */
    candidate?: { masterKey: Uint8Array; generation: number } | null
  }
  /** Key: 'self'. */
  kt: { treeHead: Uint8Array | null; lastSelfCheckMs: number; lastSelfIndex: number }
  /** Key: groupId base64url. Envelopes for epochs this device has not reached. MessageService writes, GroupService drains. */
  buffered: { messages: EncryptedMessage[] }
  /** Key: 'self'. The device inbox cursor (GroupService owns fetch, ack and cursor, §12.7.6). */
  inbox: { lastSeq: number }
  /**
   * Key: groupId base64url. The state after an own commit, written before the POST (§12.7.9).
   * Adopted when the DS accepts, or when the own commit shows up in the stream after a crash.
   */
  pendingCommits: { epoch: number; state: Uint8Array; createdAtMs: number }
  /** Key: guildId. Phase 4: the replayed signed admin chain (§12.16). */
  adminState: AdminReplayState
  /** Key: groupId base64url. Membership timeline. */
  timeline: { events: MembershipEvent[] }
  /**
   * Key: groupId base64url + ':' + deviceId. When the device held which leaf (§12.8.5).
   * `removedAtEpoch`: the first epoch without the leaf, after this client processed the Remove of
   * the device. An Add of the device clears it.
   */
  membership: { intervals: { leafIndex: number; fromEpoch: number; toEpoch: number | null }[]; removedAtEpoch?: number | null }
  /**
   * Key: groupId base64url. Fork-alert counter (§12.8.7), and the rate limit of the automatic
   * resync: the time of the last one and the number in the current streak.
   */
  aeadFailures: { failures: { atMs: number; senderDevice: DeviceId }[]; lastResyncMs?: number; resyncStreak?: number }
  /**
   * Key: the invite key id (sign_public) base64url. An invite with history that this device checked
   * (§12.11.4). `record`: the encoded SignedInviteRecord. `bundled`: per group id (base64url), the
   * newest epoch that this device sent a bundle for. `seed`: the redeemer's invite seed, kept for
   * INVITE_AUTH_WINDOW_MS after `redeemedAtMs`, then wiped; INVITE_DELETE also wipes it. `code`: the
   * redeemer's invite code, for the later fetches of the bundles. `revoked`: an INVITE_DELETE came.
   */
  invites: {
    guildId: GuildId
    record: Uint8Array
    role: 'member' | 'redeemed'
    inviteId: string | null
    code: string | null
    revoked: boolean
    expiresAtMs: number
    bundled: Record<string, number>
    seed: Uint8Array | null
    redeemedAtMs: number | null
  }
}

export interface CryptoStore {
  /**
   * One database per (origin, userId). Records are AES-256-GCM under wrapKey with a random
   * 12-byte nonce, AAD = encode(struct { opaque table<V>; opaque key<V>; }) (§12.17).
   */
  open(input: { origin: string; userId: UserId; wrapKey: CryptoKey }): Promise<void>
  get<T extends keyof StoreSchema>(table: T, key: string): Promise<StoreSchema[T] | undefined>
  put<T extends keyof StoreSchema>(table: T, key: string, value: StoreSchema[T]): Promise<void>
  delete<T extends keyof StoreSchema>(table: T, key: string): Promise<void>
  list<T extends keyof StoreSchema>(table: T, prefix?: string): Promise<{ key: string; value: StoreSchema[T] }[]>
  /** Atomic across tables (one IndexedDB transaction). Group state and the seen set use it. */
  transaction<R>(tables: (keyof StoreSchema)[], fn: (tx: Pick<CryptoStore, 'get' | 'put' | 'delete' | 'list'>) => Promise<R>): Promise<R>
  /** Deletes the database (sign-out, revocation). */
  destroy(): Promise<void>
  close(): void
}

// MARK: 4.10 signed admin actions (§12.16)

export interface AdminAction {
  guildId: GuildId
  seq: number
  type: (typeof AdminActionType)[keyof typeof AdminActionType]
  actorUserId: UserId
  actorDeviceId: DeviceId
  timestampMs: number
  /** SHA-256 of the previous encoded AdminAction, 32 zero bytes for seq 0. */
  prevHash: Uint8Array
  payload: Uint8Array
  signature: Uint8Array
}

// MARK: - 5. Engine contracts: the Worker is composed of four services

/** Shared by every service inside the Worker. */
export interface EngineContext {
  store: CryptoStore
  /** The bridge proxies these calls to the main thread. */
  transport: DsTransport
  emit<K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]): void
  now(): number
  random(n: number): Uint8Array
  readonly origin: string
  readonly platform: DevicePlatform
  readonly clientVersion: string
}

/** The device's own keys, after init. */
export interface SelfIdentity {
  userId: UserId
  deviceId: DeviceId
  chain: DeviceChain
  mlsSignatureKey: Ed25519KeyPair
  hpkeKey: X25519KeyPair
  primary: boolean
}

/** src/identity/service.ts (crypto-identity). Implements the identity part of CryptoApi. */
export interface IdentityService
  extends Pick<
    CryptoApi,
    | 'setupFirstDevice'
    | 'restoreFromRecoveryKey'
    | 'resetIdentity'
    | 'rotateRecoveryKey'
    | 'linkAsNewDevice'
    | 'linkScan'
    | 'linkAccept'
    | 'listLinkSessions'
    | 'linkConfirmSas'
    | 'linkCancel'
    | 'listDevices'
    | 'revokeDevice'
    | 'renameDevice'
    | 'getTrust'
    | 'listContactDevices'
    | 'getSafetyNumber'
    | 'verifyQr'
    | 'setVerified'
    | 'acknowledgeKeyChange'
    | 'ktSelfCheck'
    | 'signOutDevice'
    | 'proveDevice'
  > {
  /** Loads the identity row. Null before setup. */
  load(init: InitOptions): Promise<SelfIdentity | null>
  self(): SelfIdentity
  status(): CryptoStatus
  /** Fetches and verifies a user's keys (TOFU pin, KT proof in Phase 4). Cached. */
  chainContextFor(userId: UserId, entering: boolean): Promise<ChainContext>
  /** The verified certificate of a device of `userId`, revoked ones included (history checks). */
  deviceCertificate(userId: UserId, deviceId: DeviceId): Promise<DeviceCertificate | null>
  /**
   * The verified certificate of `deviceId` whoever owns it (cert.userId), revoked ones included.
   * Looks at `hintUserId` first, then at every user whose keys this Worker already fetched, then
   * refetches `hintUserId` (at most once per KEY_REFRESH_MIN_MS). Null when no known user owns it.
   * MessageService uses it so a foreign device gives 'device_mismatch' or 'edit_not_author'.
   */
  deviceOwnerCertificate(deviceId: DeviceId, hintUserId: UserId): Promise<DeviceCertificate | null>
  trustOf(userId: UserId): Promise<SenderTrust>
  /** USER_KEYS_UPDATE, KT_TREE_HEAD, KEY_PACKAGES_LOW, DEVICE_LINK. (DEVICE_INBOX goes to GroupService.) */
  onGatewayEvent(event: CryptoGatewayEvent): Promise<void>
  /**
   * A dsk_transfer inbox item, handed over by GroupService (which owns the inbox). Accepts it only
   * when the DSK generation is above the stored one and the cert verifies under the pinned own
   * master key (§12.4). Then re-uploads key packages with the new chain and fires onDskRotated.
   */
  handleInboxItem(item: WireInboxItem): Promise<void>
  /**
   * Fires after this device has a new DSK and chain (a dsk_transfer, or its own rotation after
   * revokeDevice). GroupService subscribes and calls resyncAll('dsk_rotated') (§12.4 step 4).
   */
  onDskRotated(cb: () => void): void
  /** Phase 4: fetches, verifies and replays the signed admin chain of a guild. Null without a genesis action. */
  adminState(guildId: GuildId): Promise<AdminReplayState | null>
  /** Keeps KEY_PACKAGE_TARGET key packages per suite on the DS. */
  replenishKeyPackages(): Promise<void>
  /** Uploads unbacked epoch secrets (§12.11.3). */
  backupNow(): Promise<{ uploaded: number }>
  /** KT gossip for outgoing envelopes, or null (§12.14). */
  treeHeadForGossip(groupId: GroupIdB64): Promise<Uint8Array | null>
  /** KT gossip from an incoming envelope. */
  observeTreeHead(treeHead: Uint8Array, fromUserId: UserId): Promise<void>
}

export interface SendState {
  groupId: Uint8Array
  epoch: number
  ownLeaf: number
  epochSecret: Uint8Array
}

/** src/mls/service.ts (crypto-mls). Group sync, batch commits, joins, history bundles, the device inbox. */
export interface GroupService extends Pick<CryptoApi, 'sync' | 'ensureChannelGroup' | 'membershipTimeline' | 'getEpochCode'> {
  /** MLS_*, and DEVICE_INBOX of every kind (dsk_transfer goes on to IdentityService.handleInboxItem). */
  onGatewayEvent(event: CryptoGatewayEvent): Promise<void>
  /**
   * Resync of every own leaf by external commit with a fresh key package (DSK rotation, §12.4 step 4;
   * fork alert; lost state).
   */
  resyncAll(reason: 'dsk_rotated' | 'fork' | 'state_lost'): Promise<void>
  /** Catches up, commits pending Removes (§12.7.5), then returns the state to encrypt with. */
  sendState(channelId: ChannelId): Promise<SendState>
  /** S_e of an epoch from the live state, the store, a bundle or a backup. Null when unknown. */
  epochSecret(groupId: Uint8Array, epoch: number): Promise<Uint8Array | null>
  /** The leaf that a device held at an epoch, from observed commits. Null when not observed. */
  leafAt(groupId: Uint8Array, deviceId: DeviceId, epoch: number): Promise<number | null>
  /**
   * The first epoch without the device's leaf, when this client processed the Remove of the device
   * in this group and saw no later Add of it. Null otherwise (§12.8.5 step 4).
   */
  removedAt(groupId: Uint8Array, deviceId: DeviceId): Promise<number | null>
  /** Counts an AEAD failure for the fork alert (§12.8.7). */
  reportAeadFailure(groupId: Uint8Array, epoch: number, senderDevice: DeviceId): Promise<void>
  /** The current epoch per the local state, or null when not a member. */
  currentEpoch(groupId: Uint8Array): Promise<number | null>
  /** Epoch secrets for an own new device (link) or a history_keys request. */
  exportHistoryKeys(groupIds: Uint8Array[] | 'all', maxEpochsPerGroup: number): Promise<HistoryKeyEntry[]>
  /** Never replaces a stored secret (§12.11.1). */
  importHistoryKeys(entries: HistoryKeyEntry[], source: 'own_device' | 'backup' | 'bundle'): Promise<void>
  /** The MLS-authenticated descriptor of a group (§12.6), from the local state. Null without state. */
  descriptor(groupId: Uint8Array): Promise<GroupDescriptor | null>
  /**
   * Calls `cb` after each own commit that the DS accepted: a batch or pre-send commit, an own
   * external commit (join or resync), and a commit adopted after a crash. `epoch` is the new epoch,
   * and its secret is stored. The call is asynchronous, outside the group lock. Returns the unsubscribe.
   */
  onOwnCommit(cb: (e: { groupId: Uint8Array; epoch: number }) => void): () => void
  /**
   * Calls `cb` after this device joins a group: a Welcome, or an own external commit that adds its
   * leaf (not a resync). `epoch` is the join epoch. Asynchronous and outside the group lock, as
   * onOwnCommit. Returns the unsubscribe.
   */
  onJoin(cb: (e: { groupId: Uint8Array; epoch: number }) => void): () => void
  /** Appends events to the membership timeline of a group (emits `membership`). Takes the group lock. */
  appendTimeline(groupId: GroupIdB64, events: MembershipEvent[]): Promise<void>
}

/** src/envelope/service.ts (crypto-envelope). Messages, attachments, franking reports. */
export type MessageService = Pick<CryptoApi, 'encryptMessage' | 'decryptMessages' | 'buildReport' | 'encryptAttachment' | 'decryptAttachment'>

/** src/envelope/doc-service.ts. Page envelopes (§12.20). */
export type DocService = Pick<CryptoApi, 'encryptDoc' | 'decryptDoc'>
export type CreateDocService = (ctx: EngineContext, identity: IdentityService, groups: GroupService) => DocService

/** src/admin/service.ts (crypto-identity, Phase 4). */
export type AdminService = Pick<CryptoApi, 'signAdminAction'>
export type CreateAdminService = (ctx: EngineContext, identity: IdentityService) => AdminService

/** src/invites/service.ts. Invites with history (§12.11.4). */
export interface InviteService extends Pick<CryptoApi, 'prepareHistoryInvite' | 'sendInviteBundles' | 'redeemInvite'> {
  /** INVITE_DELETE: marks the invite revoked and drops the cached records of the guild. */
  onGatewayEvent(event: CryptoGatewayEvent): Promise<void>
}
/** `perms`: the §2 rules, for the record and scope checks of §12.16. */
export type CreateInviteService = (ctx: EngineContext, identity: IdentityService, groups: GroupService, perms: AdminPermissionModel) => InviteService

/** src/media/service.ts (crypto-media). Voice groups and frame keys. */
export type VoiceService = Pick<CryptoApi, 'voiceStart' | 'voiceHandle' | 'voiceAttachTransform' | 'voiceDetachTransform' | 'voiceRoster' | 'voiceEpochCode' | 'voiceStop'>

/**
 * The deps break the identity → mls import cycle: worker/engine.ts passes `mls`, and the admin
 * permission model over @hachiman/client/permissions (worker/permissions.ts, given to the engine by
 * worker/serve.ts). Tests pass fakes.
 */
export type CreateIdentityService = (
  ctx: EngineContext,
  deps: { mls: Pick<MlsModule, 'generateKeyPackages'>; adminPermissions: AdminPermissionModel },
) => IdentityService
export interface GroupServiceDeps {
  /**
   * The §2 rules over `@hachiman/client/permissions` (worker/permissions.ts, passed by
   * worker/serve.ts through worker/engine.ts). Without it, adminReaders is null and no GCE is accepted.
   */
  adminPermissions?: AdminPermissionModel
  /** Tests pass a wrapped module. */
  mls?: MlsModule
  /** The wait between automatic resync attempts after a rejected commit. Default: setTimeout. Tests pass their own. */
  sleep?: (ms: number) => Promise<void>
}
export type CreateGroupService = (ctx: EngineContext, identity: IdentityService, deps?: GroupServiceDeps) => GroupService
export type CreateMessageService = (ctx: EngineContext, identity: IdentityService, groups: GroupService) => MessageService
export type CreateVoiceService = (ctx: EngineContext, identity: IdentityService) => VoiceService
