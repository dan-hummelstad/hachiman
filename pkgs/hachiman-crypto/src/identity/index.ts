/**
 * The identity module (docs/gateway-protocol.md §12.4, §12.5, §12.11.3): key objects, their
 * signatures, the chain check, recovery keys, backups, device messages and device linking.
 * Everything except the HPKE device messages is synchronous.
 */
import { ed25519 } from '@noble/curves/ed25519.js'

import {
  CryptoError,
  type ChainContext,
  type ChainVerdict,
  type DeviceCertificate,
  type DeviceChain,
  type DeviceId,
  type DeviceRevocation,
  type DeviceSigningKeyCert,
  type Ed25519KeyPair,
  type IdentityModule,
  type MasterKeyRecord,
  type UserId,
} from '../api'
import { decode, encode } from '../codec'
import { DSK_ROTATION_GRACE_MS, DeviceRevocationReason, SignLabel } from '../constants'
import { generateEd25519, signWithLabel, verifyWithLabel } from '../sign'
import { equalBytes } from './bytes'
import {
  decodeHistoryBatch,
  decodeIdentityBackup,
  encodeDeviceCertTbs,
  encodeDskTbs,
  encodeHistoryBatch,
  encodeIdentityBackup,
  encodeMasterKeyTbs,
  encodeRevocationTbs,
  readDeviceCert,
  readDeviceChain,
  readDskCert,
  readMasterKeyRecord,
  readRevocation,
  writeDeviceCert,
  writeDeviceChain,
  writeDskCert,
  writeMasterKeyRecord,
  writeRevocation,
} from './codec'
import { openDeviceMessage, sealDeviceMessage } from './device-message'
import { link, type LinkProtocolExt } from './link'
import { deriveBackupKeys, generateRecoveryKey, openBackup, parseRecoveryKey, sealBackup } from './recovery'
import { epochCode, parseVerifyQr, safetyNumber } from './safety'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CREDENTIAL_RE = new RegExp(`^(${UUID}):(${UUID})$`)

/** The public key of an Ed25519 secret, for checks that a transferred private key matches its cert. */
export function ed25519PublicKey(privateKey: Uint8Array): Uint8Array | null {
  try {
    return ed25519.getPublicKey(privateKey)
  } catch {
    return null
  }
}

export function keyPairMatches(privateKey: Uint8Array, publicKey: Uint8Array): boolean {
  const pub = ed25519PublicKey(privateKey)
  return pub !== null && equalBytes(pub, publicKey)
}

export function verifyMasterSelfSignature(r: MasterKeyRecord): boolean {
  return verifyWithLabel(r.publicKey, SignLabel.MASTER_KEY, encodeMasterKeyTbs(r), r.signature)
}

/** The DSK cert is signed by `master` and names its generation and user. */
export function verifyDskCert(c: DeviceSigningKeyCert, master: Pick<MasterKeyRecord, 'publicKey' | 'generation' | 'userId'>): boolean {
  return c.userId === master.userId && c.masterGeneration === master.generation && verifyWithLabel(master.publicKey, SignLabel.DEVICE_SIGNING_KEY, encodeDskTbs(c), c.signature)
}

/** The device certificate is signed by `dsk` and names its generation and user. */
export function verifyDeviceCert(c: DeviceCertificate, dsk: Pick<DeviceSigningKeyCert, 'publicKey' | 'generation' | 'userId'>): boolean {
  return c.userId === dsk.userId && c.dskGeneration === dsk.generation && verifyWithLabel(dsk.publicKey, SignLabel.DEVICE_CERTIFICATE, encodeDeviceCertTbs(c), c.signature)
}

/**
 * The three signature results of one chain. They do not depend on the ChainContext, so a caller
 * that sees the same chain bytes again (a key package checked at precheck, policy and commit
 * time) passes the same memo and skips the Ed25519 verifies.
 */
export interface ChainSignatureMemo {
  master?: boolean
  dsk?: boolean
  device?: boolean
}

function verifyChain(chain: DeviceChain, ctx: ChainContext): ChainVerdict {
  return verifyChainMemo(chain, ctx, {})
}

