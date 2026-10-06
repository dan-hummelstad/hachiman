import { DEFAULT_EVERYONE, Permissions } from '@hachiman/client/permissions'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { AdminAction, AdminPayload, AdminPermissionModel, AdminReplayState, DeviceCertificate } from '../api'
import { CodecError, bytesToUuid } from '../codec'
import { identity } from '../identity/index'
import { generateEd25519 } from '../sign'
import { AdminBits, DEFAULT_EVERYONE_PERMISSIONS, admin } from './index'

const GUILD = '11111111-1111-4111-8111-111111111111'
const OWNER = '22222222-2222-4222-8222-222222222222'
const MOD = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const DEV = '55555555-5555-4555-8555-555555555555'
const ROLE_A = '66666666-6666-4666-8666-666666666666'
const ROLE_B = '77777777-7777-4777-8777-777777777777'
const CHANNEL = '88888888-8888-4888-8888-888888888888'
const ALL = Object.values(Permissions).reduce((a, b) => a | b, 0)

/** The §2 rules, written plainly for the test (the Worker passes @hachiman/client/permissions). */
const perms: AdminPermissionModel = {
  guildPermissions(s, userId) {
    if (userId === s.ownerId) return ALL
    const mine = s.memberRoles.find((m) => m.userId === userId)?.roleIds ?? []
    let p = s.roles.find((r) => r.id === s.guildId)?.permissions ?? 0
    for (const id of mine) p |= s.roles.find((r) => r.id === id)?.permissions ?? 0
    return p & Permissions.ADMINISTRATOR ? ALL : p
  },
  channelPermissions(s, channelId, userId) {
    const base = this.guildPermissions(s, userId)
    if (base & Permissions.ADMINISTRATOR) return ALL
    let p = base
    for (const o of s.overwrites.filter((x) => x.channelId === channelId && x.targetId === userId)) p = (p & ~o.deny) | o.allow
    return p & Permissions.VIEW_CHANNEL ? p : 0
  },
  outranks(s, actor, roleId) {
    if (actor === s.ownerId) return true
    const role = s.roles.find((r) => r.id === roleId)
    const top = Math.max(0, ...(s.memberRoles.find((m) => m.userId === actor)?.roleIds ?? []).map((id) => s.roles.find((r) => r.id === id)?.position ?? 0))
    return role !== undefined && role.position < top
  },
  everyoneChannelPermissions(s, channelId) {
    let p = s.roles.find((r) => r.id === s.guildId)?.permissions ?? 0
    if (p & Permissions.ADMINISTRATOR) return ALL
    for (const o of s.overwrites.filter((x) => x.channelId === channelId && x.targetId === s.guildId)) p = (p & ~o.deny) | o.allow
    return p & Permissions.VIEW_CHANNEL ? p : 0
  },
}

function actor(userId: string) {
  const mls = generateEd25519()
  const cert: DeviceCertificate = { userId, deviceId: DEV, mlsSignatureKey: mls.publicKey, hpkeKey: new Uint8Array(32), dskGeneration: 1, issuedAtMs: 0, displayName: 'd', signature: new Uint8Array(64) }
  return { mls, cert }
}

function chainBuilder() {
  const actors = new Map([OWNER, MOD, USER].map((u) => [u, actor(u)]))
  const actions: AdminAction[] = []
  const add = (userId: string, payload: AdminPayload, over: Partial<AdminAction> = {}): AdminAction => {
    const prev = actions[actions.length - 1]
    const unsigned = {
      guildId: GUILD,
      seq: actions.length,
      type: payload.type,
      actorUserId: userId,
      actorDeviceId: DEV,
      timestampMs: actions.length,
      prevHash: prev ? admin.hash(prev) : new Uint8Array(32),
      payload: admin.encodePayload(payload),
      ...over,
    }
    const a = admin.sign(unsigned, actors.get(userId)!.mls.privateKey)
    actions.push(a)
    return a
  }
  const certOf = (u: string, d: string) => (d === DEV ? (actors.get(u)?.cert ?? null) : null)
  return { add, actions, certOf, actors }
}

const run = (b: ReturnType<typeof chainBuilder>, state: AdminReplayState | null = null, actions = b.actions) => admin.replay(state, actions, b.certOf, perms)

