/**
 * Reads for the account overview and the dashboard shell: the account
 * summary, the Hachiman sessions (live OIDC grants) and the apps with access.
 * The pure parts are in account-sessions.ts.
 */
import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { cache } from 'react'

import { db } from '@/db/client'
import { devices, guildMembers, oidcAdapterPayloads, users } from '@/db/schema'
import {
  groupAppAccess,
  toHachimanSessions,
  type AppAccess,
  type DeviceRow,
  type GrantRow,
  type HachimanSession,
} from '@/lib/account-sessions'
import { redis } from '@/lib/events'
import { fileUrl } from '@/lib/file-url'
import { redisDeviceBindings } from '@/lib/mls/device-binding'
import { deleteGrantOidcRows, liveGrantOf } from '@/lib/session-revocation'

/** `signed_in`: a live grant. `signed_out`: no live grant, but the app registered a device once. `never`: neither. */
export type HachimanState = 'signed_in' | 'signed_out' | 'never'

export interface AccountSummary {
  id: string
  displayName: string
  email: string
  /** `/api/v1/files/...`, or null. */
  avatarUrl: string | null
  role: 'user' | 'admin'
  createdAt: string
  /** No flow sets it yet (no email transport), so it is false unless set in the DB. */
  emailVerified: boolean
  /** Null for accounts from before the column (migration 0007). */
  passwordChangedAt: string | null
  guildCount: number
  hachiman: HachimanState
}

/** Null when the user does not exist. Cached per request: the layout and the page both read it. */
export const getAccountSummary = cache(async (userId: string): Promise<AccountSummary | null> => {
  const [[row], [guildsRow], [grantsRow], [devicesRow]] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db.select({ n: count() }).from(guildMembers).where(eq(guildMembers.userId, userId)),
    db.select({ n: count() }).from(oidcAdapterPayloads).where(liveGrantOf(userId)),
    db.select({ n: count() }).from(devices).where(eq(devices.userId, userId)),
  ])
  if (!row) return null
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    avatarUrl: fileUrl(row.image),
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    emailVerified: row.emailVerified !== null || row.emailVerifiedAt !== null,
    passwordChangedAt: row.passwordChangedAt ? row.passwordChangedAt.toISOString() : null,
    guildCount: guildsRow?.n ?? 0,
    hachiman: (grantsRow?.n ?? 0) > 0 ? 'signed_in' : (devicesRow?.n ?? 0) > 0 ? 'signed_out' : 'never',
  }
})

async function liveGrants(userId: string): Promise<GrantRow[]> {
  return db
    .select({
      id: oidcAdapterPayloads.id,
      payload: oidcAdapterPayloads.payload,
      expiresAt: oidcAdapterPayloads.expiresAt,
    })
    .from(oidcAdapterPayloads)
    .where(liveGrantOf(userId))
}

/** The user's Hachiman sign-ins, newest activity first. */
export async function listHachimanSessions(userId: string): Promise<HachimanSession[]> {
  const grants = await liveGrants(userId)
  if (grants.length === 0) return []
  const ids = grants.map((g) => g.id)
  const [activity, bound] = await Promise.all([
    db
      .select({
        grantId: oidcAdapterPayloads.grantId,
        iat: sql<string>`max((${oidcAdapterPayloads.payload}->>'iat')::bigint)::text`,
      })
      .from(oidcAdapterPayloads)
      .where(
        and(
          inArray(oidcAdapterPayloads.grantId, ids),
          inArray(oidcAdapterPayloads.model, ['AccessToken', 'RefreshToken']),
        ),
      )
      .groupBy(oidcAdapterPayloads.grantId),
    redisDeviceBindings(redis()).devicesOf(ids),
  ])
  const deviceIds = [...new Set(bound.filter((d): d is string => d !== null))]
  const rows = deviceIds.length
    ? await db
        .select({
          id: devices.id,
          name: devices.name,
          platform: devices.platform,
          clientVersion: devices.clientVersion,
          status: devices.status,
          lastSeenAt: devices.lastSeenAt,
        })
        .from(devices)
        .where(and(inArray(devices.id, deviceIds), eq(devices.userId, userId)))
    : []
  const byId = new Map<string, DeviceRow>(rows.map((d) => [d.id, d]))
  const deviceOf = new Map<string, DeviceRow>()
  ids.forEach((g, i) => {
    const d = bound[i] ? byId.get(bound[i]) : undefined
    if (d) deviceOf.set(g, d)
  })
  const tokenIat = new Map(activity.flatMap((a) => (a.grantId ? [[a.grantId, Number(a.iat)] as const] : [])))
  return toHachimanSessions(grants, tokenIat, deviceOf)
}

export async function listAppAccess(userId: string): Promise<AppAccess[]> {
  return groupAppAccess(await liveGrants(userId))
}

/** Signs out the user's grants among `grantIds` (others are ignored). Returns the grants ended. */
export async function revokeOwnGrants(userId: string, grantIds: readonly string[]): Promise<number> {
  if (grantIds.length === 0) return 0
  const own = await db
    .select({ id: oidcAdapterPayloads.id })
    .from(oidcAdapterPayloads)
    .where(and(liveGrantOf(userId), inArray(oidcAdapterPayloads.id, [...grantIds])))
  await deleteGrantOidcRows(own.map((g) => g.id))
  return own.length
}

/** Ends every grant of the user for the client. Returns the grants ended. */
export async function revokeAppAccess(userId: string, clientId: string): Promise<number> {
  const own = await db
    .select({ id: oidcAdapterPayloads.id })
    .from(oidcAdapterPayloads)
    .where(and(liveGrantOf(userId), sql`${oidcAdapterPayloads.payload}->>'clientId' = ${clientId}`))
  await deleteGrantOidcRows(own.map((g) => g.id))
  return own.length
}
