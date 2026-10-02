/**
 * Fuzz tests of every identity, linking, device-message and backup decoder (§12.4, §12.5,
 * §12.11). Input: mutated valid encodings and random bytes. Invariants: a decoder throws only
 * CodecError, and a value that decodes re-encodes to the same bytes (one value, one encoding).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { DeviceCertificate, DeviceRevocation, DeviceSigningKeyCert, LinkMessage, LinkOffer, MasterKeyRecord } from '../api'
import { CodecError, bytesToUuid } from '../codec'
import { edits, mutate, only, runs } from '../fuzz-helpers'
import * as c from './codec'
import { identity } from './index'

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n })
const uuid = bytes(16).map(bytesToUuid)
const u32 = fc.integer({ min: 0, max: 0xffffffff })
const ms = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
const sig = bytes(64)
const name = fc.string({ minLength: 1, maxLength: 16 }).filter((s) => new TextEncoder().encode(s).length <= 64)
const master: fc.Arbitrary<MasterKeyRecord> = fc.record({ userId: uuid, publicKey: bytes(32), generation: u32, createdAtMs: ms, prevSignature: fc.option(sig), signature: sig })
const dsk: fc.Arbitrary<DeviceSigningKeyCert> = fc.record({ userId: uuid, publicKey: bytes(32), generation: u32, masterGeneration: u32, issuedAtMs: ms, signature: sig })
const device: fc.Arbitrary<DeviceCertificate> = fc.record({ userId: uuid, deviceId: uuid, mlsSignatureKey: bytes(32), hpkeKey: bytes(32), dskGeneration: u32, issuedAtMs: ms, displayName: name, signature: sig })
const revocation: fc.Arbitrary<DeviceRevocation> = fc.record({ userId: uuid, deviceId: uuid, revokedAtMs: ms, reason: fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const, 5 as const), masterGeneration: u32, signature: sig })
const platform = fc.constantFrom('electron' as const, 'browser' as const)
const offer: fc.Arbitrary<LinkOffer> = fc.oneof(
  fc.record({ userId: uuid, deviceId: uuid, mode: fc.constant('qr' as const), commitment: fc.constant(new Uint8Array(0)), mlsSignatureKey: bytes(32), hpkeKey: bytes(32), deviceName: name, platform }),
  fc.record({ userId: uuid, deviceId: uuid, mode: fc.constant('sas' as const), commitment: bytes(32), mlsSignatureKey: bytes(32), hpkeKey: bytes(32), deviceName: name, platform }),
)
const linkMessage: fc.Arbitrary<LinkMessage> = fc.oneof(
  fc.record({ type: fc.constant('accept' as const), existingDeviceId: uuid, ephemeralPublic: bytes(32) }),
  fc.record({ type: fc.constant('reveal' as const), ephemeralPublic: bytes(32) }),
  fc.record({ type: fc.constant('transfer' as const), sealed: fc.uint8Array({ maxLength: 60 }) }),
  fc.record({ type: fc.constant('done' as const), confirmation: bytes(32) }),
  fc.record({ type: fc.constant('abort' as const), reason: fc.constantFrom('sas_mismatch' as const, 'cancelled' as const, 'error' as const) }),
)
const groupId = fc.constantFrom(new Uint8Array(22).fill(1), new Uint8Array(22).fill(2))
const historyKey = fc.record({ epoch: fc.integer({ min: 0, max: 1000 }), secret: bytes(32) })

interface Codec {
  name: string
  seeds: Uint8Array[]
  decode: (b: Uint8Array) => unknown
  encode: (v: never) => Uint8Array
  /** False for codecs whose encoder normalizes (groups or sorts) what it writes. */
  canonical?: boolean
}

function codec<T>(name: string, arb: fc.Arbitrary<T>, encode: (v: T) => Uint8Array, decode: (b: Uint8Array) => T, canonical = true): Codec {
  return { name, seeds: fc.sample(arb, { numRuns: 6, seed: 7 }).map(encode), decode, encode, canonical }
}

