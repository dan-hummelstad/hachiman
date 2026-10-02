/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument -- async test callbacks, expect.objectContaining matchers */
import { x25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'

import { CryptoError, type ChainContext, type DeviceChain, type LinkOffer } from '../api'
import { toB64url } from '../codec'
import { DSK_ROTATION_GRACE_MS, LINK_QR_PREFIX, VERIFY_QR_PREFIX } from '../constants'
import { generateEd25519 } from '../sign'
import { encodeLinkQr } from './codec'
import { identity } from './index'
import { SAS_EMOJI, sasEmoji } from './link'
import { encodeRecoveryKey } from './recovery'

const USER = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DEV = '16fd2706-8baf-433b-82eb-8c7fada847da'
const DEV2 = '886313e1-3b8a-5372-9b90-0c9aee199e5d'

function makeChain(userId = USER, deviceId = DEV) {
  const master = identity.createMasterKey(userId, 1, null)
  const dsk = identity.createDeviceSigningKey(master, 1)
  const mls = generateEd25519()
  const hpkePriv = x25519.utils.randomSecretKey()
  const device = identity.certifyDevice(dsk, { deviceId, mlsSignatureKey: mls.publicKey, hpkeKey: x25519.getPublicKey(hpkePriv), issuedAtMs: 1000, displayName: 'Laptop' })
  const chain: DeviceChain = { master: master.record, dsk: dsk.cert, device }
  return { master, dsk, mls, hpke: { privateKey: hpkePriv, publicKey: device.hpkeKey }, chain }
}

function ctxFor(k: ReturnType<typeof makeChain>, over: Partial<ChainContext> = {}): ChainContext {
  return {
    pinnedMaster: { publicKey: k.master.record.publicKey, generation: 1 },
    currentDsk: { generation: 1, issuedAtMs: 0 },
    highestSeenDskGeneration: 1,
    revokedDeviceIds: new Set(),
    leaf: { credentialIdentity: `${USER}:${DEV}`, signatureKey: k.mls.publicKey },
    entering: true,
    nowMs: 5000,
    ...over,
  }
}

describe('verifyChain', () => {
  const k = makeChain()

  it('accepts a good chain and reports first sight', () => {
    expect(identity.verifyChain(k.chain, ctxFor(k))).toEqual({ ok: true, firstSight: false })
    expect(identity.verifyChain(k.chain, ctxFor(k, { pinnedMaster: null }))).toEqual({ ok: true, firstSight: true })
  })

  it('rule 1: identity parse and user/device consistency', () => {
    expect(identity.verifyChain(k.chain, ctxFor(k, { leaf: { credentialIdentity: 'nope', signatureKey: k.mls.publicKey } }))).toEqual({ ok: false, reason: 'malformed' })
    expect(identity.verifyChain(k.chain, ctxFor(k, { leaf: { credentialIdentity: `${OTHER}:${DEV}`, signatureKey: k.mls.publicKey } }))).toEqual({ ok: false, reason: 'user_mismatch' })
    expect(identity.verifyChain(k.chain, ctxFor(k, { leaf: { credentialIdentity: `${USER}:${DEV2}`, signatureKey: k.mls.publicKey } }))).toEqual({ ok: false, reason: 'device_mismatch' })
    const other = makeChain(OTHER)
    expect(identity.verifyChain({ ...k.chain, dsk: other.chain.dsk }, ctxFor(k))).toEqual({ ok: false, reason: 'user_mismatch' })
  })

  it('rule 2: master self-signature', () => {
    const bad = { ...k.chain, master: { ...k.chain.master, signature: k.chain.dsk.signature } }
    expect(identity.verifyChain(bad, ctxFor(k))).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rule 3: pinned master', () => {
    const other = makeChain()
    expect(identity.verifyChain(k.chain, ctxFor(k, { pinnedMaster: { publicKey: other.master.record.publicKey, generation: 1 } }))).toEqual({ ok: false, reason: 'master_changed' })
  })

  it('rule 4: DSK under the master', () => {
    const other = makeChain()
    expect(identity.verifyChain({ ...k.chain, dsk: other.chain.dsk }, ctxFor(k))).toEqual({ ok: false, reason: 'bad_signature' })
    const wrongGen = identity.createDeviceSigningKey({ ...k.master, record: { ...k.master.record, generation: 2 } }, 1)
    expect(identity.verifyChain({ ...k.chain, dsk: wrongGen.cert }, ctxFor(k))).toEqual({ ok: false, reason: 'key_mismatch' })
  })

  it('rule 5: device certificate under the DSK', () => {
    const other = makeChain()
    expect(identity.verifyChain({ ...k.chain, device: other.chain.device }, ctxFor(k, { leaf: null }))).toEqual({ ok: false, reason: 'bad_signature' })
    const dsk2 = identity.createDeviceSigningKey(k.master, 2)
    const cert2 = identity.certifyDevice(dsk2, { ...k.chain.device })
    expect(identity.verifyChain({ ...k.chain, device: cert2 }, ctxFor(k))).toEqual({ ok: false, reason: 'key_mismatch' })
  })

  it('rule 6: leaf key', () => {
    expect(identity.verifyChain(k.chain, ctxFor(k, { leaf: { credentialIdentity: `${USER}:${DEV}`, signatureKey: generateEd25519().publicKey } }))).toEqual({ ok: false, reason: 'key_mismatch' })
  })

  it('rule 7: revoked', () => {
    expect(identity.verifyChain(k.chain, ctxFor(k, { revokedDeviceIds: new Set([DEV]) }))).toEqual({ ok: false, reason: 'revoked' })
  })

  it('rule 8: entering leaves need the current DSK, members get the grace period', () => {
    const current = { generation: 2, issuedAtMs: 10_000 }
    expect(identity.verifyChain(k.chain, ctxFor(k, { currentDsk: current, highestSeenDskGeneration: 2 }))).toEqual({ ok: false, reason: 'dsk_superseded' })
    expect(identity.verifyChain(k.chain, ctxFor(k, { currentDsk: current, highestSeenDskGeneration: 2, entering: false, nowMs: 10_000 + DSK_ROTATION_GRACE_MS - 1 }))).toEqual({ ok: true, firstSight: false })
    expect(identity.verifyChain(k.chain, ctxFor(k, { currentDsk: current, highestSeenDskGeneration: 2, entering: false, nowMs: 10_000 + DSK_ROTATION_GRACE_MS }))).toEqual({ ok: false, reason: 'dsk_superseded' })
    expect(identity.verifyChain(k.chain, ctxFor(k, { currentDsk: { generation: 3, issuedAtMs: 10_000 }, highestSeenDskGeneration: 3, entering: false }))).toEqual({ ok: false, reason: 'dsk_superseded' })
    expect(identity.verifyChain(k.chain, ctxFor(k, { currentDsk: null }))).toEqual({ ok: false, reason: 'dsk_superseded' })
  })

  it('rule 9: a current DSK below the highest seen generation is a downgrade', () => {
    expect(identity.verifyChain(k.chain, ctxFor(k, { highestSeenDskGeneration: 2 }))).toEqual({ ok: false, reason: 'dsk_downgrade' })
    const dsk2 = identity.createDeviceSigningKey(k.master, 2)
    const cert2 = identity.certifyDevice(dsk2, { ...k.chain.device })
    expect(identity.verifyChain({ ...k.chain, dsk: dsk2.cert, device: cert2 }, ctxFor(k))).toEqual({ ok: false, reason: 'dsk_downgrade' })
  })
})

describe('master keys and revocations', () => {
  it('signs prev_signature on rotation', () => {
    const a = identity.createMasterKey(USER, 1, null)
    const b = identity.createMasterKey(USER, 2, a.keyPair)
    expect(identity.verifyMasterKeyRecord(b.record, a.keyPair.publicKey)).toBe(true)
    expect(identity.verifyMasterKeyRecord(b.record, generateEd25519().publicKey)).toBe(false)
    expect(identity.verifyMasterKeyRecord(a.record, a.keyPair.publicKey)).toBe(false)
    expect(identity.verifyMasterKeyRecord(a.record, null)).toBe(true)
  })

  it('verifies master-signed reasons and the signed_out reason under the device key', () => {
    const k = makeChain()
    const r = identity.revoke(k.master, DEV2, 2, 7)
    expect(identity.verifyRevocation(r, { master: k.master.record, device: null })).toBe(true)
    expect(identity.verifyRevocation({ ...r, reason: 1 }, { master: k.master.record, device: null })).toBe(false)
    expect(() => identity.revoke(k.master, DEV2, 3, 7)).toThrow(CryptoError)
    expect(() => identity.revoke(k.master, DEV2, 5, 7)).toThrow(CryptoError)

    const out = identity.signOut({ userId: USER, deviceId: DEV, masterGeneration: 1, mlsSignatureKey: k.mls }, 9)
    expect(identity.verifyRevocation(out, { master: k.master.record, device: k.chain.device })).toBe(true)
    expect(identity.verifyRevocation(out, { master: k.master.record, device: null })).toBe(false)
    // A master signature never makes a signed_out revocation valid: a bearer token cannot sign out other devices.
    const forged = identity.revoke(k.master, DEV, 1, 9)
    expect(identity.verifyRevocation({ ...forged, reason: 5 }, { master: k.master.record, device: k.chain.device })).toBe(false)
    expect(identity.verifyRevocation({ ...forged, reason: 3 }, { master: k.master.record, device: k.chain.device })).toBe(false)
  })

  it('round-trips credential identities', () => {
    expect(identity.parseCredentialIdentity(identity.credentialIdentity(USER, DEV))).toEqual({ userId: USER, deviceId: DEV })
    expect(identity.parseCredentialIdentity(`${USER.toUpperCase()}:${DEV}`)).toBeNull()
    expect(identity.parseCredentialIdentity(`${USER}:${DEV}:x`)).toBeNull()
  })
})

describe('safety numbers and epoch codes', () => {
  const ka = new Uint8Array(32).fill(1)
  const kb = new Uint8Array(32).fill(2)

  it('is symmetric, 60 digits and pinned', () => {
    const a = identity.safetyNumber({ userId: USER, masterKey: ka }, { userId: OTHER, masterKey: kb })
    const b = identity.safetyNumber({ userId: OTHER, masterKey: kb }, { userId: USER, masterKey: ka })
    expect(a.digits).toBe(b.digits)
    expect(a.digits).toMatch(/^\d{60}$/)
    expect(a.groups).toHaveLength(12)
    expect(a.groups.join('')).toBe(a.digits)
    // Pinned vector: a change in the derivation breaks verification between clients.
    // Cross-checked with an independent Python implementation of §12.5.
    expect(a.digits).toBe('358363172936463357207259530235870587337121915634435290016022')
    expect(identity.safetyNumber({ userId: USER, masterKey: kb }, { userId: OTHER, masterKey: kb }).digits).not.toBe(a.digits)
  })

  it('round-trips the verify QR code', () => {
    const sn = identity.safetyNumber({ userId: USER, masterKey: ka }, { userId: OTHER, masterKey: kb })
    expect(sn.qrPayload.startsWith(VERIFY_QR_PREFIX)).toBe(true)
    expect(identity.parseVerifyQr(sn.qrPayload)).toEqual({ userId: USER, masterKey: ka, peerUserId: OTHER, peerMasterKey: kb })
    expect(() => identity.parseVerifyQr('hachiman-verify:1:AAAA')).toThrow(CryptoError)
    expect(() => identity.parseVerifyQr('x')).toThrow(CryptoError)
  })

  it('makes a 30-digit epoch code', () => {
    const auth = Uint8Array.from({ length: 32 }, (_, i) => i)
    const code = identity.epochCode(auth)
    expect(code).toMatch(/^\d{30}$/)
    // uint40(00 01 02 03 04) = 16909060 → 09060.
    expect(code.slice(0, 5)).toBe('09060')
    expect(() => identity.epochCode(new Uint8Array(29))).toThrow(CryptoError)
  })
})

describe('recovery key', () => {
  const rk = Uint8Array.from({ length: 32 }, (_, i) => i)
  const VECTOR = 'HRK1-000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FP638'

  it('matches the contract vector', () => {
    expect(encodeRecoveryKey(rk)).toBe(VECTOR)
    expect(identity.parseRecoveryKey(VECTOR)).toEqual(rk)
  })

  it('round-trips and accepts the aliases', () => {
    const g = identity.generateRecoveryKey()
    expect(g.text).toMatch(/^HRK1(-[0-9A-HJKMNP-TV-Z]{5}){11}$/)
    expect(identity.parseRecoveryKey(g.text)).toEqual(g.bytes)
    expect(identity.parseRecoveryKey(VECTOR.toLowerCase().replaceAll('-', ' '))).toEqual(rk)
    expect(identity.parseRecoveryKey(VECTOR.replaceAll('0', 'O').replace('HRK1', 'hrk1'))).toEqual(rk)
    expect(identity.parseRecoveryKey(VECTOR.replace('R40M', 'R4OM').replace('W8124', 'W8L24').replace('W8L24', 'W8I24'))).toEqual(rk)
  })

  it('rejects a typo, a checksum error, pad bits and U', () => {
    const code = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return (e as CryptoError).code
      }
      return null
    }
    expect(code(() => identity.parseRecoveryKey(VECTOR.replace('000G4', '000G5')))).toBe('InvalidRecoveryKey')
    expect(code(() => identity.parseRecoveryKey(VECTOR.slice(0, -1) + '9'))).toBe('InvalidRecoveryKey')
    // The last character carries 2 data bits and 3 pad bits: '8' = 01000 has a pad bit set.
    const last = VECTOR.slice(-1)
    expect(last).toBe('8')
    expect(code(() => identity.parseRecoveryKey(VECTOR.slice(0, -1) + '9'))).toBe('InvalidRecoveryKey')
    expect(code(() => identity.parseRecoveryKey(VECTOR.slice(0, -2) + '39'))).toBe('InvalidRecoveryKey')
    expect(code(() => identity.parseRecoveryKey(VECTOR.replace('R38E1', 'R38U1')))).toBe('InvalidRecoveryKey')
    expect(code(() => identity.parseRecoveryKey(VECTOR.slice(0, -1)))).toBe('InvalidRecoveryKey')
    expect(code(() => identity.parseRecoveryKey(VECTOR.replace('HRK1', 'HRK2')))).toBe('InvalidRecoveryKey')
  })

  it('rejects non-zero pad bits with a valid checksum', () => {
    // Same data bits, pad bits set: '8' (01000) → '9' (01001) keeps the 2 data bits "01".
    const text = VECTOR.slice(0, -1) + 'F' // F = 01111: data bits 01, pad 111
    expect(() => identity.parseRecoveryKey(text)).toThrow(/pad bits/)
  })
})

