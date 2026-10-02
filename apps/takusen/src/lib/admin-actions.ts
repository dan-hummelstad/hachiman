/**
 * Signed admin actions (docs/gateway-protocol.md §12.16, Phase 4).
 *
 * The role, overwrite, member-role and channel historyVisibility routes take
 * the header `X-Hachiman-Signed-Action`. Takusen verifies each action under
 * the certificate of the actor device (`DsModule.verifyAdminAction`), checks
 * that it matches the request and continues the chain (`seq`, `prev_hash`),
 * and stores it in the transaction of the route. The header is optional until
 * the guild has a genesis action, then required.
 *
 * The header holds one base64url action, or two separated by a comma: the
 * genesis, then the action of the request. Thus the owner's client can post
 * the genesis with the first signed request. `PATCH /guilds/:id` with no other
 * change posts the genesis alone.
 *
 * Takusen does not replay the permissions: the route has already checked them
 * on the REST state. Clients replay the chain (§12.16 "Client check").
 */
import { and, asc, desc, eq, gt } from 'drizzle-orm'

import { db, type Tx } from '@/db/client'
import { adminActions, guilds } from '@/db/schema'
import { ApiError } from '@/lib/errors'
import { bytesEqual, fromB64, toB64 } from '@/lib/mls/bytes'
import { getDsModule, type DsModule } from '@/lib/mls/crypto'
import { requireDevice } from '@/lib/mls/device-auth'

import type { AdminAction, AdminPayload, WireAdminAction } from '../../../../pkgs/hachiman-crypto/src/api'
import { admin } from '../../../../pkgs/hachiman-crypto/src/admin/index'
import { AdminActionType } from '../../../../pkgs/hachiman-crypto/src/constants'

export type { AdminPayload }

export const SIGNED_ACTION_HEADER = 'x-hachiman-signed-action'

/** The genesis and the action of the request. */
const MAX_ACTIONS_PER_REQUEST = 2
/** An encoded action is about 150 bytes plus its payload. A reorder of 250 roles is about 5 KiB. */
const MAX_ACTION_BYTES = 16 * 1024
const ZERO_HASH = new Uint8Array(32)

export const ADMIN_ACTIONS_PAGE_DEFAULT = 100
export const ADMIN_ACTIONS_PAGE_MAX = 1000

/** What the route expects: the payload of its change, or the genesis alone. */
export type ExpectedAdminAction = AdminPayload | 'genesis'

export interface ChainHead {
  seq: number
  hash: Uint8Array
}

/** The storage of one guild's chain. */
export interface AdminChainStore {
  /** Locks the chain until the transaction ends and returns its newest action. */
  lockHead(guildId: string): Promise<ChainHead | null>
  append(row: { guildId: string; seq: number; action: Uint8Array; hash: Uint8Array; actorUserId: string }): Promise<void>
}

export type AdminVerifier = Pick<DsModule, 'verifyAdminAction' | 'adminActionHash'>

export interface AdminActor {
  userId: string
  deviceId: string
  /** The stored DeviceCertificate of the actor device. */
  certificate: Uint8Array | null
}

function invalid(message: string): ApiError {
  return new ApiError('InvalidAdminAction', 400, message)
}

/** The header value → encoded actions, in order. No header → []. */
export function parseSignedActions(header: string | null): Uint8Array[] {
  if (header === null || header.trim() === '') return []
  const parts = header.split(',').map((p) => p.trim())
  if (parts.length > MAX_ACTIONS_PER_REQUEST) throw invalid(`at most ${MAX_ACTIONS_PER_REQUEST} actions per request`)
  return parts.map((p) => {
    const bytes = fromB64(p)
    if (!bytes || bytes.length === 0) throw invalid('the action is not base64url')
    if (bytes.length > MAX_ACTION_BYTES) throw invalid('the action is too large')
    return bytes
  })
}

function payloadOf(a: AdminAction): AdminPayload {
  try {
    return admin.decodePayload(a.type, a.payload)
  } catch {
    throw invalid('the action payload does not decode')
  }
}

/** Reorder positions and member role ids are sets: the order in the request does not matter. */
function canonical(p: AdminPayload): AdminPayload {
  if (p.type === AdminActionType.ROLE_REORDER) {
    return { ...p, positions: [...p.positions].sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0)) }
  }
  if (p.type === AdminActionType.MEMBER_ROLES) return { ...p, roleIds: [...p.roleIds].sort() }
  return p
}

/** True when the signed payload states the same change as the request. */
export function matchesRequest(actual: AdminPayload, expected: AdminPayload): boolean {
  if (actual.type !== expected.type) return false
  try {
    return bytesEqual(admin.encodePayload(canonical(actual)), admin.encodePayload(canonical(expected)))
  } catch {
    return false
  }
}

/**
 * Verifies and stores the actions of one request (§12.16). Call inside the
 * route transaction, before the write, so a bad action rolls the change back.
 * Returns the stored actions.
 */
