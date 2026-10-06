/**
 * Fuzz tests of the invite decoders (§12.11.4). Input: mutated valid encodings and random bytes.
 * Invariants: a decoder throws only CodecError, and a value that decodes re-encodes to the same
 * bytes (one value, one encoding).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CodecError, bytesToUuid } from '../codec'
import { edits, mutate, only, runs } from '../fuzz-helpers'
import { compareBytes } from '../identity/bytes'
import * as c from './codec'

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n })
const uuid = bytes(16).map(bytesToUuid)
const ms = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
const sig = bytes(64)
const channelIds = fc.uniqueArray(bytes(16), { maxLength: 3, comparator: (a, b) => compareBytes(a, b) === 0 }).map((ids) => ids.sort(compareBytes).map(bytesToUuid))
const record = fc.record({ guildId: uuid, hpkePublic: bytes(32), signPublic: bytes(32), channelIds, adminChainSeq: ms, expiresAtMs: ms, maxUses: fc.integer({ min: 0, max: 0xffffffff }), creatorUserId: uuid, creatorDeviceId: uuid })
const signedRecord = fc.record({ record: record.map(c.encodeInviteRecord), signature: sig })
const keys = fc.uniqueArray(fc.record({ epoch: fc.integer({ min: 0, max: 1000 }), secret: bytes(32) }), { selector: (k) => k.epoch, minLength: 1, maxLength: 3 }).map((ks) => ks.sort((a, b) => a.epoch - b.epoch))
const tbs = fc.record({ signPublic: bytes(32), groupId: bytes(22), keys, senderUserId: uuid, senderDeviceId: uuid })

interface Codec {
  name: string
  seeds: Uint8Array[]
  decode: (b: Uint8Array) => unknown
  encode: (v: never) => Uint8Array
}

function codec<T>(name: string, arb: fc.Arbitrary<T>, encode: (v: T) => Uint8Array, decode: (b: Uint8Array) => T): Codec {
  return { name, seeds: fc.sample(arb, { numRuns: 6, seed: 7 }).map(encode), decode, encode }
}

const codecs: Codec[] = [
  codec('InviteRecord', record, c.encodeInviteRecord, c.decodeInviteRecord),
  codec('SignedInviteRecord', signedRecord, c.encodeSignedInviteRecord, c.decodeSignedInviteRecord),
  codec('InviteBundleTBS', tbs, c.encodeInviteBundleTbs, c.decodeInviteBundleTbs),
  codec('InviteBundleContent', fc.record({ tbs: tbs.map(c.encodeInviteBundleTbs), signature: sig }), c.encodeInviteBundleContent, c.decodeInviteBundleContent),
  codec('InviteBundle', fc.record({ enc: bytes(32), ciphertext: fc.uint8Array({ maxLength: 60 }) }), c.encodeInviteBundle, c.decodeInviteBundle),
  codec('InviteAuth', fc.record({ signedRecord: signedRecord.map(c.encodeSignedInviteRecord), signature: sig }), c.encodeInviteAuth, c.decodeInviteAuth),
]

describe('invite decoders (fuzz)', () => {
  for (const k of codecs) {
    it(`${k.name}: throws only CodecError; what decodes re-encodes to the same bytes`, () => {
      fc.assert(
        fc.property(fc.oneof(fc.constantFrom(...k.seeds), fc.uint8Array({ maxLength: 300 })), edits(), fc.option(fc.nat()), fc.uint8Array({ maxLength: 2 }), (base, e, cut, tail) => {
          const b = mutate(base, e, cut, tail)
          const v = only(() => k.decode(b), CodecError)
          if (v === undefined) return
          expect(k.encode(v as never)).toEqual(b)
        }),
        runs(800),
      )
    })
  }
})
