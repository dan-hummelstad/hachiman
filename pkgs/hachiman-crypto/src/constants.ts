/**
 * Shared constants of @hachiman/crypto. docs/gateway-protocol.md §12 is normative.
 * When you change a value here, change the contract in the same commit.
 */

// MARK: - Protocol versions

/** Gateway IDENTIFY capability for this protocol (§6, §12.1). */
export const E2EE_CAPABILITY = 'e2ee/1'
/** Version byte of every Hachiman binary object (§12.2). */
export const WIRE_VERSION = 1

// MARK: - MLS

/** RFC 9420 cipher suite ids that Hachiman accepts (§12.3). */
export const CipherSuite = {
  /** MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519. The default for every group. */
  X25519_AES128GCM_SHA256_ED25519: 1,
  /** MLS_256_XWING_AES256GCM_SHA512_Ed25519. Phase 4, per-group opt-in (§12.15). */
  XWING_AES256GCM_SHA512_ED25519: 83,
} as const
export type CipherSuiteId = (typeof CipherSuite)[keyof typeof CipherSuite]
export const DEFAULT_CIPHER_SUITE: CipherSuiteId = CipherSuite.X25519_AES128GCM_SHA256_ED25519

/** ts-mls names of the cipher suites above. */
export const CIPHER_SUITE_NAME = {
  1: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  83: 'MLS_256_XWING_AES256GCM_SHA512_Ed25519',
} as const satisfies Record<CipherSuiteId, string>

/** Private-use MLS extension types (RFC 9420 §17.3, range 0xF000-0xFFFF). */
export const ExtensionType = {
  /** LeafNode extension. Data: DeviceChain (§12.4). */
  DEVICE_CHAIN: 0xf1a0,
  /** GroupContext extension. Data: GroupDescriptor (§12.6). */
  GROUP_DESCRIPTOR: 0xf1a1,
} as const

/** MLS exporter labels (§12.3). */
export const ExporterLabel = {
  /** S_e = MLS-Exporter(MESSAGE, group_id, 32). */
  MESSAGE: 'hachiman message v1',
  /** RFC 9605 §5.2. Context is empty, length is 32 (SHA-256 Nh). */
  SFRAME: 'SFrame 1.0 Base Key',
  /** K_hist = MLS-Exporter(HISTORY, group_id || uint64(epoch), 32). */
  HISTORY: 'hachiman history v1',
} as const
export const EXPORTER_LENGTH = 32

/** MLS group kinds. The byte value is part of the group id (§12.6). */
export const GroupKind = {
  PUBLIC_SET: 1,
  CHANNEL: 2,
  DM: 3,
  VOICE: 4,
} as const
export type GroupKindId = (typeof GroupKind)[keyof typeof GroupKind]
export type GroupKindName = 'public_set' | 'channel' | 'dm' | 'voice'
/** Byte length of a group id: version(1) || kind(1) || scope(16) || generation(4). */
export const GROUP_ID_LENGTH = 22

export const HistoryVisibility = { JOINED: 1, SHARED: 2 } as const
export type HistoryVisibilityName = 'joined' | 'shared'

// MARK: - Signature labels (Hachiman SignWithLabel, §12.2)

/** Prefix of every Hachiman signature label. */
export const SIGN_LABEL_PREFIX = 'Hachiman 1.0 '
export const SignLabel = {
  MASTER_KEY: 'MasterKey',
  DEVICE_SIGNING_KEY: 'DeviceSigningKey',
  DEVICE_CERTIFICATE: 'DeviceCertificate',
  DEVICE_REVOCATION: 'DeviceRevocation',
  ENVELOPE: 'Envelope',
  HISTORY_BUNDLE: 'HistoryBundle',
  ADMIN_ACTION: 'AdminAction',
  TREE_HEAD: 'TreeHead',
  DEVICE_MESSAGE: 'DeviceMessage',
  DOC_ENVELOPE: 'DocEnvelope',
  /** InviteRecord, by the creator device MLS key (§12.11.4). */
  INVITE_RECORD: 'InviteRecord',
  /** InviteBundleTBS, by the sender device MLS key (§12.11.4). */
  INVITE_BUNDLE: 'InviteBundle',
  /** InviteAuth, by the invite sign key (§12.11.4). */
  INVITE_AUTH: 'InviteAuth',
} as const