const codecs: Codec[] = [
  codec('MasterKeyRecord', master, identity.encodeMasterKeyRecord, identity.decodeMasterKeyRecord),
  codec('DeviceSigningKeyCert', dsk, identity.encodeDskCert, identity.decodeDskCert),
  codec('DeviceCertificate', device, identity.encodeDeviceCertificate, identity.decodeDeviceCertificate),
  codec('DeviceChain', fc.record({ master, dsk, device }), identity.encodeDeviceChain, identity.decodeDeviceChain),
  codec('DeviceRevocation', revocation, identity.encodeRevocation, identity.decodeRevocation),
  codec('VerifyQr', fc.record({ userId: uuid, masterKey: bytes(32), peerUserId: uuid, peerMasterKey: bytes(32) }), c.encodeVerifyQr, c.decodeVerifyQr),
  codec('LinkOffer', offer, c.encodeLinkOffer, c.decodeLinkOffer),
  codec('LinkQr', fc.record({ offer, sessionId: uuid, ephemeralPublic: bytes(32), linkSecret: bytes(16) }), c.encodeLinkQr, c.decodeLinkQr),
  codec('LinkMessage', linkMessage, c.encodeLinkMessage, c.decodeLinkMessage),
  codec('SealedDeviceMessage', fc.record({ kind: fc.constantFrom('dsk_transfer' as const, 'history_keys' as const), senderDeviceId: uuid, enc: bytes(32), ciphertext: fc.uint8Array({ maxLength: 60 }) }), c.encodeSealedDeviceMessage, c.decodeSealedDeviceMessage),
  codec('DeviceMessagePlaintext', fc.record({ payload: fc.uint8Array({ maxLength: 60 }), signature: sig }), c.encodeDeviceMessagePlaintext, c.decodeDeviceMessagePlaintext),
  codec('DskTransfer', fc.record({ dsk, dskPrivateKey: bytes(32), device }), c.encodeDskTransfer, c.decodeDskTransfer),
  codec('HistoryKeysPayload', fc.record({ type: fc.constant('response' as const), groupId: bytes(22), epochFrom: fc.constant(0), epochTo: ms, keys: fc.array(historyKey, { maxLength: 3 }) }), c.encodeHistoryKeysPayload, c.decodeHistoryKeysPayload),
  codec('BackupBlob', fc.record({ kind: fc.constantFrom(1 as const, 2 as const), keyId: bytes(16), nonce: bytes(12), ciphertext: fc.uint8Array({ maxLength: 60 }) }), c.encodeBackupBlob, c.decodeBackupBlob),
  codec('IdentityBackup', fc.record({ master, masterPrivateKey: bytes(32), dskCert: dsk, dskPrivateKey: bytes(32) }), identity.encodeIdentityBackup, identity.decodeIdentityBackup),
  codec(
    'HistoryBatch',
    fc.uniqueArray(historyKey, { selector: (k) => k.epoch, minLength: 1, maxLength: 4 }).map((keys) => keys.map((k) => ({ groupId: new Uint8Array(22).fill(3), ...k }))),
    identity.encodeHistoryBatch,
    identity.decodeHistoryBatch,
    // Known (docs/e2ee-audit-scope.md, FZ-4): the decoder accepts keys in any epoch order and
    // duplicate epochs; the encoder sorts. So the bytes are not canonical, only stable.
    false,
  ),
  codec(
    'LinkTransfer',
    fc.record({ master, dskCert: dsk, dskPrivateKey: bytes(32), deviceCertificate: device, historyKeys: fc.array(fc.record({ groupId, epoch: fc.integer({ min: 0, max: 1000 }), secret: bytes(32) }), { maxLength: 3 }) }),
    c.encodeLinkTransfer,
    c.decodeLinkTransfer,
    false, // the history batches inside it, as above
  ),
]

describe('identity decoders (fuzz)', () => {
  for (const k of codecs) {
    it(`${k.name}: throws only CodecError; what decodes re-encodes to the same bytes`, () => {
      fc.assert(
        fc.property(fc.oneof(fc.constantFrom(...k.seeds), fc.uint8Array({ maxLength: 300 })), edits(), fc.option(fc.nat()), fc.uint8Array({ maxLength: 2 }), (base, e, cut, tail) => {
          const b = mutate(base, e, cut, tail)
          const v = only(() => k.decode(b), CodecError)
          if (v === undefined) return
          // The encoder must accept every value the decoder returns.
          const again = k.encode(v as never)
          if (k.canonical !== false) expect(again).toEqual(b)
          else expect(k.encode(k.decode(again) as never)).toEqual(again)
        }),
        runs(800),
      )
    })
  }
})
