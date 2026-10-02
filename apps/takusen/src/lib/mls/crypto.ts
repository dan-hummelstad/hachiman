/**
 * The one import point of @hachiman/crypto in Takusen. Every DS file imports
 * crypto types, constants and the DsModule from here, so the package seam
 * stays in one file (docs/gateway-protocol.md §12.18).
 *
 * The DsModule loads lazily: route modules and tests that never touch MLS do
 * not load ts-mls. Tests inject a fake with `setDsModule`.
 */
import type { DsModule, DsSigner } from '@hachiman/crypto'

export type {
  B64url,
  CommitCheck,
  CommitInspection,
  DeviceCertificate,
  DeviceChain,
  DeviceRevocation,
  DeviceSigningKeyCert,
  DsModule,
  DsSigner,
  EnvelopeHeader,
  GroupDescriptor,
  GroupInfoInspection,
  KeyPackageInspection,
  KtEntry,
  LeafEntry,
  MasterKeyRecord,
  SignedTreeHead,
  WireBatchAssign,
  WireDevice,
  WireDsInfo,
  WireHandshake,
  WireInboxItem,
  WireJoinRequest,
  WireKtEntry,
  WireKtTreeHead,
  WireMlsGroup,
  WireUserKeys,
} from '@hachiman/crypto'
export type { CipherSuiteId, GroupKindName, HistoryVisibilityName } from '@hachiman/crypto/constants'
export {
  ADD_ONLY_EPOCH_GRACE_MS,
  BATCH_INTERVAL_MS,
  BATCH_MAX_ADDS,
  BATCH_TIMEOUT_MS,
  CipherSuite,
  DEFAULT_CIPHER_SUITE,
  DSK_ROTATION_GRACE_MS,
  DeviceRevocationReason,
  ExtensionType,
  GROUP_STATE_EPOCHS_KEPT,
  GroupKind,
  HANDSHAKE_INLINE_MAX_BYTES,
  HANDSHAKE_RETENTION_MS,
  HISTORY_BUNDLE_MAX_BYTES,
  HistoryVisibility,
  KEY_PACKAGE_LIFETIME_MS,
  KEY_PACKAGE_LOW_WATER,
  KEY_PACKAGE_TARGET,
  KtEntryType,
  LINK_SESSION_TTL_MS,
  MAX_ENVELOPE_BYTES,
  PUBLIC_SET_MAX_MEMBERS,
  WIRE_VERSION,
} from '@hachiman/crypto/constants'
export { DEVICE_PROOF_MAX_SKEW_MS, DEVICE_PROOF_NONCE_RE, deviceProofMessage } from '@hachiman/crypto/device-proof'

let override: DsModule | null = null
let loading: Promise<DsModule> | null = null

/** The DsModule of `@hachiman/crypto/ds`. */
export async function getDsModule(): Promise<DsModule> {
  if (override) return override
  loading ??= import('@hachiman/crypto/ds').then((m) => m.ds)
  return loading
}

/** Tests only: replace the DsModule (null restores the real one). */
export function setDsModule(ds: DsModule | null): void {
  override = ds
  signerCache = null
}

let signerCache: Promise<DsSigner> | null = null

/** The DS signer from the seed file (§12.7.1). One per process. */
export async function getDsSigner(loadSeed: () => Uint8Array): Promise<DsSigner> {
  signerCache ??= getDsModule().then((ds) => ds.loadSigner(loadSeed()))
  return signerCache
}
