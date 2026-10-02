'use server'

import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { signIn } from '@/auth'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { requireUser } from '@/lib/auth-helpers'
import { completePasswordChange } from '@/lib/password-reset'
import { revokeUserSessions } from '@/lib/session-revocation'

const BCRYPT_COST = 12

export interface AccountActionResult {
  ok: boolean
  error?: string
  message?: string
}

const displayNameSchema = z.object({
  displayName: z
    .string()
    .min(1, 'Display name is required')
    .max(64, 'Display name is too long')
    .transform((value) => value.trim()),
})

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'New password must be at least 8 characters')
      .max(128, 'New password is too long'),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'New passwords do not match',
  })

export async function updateDisplayNameAction(
  _prev: AccountActionResult | undefined,
  formData: FormData,
): Promise<AccountActionResult> {
  const session = await requireUser()
  const parsed = displayNameSchema.safeParse({
    displayName: formData.get('displayName'),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue?.message ?? 'Invalid input' }
  }
  const { displayName } = parsed.data
  await db
    .update(users)
    .set({ displayName, name: displayName, updatedAt: new Date() })
    .where(eq(users.id, session.user.id))
  revalidatePath('/account')
  return { ok: true, message: 'Display name updated' }
}

export async function changePasswordAction(
  _prev: AccountActionResult | undefined,
  formData: FormData,
): Promise<AccountActionResult> {
  const session = await requireUser()
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
    confirmPassword: formData.get('confirmPassword'),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue?.message ?? 'Invalid input' }
  }

  const row = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { passwordHash: true, email: true },
  })
  if (!row?.passwordHash) {
    return {
      ok: false,
      error: 'This account does not have a password set',
    }
  }

  const ok = await bcrypt.compare(parsed.data.currentPassword, row.passwordHash)
  if (!ok) {
    return { ok: false, error: 'Current password is incorrect' }
  }

  // Other sessions are revoked. The devices stay (§12.18): a password change
  // is not a reset. This browser gets a new cookie after the cut-off.
  const newHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST)
  const newPassword = parsed.data.newPassword
  await completePasswordChange(
    {
      async setPassword(userId, passwordHash) {
        await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId))
      },
      async revokeSessions(userId) {
        await revokeUserSessions(userId)
      },
      async keepCurrentSession() {
        await signIn('credentials', { email: row.email, password: newPassword, redirect: false })
      },
    },
    { userId: session.user.id, passwordHash: newHash },
  )

  return { ok: true, message: 'Password updated. Other sessions are signed out.' }
}