describe('admin codecs', () => {
  it('keeps the §2 bits in sync with @hachiman/client', () => {
    expect(AdminBits.ADMINISTRATOR).toBe(Permissions.ADMINISTRATOR)
    expect(AdminBits.MANAGE_CHANNELS).toBe(Permissions.MANAGE_CHANNELS)
    expect(AdminBits.VIEW_CHANNEL).toBe(Permissions.VIEW_CHANNEL)
    expect(AdminBits.MANAGE_ROLES).toBe(Permissions.MANAGE_ROLES)
    expect(DEFAULT_EVERYONE_PERMISSIONS).toBe(DEFAULT_EVERYONE)
  })

  it('round-trips every payload type', () => {
    const id = fc.uint8Array({ minLength: 16, maxLength: 16 }).map(bytesToUuid)
    const n = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })
    const u32 = fc.integer({ min: 0, max: 0xffffffff })
    const target = fc.constantFrom('role' as const, 'member' as const)
    const payload: fc.Arbitrary<AdminPayload> = fc.oneof(
      fc.record({ type: fc.constant(0 as const), ownerId: id }),
      fc.record({ type: fc.constantFrom(1 as const, 2 as const), roleId: id, permissions: n, position: u32 }),
      fc.record({ type: fc.constant(3 as const), roleId: id }),
      fc.record({ type: fc.constant(4 as const), positions: fc.array(fc.record({ roleId: id, position: u32 }), { maxLength: 4 }) }),
      fc.record({ type: fc.constant(5 as const), channelId: id, targetId: id, targetType: target, allow: n, deny: n }),
      fc.record({ type: fc.constant(6 as const), channelId: id, targetId: id, targetType: target }),
      fc.record({ type: fc.constant(7 as const), userId: id, roleIds: fc.array(id, { maxLength: 4 }) }),
      fc.record({ type: fc.constant(8 as const), channelId: id, historyVisibility: fc.constantFrom('joined' as const, 'shared' as const) }),
    )
    fc.assert(
      fc.property(payload, (p) => {
        const b = admin.encodePayload(p)
        expect(admin.decodePayload(p.type, b)).toEqual(p)
        expect(() => admin.decodePayload(p.type, new Uint8Array([...b, 0]))).toThrow(CodecError)
      }),
    )
    expect(() => admin.decodePayload(5, admin.encodePayload({ type: 6, channelId: CHANNEL, targetId: USER, targetType: 'role' }))).toThrow(CodecError)
  })

  it('round-trips actions, signs, verifies and hashes', () => {
    const b = chainBuilder()
    const a = b.add(OWNER, { type: 0, ownerId: OWNER })
    const enc = admin.encodeAction(a)
    expect(admin.decodeAction(enc)).toEqual(a)
    expect(() => admin.decodeAction(new Uint8Array([...enc, 0]))).toThrow(CodecError)
    const v2 = enc.slice()
    v2[0] = 2
    expect(() => admin.decodeAction(v2)).toThrow(CodecError)
    const cert = b.actors.get(OWNER)!.cert
    expect(admin.verify(a, cert)).toBe(true)
    expect(admin.verify({ ...a, seq: 1 }, cert)).toBe(false)
    expect(admin.verify(a, b.actors.get(MOD)!.cert)).toBe(false)
    expect(admin.hash(a)).toHaveLength(32)
    expect(admin.hash(a)).not.toEqual(admin.hash({ ...a, timestampMs: 99 }))
  })

  it('works with real device certificates', () => {
    const master = identity.createMasterKey(OWNER, 1, null)
    const dsk = identity.createDeviceSigningKey(master, 1)
    const mls = generateEd25519()
    const cert = identity.certifyDevice(dsk, { deviceId: DEV, mlsSignatureKey: mls.publicKey, hpkeKey: new Uint8Array(32), issuedAtMs: 0, displayName: 'x' })
    const a = admin.sign({ guildId: GUILD, seq: 0, type: 0, actorUserId: OWNER, actorDeviceId: DEV, timestampMs: 0, prevHash: new Uint8Array(32), payload: admin.encodePayload({ type: 0, ownerId: OWNER }) }, mls.privateKey)
    expect(admin.verify(a, cert)).toBe(true)
  })
})