export function verifyChainMemo(chain: DeviceChain, ctx: ChainContext, memo: ChainSignatureMemo): ChainVerdict {
  const { master, dsk, device } = chain
  // 1. Identity and user/device consistency.
  if (ctx.leaf !== null) {
    const id = parseCredentialIdentity(ctx.leaf.credentialIdentity)
    if (id === null) return { ok: false, reason: 'malformed' }
    if (id.userId !== master.userId) return { ok: false, reason: 'user_mismatch' }
    if (id.deviceId !== device.deviceId) return { ok: false, reason: 'device_mismatch' }
  }
  if (dsk.userId !== master.userId || device.userId !== master.userId) return { ok: false, reason: 'user_mismatch' }
  // 2. Master self-signature.
  if (!(memo.master ??= verifyMasterSelfSignature(master))) return { ok: false, reason: 'bad_signature' }
  // 3. TOFU pin.
  if (ctx.pinnedMaster !== null && (!equalBytes(ctx.pinnedMaster.publicKey, master.publicKey) || ctx.pinnedMaster.generation !== master.generation)) {
    return { ok: false, reason: 'master_changed' }
  }
  // 4. DSK under the master.
  if (dsk.masterGeneration !== master.generation) return { ok: false, reason: 'key_mismatch' }
  if (!(memo.dsk ??= verifyWithLabel(master.publicKey, SignLabel.DEVICE_SIGNING_KEY, encodeDskTbs(dsk), dsk.signature))) return { ok: false, reason: 'bad_signature' }
  // 5. Device certificate under the DSK.
  if (device.dskGeneration !== dsk.generation) return { ok: false, reason: 'key_mismatch' }
  if (!(memo.device ??= verifyWithLabel(dsk.publicKey, SignLabel.DEVICE_CERTIFICATE, encodeDeviceCertTbs(device), device.signature))) return { ok: false, reason: 'bad_signature' }
  // 6. The leaf signs with the certified key.
  if (ctx.leaf !== null && !equalBytes(ctx.leaf.signatureKey, device.mlsSignatureKey)) return { ok: false, reason: 'key_mismatch' }
  // 7. Not revoked.
  if (ctx.revokedDeviceIds.has(device.deviceId)) return { ok: false, reason: 'revoked' }
  // 9 before 8: a downgraded current generation makes the rule 8 comparison meaningless.
  const current = ctx.currentDsk
  if (current === null) return { ok: false, reason: 'dsk_superseded' }
  if (ctx.highestSeenDskGeneration !== null && current.generation < ctx.highestSeenDskGeneration) return { ok: false, reason: 'dsk_downgrade' }
  // A signed chain newer than the DS's current generation means the DS reports a lower one.
  if (dsk.generation > current.generation) return { ok: false, reason: 'dsk_downgrade' }
  // 8. Entering leaves need the current DSK. Members keep the previous one during the grace period.
  if (dsk.generation !== current.generation) {
    const inGrace = dsk.generation === current.generation - 1 && ctx.nowMs < current.issuedAtMs + DSK_ROTATION_GRACE_MS
    if (ctx.entering || !inGrace) return { ok: false, reason: 'dsk_superseded' }
  }
  return { ok: true, firstSight: ctx.pinnedMaster === null }
}

export function credentialIdentity(userId: UserId, deviceId: DeviceId): string {
  const s = `${userId}:${deviceId}`
  if (!CREDENTIAL_RE.test(s)) throw new CryptoError('Malformed', 'credential ids must be canonical lowercase UUIDs')
  return s
}

export function parseCredentialIdentity(identity: string): { userId: UserId; deviceId: DeviceId } | null {
  const m = CREDENTIAL_RE.exec(identity)
  return m ? { userId: m[1]!, deviceId: m[2]! } : null
}

function revoke(master: { record: MasterKeyRecord; keyPair: Ed25519KeyPair }, deviceId: DeviceId, reason: DeviceRevocation['reason'], nowMs: number): DeviceRevocation {
  if (reason !== DeviceRevocationReason.USER && reason !== DeviceRevocationReason.LOST && reason !== DeviceRevocationReason.COMPROMISED) {
    throw new CryptoError('Unsupported', `the master key does not sign revocation reason ${reason}`)
  }
  const tbs = { userId: master.record.userId, deviceId, revokedAtMs: nowMs, reason, masterGeneration: master.record.generation }
  return { ...tbs, signature: signWithLabel(master.keyPair.privateKey, SignLabel.DEVICE_REVOCATION, encodeRevocationTbs(tbs)) }
}

function verifyRevocation(r: DeviceRevocation, keys: { master: MasterKeyRecord; device: DeviceCertificate | null }): boolean {
  if (r.userId !== keys.master.userId) return false
  const tbs = encodeRevocationTbs(r)
  switch (r.reason) {
    case DeviceRevocationReason.USER:
    case DeviceRevocationReason.LOST:
    case DeviceRevocationReason.COMPROMISED:
      return r.masterGeneration === keys.master.generation && verifyWithLabel(keys.master.publicKey, SignLabel.DEVICE_REVOCATION, tbs, r.signature)
    case DeviceRevocationReason.SIGNED_OUT: {
      const d = keys.device
      return d !== null && d.userId === r.userId && d.deviceId === r.deviceId && verifyWithLabel(d.mlsSignatureKey, SignLabel.DEVICE_REVOCATION, tbs, r.signature)
    }
    default:
      return false
  }
}

