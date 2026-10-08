'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { RENEW_AUTH_TIME, unstable_update } from '@/auth'
import { revokeAppAccess, revokeOwnGrants } from '@/lib/account'
import { requireUser } from '@/lib/auth-helpers'
import { revokeUserSessionsBefore } from '@/lib/session-revocation'

export interface SessionActionResult {
  ok: boolean
  error?: string
  /** The Hachiman sessions (OIDC grants) that ended. */
  ended?: number
}

const idSchema = z.string().min(1).max(200)

/** Signs out one Hachiman session (an OIDC grant of the caller). The device and its keys stay. */
export async function signOutHachimanSessionAction(grantId: string): Promise<SessionActionResult> {
  const session = await requireUser()
  const parsed = idSchema.safeParse(grantId)
  if (!parsed.success) return { ok: false, error: 'Unknown session' }
  const ended = await revokeOwnGrants(session.user.id, [parsed.data])
  revalidatePath('/dashboard')
  return ended === 0 ? { ok: false, error: 'This session has already ended', ended } : { ok: true, ended }
}

/**
 * Ends every other session of the caller: all Hachiman sessions and every
 * other dashboard cookie. This cookie gets a new `authTime` first, so the
 * cut-off (a time from before it) spares it. Devices and keys stay.
 */
export async function signOutEverywhereElseAction(): Promise<SessionActionResult> {
  const session = await requireUser()
  const since = Date.now()
  await unstable_update(RENEW_AUTH_TIME as Parameters<typeof unstable_update>[0])
  await revokeUserSessionsBefore(session.user.id, since)
  // No revalidatePath: the render in this request reads the old, now revoked cookie
  // (see dashboard/page.tsx). The client refreshes once the new cookie is set.
  return { ok: true }
}

/** Revokes an app's access: every live grant of the caller for that OIDC client. */
export async function revokeAppAccessAction(clientId: string): Promise<SessionActionResult> {
  const session = await requireUser()
  const parsed = idSchema.safeParse(clientId)
  if (!parsed.success) return { ok: false, error: 'Unknown app' }
  const ended = await revokeAppAccess(session.user.id, parsed.data)
  revalidatePath('/dashboard')
  return { ok: true, ended }
}