describe('backups', () => {
  it('seals and opens, and a wrong key gives WrongRecoveryKey', () => {
    const keys = identity.deriveBackupKeys(new Uint8Array(32).fill(7))
    expect(keys.key).toHaveLength(32)
    expect(keys.keyId).toHaveLength(16)
    const blob = identity.sealBackup(keys, 2, new Uint8Array([1, 2, 3]))
    expect(identity.openBackup(keys, blob)).toEqual({ kind: 2, plaintext: new Uint8Array([1, 2, 3]) })
    const other = identity.deriveBackupKeys(new Uint8Array(32).fill(8))
    expect(() => identity.openBackup(other, blob)).toThrow(expect.objectContaining({ code: 'WrongRecoveryKey' }))
    // Same key id, other key: the tag fails.
    expect(() => identity.openBackup({ key: other.key, keyId: keys.keyId }, blob)).toThrow(expect.objectContaining({ code: 'WrongRecoveryKey' }))
    // The kind is in the AAD.
    const tampered = blob.slice()
    tampered[1] = 1
    expect(() => identity.openBackup(keys, tampered)).toThrow(expect.objectContaining({ code: 'WrongRecoveryKey' }))
    expect(() => identity.openBackup(keys, new Uint8Array([9]))).toThrow(expect.objectContaining({ code: 'Malformed' }))
  })
})

