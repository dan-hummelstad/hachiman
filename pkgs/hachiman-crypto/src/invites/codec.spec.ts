import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CodecError, bytesToUuid, encode, toB64url } from '../codec'
import { HISTORY_BUNDLE_MAX_EPOCHS, INVITE_BUNDLE_MAX_BYTES, INVITE_MAX_SCOPE_CHANNELS } from '../constants'
import { compareBytes } from '../identity/bytes'
import * as c from './codec'

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n })
const uuid = bytes(16).map(bytesToUuid)
const ms = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
const sig = bytes(64)
const sortedIds = (max: number) => fc.uniqueArray(bytes(16), { maxLength: max, comparator: (a, b) => compareBytes(a, b) === 0 }).map((ids) => ids.sort(compareBytes).map(bytesToUuid))
const record: fc.Arbitrary<c.InviteRecord> = fc.record({
  guildId: uuid,
  hpkePublic: bytes(32),
  signPublic: bytes(32),
  channelIds: sortedIds(6),
  adminChainSeq: ms,
  expiresAtMs: ms,
  maxUses: fc.integer({ min: 0, max: 0xffffffff }),
  creatorUserId: uuid,
  creatorDeviceId: uuid,
})
const keys = fc.uniqueArray(fc.record({ epoch: ms, secret: bytes(32) }), { selector: (k) => k.epoch, minLength: 1, maxLength: 5 }).map((ks) => ks.sort((a, b) => a.epoch - b.epoch))
const tbs: fc.Arbitrary<c.InviteBundleTbs> = fc.record({ signPublic: bytes(32), groupId: fc.uint8Array({ minLength: 1, maxLength: 64 }), keys, senderUserId: uuid, senderDeviceId: uuid })

const ID = (n: number) => bytesToUuid(new Uint8Array(16).fill(n))
const baseRecord: c.InviteRecord = {
  guildId: ID(1),
  hpkePublic: new Uint8Array(32).fill(2),
  signPublic: new Uint8Array(32).fill(3),
  channelIds: [ID(4), ID(5)],
  adminChainSeq: 7,
  expiresAtMs: 0,
  maxUses: 1,
  creatorUserId: ID(6),
  creatorDeviceId: ID(7),
}
const baseTbs: c.InviteBundleTbs = { signPublic: new Uint8Array(32).fill(3), groupId: new Uint8Array(22).fill(8), keys: [{ epoch: 1, secret: new Uint8Array(32).fill(9) }], senderUserId: ID(6), senderDeviceId: ID(7) }

/** Round trip, then a trailing byte, a cut and (when versionAt is set) a bad version must fail. */
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