// MARK: - HKDF info strings (§12.3, §12.5, §12.8, §12.11)

export const HkdfInfo = {
  MESSAGE_KEY: 'hachiman msg key v1',
  /** K_doc of a page envelope (§12.20). A different label from MESSAGE_KEY, so K_doc never equals K_msg. */
  DOC_KEY: 'hachiman doc key v1',
  FRANKING: 'hachiman franking v1',
  BACKUP_KEY: 'hachiman backup key v1',
  BACKUP_KEY_ID: 'hachiman backup id v1',
  LINK_SAS: 'hachiman link sas v1',
  LINK_KEY: 'hachiman link key v1',
  SEALED_DEVICE_MESSAGE: 'hachiman sealed v1',
  /** The invite HPKE (X25519) private key from the invite seed (§12.11.4). */
  INVITE_HPKE: 'hachiman invite hpke v1',
  /** The invite sign (Ed25519) private key from the invite seed (§12.11.4). */
  INVITE_SIGN: 'hachiman invite sign v1',
} as const

/** Epoch grace for message sends after a commit that removed no leaf (§12.8.4). */
export const ADD_ONLY_EPOCH_GRACE_MS = 10_000
/** Max adds per batch (§12.7.5). */
export const BATCH_MAX_ADDS = 100

// MARK: - Envelope (§12.8)

/** First two bytes of an Envelope: 'H' and the wire version. */
export const ENVELOPE_MAGIC = 0x4801
/** The EnvelopeContent kind byte. A client that does not know a kind gives 'malformed' (§12.8.1). */
export const EnvelopeKind = { MESSAGE: 1, EDIT: 2, REACTION: 3, PAGE_ACTIVITY: 4 } as const
/** A reaction emoji: 1 to this many UTF-16 code units, no control characters (§12.8.1). */
export const MAX_REACTION_EMOJI_LENGTH = 32
/** UTF-8 bytes of the longest emoji: each UTF-16 unit encodes to at most 3 bytes. */
export const MAX_REACTION_EMOJI_BYTES = 96
/** page_activity `changes`: 1 to this (§12.8.1). */
export const MAX_PAGE_ACTIVITY_CHANGES = 10_000
export const ENVELOPE_AEAD = 'AES-256-GCM'
export const CLIENT_MSG_ID_LENGTH = 16
export const MESSAGE_SALT_LENGTH = 32
export const FRANKING_KEY_LENGTH = 32
export const FRANKING_TAG_LENGTH = 32
/**
 * Takusen default for TAKUSEN_MAX_ENVELOPE_BYTES. The largest valid content (8000 text bytes,
 * 100 mentions, 10 full pointers with thumbnails, KT gossip) encodes to about 18.3 KB.
 */
export const MAX_ENVELOPE_BYTES = 32_768
/** Pointers per message (Limits.maxAttachmentsPerMessage). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10
/** Upload ids per message: each pointer gives its file id and an optional thumbnail id (§12.8.5 step 8). */
export const MAX_MESSAGE_UPLOAD_IDS = 20
/** UTF-8 bytes of EnvelopeContent.text. */
export const MAX_TEXT_BYTES = 8_000
export const MentionType = { USER: 1, ROLE: 2, EVERYONE: 3 } as const

// MARK: - Page envelopes (§12.20)

