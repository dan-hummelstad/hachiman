import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { DeviceCertificate, DeviceRevocation, DeviceSigningKeyCert, HistoryKeyEntry, LinkMessage, LinkOffer, MasterKeyRecord } from '../api'
import { CodecError, bytesToUuid } from '../codec'
import * as c from './codec'
import { identity } from './index'

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n })
const uuid = bytes(16).map(bytesToUuid)
const u32 = fc.integer({ min: 0, max: 0xffffffff })
const ms = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
const sig = bytes(64)
// 1 to 64 UTF-8 bytes.
const name = fc.string({ minLength: 1, maxLength: 16 }).filter((s) => new TextEncoder().encode(s).length <= 64)

const master: fc.Arbitrary<MasterKeyRecord> = fc.record({ userId: uuid, publicKey: bytes(32), generation: u32, createdAtMs: ms, prevSignature: fc.option(sig), signature: sig })
const dsk: fc.Arbitrary<DeviceSigningKeyCert> = fc.record({ userId: uuid, publicKey: bytes(32), generation: u32, masterGeneration: u32, issuedAtMs: ms, signature: sig })
const device: fc.Arbitrary<DeviceCertificate> = fc.record({
  userId: uuid,
  deviceId: uuid,
  mlsSignatureKey: bytes(32),
  hpkeKey: bytes(32),
  dskGeneration: u32,
  issuedAtMs: ms,
  displayName: name,
  signature: sig,
})
const revocation: fc.Arbitrary<DeviceRevocation> = fc.record({
  userId: uuid,
  deviceId: uuid,
  revokedAtMs: ms,
  reason: fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const, 5 as const),
  masterGeneration: u32,
  signature: sig,
})
const offer: fc.Arbitrary<LinkOffer> = fc.oneof(
  fc.record({ userId: uuid, deviceId: uuid, mode: fc.constant('qr' as const), commitment: fc.constant(new Uint8Array(0)), mlsSignatureKey: bytes(32), hpkeKey: bytes(32), deviceName: name, platform: fc.constantFrom('electron' as const, 'browser' as const) }),
  fc.record({ userId: uuid, deviceId: uuid, mode: fc.constant('sas' as const), commitment: bytes(32), mlsSignatureKey: bytes(32), hpkeKey: bytes(32), deviceName: name, platform: fc.constantFrom('electron' as const, 'browser' as const) }),
)
const historyKey = fc.record({ epoch: ms, secret: bytes(32) })
const groupId = bytes(22)

/** Every codec: round trip, then a trailing byte and a bad version must fail. */
function roundTrip<T>(arb: fc.Arbitrary<T>, enc: (v: T) => Uint8Array, dec: (b: Uint8Array) => T, versionAt: number | null = 0): void {
  fc.assert(
    fc.property(arb, (v) => {
      const b = enc(v)
      expect(dec(b)).toEqual(v)
      expect(enc(dec(b))).toEqual(b)
      expect(() => dec(new Uint8Array([...b, 0]))).toThrow(CodecError)
      expect(() => dec(b.subarray(0, b.length - 1))).toThrow(CodecError)
      if (versionAt !== null) {
        const bad = b.slice()
        bad[versionAt] = 2
        expect(() => dec(bad)).toThrow(CodecError)
      }
    }),
    { numRuns: 50 },
  )
}