describe('invite codecs', () => {
  it('round-trip every struct', () => {
    roundTrip(record, c.encodeInviteRecord, c.decodeInviteRecord)
    roundTrip(fc.record({ record: record.map(c.encodeInviteRecord), signature: sig }), c.encodeSignedInviteRecord, c.decodeSignedInviteRecord, null)
    roundTrip(tbs, c.encodeInviteBundleTbs, c.decodeInviteBundleTbs)
    roundTrip(fc.record({ tbs: tbs.map(c.encodeInviteBundleTbs), signature: sig }), c.encodeInviteBundleContent, c.decodeInviteBundleContent, null)
    roundTrip(fc.record({ enc: bytes(32), ciphertext: fc.uint8Array({ maxLength: 80 }) }), c.encodeInviteBundle, c.decodeInviteBundle)
    roundTrip(fc.record({ signedRecord: record.map((r) => c.encodeSignedInviteRecord({ record: c.encodeInviteRecord(r), signature: new Uint8Array(64) })), signature: sig }), c.encodeInviteAuth, c.decodeInviteAuth)
  })

  it('pins the InviteRecord layout', () => {
    const b = c.encodeInviteRecord(baseRecord)
    // version, guild_id, hpke_public, sign_public, channel_ids<V> (32 bytes, prefix 0x20), then the rest.
    expect(b[0]).toBe(1)
    expect(b.length).toBe(1 + 16 + 32 + 32 + 1 + 32 + 8 + 8 + 4 + 16 + 16)
    expect(b[1 + 16 + 64]).toBe(32)
    expect(c.inviteRecordView(c.decodeInviteRecord(b))).toEqual({
      guildId: ID(1),
      hpkePublic: toB64url(baseRecord.hpkePublic),
      keyId: toB64url(baseRecord.signPublic),
      channelIds: [ID(4), ID(5)],
      adminChainSeq: 7,
      expiresAtMs: 0,
      maxUses: 1,
      creatorUserId: ID(6),
      creatorDeviceId: ID(7),
    })
  })

  it('accepts only strictly ascending channel ids, at most INVITE_MAX_SCOPE_CHANNELS', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => bytesToUuid(new Uint8Array([...new Uint8Array(14), i >> 8, i & 0xff])))
    expect(c.decodeInviteRecord(c.encodeInviteRecord({ ...baseRecord, channelIds: [] })).channelIds).toEqual([])
    expect(c.decodeInviteRecord(c.encodeInviteRecord({ ...baseRecord, channelIds: ids(INVITE_MAX_SCOPE_CHANNELS) })).channelIds).toHaveLength(INVITE_MAX_SCOPE_CHANNELS)
    expect(() => c.encodeInviteRecord({ ...baseRecord, channelIds: ids(INVITE_MAX_SCOPE_CHANNELS + 1) })).toThrow(CodecError)
    expect(() => c.encodeInviteRecord({ ...baseRecord, channelIds: [ID(5), ID(4)] })).toThrow(/ascending/)
    expect(() => c.encodeInviteRecord({ ...baseRecord, channelIds: [ID(4), ID(4)] })).toThrow(/ascending/)
    expect(() => c.encodeInviteRecord({ ...baseRecord, channelIds: ['not-a-uuid'] })).toThrow(CodecError)
    // The same checks on decode: swap the two ids of a valid encoding.
    const b = c.encodeInviteRecord(baseRecord)
    const at = 1 + 16 + 64 + 1
    const swapped = b.slice()
    swapped.set(b.subarray(at + 16, at + 32), at)
    swapped.set(b.subarray(at, at + 16), at + 16)
    expect(() => c.decodeInviteRecord(swapped)).toThrow(/ascending/)
    // A channel vector that is not a multiple of 16 bytes.
    const ragged = encode((w) => {
      w.u8(1).fixed(new Uint8Array(16), 16).fixed(new Uint8Array(32), 32).fixed(new Uint8Array(32), 32).opaque(new Uint8Array(17))
      w.u64(0).u64(0).u32(0).fixed(new Uint8Array(16), 16).fixed(new Uint8Array(16), 16)
    })
    expect(() => c.decodeInviteRecord(ragged)).toThrow(CodecError)
  })

  it('checks key sizes, epochs and group ids', () => {
    expect(() => c.encodeInviteRecord({ ...baseRecord, hpkePublic: new Uint8Array(31) })).toThrow(CodecError)
    expect(() => c.encodeInviteRecord({ ...baseRecord, signPublic: new Uint8Array(33) })).toThrow(CodecError)
    expect(() => c.encodeInviteBundleTbs({ ...baseTbs, keys: [] })).toThrow(CodecError)
    const k = (epoch: number) => ({ epoch, secret: new Uint8Array(32) })
    expect(() => c.encodeInviteBundleTbs({ ...baseTbs, keys: [k(2), k(1)] })).toThrow(/ascending/)
    expect(() => c.encodeInviteBundleTbs({ ...baseTbs, keys: [k(1), k(1)] })).toThrow(/ascending/)
    const many = Array.from({ length: HISTORY_BUNDLE_MAX_EPOCHS }, (_, i) => k(i))
    expect(c.decodeInviteBundleTbs(c.encodeInviteBundleTbs({ ...baseTbs, keys: many })).keys).toHaveLength(HISTORY_BUNDLE_MAX_EPOCHS)
    expect(() => c.encodeInviteBundleTbs({ ...baseTbs, keys: [...many, k(HISTORY_BUNDLE_MAX_EPOCHS)] })).toThrow(CodecError)
    expect(() => c.encodeInviteBundleTbs({ ...baseTbs, groupId: new Uint8Array(0) })).toThrow(/group id/)
    expect(() => c.encodeInviteBundleTbs({ ...baseTbs, groupId: new Uint8Array(65) })).toThrow(/group id/)
    expect(() => c.inviteAuthContent(new Uint8Array(0), new Uint8Array(32))).toThrow(/group id/)
  })

  it('encodes only u64 values that the decoders accept', () => {
    const bad = [Number.MAX_SAFE_INTEGER + 1, 2 ** 60, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
    const k = (epoch: number) => ({ epoch, secret: new Uint8Array(32) })
    for (const v of bad) {
      expect(() => c.encodeInviteRecord({ ...baseRecord, adminChainSeq: v })).toThrow(CodecError)
      expect(() => c.encodeInviteRecord({ ...baseRecord, expiresAtMs: v })).toThrow(CodecError)
      expect(() => c.encodeInviteBundleTbs({ ...baseTbs, keys: [k(v)] })).toThrow(CodecError)
      expect(() => c.encodeInviteBundleTbs({ ...baseTbs, keys: [k(0), k(v)] })).toThrow(CodecError)
    }
    const max = Number.MAX_SAFE_INTEGER
    expect(c.decodeInviteRecord(c.encodeInviteRecord({ ...baseRecord, adminChainSeq: max, expiresAtMs: max }))).toMatchObject({ adminChainSeq: max, expiresAtMs: max })
    expect(c.decodeInviteBundleTbs(c.encodeInviteBundleTbs({ ...baseTbs, keys: [k(max)] })).keys[0]!.epoch).toBe(max)
  })

  it('rejects signatures that are not 64 bytes and inner objects that do not decode', () => {
    const rec = c.encodeInviteRecord(baseRecord)
    expect(() => c.encodeSignedInviteRecord({ record: rec, signature: new Uint8Array(63) })).toThrow(/64 bytes/)
    expect(() => c.decodeSignedInviteRecord(encode((w) => void w.opaque(rec).opaque(new Uint8Array(65))))).toThrow(CodecError)
    expect(() => c.decodeSignedInviteRecord(encode((w) => void w.opaque(rec.subarray(1)).opaque(new Uint8Array(64))))).toThrow(CodecError)
    expect(() => c.encodeSignedInviteRecord({ record: rec.subarray(1), signature: new Uint8Array(64) })).toThrow(CodecError)
    const t = c.encodeInviteBundleTbs(baseTbs)
    expect(() => c.decodeInviteBundleContent(encode((w) => void w.opaque(t.subarray(0, -1)).opaque(new Uint8Array(64))))).toThrow(CodecError)
    expect(() => c.decodeInviteAuth(encode((w) => void w.u8(1).opaque(rec).opaque(new Uint8Array(64))))).toThrow(CodecError)
  })

  it('caps an InviteBundle at INVITE_BUNDLE_MAX_BYTES', () => {
    const fits = INVITE_BUNDLE_MAX_BYTES - 1 - 32 - 4
    expect(c.encodeInviteBundle({ enc: new Uint8Array(32), ciphertext: new Uint8Array(fits) })).toHaveLength(INVITE_BUNDLE_MAX_BYTES)
    expect(() => c.encodeInviteBundle({ enc: new Uint8Array(32), ciphertext: new Uint8Array(fits + 1) })).toThrow(/too large/)
    expect(() => c.decodeInviteBundle(new Uint8Array(INVITE_BUNDLE_MAX_BYTES + 1))).toThrow(/too large/)
  })
})
