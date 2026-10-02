/**
 * Signed admin actions (docs/gateway-protocol.md §12.16, Phase 4): codecs, sign, verify, hash
 * and the chain replay. The §2 permission rules come in through AdminPermissionModel, so this
 * module never imports @hachiman/client.
 */
import { sha256 } from '@noble/hashes/sha2.js'

import {
  CryptoError,
  type AdminAction,
  type AdminActionModule,
  type AdminActionTypeId,
  type AdminPayload,
  type AdminPermissionModel,
  type AdminReplayState,
  type DeviceCertificate,
  type DeviceId,
  type UserId,
} from '../api'
import { CodecError, Reader, Writer, bytesToUuid, decode, encode, uuidToBytes } from '../codec'
import { AdminActionType, SignLabel, WIRE_VERSION } from '../constants'
import { equalBytes } from '../identity/bytes'
import { signWithLabel, verifyWithLabel } from '../sign'

/**
 * The §2 bits that the replay checks. `admin.spec.ts` compares them with
 * `@hachiman/client/permissions`, so the two cannot drift.
 */
export const AdminBits = {
  ADMINISTRATOR: 1 << 3,
  MANAGE_CHANNELS: 1 << 4,
  MANAGE_ROLES: 1 << 28,
} as const
/** §2 DEFAULT_EVERYONE: the @everyone role that POST /guilds creates, before any signed action. */
export const DEFAULT_EVERYONE_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 15) | (1 << 16) | (1 << 20) | (1 << 21) | (1 << 0) | (1 << 26)

const ZERO_HASH = new Uint8Array(32)

const uuid = (w: Writer, id: string): Writer => w.fixed(uuidToBytes(id), 16)
const readUuid = (r: Reader): string => bytesToUuid(r.fixed(16))
const isType = (t: number): t is AdminActionTypeId => Number.isInteger(t) && t >= 0 && t <= 8

function writeUnsigned(w: Writer, a: Omit<AdminAction, 'signature'>): void {
  if (!isType(a.type)) throw new CodecError(`bad admin action type ${a.type as number}`)
  w.u8(WIRE_VERSION)
  uuid(w, a.guildId).u64(a.seq).u8(a.type)
  uuid(w, a.actorUserId)
  uuid(w, a.actorDeviceId).u64(a.timestampMs).fixed(a.prevHash, 32).opaque(a.payload)
}
const encodeUnsigned = (a: Omit<AdminAction, 'signature'>): Uint8Array =>
  encode((w) => {
    writeUnsigned(w, a)
  })

function encodeAction(a: AdminAction): Uint8Array {
  return encode((w) => {
    writeUnsigned(w, a)
    w.opaque(a.signature)
  })
}

function decodeAction(b: Uint8Array): AdminAction {
  return decode(b, (r) => {
    const v = r.u8()
    if (v !== WIRE_VERSION) throw new CodecError(`unsupported version ${v}`)
    const guildId = readUuid(r)
    const seq = r.u64n()
    const type = r.u8()
    if (!isType(type)) throw new CodecError(`bad admin action type ${type}`)
    return { guildId, seq, type, actorUserId: readUuid(r), actorDeviceId: readUuid(r), timestampMs: r.u64n(), prevHash: r.fixed(32), payload: r.opaque(), signature: r.opaque(64) }
  })
}

const TARGET = { role: 1, member: 2 } as const
function readTarget(r: Reader): 'role' | 'member' {
  const t = r.u8()
  if (t === 1) return 'role'
  if (t === 2) return 'member'
  throw new CodecError(`bad overwrite target type ${t}`)
}