describe('sealed device messages', () => {
  const sender = makeChain(USER, DEV)
  const recipient = makeChain(USER, DEV2)
  const payload = new Uint8Array([4, 5, 6])
  const seal = () => identity.sealToDevice(recipient.hpke.publicKey, 'dsk_transfer', DEV, payload, { recipientDeviceId: DEV2, signatureKey: sender.mls.privateKey })

  it('opens for the recipient with the sender key', async () => {
    const sealed = await seal()
    const r = await identity.openFromDevice(recipient.hpke.privateKey, sealed, { recipientDeviceId: DEV2, senderSignatureKey: async (id) => (id === DEV ? sender.mls.publicKey : null) })
    expect(r).toEqual({ kind: 'dsk_transfer', senderDeviceId: DEV, plaintext: payload })
  })

  it('fails for a wrong recipient and a wrong sender', async () => {
    const sealed = await seal()
    const other = makeChain(USER, DEV)
    await expect(identity.openFromDevice(other.hpke.privateKey, sealed, { recipientDeviceId: DEV2, senderSignatureKey: async () => sender.mls.publicKey })).rejects.toThrow(CryptoError)
    // The recipient device id is in the HPKE info.
    await expect(identity.openFromDevice(recipient.hpke.privateKey, sealed, { recipientDeviceId: DEV, senderSignatureKey: async () => sender.mls.publicKey })).rejects.toThrow(CryptoError)
    await expect(identity.openFromDevice(recipient.hpke.privateKey, sealed, { recipientDeviceId: DEV2, senderSignatureKey: async () => other.mls.publicKey })).rejects.toThrow(/signature/)
    await expect(identity.openFromDevice(recipient.hpke.privateKey, sealed, { recipientDeviceId: DEV2, senderSignatureKey: async () => null })).rejects.toThrow(/sender/)
    // The sender id is the AAD: a relabelled sender fails the HPKE open.
    const relabelled = sealed.slice()
    relabelled[2]! ^= 1
    await expect(identity.openFromDevice(recipient.hpke.privateKey, relabelled, { recipientDeviceId: DEV2, senderSignatureKey: async () => sender.mls.publicKey })).rejects.toThrow(/does not open/)
  })

  it('needs the recipient id and signer', async () => {
    await expect(identity.sealToDevice(recipient.hpke.publicKey, 'dsk_transfer', DEV, payload)).rejects.toMatchObject({ code: 'Unsupported' })
  })
})

