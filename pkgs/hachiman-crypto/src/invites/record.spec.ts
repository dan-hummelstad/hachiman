import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { DeviceCertificate } from '../api'
import { bytesToUuid } from '../codec'
import { SignLabel } from '../constants'
import { flip, flipped, runs } from '../fuzz-helpers'
import { generateEd25519, signWithLabel } from '../sign'
import { type InviteBundleTbs, type InviteRecord, decodeInviteAuth, decodeInviteBundleContent, decodeSignedInviteRecord, encodeInviteAuth, encodeInviteBundleContent, encodeInviteRecord, encodeSignedInviteRecord } from './codec'
import { deriveInviteKeys, openInviteBundle, sealInviteBundle } from './keys'
import { signInviteAuth, signInviteBundle, signInviteRecord, verifyInviteAuth, verifyInviteBundle, verifyInviteRecordSignature } from './record'

const ID = (n: number) => bytesToUuid(new Uint8Array(16).fill(n))
const GUILD = ID(1)
const ADMIN = ID(2)
const ADMIN_DEV = ID(3)
const MEMBER = ID(4)
const MEMBER_DEV = ID(5)
const GROUP = new Uint8Array(22).fill(9)

function device(userId: string, deviceId: string) {
  const mls = generateEd25519()
  const cert: DeviceCertificate = { userId, deviceId, mlsSignatureKey: mls.publicKey, hpkeKey: new Uint8Array(32), dskGeneration: 1, issuedAtMs: 0, displayName: 'd', signature: new Uint8Array(64) }
  return { mls, cert }
}

const keys = deriveInviteKeys(new Uint8Array(32).fill(7))
const admin = device(ADMIN, ADMIN_DEV)
const member = device(MEMBER, MEMBER_DEV)
const rec: InviteRecord = {
  guildId: GUILD,
  hpkePublic: keys.hpke.publicKey,
  signPublic: keys.sign.publicKey,
  channelIds: [ID(10), ID(11)],
  adminChainSeq: 3,
  expiresAtMs: 1_900_000_000_000,
  maxUses: 1,
  creatorUserId: ADMIN,
  creatorDeviceId: ADMIN_DEV,
}
const tbs: InviteBundleTbs = { signPublic: keys.sign.publicKey, groupId: GROUP, keys: [{ epoch: 4, secret: new Uint8Array(32).fill(1) }, { epoch: 5, secret: new Uint8Array(32).fill(2) }], senderUserId: MEMBER, senderDeviceId: MEMBER_DEV }

describe('invite records', () => {
  const signed = signInviteRecord(rec, admin.mls.privateKey)

  it('verifies under the creator certificate', () => {
    expect(verifyInviteRecordSignature(signed, admin.cert)).toEqual(rec)
  })

  it('rejects another device, mismatched ids and a tampered record', () => {
    // The member's key, with the creator ids in its certificate: the signature fails.
    expect(verifyInviteRecordSignature(signed, { ...member.cert, userId: ADMIN, deviceId: ADMIN_DEV })).toBeNull()
    // The creator's key under other ids: the ids must be those of the record.
    expect(verifyInviteRecordSignature(signed, { ...admin.cert, deviceId: MEMBER_DEV })).toBeNull()
    expect(verifyInviteRecordSignature(signed, { ...admin.cert, userId: MEMBER })).toBeNull()
    // A server that widens the scope or the use limit breaks the signature.
    const s = decodeSignedInviteRecord(signed)
    const wider = encodeSignedInviteRecord({ record: encodeInviteRecord({ ...rec, channelIds: [ID(10), ID(11), ID(12)] }), signature: s.signature })
    expect(verifyInviteRecordSignature(wider, admin.cert)).toBeNull()
    const unlimited = encodeSignedInviteRecord({ record: encodeInviteRecord({ ...rec, maxUses: 0 }), signature: s.signature })
    expect(verifyInviteRecordSignature(unlimited, admin.cert)).toBeNull()
    expect(verifyInviteRecordSignature(signed.subarray(1), admin.cert)).toBeNull()
  })

  it('rejects a signature with another label', () => {
    const record = encodeInviteRecord(rec)
    for (const label of [SignLabel.INVITE_BUNDLE, SignLabel.ADMIN_ACTION, SignLabel.INVITE_AUTH]) {
      const relabelled = encodeSignedInviteRecord({ record, signature: signWithLabel(admin.mls.privateKey, label, record) })
      expect(verifyInviteRecordSignature(relabelled, admin.cert)).toBeNull()
    }
  })
})

