/**
 * Invites with history (docs/gateway-protocol.md §4 "Invite limits",
 * §12.11.4, §12.12): the record checks of POST /guilds/:id/invites, the
 * record list of the members, the bundle store and its sweep. Takusen stores
 * the signed record and the sealed bundles. It cannot open a bundle, and it
 * does not check the admin state of a record: the members do (§12.16).
 *
 * The rules are pure functions. The storage seam is InviteHistoryStore, with
 * a Drizzle and an in-memory implementation (invite-history.in-memory.ts).
 * invite-history.conformance.ts runs on both. Keep them in step.
 *
 * This module does not import `lib/guilds.ts` or `lib/invites.ts`:
 * `lib/invite-limits.ts` calls `revokeInvites`, and `lib/guilds.ts` imports it.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, max, or, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import { guildMembers, inviteBundles, invites, type InviteBundleRow, type InviteRow } from '@/db/schema'
import { ApiError, ValidationError } from '@/lib/errors'
import { fromB64, toB64 } from '@/lib/mls/bytes'
import {
  INVITE_BUNDLE_FETCH_WINDOW_MS,
  INVITE_BUNDLE_MAX_BYTES,
  INVITE_BUNDLES_MAX_BYTES,
  INVITE_MAX_SCOPE_CHANNELS,
  type DsModule,
  type InviteRecordView,
  type WireInviteBundles,
  type WireInviteRecord,
} from '@/lib/mls/crypto'
import { requireReadableGroup } from '@/lib/mls/groups'
import type { MlsRepo } from '@/lib/mls/repo'
import type { Executor } from '@/lib/mls/repo.drizzle'

/** A SignedInviteRecord with 500 channel ids is about 8.2 KiB. */
export const INVITE_RECORD_MAX_BYTES = 16 * 1024
/** The record expiry may differ this much from the expiry that Takusen computes. */
export const INVITE_RECORD_EXPIRY_SKEW_MS = 300_000
/**
 * The bundles of one sender user of an invite, over all its devices (revoked
 * ones too), unless the creator sent them. Every member reads `public_set`, so
 * without this share one member could push the creation bundles out of
 * INVITE_BUNDLES_MAX_BYTES. Several members together still can (§12.12).
 */
export const INVITE_BUNDLES_SENDER_MAX_BYTES = 1024 * 1024

// MARK: - Rules

export interface RecordExpectation {
  guildId: string
  /** The caller, and its X-Hachiman-Device. */
  userId: string
  deviceId: string
  /** The values of the request body. */
  maxAgeSeconds: number
  maxUses: number
  now: Date
  /** The ids of the record `channel_ids` that are channels of the guild. */
  guildChannelIds: ReadonlySet<string>
}

/**
 * The checks of POST /guilds/:id/invites with `record`. `view` is the result of
 * DsModule.verifyInviteRecord under the certificate of the caller device: null
 * when the record does not decode or verify. Returns the key id. Throws 400.
 */
export function checkInviteRecord(view: InviteRecordView | null, e: RecordExpectation): Uint8Array {
  if (!view) throw new ValidationError('The record does not verify under the device certificate')
  if (view.guildId !== e.guildId || view.creatorUserId !== e.userId || view.creatorDeviceId !== e.deviceId) {
    throw new ValidationError('The record is for another guild, user or device')
  }
  if (view.maxUses !== e.maxUses) throw new ValidationError('The record max_uses is not maxUses')
  if (e.maxAgeSeconds === 0) {
    if (view.expiresAtMs !== 0) throw new ValidationError('A permanent invite needs a record with expires_at_ms 0')
  } else if (view.expiresAtMs === 0 || Math.abs(view.expiresAtMs - (e.now.getTime() + e.maxAgeSeconds * 1000)) > INVITE_RECORD_EXPIRY_SKEW_MS) {
    throw new ValidationError('The record expires_at_ms does not match maxAgeSeconds')
  }
  if (view.channelIds.length > INVITE_MAX_SCOPE_CHANNELS) throw new ValidationError('The record has too many channels')
  // A channel id does not name its guild, and the redeemer cannot check the guild of a group that
  // it does not hold yet (§12.11.4 "Scope").
  if (view.channelIds.some((c) => !e.guildChannelIds.has(c))) throw new ValidationError('The record names a channel that is not of this guild')
  const keyId = fromB64(view.keyId)
  if (!keyId || keyId.length !== 32) throw new ValidationError('The record has no valid key id')
  return keyId
}