function encodePayload(p: AdminPayload): Uint8Array {
  return encode((w) => {
    switch (p.type) {
      case 0:
        uuid(w, p.ownerId)
        return
      case 1:
      case 2:
        uuid(w, p.roleId).u64(p.permissions).u32(p.position)
        return
      case 3:
        uuid(w, p.roleId)
        return
      case 4:
        w.vector(p.positions, (x, rp) => void uuid(x, rp.roleId).u32(rp.position))
        return
      case 5:
        uuid(w, p.channelId)
        uuid(w, p.targetId).u8(TARGET[p.targetType]).u64(p.allow).u64(p.deny)
        return
      case 6:
        uuid(w, p.channelId)
        uuid(w, p.targetId).u8(TARGET[p.targetType])
        return
      case 7:
        uuid(w, p.userId).vector(p.roleIds, (x, id) => void uuid(x, id))
        return
      case 8:
        uuid(w, p.channelId).u8(p.historyVisibility === 'joined' ? 1 : 2)
        return
    }
  })
}

function decodePayload(type: AdminActionTypeId, b: Uint8Array): AdminPayload {
  return decode(b, (r): AdminPayload => {
    switch (type) {
      case 0:
        return { type, ownerId: readUuid(r) }
      case 1:
      case 2:
        return { type, roleId: readUuid(r), permissions: r.u64n(), position: r.u32() }
      case 3:
        return { type, roleId: readUuid(r) }
      case 4:
        return { type, positions: r.vector((x) => ({ roleId: readUuid(x), position: x.u32() })) }
      case 5:
        return { type, channelId: readUuid(r), targetId: readUuid(r), targetType: readTarget(r), allow: r.u64n(), deny: r.u64n() }
      case 6:
        return { type, channelId: readUuid(r), targetId: readUuid(r), targetType: readTarget(r) }
      case 7:
        return { type, userId: readUuid(r), roleIds: r.vector(readUuid) }
      case 8: {
        const channelId = readUuid(r)
        const v = r.u8()
        if (v !== 1 && v !== 2) throw new CodecError(`bad history visibility ${v}`)
        return { type, channelId, historyVisibility: v === 1 ? 'joined' : 'shared' }
      }
    }
  })
}

function sign(unsigned: Omit<AdminAction, 'signature'>, actorSignatureKey: Uint8Array): AdminAction {
  return { ...unsigned, signature: signWithLabel(actorSignatureKey, SignLabel.ADMIN_ACTION, encodeUnsigned(unsigned)) }
}

function verify(a: AdminAction, actorCert: DeviceCertificate): boolean {
  if (actorCert.userId !== a.actorUserId || actorCert.deviceId !== a.actorDeviceId) return false
  try {
    return verifyWithLabel(actorCert.mlsSignatureKey, SignLabel.ADMIN_ACTION, encodeUnsigned(a), a.signature)
  } catch {
    return false
  }
}

const hash = (a: AdminAction): Uint8Array => sha256(encodeAction(a))

// MARK: - Replay

const has = (perms: number, bit: number): boolean => (perms & bit) === bit

/** Bits above the actor's own may not be granted (§4 "Implemented extras"). */
const grantsOnlyHeld = (granted: number, held: number): boolean => (granted & ~held) === 0

function cloneState(s: AdminReplayState): AdminReplayState {
  return {
    guildId: s.guildId,
    seq: s.seq,
    headHash: s.headHash.slice(),
    ownerId: s.ownerId,
    roles: s.roles.map((r) => ({ ...r })),
    overwrites: s.overwrites.map((o) => ({ ...o })),
    memberRoles: s.memberRoles.map((m) => ({ userId: m.userId, roleIds: [...m.roleIds] })),
    historyVisibility: s.historyVisibility.map((h) => ({ ...h })),
  }
}

/** The user ids the state knows: the owner and every member with a role row. */
function knownMembers(s: AdminReplayState, actor: UserId): UserId[] {
  return [...new Set([s.ownerId, actor, ...s.memberRoles.map((m) => m.userId)])]
}

/**
 * Applies one non-genesis payload to `next` after the permission checks against `before`.
 * Returns a failure reason, or null.
 */
