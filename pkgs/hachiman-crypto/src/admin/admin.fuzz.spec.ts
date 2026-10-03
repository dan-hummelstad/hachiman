/**
 * Fuzz tests of signed admin actions (§12.16): the action and payload decoders, the signature
 * coverage and the chain replay. A changed byte must never give a verified action or a state.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CryptoError, type AdminAction, type AdminActionTypeId, type AdminPayload, type AdminPermissionModel, type DeviceCertificate } from '../api'
import { CodecError } from '../codec'
import { edits, flip, flipped, mutate, only, runs } from '../fuzz-helpers'
import { generateEd25519 } from '../sign'
import { admin } from './index'

const GUILD = '11111111-1111-4111-8111-111111111111'
const OWNER = '22222222-2222-4222-8222-222222222222'
const DEV = '55555555-5555-4555-8555-555555555555'
const ROLE = '66666666-6666-4666-8666-666666666666'
const CHANNEL = '88888888-8888-4888-8888-888888888888'

const key = generateEd25519()
const cert: DeviceCertificate = { userId: OWNER, deviceId: DEV, mlsSignatureKey: key.publicKey, hpkeKey: new Uint8Array(32), dskGeneration: 1, issuedAtMs: 0, displayName: 'd', signature: new Uint8Array(64) }
const certOf = (u: string, d: string) => (u === OWNER && d === DEV ? cert : null)
/** The owner may do everything; nobody else may do anything. */
const perms: AdminPermissionModel = {
  guildPermissions: (s, u) => (u === s.ownerId ? 0x7fffffff : 0),
  channelPermissions: (s, _c, u) => (u === s.ownerId ? 0x7fffffff : 0),
  outranks: (s, actor) => actor === s.ownerId,
}

function chain(payloads: AdminPayload[]): AdminAction[] {
  const out: AdminAction[] = []
  for (const p of payloads) {
    const prev = out.at(-1)
    out.push(
      admin.sign(
        { guildId: GUILD, seq: out.length, type: p.type, actorUserId: OWNER, actorDeviceId: DEV, timestampMs: out.length, prevHash: prev ? admin.hash(prev) : new Uint8Array(32), payload: admin.encodePayload(p) },
        key.privateKey,
      ),
    )
  }
  return out
}

const valid = chain([
  { type: 0, ownerId: OWNER },
  { type: 1, roleId: ROLE, permissions: 1024, position: 1 },
  { type: 5, channelId: CHANNEL, targetId: ROLE, targetType: 'role', allow: 1024, deny: 0 },
  { type: 7, userId: OWNER, roleIds: [ROLE] },
  { type: 8, channelId: CHANNEL, historyVisibility: 'shared' },
])
const encoded = valid.map((a) => admin.encodeAction(a))

describe('admin actions (fuzz)', () => {
  it('decodeAction throws only CodecError and accepts only canonical bytes', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...encoded), fc.uint8Array({ maxLength: 200 })), edits(), fc.option(fc.nat()), fc.uint8Array({ maxLength: 2 }), (base, e, cut, tail) => {
        const b = mutate(base, e, cut, tail)
        const a = only(() => admin.decodeAction(b), CodecError)
        if (a !== undefined) expect(admin.encodeAction(a)).toEqual(b)
      }),
      runs(3000),
    )
  })

  it('decodePayload throws only CodecError for every type and accepts only canonical bytes', () => {
    const payloads = valid.map((a) => a.payload)
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.oneof(fc.constantFrom(...payloads), fc.uint8Array({ maxLength: 120 })), edits(4), fc.option(fc.nat()), (type, base, e, cut) => {
        const b = mutate(base, e, cut)
        const p = only(() => admin.decodePayload(type as AdminActionTypeId, b), CodecError)
        if (p !== undefined) expect(admin.encodePayload(p)).toEqual(b)
      }),
      runs(3000),
    )
  })

  it('the signature covers every byte: a flipped action never verifies', () => {
    fc.assert(
      fc.property(fc.nat(encoded.length - 1), flip, (i, f) => {
        const a = only(() => admin.decodeAction(flipped(encoded[i]!, f)), CodecError)
        if (a !== undefined) expect(admin.verify(a, cert)).toBe(false)
      }),
      runs(3000),
    )
  })

  it('replay of the honest chain works; a flipped, dropped or reordered action throws CryptoError', () => {
    expect(admin.replay(null, valid, certOf, perms).seq).toBe(valid.length - 1)
    fc.assert(
      fc.property(fc.nat(encoded.length - 1), flip, fc.constantFrom('flip' as const, 'drop' as const, 'swap' as const), (i, f, how) => {
        let actions: AdminAction[]
        if (how === 'flip') {
          const a = only(() => admin.decodeAction(flipped(encoded[i]!, f)), CodecError)
          if (a === undefined) return
          actions = valid.map((x, k) => (k === i ? a : x))
        } else if (how === 'drop') {
          if (i === valid.length - 1) return // a shorter honest prefix is still a valid chain
          actions = valid.filter((_, k) => k !== i)
        } else {
          const j = (i + 1) % valid.length
          actions = valid.map((x, k) => (k === i ? valid[j]! : k === j ? valid[i]! : x))
        }
        expect(() => admin.replay(null, actions, certOf, perms)).toThrow(CryptoError)
      }),
      runs(1000),
    )
  })

  it('replay never throws anything but CryptoError on arbitrary decodable actions', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(encoded.length - 1), edits(3)), { minLength: 1, maxLength: 5 }), (picks) => {
        const actions = picks.map(([i, e]) => only(() => admin.decodeAction(mutate(encoded[i]!, e)), CodecError)).filter((a): a is AdminAction => a !== undefined)
        if (actions.length === 0) return
        only(() => admin.replay(null, actions, certOf, perms), CryptoError)
      }),
      runs(1000),
    )
  })
})