describe('invite bundles', () => {
  const expect_ = { signPublic: keys.sign.publicKey, groupId: GROUP }
  const content = signInviteBundle(tbs, member.mls.privateKey)

  it('verifies under the sender certificate with the AAD values', () => {
    expect(verifyInviteBundle(content, member.cert, expect_)).toEqual(tbs)
  })

  it('rejects another group, another invite, another sender and a tampered TBS', () => {
    expect(verifyInviteBundle(content, member.cert, { ...expect_, groupId: new Uint8Array(22).fill(8) })).toBeNull()
    expect(verifyInviteBundle(content, member.cert, { ...expect_, signPublic: deriveInviteKeys(new Uint8Array(32).fill(8)).sign.publicKey })).toBeNull()
    expect(verifyInviteBundle(content, admin.cert, expect_)).toBeNull()
    expect(verifyInviteBundle(content, { ...admin.cert, userId: MEMBER, deviceId: MEMBER_DEV }, expect_)).toBeNull()
    expect(verifyInviteBundle(content, { ...member.cert, deviceId: ADMIN_DEV }, expect_)).toBeNull()
    const c = decodeInviteBundleContent(content)
    const flipped = c.tbs.slice()
    flipped[flipped.length - 20]! ^= 1
    expect(verifyInviteBundle(encodeInviteBundleContent({ tbs: flipped, signature: c.signature }), member.cert, expect_)).toBeNull()
    const relabelled = encodeInviteBundleContent({ tbs: c.tbs, signature: signWithLabel(member.mls.privateKey, SignLabel.HISTORY_BUNDLE, c.tbs) })
    expect(verifyInviteBundle(relabelled, member.cert, expect_)).toBeNull()
  })

  it('goes from the creator and a member to the redeemer, who has only the seed and the record', async () => {
    const signed = signInviteRecord(rec, admin.mls.privateKey)
    const blob = await sealInviteBundle(rec, GROUP, content)
    // The redeemer: keys from the seed, the record must name them (§12.11.4).
    const mine = deriveInviteKeys(new Uint8Array(32).fill(7))
    const r = verifyInviteRecordSignature(signed, admin.cert)!
    expect(r.signPublic).toEqual(mine.sign.publicKey)
    expect(r.hpkePublic).toEqual(mine.hpke.publicKey)
    const opened = await openInviteBundle(mine, GROUP, blob)
    expect(verifyInviteBundle(opened, member.cert, { signPublic: mine.sign.publicKey, groupId: GROUP })?.keys).toEqual(tbs.keys)
  })
})

describe('invite auth', () => {
  const signedRecord = signInviteRecord(rec, admin.mls.privateKey)
  const leaf = generateEd25519().publicKey
  const auth = signInviteAuth({ signedRecord, signPrivateKey: keys.sign.privateKey, groupId: GROUP, leafSignatureKey: leaf })

  it('verifies over the group and the leaf key under sign_public', () => {
    const v = verifyInviteAuth({ auth, groupId: GROUP, leafSignatureKey: leaf })
    expect(v?.keyId).toEqual(keys.sign.publicKey)
    expect(v?.signedRecord).toEqual(signedRecord)
    expect(v?.record).toEqual(rec)
  })

  it('rejects another group, another leaf, another seed and a swapped record', () => {
    expect(verifyInviteAuth({ auth, groupId: new Uint8Array(22).fill(8), leafSignatureKey: leaf })).toBeNull()
    expect(verifyInviteAuth({ auth, groupId: GROUP, leafSignatureKey: generateEd25519().publicKey })).toBeNull()
    const other = deriveInviteKeys(new Uint8Array(32).fill(8))
    expect(verifyInviteAuth({ auth: signInviteAuth({ signedRecord, signPrivateKey: other.sign.privateKey, groupId: GROUP, leafSignatureKey: leaf }), groupId: GROUP, leafSignatureKey: leaf })).toBeNull()
    // A valid auth signature moved onto the record of another invite.
    const otherRecord = signInviteRecord({ ...rec, signPublic: other.sign.publicKey, hpkePublic: other.hpke.publicKey }, admin.mls.privateKey)
    const a = decodeInviteAuth(auth)
    expect(verifyInviteAuth({ auth: encodeInviteAuth({ signedRecord: otherRecord, signature: a.signature }), groupId: GROUP, leafSignatureKey: leaf })).toBeNull()
    expect(verifyInviteAuth({ auth: auth.subarray(0, auth.length - 1), groupId: GROUP, leafSignatureKey: leaf })).toBeNull()
  })
})

describe('invite signatures (fuzz)', () => {
  it('cover every byte: a flipped record, bundle content or auth never verifies', () => {
    // The InviteAuth signature covers only the group and the leaf key. A flip in its record must
    // fail the creator signature check of the record, which the caller always runs too.
    const signed = signInviteRecord(rec, admin.mls.privateKey)
    const content = signInviteBundle(tbs, member.mls.privateKey)
    const leaf = generateEd25519().publicKey
    const auth = signInviteAuth({ signedRecord: signed, signPrivateKey: keys.sign.privateKey, groupId: GROUP, leafSignatureKey: leaf })
    fc.assert(
      fc.property(flip, (fl) => {
        expect(verifyInviteRecordSignature(flipped(signed, fl), admin.cert)).toBeNull()
        expect(verifyInviteBundle(flipped(content, fl), member.cert, { signPublic: keys.sign.publicKey, groupId: GROUP })).toBeNull()
        const v = verifyInviteAuth({ auth: flipped(auth, fl), groupId: GROUP, leafSignatureKey: leaf })
        if (v !== null) expect(verifyInviteRecordSignature(v.signedRecord, admin.cert)).toBeNull()
      }),
      runs(300),
    )
  })
})