function apply(before: AdminReplayState, next: AdminReplayState, actor: UserId, p: AdminPayload, perms: AdminPermissionModel): string | null {
  const everyoneId = before.guildId
  const guildPerms = perms.guildPermissions(before, actor)
  const role = (id: string) => next.roles.find((r) => r.id === id)
  switch (p.type) {
    case 0:
      return 'genesis after seq 0'
    case 1: {
      if (!has(guildPerms, AdminBits.MANAGE_ROLES)) return 'role_create needs MANAGE_ROLES'
      if (role(p.roleId)) return 'role exists'
      if (!grantsOnlyHeld(p.permissions, guildPerms)) return 'role_create grants bits the actor lacks'
      if (p.position === 0) return 'position 0 is @everyone'
      next.roles.push({ id: p.roleId, permissions: p.permissions, position: p.position })
      if (!perms.outranks(next, actor, p.roleId)) return 'role_create above the actor'
      return null
    }
    case 2: {
      if (!has(guildPerms, AdminBits.MANAGE_ROLES)) return 'role_update needs MANAGE_ROLES'
      const r = role(p.roleId)
      if (!r) return 'unknown role'
      if (p.roleId === everyoneId ? p.position !== 0 : p.position === 0) return 'only @everyone has position 0'
      if (p.roleId !== everyoneId && !perms.outranks(before, actor, p.roleId)) return 'role_update above the actor'
      if (!grantsOnlyHeld(p.permissions & ~r.permissions, guildPerms)) return 'role_update grants bits the actor lacks'
      r.permissions = p.permissions
      r.position = p.position
      if (p.roleId !== everyoneId && !perms.outranks(next, actor, p.roleId)) return 'role_update moves the role above the actor'
      return null
    }
    case 3: {
      if (!has(guildPerms, AdminBits.MANAGE_ROLES)) return 'role_delete needs MANAGE_ROLES'
      if (p.roleId === everyoneId) return '@everyone cannot be deleted'
      if (!role(p.roleId)) return 'unknown role'
      if (!perms.outranks(before, actor, p.roleId)) return 'role_delete above the actor'
      next.roles = next.roles.filter((r) => r.id !== p.roleId)
      next.overwrites = next.overwrites.filter((o) => !(o.targetType === 'role' && o.targetId === p.roleId))
      for (const m of next.memberRoles) m.roleIds = m.roleIds.filter((id) => id !== p.roleId)
      return null
    }
    case 4: {
      if (!has(guildPerms, AdminBits.MANAGE_ROLES)) return 'role_reorder needs MANAGE_ROLES'
      const seen = new Set<string>()
      const moved: string[] = []
      for (const rp of p.positions) {
        if (seen.has(rp.roleId)) return 'duplicate role in reorder'
        seen.add(rp.roleId)
        const r = role(rp.roleId)
        if (!r) return 'unknown role'
        if (rp.roleId === everyoneId || rp.position === 0) return '@everyone stays at position 0'
        if (r.position === rp.position) continue
        if (!perms.outranks(before, actor, rp.roleId)) return 'role_reorder moves a role above the actor'
        r.position = rp.position
        moved.push(rp.roleId)
      }
      for (const id of moved) if (!perms.outranks(next, actor, id)) return 'role_reorder moves a role above the actor'
      return null
    }
    case 5: {
      if (!has(guildPerms, AdminBits.MANAGE_ROLES)) return 'overwrite_put needs MANAGE_ROLES'
      if (p.targetType === 'role' && !role(p.targetId)) return 'unknown role'
      if ((p.allow & p.deny) !== 0) return 'a bit is both allowed and denied'
      if (!grantsOnlyHeld(p.allow, guildPerms)) return 'overwrite_put grants bits the actor lacks'
      next.overwrites = next.overwrites.filter((o) => !(o.channelId === p.channelId && o.targetId === p.targetId && o.targetType === p.targetType))
      next.overwrites.push({ channelId: p.channelId, targetId: p.targetId, targetType: p.targetType, allow: p.allow, deny: p.deny })
      return null
    }
    case 6: {
      if (!has(guildPerms, AdminBits.MANAGE_ROLES)) return 'overwrite_delete needs MANAGE_ROLES'
      const n = next.overwrites.length
      next.overwrites = next.overwrites.filter((o) => !(o.channelId === p.channelId && o.targetId === p.targetId && o.targetType === p.targetType))
      return next.overwrites.length === n ? 'unknown overwrite' : null
    }
    case 7: {
      if (!has(guildPerms, AdminBits.MANAGE_ROLES)) return 'member_roles needs MANAGE_ROLES'
      if (new Set(p.roleIds).size !== p.roleIds.length) return 'duplicate role in member_roles'
      const old = before.memberRoles.find((m) => m.userId === p.userId)?.roleIds ?? []
      for (const id of p.roleIds) {
        if (id === everyoneId) return '@everyone is implicit'
        if (!role(id)) return 'unknown role'
      }
      const changed = [...p.roleIds.filter((id) => !old.includes(id)), ...old.filter((id) => !p.roleIds.includes(id))]
      for (const id of changed) if (!perms.outranks(before, actor, id)) return 'member_roles changes a role above the actor'
      next.memberRoles = next.memberRoles.filter((m) => m.userId !== p.userId)
      if (p.roleIds.length > 0) next.memberRoles.push({ userId: p.userId, roleIds: [...p.roleIds] })
      return null
    }
    case 8: {
      const channelPerms = perms.channelPermissions(before, p.channelId, actor, knownMembers(before, actor))
      if (!has(channelPerms, AdminBits.MANAGE_CHANNELS)) return 'channel_history_visibility needs MANAGE_CHANNELS'
      next.historyVisibility = next.historyVisibility.filter((h) => h.channelId !== p.channelId)
      next.historyVisibility.push({ channelId: p.channelId, value: p.historyVisibility })
      return null
    }
  }
}

