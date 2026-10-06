/**
 * Signatures of invites with history (docs/gateway-protocol.md §12.11.4): the InviteRecord by the
 * creator device, the InviteBundleTBS by the sender device (both with the device MLS key that the
 * DeviceCertificate certifies), and the InviteAuth by the invite sign key.
 *
 * Pure: `mls/ds.ts` (Node) imports this file. These functions check signatures and ids only. The
 * certificate lookup, revocation, trust and admin-state checks belong to the caller (§12.16).
 * Every verify returns null on any failure, never a partial value.
 */
import type { DeviceCertificate } from '../api'
import { SignLabel } from '../constants'
import { equalBytes } from '../identity/bytes'
import { signWithLabel, verifyWithLabel } from '../sign'
import {
  type InviteBundleTbs,
  type InviteRecord,
  decodeInviteAuth,
  decodeInviteBundleContent,
  decodeInviteBundleTbs,
  decodeInviteRecord,
  decodeSignedInviteRecord,
  encodeInviteAuth,
  encodeInviteBundleContent,
  encodeInviteBundleTbs,
  encodeInviteRecord,
  encodeSignedInviteRecord,
  inviteAuthContent,
} from './codec'

// MARK: - InviteRecord

/** SignWithLabel(creator device MLS key, "InviteRecord", record). Returns the encoded SignedInviteRecord. */
export function signInviteRecord(rec: InviteRecord, devicePrivateKey: Uint8Array): Uint8Array {
  const record = encodeInviteRecord(rec)
  return encodeSignedInviteRecord({ record, signature: signWithLabel(devicePrivateKey, SignLabel.INVITE_RECORD, record) })
}

/**
 * The decoded record when `cert` is the creator device (user and device id) and the signature
 * verifies under its MLS key. Null otherwise.
 */
export function verifyInviteRecordSignature(signed: Uint8Array, cert: DeviceCertificate): InviteRecord | null {
  try {
    const s = decodeSignedInviteRecord(signed)
    const rec = decodeInviteRecord(s.record)
    if (rec.creatorUserId !== cert.userId || rec.creatorDeviceId !== cert.deviceId) return null
    return verifyWithLabel(cert.mlsSignatureKey, SignLabel.INVITE_RECORD, s.record, s.signature) ? rec : null
  } catch {
    return null
  }
}

// MARK: - Invite bundles

/** SignWithLabel(sender device MLS key, "InviteBundle", tbs). Returns the encoded InviteBundleContent. */
export function signInviteBundle(t: InviteBundleTbs, senderPrivateKey: Uint8Array): Uint8Array {
  const tbs = encodeInviteBundleTbs(t)
  return encodeInviteBundleContent({ tbs, signature: signWithLabel(senderPrivateKey, SignLabel.INVITE_BUNDLE, tbs) })
}

/**
 * The decoded TBS when it names the AAD values of the bundle (`expect`: the invite key id and the
 * group), `cert` is the sender device, and the signature verifies. Null otherwise.
 */
export function verifyInviteBundle(content: Uint8Array, cert: DeviceCertificate, expect: { signPublic: Uint8Array; groupId: Uint8Array }): InviteBundleTbs | null {
  try {
    const c = decodeInviteBundleContent(content)
    const t = decodeInviteBundleTbs(c.tbs)
    if (!equalBytes(t.signPublic, expect.signPublic) || !equalBytes(t.groupId, expect.groupId)) return null
    if (t.senderUserId !== cert.userId || t.senderDeviceId !== cert.deviceId) return null
    return verifyWithLabel(cert.mlsSignatureKey, SignLabel.INVITE_BUNDLE, c.tbs, c.signature) ? t : null
  } catch {
    return null
  }
}

// MARK: - InviteAuth

/**
 * SignWithLabel(invite sign key, "InviteAuth", encode(group_id, leaf_signature_key)). Returns the
 * encoded InviteAuth that carries the SignedInviteRecord.
 */
export function signInviteAuth(input: { signedRecord: Uint8Array; signPrivateKey: Uint8Array; groupId: Uint8Array; leafSignatureKey: Uint8Array }): Uint8Array {
  const signature = signWithLabel(input.signPrivateKey, SignLabel.INVITE_AUTH, inviteAuthContent(input.groupId, input.leafSignatureKey))
  return encodeInviteAuth({ signedRecord: input.signedRecord, signature })
}

/**
 * The pure part of the InviteAuth check: decodes it and verifies the signature over `groupId` and
 * `leafSignatureKey` under the record's sign_public. It does not verify the creator signature of
 * the record. Null on any failure.
 */
export function verifyInviteAuth(input: { auth: Uint8Array; groupId: Uint8Array; leafSignatureKey: Uint8Array }): { keyId: Uint8Array; signedRecord: Uint8Array; record: InviteRecord } | null {
  try {
    const a = decodeInviteAuth(input.auth)
    const record = decodeInviteRecord(decodeSignedInviteRecord(a.signedRecord).record)
    if (!verifyWithLabel(record.signPublic, SignLabel.INVITE_AUTH, inviteAuthContent(input.groupId, input.leafSignatureKey), a.signature)) return null
    return { keyId: record.signPublic, signedRecord: a.signedRecord, record }
  } catch {
    return null
  }
}
