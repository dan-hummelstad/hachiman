'use server'

import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { AuthError } from 'next-auth'
import { z } from 'zod'

import { signIn } from '@/auth'
import { db } from '@/db/client'
import { passwordResetTokens, users } from '@/db/schema'
import {
  RESET_TOKEN_TTL_MS,
  buildResetUrl,
  completePasswordReset,
  drizzlePasswordResetPorts,
  generateResetToken,
  hashResetToken,
  resetTokenEmail,
} from '@/lib/password-reset'
import { PASSWORD_MIN_LENGTH, passwordProblem } from '@/lib/password-strength'

import { safeNext } from './handoff'

const BCRYPT_COST = 12

export interface FormActionResult {
  ok: boolean
  error?: string
  // For requestPasswordResetAction: hide success/failure distinction from the
  // user (anti-enumeration) but still let the page show a confirmation message.
  message?: string
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const emailField = z
  .string()
  .min(1, 'Email is required')
  .email('Enter a valid email address')
  .max(254, 'Email is too long')
  .transform((value) => value.trim().toLowerCase())

const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(128, 'Password is too long')

const signupSchema = z.object({
  displayName: z
    .string()
    .min(1, 'Display name is required')
    .max(64, 'Display name is too long')
    .transform((value) => value.trim()),
  email: emailField,
  password: passwordField,
})

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Password is required'),
})

const requestResetSchema = z.object({
  email: emailField,
})

const resetSchema = z
  .object({
    token: z.string().min(1, 'Reset token is missing'),
    password: passwordField,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isRedirectError(error: unknown): boolean {
  // next/navigation's `redirect()` throws an internal error tagged
  // NEXT_REDIRECT. Server actions need to re-throw it so Next can intercept.
  if (!error || typeof error !== 'object') return false
  const message = (error as { message?: string }).message
  const digest = (error as { digest?: string }).digest
  return (
    typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')
  ) || message === 'NEXT_REDIRECT'
}

function safeNextPath(value: FormDataEntryValue | null): string {
  return safeNext(value) ?? '/dashboard'
}

// ---------------------------------------------------------------------------
// signupAction — create a new user + immediately sign them in, then redirect
// to `next` (or /dashboard).
// ---------------------------------------------------------------------------
export async function signupAction(
  _prev: FormActionResult | undefined,
  formData: FormData,
): Promise<FormActionResult> {
  const parsed = signupSchema.safeParse({
    displayName: formData.get('displayName'),
    email: formData.get('email'),
    password: formData.get('password'),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue?.message ?? 'Invalid input' }
  }

  const { displayName, email, password } = parsed.data
  const weak = passwordProblem(password, email)
  if (weak) return { ok: false, error: weak }
  const next = safeNextPath(formData.get('next'))

  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  })
  if (existing) {
    return { ok: false, error: 'An account with that email already exists' }
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST)
  await db.insert(users).values({
    email,
    displayName,
    name: displayName,
    passwordHash,
    passwordChangedAt: new Date(),
  })

  try {
    await signIn('credentials', {
      email,
      password,
      redirect: true,
      redirectTo: next,
    })
  } catch (error) {
    if (isRedirectError(error)) throw error
    if (error instanceof AuthError) {
      return {
        ok: false,
        error: 'Account created, but sign-in failed. Try logging in.',
      }
    }
    throw error
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// loginAction — sign in with credentials, then redirect to `next` (or
// /dashboard). The `redirect: true` mode lets Auth.js perform the redirect
// itself by throwing a NEXT_REDIRECT — we re-throw to preserve that.
// ---------------------------------------------------------------------------
export async function loginAction(
  _prev: FormActionResult | undefined,
  formData: FormData,
): Promise<FormActionResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue?.message ?? 'Invalid input' }
  }

  const next = safeNextPath(formData.get('next'))

  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: true,
      redirectTo: next,
    })
  } catch (error) {
    if (isRedirectError(error)) throw error
    if (error instanceof AuthError) {
      return { ok: false, error: 'Invalid email or password' }
    }
    throw error
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// requestPasswordResetAction — insert a reset token row + log the link to
// the server console. Always returns a generic confirmation to avoid leaking
// which addresses have accounts.
// ---------------------------------------------------------------------------
export async function requestPasswordResetAction(
  _prev: FormActionResult | undefined,
  formData: FormData,
): Promise<FormActionResult> {
  const parsed = requestResetSchema.safeParse({
    email: formData.get('email'),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue?.message ?? 'Invalid email' }
  }

  const { email } = parsed.data
  const next = safeNext(formData.get('next'))
  const message =
    'If an account exists for that address, a password reset link has been sent.'

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  })
  if (!user) {
    // Silently succeed — anti-enumeration.
    return { ok: true, message }
  }

  const token = generateResetToken()
  const tokenHash = hashResetToken(token)
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS)

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  })

  const baseUrl = process.env.NEXTAUTH_URL ?? 'http://localhost:3000'
  const resetUrl = buildResetUrl(baseUrl, token, next)
  // No email transport wired up yet — log to the server console so a dev can
  // grab the URL during local testing.
  console.info(
    `[password-reset] ${email} -> ${resetUrl} (expires ${expiresAt.toISOString()})`,
  )

  return { ok: true, message }
}

// ---------------------------------------------------------------------------
// resetPasswordAction — consume the token, set a new password, and revoke
// every session and every device of the user (§12.4 "Password reset").
// ---------------------------------------------------------------------------
export async function resetPasswordAction(
  _prev: FormActionResult | undefined,
  formData: FormData,
): Promise<FormActionResult> {
  const parsed = resetSchema.safeParse({
    token: formData.get('token'),
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue?.message ?? 'Invalid input' }
  }

  const { token, password } = parsed.data
  const tokenHash = hashResetToken(token)
  const email = await resetTokenEmail(tokenHash, new Date())
  if (!email) {
    return { ok: false, error: 'This reset link has expired or is invalid' }
  }
  const weak = passwordProblem(password, email)
  if (weak) return { ok: false, error: weak }
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST)
  const userId = await completePasswordReset(drizzlePasswordResetPorts, {
    tokenHash,
    passwordHash,
    now: new Date(),
  })
  if (!userId) {
    return { ok: false, error: 'This reset link has expired or is invalid' }
  }

  return {
    ok: true,
    message: 'Every device is signed out. Sign in with your new password.',
  }
}