export type InviteUsability = 'ok' | 'revoked' | 'expired' | 'exhausted'

/** Why an invite cannot be used, in this order, or 'ok'. `activeRecords` has the same rule in SQL. */
export function inviteUsability(
  i: Pick<InviteRow, 'revoked' | 'expiresAt' | 'exhaustedAt' | 'maxUses' | 'uses'>,
  now: Date,
): InviteUsability {
  if (i.revoked) return 'revoked'
  if (i.expiresAt !== null && i.expiresAt <= now) return 'expired'
  if (i.exhaustedAt !== null || (i.maxUses !== null && i.uses >= i.maxUses)) return 'exhausted'
  return 'ok'
}

export function isInviteActive(i: Pick<InviteRow, 'revoked' | 'expiresAt' | 'exhaustedAt' | 'maxUses' | 'uses'>, now: Date): boolean {
  return inviteUsability(i, now) === 'ok'
}

function unknownInvite(): ApiError {
  return new ApiError('UnknownInvite', 404, 'unknown invite')
}

// MARK: - Storage seam

/** An active invite with a record, and the newest stored bundle epoch of each group (group id order). */
export interface StoredInviteRecord {
  inviteId: string
  keyId: Uint8Array
  record: Uint8Array
  expiresAt: Date | null
  bundled: { groupId: Uint8Array; epoch: number }[]
}

export type NewInviteBundle = Omit<InviteBundleRow, 'id' | 'createdAt'>

export interface InviteHistoryStore {
  transaction<T>(fn: (store: InviteHistoryStore) => Promise<T>): Promise<T>
  /** `lock`: FOR NO KEY UPDATE. A revoke, an accept and another bundle post of the invite wait for the transaction. */
  getInvite(id: string, lock?: boolean): Promise<InviteRow | null>
  /**
   * The accept of a new member (§4): a membership row that names the invite,
   * one more use, and `exhausted_at` at the last use. Call with the invite row
   * locked FOR UPDATE.
   */
  joinWithInvite(invite: InviteRow, userId: string, now: Date): Promise<void>
  /** The membership of the user, or null for a non-member. */
  memberJoin(guildId: string, userId: string): Promise<{ inviteId: string | null; joinedAt: Date } | null>
  /** The active invites of the guild that have a record, oldest first. */
  activeRecords(guildId: string, now: Date): Promise<StoredInviteRecord[]>
  insertBundle(b: NewInviteBundle): Promise<void>
  /**
   * Deletes the oldest bundles of the invite (only those of `senderUser`, when given) until their
   * sizes sum to at most `maxBytes`. Returns the count.
   */
  trimBundles(inviteId: string, maxBytes: number, senderUser?: string): Promise<number>
  /** Oldest first. */
  listBundles(inviteId: string): Promise<InviteBundleRow[]>
  /** Revokes the invites that are not revoked and returns them. Deletes the bundles of every id. */
  revokeInvites(ids: readonly string[]): Promise<{ inviteId: string; code: string }[]>
  /** Deletes the bundles of revoked invites, and of invites that expired or were exhausted before `before`. */
  deleteStaleBundles(before: Date): Promise<number>
}