describe('link protocol', () => {
  const k = makeChain()
  const base: Omit<LinkOffer, 'commitment' | 'mode'> = { userId: USER, deviceId: DEV2, mlsSignatureKey: k.mls.publicKey, hpkeKey: k.hpke.publicKey, deviceName: 'Phone', platform: 'browser' }
  const SESSION = '3b241101-e2bb-4255-8caf-4136c566a962'
  const transfer = { master: k.chain.master, dskCert: k.chain.dsk, dskPrivateKey: k.dsk.keyPair.privateKey, deviceCertificate: k.chain.device, historyKeys: [{ groupId: new Uint8Array(22).fill(3), epoch: 4, secret: new Uint8Array(32).fill(9) }] }
  const eph = () => {
    const privateKey = x25519.utils.randomSecretKey()
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
  }

  it('QR mode: both sides derive one key, the transfer opens, done confirms', () => {
    const { offer, secrets } = identity.link.createOffer(base, 'qr')
    const qr = identity.link.encodeQr(offer, SESSION, secrets.ephemeral.publicKey, secrets.linkSecret!)
    expect(qr.startsWith(LINK_QR_PREFIX)).toBe(true)
    const scanned = identity.link.parseQr(qr)
    expect(scanned.sessionId).toBe(SESSION)
    const existing = eph()
    const e = identity.link.deriveSession({ offer: scanned.offer, existingPublic: existing.publicKey, newPublic: scanned.ephemeralPublic, ownPrivate: existing.privateKey, linkSecret: scanned.linkSecret })
    const n = identity.link.deriveSession({ offer, existingPublic: existing.publicKey, newPublic: secrets.ephemeral.publicKey, ownPrivate: secrets.ephemeral.privateKey, linkSecret: secrets.linkSecret })
    expect(e.key).toEqual(n.key)
    expect(e.sas).toEqual(n.sas)
    const sealed = identity.link.sealTransfer(e.key, e.transcriptHash, transfer)
    expect(identity.link.openTransfer(n.key, n.transcriptHash, sealed)).toEqual(transfer)
    expect(identity.link.verifyConfirmation(e.key, e.transcriptHash, identity.link.confirmation(n.key, n.transcriptHash))).toBe(true)
  })

  it('QR mode: a substituted key on the DS cannot open the transfer', () => {
    const { offer, secrets } = identity.link.createOffer(base, 'qr')
    const existing = eph()
    const mitm = eph()
    // The DS swaps e_existing in the accept: the new device derives with the attacker key.
    const attacker = identity.link.deriveSession({ offer, existingPublic: mitm.publicKey, newPublic: secrets.ephemeral.publicKey, ownPrivate: mitm.privateKey, linkSecret: new Uint8Array(16) })
    const n = identity.link.deriveSession({ offer, existingPublic: mitm.publicKey, newPublic: secrets.ephemeral.publicKey, ownPrivate: secrets.ephemeral.privateKey, linkSecret: secrets.linkSecret })
    expect(attacker.key).not.toEqual(n.key)
    const e = identity.link.deriveSession({ offer, existingPublic: existing.publicKey, newPublic: secrets.ephemeral.publicKey, ownPrivate: existing.privateKey, linkSecret: secrets.linkSecret })
    expect(() => identity.link.openTransfer(n.key, n.transcriptHash, identity.link.sealTransfer(e.key, e.transcriptHash, transfer))).toThrow(expect.objectContaining({ code: 'LinkAborted' }))
  })

  it('SAS mode: 7 emoji agree, a substituted key changes them, the commitment binds the new key', () => {
    const { offer, secrets } = identity.link.createOffer(base, 'sas')
    expect(offer.commitment).toHaveLength(32)
    const existing = eph()
    const e = identity.link.deriveSession({ offer, existingPublic: existing.publicKey, newPublic: secrets.ephemeral.publicKey, ownPrivate: existing.privateKey, linkSecret: null })
    const n = identity.link.deriveSession({ offer, existingPublic: existing.publicKey, newPublic: secrets.ephemeral.publicKey, ownPrivate: secrets.ephemeral.privateKey, linkSecret: null })
    expect(e.sas).toHaveLength(7)
    expect(e.sas).toEqual(n.sas)
    for (const s of e.sas) expect(s.index).toBeGreaterThanOrEqual(0)

    // MITM: the DS gives each side its own key. Each side derives with a different transcript.
    const m1 = eph()
    const nSide = identity.link.deriveSession({ offer, existingPublic: m1.publicKey, newPublic: secrets.ephemeral.publicKey, ownPrivate: secrets.ephemeral.privateKey, linkSecret: null })
    expect(nSide.sas).not.toEqual(e.sas)
    // The DS cannot reveal another new-device key: the commitment check fails.
    const m2 = eph()
    expect(() => identity.link.deriveSession({ offer, existingPublic: existing.publicKey, newPublic: m2.publicKey, ownPrivate: existing.privateKey, linkSecret: null })).toThrow(
      expect.objectContaining({ code: 'SasMismatch' }),
    )
  })

  it('maps SAS bits to the Matrix table and rejects a SAS offer in a QR code', () => {
    expect(sasEmoji(new Uint8Array(6).fill(0xff)).map((e) => e.name)).toEqual(Array(7).fill('Pin'))
    expect(sasEmoji(new Uint8Array(6)).map((e) => e.name)).toEqual(Array(7).fill('Dog'))
    // 000001 000010 ... : indexes 1, 2, 3, 4, 5, 6, 7.
    const bits = [1, 2, 3, 4, 5, 6, 7].map((i) => i.toString(2).padStart(6, '0')).join('').padEnd(48, '0')
    const sas = Uint8Array.from({ length: 6 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2))
    expect(sasEmoji(sas).map((e) => e.name)).toEqual(['Cat', 'Lion', 'Horse', 'Unicorn', 'Pig', 'Elephant', 'Rabbit'])
    expect(SAS_EMOJI).toHaveLength(64)
    const qr = toB64url(encodeLinkQr({ offer: { ...base, mode: 'sas', commitment: new Uint8Array(32) }, sessionId: SESSION, ephemeralPublic: new Uint8Array(32), linkSecret: new Uint8Array(16) }))
    expect(() => identity.link.parseQr(LINK_QR_PREFIX + qr)).toThrow(CryptoError)
  })
})