/** First two bytes of a DocEnvelope. A message envelope (ENVELOPE_MAGIC) never decodes as one. */
export const DOC_ENVELOPE_MAGIC = 0x4802
export const DocEnvelopeKind = { UPDATE: 1, SNAPSHOT: 2, AWARENESS: 3, TITLE: 4 } as const
export const PAGE_ID_LENGTH = 16
export const DOC_SALT_LENGTH = 32
/** UTF-8 bytes of a page title (doc_title body), 1 to this. */
export const MAX_PAGE_TITLE_BYTES = 200
/** A doc_awareness envelope as base64url on op 5 (§6). The gateway drops a larger frame. */
export const MAX_DOC_AWARENESS_B64_BYTES = 8_192

/**
 * Fork alert: this many AEAD failures in the window (§12.8.7). The count is per group and does not
 * use the sender: the envelope header is not authenticated before decryption.
 */
export const FORK_ALERT_FAILURES = 3
export const FORK_ALERT_WINDOW_MS = 10 * 60_000
/**
 * The automatic aead_failures resync of one group: at most one per FORK_RESYNC_MIN_INTERVAL_MS.
 * Each further resync doubles the wait, up to FORK_RESYNC_MAX_INTERVAL_MS. The streak resets when
 * no resync ran for FORK_RESYNC_MAX_INTERVAL_MS.
 */
export const FORK_RESYNC_MIN_INTERVAL_MS = 10 * 60_000
export const FORK_RESYNC_MAX_INTERVAL_MS = 24 * 60 * 60_000
/**
 * After this device rejects a commit that the DS accepted, it resyncs by external commit after
 * each of these waits (5 attempts, about 31 s in total). Then the group stays stopped until the
 * next sync() (READY / RESUMED) starts the attempts again.
 */
export const COMMIT_REJECTED_RESYNC_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000]

// MARK: - Attachments (§12.9)

export const ATTACHMENT_MAGIC = 'HAT1'
export const ATTACHMENT_SEGMENT_SIZE = 65_536
export const ATTACHMENT_TAG_LENGTH = 16
export const ATTACHMENT_NONCE_PREFIX_LENGTH = 7
export const ATTACHMENT_HEADER_LENGTH = 13
export const THUMBNAIL_MAX_EDGE = 320

// MARK: - SFrame (§12.10)

/** RFC 9605 cipher suite AES_128_GCM_SHA256_128. */
export const SFRAME_CIPHER_SUITE = 0x0004
/** Low bits of the MLS epoch in the KID. */
export const SFRAME_EPOCH_BITS = 4
/** Media index = leaf_index * 2 + track. */
export const SFrameTrack = { AUDIO: 0, VIDEO: 1 } as const
export const SFRAME_OLD_EPOCH_RETENTION_MS = 10_000
export const SFRAME_REPLAY_WINDOW = 1024
/** Clear codec prefix bytes. */
export const VP8_KEYFRAME_PREFIX = 10
export const VP8_DELTA_PREFIX = 1
export const OPUS_PREFIX = 0

// MARK: - Identity, verification, recovery (§12.4, §12.5, §12.11)

export const SAFETY_NUMBER_ITERATIONS = 5200
export const SAFETY_NUMBER_VERSION = 0
/** 6 groups of 5 digits per user. */
export const SAFETY_NUMBER_GROUPS_PER_USER = 6
/** 6 groups of 5 digits. */
export const EPOCH_CODE_GROUPS = 6
export const RECOVERY_KEY_PREFIX = 'HRK1'
export const RECOVERY_KEY_BYTES = 32
export const LINK_QR_PREFIX = 'hachiman-link:1:'
export const VERIFY_QR_PREFIX = 'hachiman-verify:1:'
export const SAS_EMOJI_COUNT = 7
export const LINK_SESSION_TTL_MS = 10 * 60_000
/** Leaves with a chain from a superseded device-signing key stay valid this long. */
export const DSK_ROTATION_GRACE_MS = 30 * 24 * 60 * 60_000
export const DeviceRevocationReason = { USER: 1, LOST: 2, PASSWORD_RESET: 3, COMPROMISED: 4, SIGNED_OUT: 5 } as const
export const BackupKind = { IDENTITY: 1, HISTORY: 2 } as const