describe('admin replay', () => {
  function base() {
    const b = chainBuilder()
    b.add(OWNER, { type: 0, ownerId: OWNER })
    b.add(OWNER, { type: 1, roleId: ROLE_A, permissions: Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS | Permissions.VIEW_CHANNEL, position: 2 })
    b.add(OWNER, { type: 1, roleId: ROLE_B, permissions: Permissions.VIEW_CHANNEL, position: 1 })
    b.add(OWNER, { type: 7, userId: MOD, roleIds: [ROLE_A] })
    return b
  }

  it('replays a valid chain into the state', () => {
    const b = base()
    b.add(MOD, { type: 7, userId: USER, roleIds: [ROLE_B] })
    b.add(MOD, { type: 5, channelId: CHANNEL, targetId: ROLE_B, targetType: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL })
    b.add(MOD, { type: 8, channelId: CHANNEL, historyVisibility: 'shared' })
    b.add(OWNER, { type: 2, roleId: GUILD, permissions: Permissions.VIEW_CHANNEL, position: 0 })
    const s = run(b)
    expect(s.seq).toBe(7)
    expect(s.headHash).toEqual(admin.hash(b.actions[7]!))
    expect(s.ownerId).toBe(OWNER)
    expect(s.roles.map((r) => r.id).sort()).toEqual([GUILD, ROLE_A, ROLE_B].sort())
    expect(s.roles.find((r) => r.id === GUILD)?.permissions).toBe(Permissions.VIEW_CHANNEL)
    expect(s.memberRoles).toEqual([{ userId: MOD, roleIds: [ROLE_A] }, { userId: USER, roleIds: [ROLE_B] }])
    expect(s.overwrites).toHaveLength(1)
    expect(s.historyVisibility).toEqual([{ channelId: CHANNEL, value: 'shared' }])
    // Incremental replay from a cached state gives the same result.
    const mid = run(b, null, b.actions.slice(0, 4))
    expect(run(b, mid, b.actions.slice(4))).toEqual(s)
  })

  it('deletes a role with its overwrites and assignments', () => {
    const b = base()
    b.add(OWNER, { type: 7, userId: USER, roleIds: [ROLE_B] })
    b.add(OWNER, { type: 5, channelId: CHANNEL, targetId: ROLE_B, targetType: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 })
    b.add(MOD, { type: 3, roleId: ROLE_B })
    const s = run(b)
    expect(s.roles.some((r) => r.id === ROLE_B)).toBe(false)
    expect(s.overwrites).toEqual([])
    expect(s.memberRoles.find((m) => m.userId === USER)?.roleIds).toEqual([])
  })

  it('rejects a bad seq, a bad prev_hash and a bad signature', () => {
    const b = base()
    const good = b.actions
    const skip = chainBuilder()
    expect(() => run(b, null, [good[0]!, good[2]!])).toThrow(/seq 2: expected seq 1/)
    const wrongPrev = { ...good[1]!, prevHash: new Uint8Array(32).fill(1) }
    expect(() => run(b, null, [good[0]!, admin.sign(wrongPrev, b.actors.get(OWNER)!.mls.privateKey)])).toThrow(/prev_hash/)
    expect(() => run(b, null, [good[0]!, { ...good[1]!, signature: good[0]!.signature }])).toThrow(/signature/)
    expect(() => admin.replay(null, good, () => null, perms)).toThrow(/unknown actor/)
    expect(() => run(skip, null, [])).toThrow(/empty/)
    // The first action must be the owner's genesis.
    const noGenesis = chainBuilder()
    noGenesis.add(OWNER, { type: 3, roleId: ROLE_A })
    expect(() => run(noGenesis)).toThrow(/genesis/)
    const notOwner = chainBuilder()
    notOwner.add(MOD, { type: 0, ownerId: OWNER })
    expect(() => run(notOwner)).toThrow(/owner signs/)
  })

  it('rejects an actor without the permission in the state before the action', () => {
    const b = base()
    b.add(USER, { type: 1, roleId: ROLE_B, permissions: 0, position: 1 })
    expect(() => run(b)).toThrow(/seq 4: role_create needs MANAGE_ROLES/)

    const grant = base()
    grant.add(MOD, { type: 1, roleId: '99999999-9999-4999-8999-999999999999', permissions: Permissions.ADMINISTRATOR, position: 1 })
    expect(() => run(grant)).toThrow(/grants bits/)

    const hierarchy = base()
    hierarchy.add(MOD, { type: 2, roleId: ROLE_A, permissions: Permissions.VIEW_CHANNEL, position: 2 })
    expect(() => run(hierarchy)).toThrow(/above the actor/)

    const selfPromote = base()
    selfPromote.add(MOD, { type: 7, userId: MOD, roleIds: [ROLE_A, ROLE_B] })
    expect(run(selfPromote).memberRoles.find((m) => m.userId === MOD)?.roleIds).toEqual([ROLE_A, ROLE_B])
    const promoteHigh = base()
    promoteHigh.add(MOD, { type: 7, userId: USER, roleIds: [ROLE_A] })
    expect(() => run(promoteHigh)).toThrow(/above the actor/)

    const everyone = base()
    everyone.add(OWNER, { type: 3, roleId: GUILD })
    expect(() => run(everyone)).toThrow(/@everyone/)

    const history = base()
    history.add(USER, { type: 8, channelId: CHANNEL, historyVisibility: 'shared' })
    expect(() => run(history)).toThrow(/MANAGE_CHANNELS/)

    // The permission is checked in the state before the action: a grant in the same action does not count.
    const sameAction = chainBuilder()
    sameAction.add(OWNER, { type: 0, ownerId: OWNER })
    sameAction.add(OWNER, { type: 1, roleId: ROLE_A, permissions: Permissions.MANAGE_ROLES, position: 1 })
    sameAction.add(USER, { type: 7, userId: USER, roleIds: [ROLE_A] })
    expect(() => run(sameAction)).toThrow(/seq 2: member_roles needs MANAGE_ROLES/)
  })

  it('rejects an action for another guild', () => {
    const b = base()
    b.add(OWNER, { type: 3, roleId: ROLE_B }, { guildId: '99999999-9999-4999-8999-999999999999' })
    expect(() => run(b)).toThrow(/another guild/)
  })
})