describe('identity codecs', () => {
  it('MasterKeyRecord', () => {
    roundTrip(master, identity.encodeMasterKeyRecord, identity.decodeMasterKeyRecord)
  })
  it('DeviceSigningKeyCert', () => {
    roundTrip(dsk, identity.encodeDskCert, identity.decodeDskCert)
  })
  it('DeviceCertificate', () => {
    roundTrip(device, identity.encodeDeviceCertificate, identity.decodeDeviceCertificate)
  })
  it('DeviceChain', () => {
    roundTrip(fc.record({ master, dsk, device }), identity.encodeDeviceChain, identity.decodeDeviceChain)
  })
  it('DeviceRevocation', () => {
    roundTrip(revocation, identity.encodeRevocation, identity.decodeRevocation)
  })
  it('VerifyQr', () => {
    roundTrip(fc.record({ userId: uuid, masterKey: bytes(32), peerUserId: uuid, peerMasterKey: bytes(32) }), c.encodeVerifyQr, c.decodeVerifyQr)
  })
  it('LinkOffer', () => {
    roundTrip(offer, c.encodeLinkOffer, c.decodeLinkOffer)
  })
  it('LinkQr', () => {
    roundTrip(fc.record({ offer, sessionId: uuid, ephemeralPublic: bytes(32), linkSecret: bytes(16) }), c.encodeLinkQr, c.decodeLinkQr)
  })
  it('LinkMessage', () => {
    const msg: fc.Arbitrary<LinkMessage> = fc.oneof(
      fc.record({ type: fc.constant('accept' as const), existingDeviceId: uuid, ephemeralPublic: bytes(32) }),
      fc.record({ type: fc.constant('reveal' as const), ephemeralPublic: bytes(32) }),
      fc.record({ type: fc.constant('transfer' as const), sealed: fc.uint8Array({ maxLength: 200 }) }),
      fc.record({ type: fc.constant('done' as const), confirmation: bytes(32) }),
      fc.record({ type: fc.constant('abort' as const), reason: fc.constantFrom('sas_mismatch' as const, 'cancelled' as const, 'error' as const) }),
    )
    roundTrip(msg, c.encodeLinkMessage, c.decodeLinkMessage, null)
    expect(() => c.decodeLinkMessage(new Uint8Array([6]))).toThrow(CodecError)
    expect(() => c.decodeLinkMessage(new Uint8Array([5, 4]))).toThrow(CodecError)
  })
  it('LinkTransfer groups history by group id', () => {
    const transfer = fc.record({
      master,
      dskCert: dsk,
      dskPrivateKey: bytes(32),
      deviceCertificate: device,
      historyKeys: fc.array(fc.record({ groupId: fc.constantFrom(new Uint8Array(22).fill(1), new Uint8Array(22).fill(2)), epoch: ms, secret: bytes(32) }), { maxLength: 6 }),
    })
    fc.assert(
      fc.property(transfer, (t) => {
        const back = c.decodeLinkTransfer(c.encodeLinkTransfer(t))
        const norm = (h: readonly HistoryKeyEntry[]) => c.groupHistory(h).flatMap((g) => g.keys.map((k) => [Array.from(g.groupId).join(), k.epoch, Array.from(k.secret).join()].join('|'))).sort()
        expect(norm(back.historyKeys)).toEqual(norm(t.historyKeys))
        expect({ ...back, historyKeys: [] }).toEqual({ ...t, historyKeys: [] })
        expect(() => c.decodeLinkTransfer(new Uint8Array([...c.encodeLinkTransfer(t), 0]))).toThrow(CodecError)
      }),
      { numRuns: 30 },
    )
  })
  it('SealedDeviceMessage and DeviceMessagePlaintext', () => {
    roundTrip(
      fc.record({ kind: fc.constantFrom('dsk_transfer' as const, 'history_keys' as const), senderDeviceId: uuid, enc: bytes(32), ciphertext: fc.uint8Array({ maxLength: 300 }) }),
      c.encodeSealedDeviceMessage,
      c.decodeSealedDeviceMessage,
    )
    roundTrip(fc.record({ payload: fc.uint8Array({ maxLength: 300 }), signature: sig }), c.encodeDeviceMessagePlaintext, c.decodeDeviceMessagePlaintext, null)
    expect(() => c.decodeSealedDeviceMessage(new Uint8Array([1, 1, ...new Uint8Array(48), 0]))).toThrow(CodecError)
  })
  it('dsk_transfer and history_keys payloads', () => {
    roundTrip(fc.record({ dsk, dskPrivateKey: bytes(32), device }), c.encodeDskTransfer, c.decodeDskTransfer)
    roundTrip(
      fc.record({ type: fc.constant('response' as const), groupId, epochFrom: fc.constant(0), epochTo: ms, keys: fc.array(historyKey, { maxLength: 5 }) }),
      c.encodeHistoryKeysPayload,
      c.decodeHistoryKeysPayload,
      null,
    )
    const req = c.encodeHistoryKeysPayload({ type: 'request', groupId: new Uint8Array(22), epochFrom: 1, epochTo: 2, keys: [] })
    expect(c.decodeHistoryKeysPayload(req).type).toBe('request')
    expect(() => c.encodeHistoryKeysPayload({ type: 'request', groupId: new Uint8Array(22), epochFrom: 3, epochTo: 2, keys: [] })).toThrow(CodecError)
  })
  it('BackupBlob, IdentityBackup and HistoryBatch', () => {
    roundTrip(fc.record({ kind: fc.constantFrom(1 as const, 2 as const), keyId: bytes(16), nonce: bytes(12), ciphertext: fc.uint8Array({ maxLength: 100 }) }), c.encodeBackupBlob, c.decodeBackupBlob)
    roundTrip(fc.record({ master, masterPrivateKey: bytes(32), dskCert: dsk, dskPrivateKey: bytes(32) }), identity.encodeIdentityBackup, identity.decodeIdentityBackup)
    fc.assert(
      fc.property(groupId, fc.uniqueArray(historyKey, { selector: (k) => k.epoch, minLength: 1, maxLength: 8 }), (g, keys) => {
        const entries = keys.map((k) => ({ groupId: g, ...k }))
        const back = identity.decodeHistoryBatch(identity.encodeHistoryBatch(entries))
        expect(back).toEqual([...entries].sort((a, b) => a.epoch - b.epoch))
      }),
      { numRuns: 30 },
    )
    expect(() => identity.encodeHistoryBatch([{ groupId: new Uint8Array(22), epoch: 1, secret: new Uint8Array(32) }, { groupId: new Uint8Array(22).fill(1), epoch: 1, secret: new Uint8Array(32) }])).toThrow(CodecError)
  })
  it('rejects bad enum values and names', () => {
    const d = fc.sample(device, 1)[0]!
    expect(() => identity.encodeDeviceCertificate({ ...d, displayName: '' })).toThrow(CodecError)
    expect(() => identity.encodeDeviceCertificate({ ...d, displayName: 'x'.repeat(65) })).toThrow(CodecError)
    const r = fc.sample(revocation, 1)[0]!
    const b = identity.encodeRevocation(r)
    b[1 + 16 + 16 + 8] = 6
    expect(() => identity.decodeRevocation(b)).toThrow(CodecError)
  })
})