export async function applySignedActions(
  store: AdminChainStore,
  verifier: AdminVerifier,
  input: { guildId: string; ownerId: string; actor: AdminActor; actions: Uint8Array[]; expected: ExpectedAdminAction },
): Promise<AdminAction[]> {
  let head = await store.lockHead(input.guildId)
  if (input.actions.length === 0) {
    if (head !== null && input.expected !== 'genesis') {
      throw invalid('the guild has a signed admin chain: X-Hachiman-Signed-Action is required')
    }
    return []
  }
  if (input.actions.length > MAX_ACTIONS_PER_REQUEST) throw invalid(`at most ${MAX_ACTIONS_PER_REQUEST} actions per request`)
  const certificate = input.actor.certificate
  if (!certificate) throw invalid('the actor device has no certificate')

  const stored: AdminAction[] = []
  for (const [i, bytes] of input.actions.entries()) {
    const a = verifier.verifyAdminAction(bytes, certificate)
    if (!a) throw invalid('the action does not verify under the actor device certificate')
    if (a.guildId !== input.guildId || a.actorUserId !== input.actor.userId || a.actorDeviceId !== input.actor.deviceId) {
      throw invalid('the action is for another guild or actor')
    }
    const nextSeq = head === null ? 0 : head.seq + 1
    if (a.seq !== nextSeq || !bytesEqual(a.prevHash, head?.hash ?? ZERO_HASH)) {
      throw new ApiError('AdminActionConflict', 409, `the action does not continue the chain at seq ${nextSeq}`)
    }

    const payload = payloadOf(a)
    const last = i === input.actions.length - 1
    if (payload.type === AdminActionType.GENESIS) {
      if (head !== null) throw invalid('a genesis action is only valid at seq 0')
      if (payload.ownerId !== input.ownerId || input.actor.userId !== input.ownerId) throw invalid('the owner signs the genesis')
      if (last && input.expected !== 'genesis') throw invalid('the change of the request is not signed')
    } else {
      if (head === null) throw new ApiError('AdminActionConflict', 409, 'the chain starts with a genesis action at seq 0')
      if (!last) throw invalid('only the genesis can come before the action of the request')
      if (input.expected === 'genesis' || !matchesRequest(payload, input.expected)) {
        throw invalid('the action does not match the request')
      }
    }

    const hash = verifier.adminActionHash(bytes)
    await store.append({ guildId: input.guildId, seq: a.seq, action: bytes, hash, actorUserId: a.actorUserId })
    head = { seq: a.seq, hash }
    stored.push(a)
  }
  return stored
}

/**
 * The role id of a signed role_create. The route creates the role with this
 * id, because the signed payload must name the role (§12.16). Null when the
 * header has no role_create (the verify step then rejects the request).
 */
export function signedRoleCreateId(header: string | null): string | null {
  const actions = parseSignedActions(header)
  const last = actions.at(-1)
  if (!last) return null
  try {
    const a = admin.decodeAction(last)
    if (a.type !== AdminActionType.ROLE_CREATE) return null
    const p = admin.decodePayload(a.type, a.payload)
    return p.type === AdminActionType.ROLE_CREATE ? p.roleId : null
  } catch {
    return null
  }
}

// MARK: - Drizzle

export function drizzleAdminChainStore(tx: Tx): AdminChainStore {
  return {
    async lockHead(guildId) {
      // The guild row lock serialises the appends of one guild.
      await tx.select({ id: guilds.id }).from(guilds).where(eq(guilds.id, guildId)).for('update')
      const [row] = await tx
        .select({ seq: adminActions.seq, hash: adminActions.hash })
        .from(adminActions)
        .where(eq(adminActions.guildId, guildId))
        .orderBy(desc(adminActions.seq))
        .limit(1)
      return row ?? null
    },
    async append(row) {
      await tx.insert(adminActions).values(row)
    },
  }
}

/**
 * The route entry point: reads the header, resolves the actor device when an
 * action is present, and applies the actions in `tx`.
 */
export async function enforceAdminAction(
  tx: Tx,
  req: Request,
  ctx: { guildId: string; ownerId: string; userId: string },
  expected: ExpectedAdminAction,
): Promise<AdminAction[]> {
  const actions = parseSignedActions(req.headers.get(SIGNED_ACTION_HEADER))
  const store = drizzleAdminChainStore(tx)
  if (actions.length === 0) {
    return applySignedActions(store, UNUSED_VERIFIER, {
      guildId: ctx.guildId,
      ownerId: ctx.ownerId,
      actor: { userId: ctx.userId, deviceId: '', certificate: null },
      actions,
      expected,
    })
  }
  const device = await requireDevice(req, ctx.userId)
  return applySignedActions(store, await getDsModule(), {
    guildId: ctx.guildId,
    ownerId: ctx.ownerId,
    actor: { userId: ctx.userId, deviceId: device.id, certificate: device.certificate },
    actions,
    expected,
  })
}

/** Without actions, applySignedActions never verifies. */
const UNUSED_VERIFIER: AdminVerifier = {
  verifyAdminAction: () => null,
  adminActionHash: () => {
    throw new Error('unreachable')
  },
}

/** GET /guilds/:id/admin-actions: seq > after, ascending. */
export async function listAdminActions(guildId: string, after: number, limit: number): Promise<WireAdminAction[]> {
  const rows = await db
    .select()
    .from(adminActions)
    .where(and(eq(adminActions.guildId, guildId), gt(adminActions.seq, after)))
    .orderBy(asc(adminActions.seq))
    .limit(limit)
  return rows.map((r) => ({ guildId: r.guildId, seq: r.seq, action: toB64(r.action), createdAt: r.createdAt.toISOString() }))
}