export function drizzleInviteHistoryStore(x: Executor = db): InviteHistoryStore {
  return {
    async transaction(fn) {
      // On a transaction handle this opens a savepoint.
      return x.transaction((tx) => fn(drizzleInviteHistoryStore(tx)))
    },
    async getInvite(id, lock = false) {
      const q = x.select().from(invites).where(eq(invites.id, id))
      const [row] = lock ? await q.for('no key update') : await q
      return row ?? null
    },
    async joinWithInvite(invite, userId, now) {
      await x.insert(guildMembers).values({ guildId: invite.guildId, userId, inviteId: invite.id, joinedAt: now })
      const uses = invite.uses + 1
      await x
        .update(invites)
        .set({ uses, ...(invite.maxUses !== null && uses >= invite.maxUses && { exhaustedAt: now }) })
        .where(eq(invites.id, invite.id))
    },
    async memberJoin(guildId, userId) {
      const [row] = await x
        .select({ inviteId: guildMembers.inviteId, joinedAt: guildMembers.joinedAt })
        .from(guildMembers)
        .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
        .limit(1)
      return row ?? null
    },
    async activeRecords(guildId, now) {
      const rows = await x
        .select({ inviteId: invites.id, keyId: invites.keyId, record: invites.record, expiresAt: invites.expiresAt })
        .from(invites)
        .where(
          and(
            eq(invites.guildId, guildId),
            isNotNull(invites.record),
            isNotNull(invites.keyId),
            // The next four lines are inviteUsability(i, now) === 'ok'. Keep them in step.
            eq(invites.revoked, false),
            or(isNull(invites.expiresAt), gt(invites.expiresAt, now)),
            isNull(invites.exhaustedAt),
            or(isNull(invites.maxUses), lt(invites.uses, invites.maxUses)),
          ),
        )
        .orderBy(asc(invites.createdAt), asc(invites.id))
      if (rows.length === 0) return []
      const epochs = await x
        .select({ inviteId: inviteBundles.inviteId, groupId: inviteBundles.groupId, epoch: max(inviteBundles.epoch) })
        .from(inviteBundles)
        .where(inArray(inviteBundles.inviteId, rows.map((r) => r.inviteId)))
        .groupBy(inviteBundles.inviteId, inviteBundles.groupId)
        .orderBy(asc(inviteBundles.groupId))
      return rows.map((r) => ({
        inviteId: r.inviteId,
        keyId: r.keyId!,
        record: r.record!,
        expiresAt: r.expiresAt,
        bundled: epochs.filter((e) => e.inviteId === r.inviteId).map((e) => ({ groupId: e.groupId, epoch: e.epoch! })),
      }))
    },
    async insertBundle(b) {
      await x.insert(inviteBundles).values(b)
    },
    async trimBundles(inviteId, maxBytes, senderUser) {
      const scope =
        senderUser === undefined
          ? eq(inviteBundles.inviteId, inviteId)
          : and(eq(inviteBundles.inviteId, inviteId), eq(inviteBundles.senderUser, senderUser))
      // Newest first, the running sum of the sizes: a bundle goes when the newer ones and it are above the cap.
      const rows = await x
        .delete(inviteBundles)
        .where(
          inArray(
            inviteBundles.id,
            sql`(select id from (select ${inviteBundles.id} as id, sum(${inviteBundles.size}) over (order by ${inviteBundles.createdAt} desc, ${inviteBundles.id} desc) as running from ${inviteBundles} where ${scope}) sized where running > ${maxBytes})`,
          ),
        )
        .returning({ id: inviteBundles.id })
      return rows.length
    },
    async listBundles(inviteId) {
      return x.select().from(inviteBundles).where(eq(inviteBundles.inviteId, inviteId)).orderBy(asc(inviteBundles.createdAt), asc(inviteBundles.id))
    },
    async revokeInvites(ids) {
      if (ids.length === 0) return []
      const revoked = await x
        .update(invites)
        .set({ revoked: true })
        .where(and(inArray(invites.id, [...ids]), eq(invites.revoked, false)))
        .returning({ inviteId: invites.id, code: invites.code })
      await x.delete(inviteBundles).where(inArray(inviteBundles.inviteId, [...ids]))
      return revoked
    },
    async deleteStaleBundles(before) {
      const stale = x
        .select({ id: invites.id })
        .from(invites)
        .where(or(eq(invites.revoked, true), lt(invites.expiresAt, before), lt(invites.exhaustedAt, before)))
      const rows = await x.delete(inviteBundles).where(inArray(inviteBundles.inviteId, stale)).returning({ id: inviteBundles.id })
      return rows.length
    },
  }
}

// MARK: - Services

export function toWireInviteRecord(r: StoredInviteRecord): WireInviteRecord {
  return {
    inviteId: r.inviteId,
    keyId: toB64(r.keyId),
    record: toB64(r.record),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    bundled: r.bundled.map((b) => ({ groupId: toB64(b.groupId), epoch: b.epoch })),
  }
}

/** GET /guilds/:id/invite-records. The route checks that the caller is a member. */
export async function listInviteRecords(store: InviteHistoryStore, guildId: string, now: Date): Promise<WireInviteRecord[]> {
  return (await store.activeRecords(guildId, now)).map(toWireInviteRecord)
}