function replay(
  state: AdminReplayState | null,
  actions: AdminAction[],
  actorCert: (userId: UserId, deviceId: DeviceId) => DeviceCertificate | null,
  perms: AdminPermissionModel,
): AdminReplayState {
  let cur = state === null ? null : cloneState(state)
  for (const a of actions) {
    const fail = (why: string): never => {
      throw new CryptoError('Malformed', `admin action seq ${a.seq}: ${why}`)
    }
    const expectedSeq = cur === null ? 0 : cur.seq + 1
    if (a.seq !== expectedSeq) fail(`expected seq ${expectedSeq}`)
    if (!equalBytes(a.prevHash, cur === null ? ZERO_HASH : cur.headHash)) fail('prev_hash does not continue the chain')
    if (cur !== null && a.guildId !== cur.guildId) fail('another guild')
    const cert = actorCert(a.actorUserId, a.actorDeviceId)
    if (cert === null || !verify(a, cert)) fail('bad signature or unknown actor device')
    let payload: AdminPayload
    try {
      payload = decodePayload(a.type, a.payload)
    } catch (e) {
      return fail(`payload: ${(e as Error).message}`)
    }
    if (cur === null) {
      if (payload.type !== AdminActionType.GENESIS) return fail('the chain starts with genesis')
      if (payload.ownerId !== a.actorUserId) fail('the owner signs the genesis')
      cur = {
        guildId: a.guildId,
        seq: 0,
        headHash: hash(a),
        ownerId: payload.ownerId,
        roles: [{ id: a.guildId, permissions: DEFAULT_EVERYONE_PERMISSIONS, position: 0 }],
        overwrites: [],
        memberRoles: [],
        historyVisibility: [],
      }
      continue
    }
    const next = cloneState(cur)
    const why = apply(cur, next, a.actorUserId, payload, perms)
    if (why !== null) fail(why)
    next.seq = a.seq
    next.headHash = hash(a)
    cur = next
  }
  if (cur === null) throw new CryptoError('Malformed', 'empty admin chain')
  return cur
}

export const admin: AdminActionModule = {
  encodeAction,
  decodeAction,
  encodePayload,
  decodePayload,
  sign,
  verify,
  hash,
  replay,
}
