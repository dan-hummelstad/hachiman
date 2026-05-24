/**
 * Server-side auth helpers.
 *
 * Usage:
 *   import { requireUser } from '@/lib/auth-helpers'
 *   const session = await requireUser()       // throws if unauthenticated
 *   const adminSession = await requireUser({ role: 'admin' })
 */
import { auth } from '@/auth'

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export interface RequireUserOptions {
  role?: 'user' | 'admin'
}

export async function requireUser(options: RequireUserOptions = {}) {
  const session = await auth()
  if (!session?.user?.id) {
    throw new UnauthorizedError()
  }
  if (options.role === 'admin' && session.user.role !== 'admin') {
    throw new ForbiddenError()
  }
  return session
}

export async function getOptionalUser() {
  const session = await auth()
  return session?.user?.id ? session : null
}