// MARK: - Groups and the delivery service (§12.7)

export const KEY_PACKAGE_TARGET = 100
export const KEY_PACKAGE_LOW_WATER = 10
export const KEY_PACKAGE_LIFETIME_MS = 90 * 24 * 60 * 60_000
export const BATCH_INTERVAL_MS = 2_000
export const BATCH_TIMEOUT_MS = 5_000
export const HANDSHAKE_RETENTION_MS = 30 * 24 * 60 * 60_000
/** Inline MLS message bytes in MLS_HANDSHAKE above this size are omitted. */
export const HANDSHAKE_INLINE_MAX_BYTES = 32_768
export const GROUP_STATE_EPOCHS_KEPT = 8
export const HISTORY_BUNDLE_MAX_EPOCHS = 4096
/** The largest link message body that the DS takes (Takusen LINK_MESSAGE_MAX_BYTES, §12.5). */
export const LINK_MESSAGE_MAX_BYTES = 262_144
export const HISTORY_BUNDLE_MAX_BYTES = 524_288
/**
 * Default for TAKUSEN_PUBLIC_SET_MAX_MEMBERS: leaves of one public_set group (§12.7.8).
 * Above it, a join gets 403 GroupFull. Set by the Phase 3 load test (src/mls/load.bench.ts,
 * docs/e2ee-load-test.md). After the lazy state encoding, the chain signature memo and
 * retainKeysForEpochs 1 (src/mls/index.ts), a full batch of BATCH_MAX_ADDS DS Adds takes the
 * committer 0.35 s at 250 leaves, 0.43 s at 500 and 0.58 s at 1000 (deadline 5 s). The limit now
 * is a join by Welcome: 0.6 s at 250, 2.2 s at 500, 8.3 s at 1000 (budget 10 s, desktop CPU, it
 * grows about with the square of the leaves).
 */
export const PUBLIC_SET_MAX_MEMBERS = 500

// MARK: - Invites with history (§12.11.4)

export const INVITE_BUNDLE_HPKE_INFO = 'hachiman invite bundle v1'
/** Version byte of InviteRecord, InviteBundleTBS, InviteBundle and InviteAuth. */
export const INVITE_WIRE_VERSION = 1
/** The invite seed: the secret of the link fragment. */
export const INVITE_SEED_BYTES = 32
/** Channel ids in InviteRecord.channel_ids. */
export const INVITE_MAX_SCOPE_CHANNELS = 500
/** Stored bundle bytes per invite. Takusen drops the oldest bundles above it. */
export const INVITE_BUNDLES_MAX_BYTES = 4 * 1024 * 1024
/** One InviteBundle blob. */
export const INVITE_BUNDLE_MAX_BYTES = 640 * 1024
/** The redeemer gets the bundles only this long after its guild join with the invite. */
export const INVITE_BUNDLE_FETCH_WINDOW_MS = 3_600_000
/** An invite_auth join is accepted this long after the guild join with the invite. */
export const INVITE_AUTH_WINDOW_MS = 86_400_000

// MARK: - Key transparency (§12.14)

export const KtEntryType = { MASTER_KEY: 1, DEVICE_SIGNING_KEY: 2, DEVICE_CERTIFICATE: 3, DEVICE_REVOCATION: 4 } as const
export const KT_SELF_CHECK_INTERVAL_MS = 24 * 60 * 60_000
export const KT_GOSSIP_MIN_INTERVAL_MS = 60 * 60_000

// MARK: - Signed admin actions (§12.16)

export const AdminActionType = {
  GENESIS: 0,
  ROLE_CREATE: 1,
  ROLE_UPDATE: 2,
  ROLE_DELETE: 3,
  ROLE_REORDER: 4,
  OVERWRITE_PUT: 5,
  OVERWRITE_DELETE: 6,
  MEMBER_ROLES: 7,
  CHANNEL_HISTORY_VISIBILITY: 8,
} as const