/**
 * The scope of the stored record (§12.11.4): the `public_set` group, or the
 * `channel` group of a channel that the record names. Members also check that
 * @everyone still views the channel. Takusen verified the record at POST.
 */
function inRecordScope(group: { kind: string; channelId: string | null }, record: Uint8Array, ds: Pick<DsModule, 'parseInviteRecord'>): boolean {
  if (group.kind === 'public_set') return true
  return group.kind === 'channel' && group.channelId !== null && ds.parseInviteRecord(record).channelIds.includes(group.channelId)
}

/**
 * POST /invite-records/:inviteId/bundles. The caller reads the group, the group
 * belongs to the guild of the invite and to the scope of its record, and the
 * invite is active with a record. The invite row stays locked until the caps
 * are applied: a revoke cannot leave a bundle behind, and two posts cannot pass
 * the caps together. The share of one sender user applies first, then the cap
 * of the invite.
 */
export async function postInviteBundle(
  store: InviteHistoryStore,
  mls: MlsRepo,
  ds: Pick<DsModule, 'parseInviteRecord'>,
  caller: { userId: string; device: { id: string } },
  inviteId: string,
  body: { groupId: Uint8Array; epoch: number; blob: Uint8Array },
  now: Date,
): Promise<void> {
  if (body.blob.length > INVITE_BUNDLE_MAX_BYTES) throw new ApiError('ValidationError', 400, 'the bundle is above 640 KiB')
  const { group } = await requireReadableGroup(mls, body.groupId, caller.userId)
  if (group.epoch === null || body.epoch > group.epoch) throw new ApiError('ValidationError', 400, 'the epoch is ahead of the group')
  await store.transaction(async (s) => {
    const invite = await s.getInvite(inviteId, true)
    if (!invite || invite.guildId !== group.guildId || invite.record === null || !isInviteActive(invite, now)) throw unknownInvite()
    // Any reader of a private channel could else post wrong keys for its group (§12.12).
    if (!inRecordScope(group, invite.record, ds)) throw new ApiError('ValidationError', 400, 'the group is not in the scope of the invite')
    await s.insertBundle({
      inviteId,
      groupId: body.groupId,
      epoch: body.epoch,
      senderDevice: caller.device.id,
      senderUser: caller.userId,
      blob: body.blob,
      size: body.blob.length,
    })
    // The creation bundles can be large. The record names the creator, and Takusen checked that it is `created_by`.
    if (caller.userId !== invite.createdBy) await s.trimBundles(inviteId, INVITE_BUNDLES_SENDER_MAX_BYTES, caller.userId)
    await s.trimBundles(inviteId, INVITE_BUNDLES_MAX_BYTES)
  })
}

/**
 * GET /invites/:code/bundles. Only for a member who joined with this invite,
 * during INVITE_BUNDLE_FETCH_WINDOW_MS after the join. Every other case is
 * 404 UnknownInvite. `invite`: the row of the code, or null.
 */
export async function inviteBundlesOf(store: InviteHistoryStore, invite: InviteRow | null, userId: string, now: Date): Promise<WireInviteBundles> {
  if (!invite || invite.revoked || invite.record === null) throw unknownInvite()
  const join = await store.memberJoin(invite.guildId, userId)
  if (!join || join.inviteId !== invite.id || now.getTime() - join.joinedAt.getTime() > INVITE_BUNDLE_FETCH_WINDOW_MS) throw unknownInvite()
  return {
    inviteId: invite.id,
    record: toB64(invite.record),
    bundles: (await store.listBundles(invite.id)).map((b) => ({
      groupId: toB64(b.groupId),
      epoch: b.epoch,
      blob: toB64(b.blob),
      senderDevice: b.senderDevice,
    })),
  }
}

/**
 * The daily DS sweep (grpc/mls-scheduler.ts): the bundles of revoked invites,
 * and of invites that expired or were exhausted more than
 * INVITE_BUNDLE_FETCH_WINDOW_MS ago. Returns the count.
 */
export async function sweepInviteBundles(store: Pick<InviteHistoryStore, 'deleteStaleBundles'>, now: Date): Promise<number> {
  return store.deleteStaleBundles(new Date(now.getTime() - INVITE_BUNDLE_FETCH_WINDOW_MS))
}