export interface IdentityModuleExt extends IdentityModule {
  link: LinkProtocolExt
}

export const identity: IdentityModuleExt = {
  encodeMasterKeyRecord: (r) => encode((w) => {
    writeMasterKeyRecord(w, r)
  }),
  decodeMasterKeyRecord: (b) => decode(b, readMasterKeyRecord),
  encodeDskCert: (c) => encode((w) => {
    writeDskCert(w, c)
  }),
  decodeDskCert: (b) => decode(b, readDskCert),
  encodeDeviceCertificate: (c) => encode((w) => {
    writeDeviceCert(w, c)
  }),
  decodeDeviceCertificate: (b) => decode(b, readDeviceCert),
  encodeDeviceChain: (c) => encode((w) => {
    writeDeviceChain(w, c)
  }),
  decodeDeviceChain: (b) => decode(b, readDeviceChain),
  encodeRevocation: (r) => encode((w) => {
    writeRevocation(w, r)
  }),
  decodeRevocation: (b) => decode(b, readRevocation),

  signWithLabel,
  verifyWithLabel,

  createMasterKey(userId, generation, prev) {
    const keyPair = generateEd25519()
    const tbs = { userId, publicKey: keyPair.publicKey, generation, createdAtMs: Date.now() }
    const content = encodeMasterKeyTbs(tbs)
    const record: MasterKeyRecord = {
      ...tbs,
      prevSignature: prev === null ? null : signWithLabel(prev.privateKey, SignLabel.MASTER_KEY, content),
      signature: signWithLabel(keyPair.privateKey, SignLabel.MASTER_KEY, content),
    }
    return { record, keyPair }
  },

  createDeviceSigningKey(master, generation) {
    const keyPair = generateEd25519()
    const tbs = { userId: master.record.userId, publicKey: keyPair.publicKey, generation, masterGeneration: master.record.generation, issuedAtMs: Date.now() }
    return { cert: { ...tbs, signature: signWithLabel(master.keyPair.privateKey, SignLabel.DEVICE_SIGNING_KEY, encodeDskTbs(tbs)) }, keyPair }
  },

  certifyDevice(dsk, device) {
    const tbs = { ...device, userId: dsk.cert.userId, dskGeneration: dsk.cert.generation }
    return { ...tbs, signature: signWithLabel(dsk.keyPair.privateKey, SignLabel.DEVICE_CERTIFICATE, encodeDeviceCertTbs(tbs)) }
  },

  revoke,

  signOut(self, nowMs) {
    const tbs = { userId: self.userId, deviceId: self.deviceId, revokedAtMs: nowMs, reason: DeviceRevocationReason.SIGNED_OUT, masterGeneration: self.masterGeneration }
    return { ...tbs, signature: signWithLabel(self.mlsSignatureKey.privateKey, SignLabel.DEVICE_REVOCATION, encodeRevocationTbs(tbs)) }
  },

  verifyMasterKeyRecord(r, prevPublicKey) {
    if (!verifyMasterSelfSignature(r)) return false
    if (prevPublicKey === null) return true
    return r.prevSignature !== null && verifyWithLabel(prevPublicKey, SignLabel.MASTER_KEY, encodeMasterKeyTbs(r), r.prevSignature)
  },

  verifyRevocation,
  verifyChain,
  credentialIdentity,
  parseCredentialIdentity,
  safetyNumber,
  parseVerifyQr,
  epochCode,

  generateRecoveryKey,
  parseRecoveryKey,
  deriveBackupKeys,
  sealBackup,
  openBackup,
  encodeIdentityBackup,
  decodeIdentityBackup,
  encodeHistoryBatch,
  decodeHistoryBatch,

  async sealToDevice(recipientHpkeKey, kind, senderDeviceId, plaintext, opts) {
    return sealDeviceMessage({ recipientHpkeKey, recipientDeviceId: opts.recipientDeviceId, kind, senderDeviceId, signatureKey: opts.signatureKey, payload: plaintext })
  },

  async openFromDevice(recipientHpkePrivateKey, sealed, opts) {
    const r = await openDeviceMessage({ recipientHpkePrivateKey, recipientDeviceId: opts.recipientDeviceId, sealed, senderSignatureKey: opts.senderSignatureKey })
    return { kind: r.kind, senderDeviceId: r.senderDeviceId, plaintext: r.payload }
  },

  link,
}

export { sealDeviceMessage, openDeviceMessage } from './device-message'
export { encodeRecoveryKey } from './recovery'
