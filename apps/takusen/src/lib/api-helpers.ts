/**
 * Shared API route helpers — error -> NextResponse mapping and the small
 * request-parsing utilities every /api/v1 and /api/admin route uses.
 */
import type { Session } from 'next-auth'
import { NextResponse, type NextRequest } from 'next/server'
import { ZodError, type ZodType, type ZodTypeDef } from 'zod'

import { ForbiddenError, requireAdmin, UnauthorizedError } from '@/lib/auth-helpers'
import {
  ConflictError,
  InviteExhaustedError,
  InviteExpiredError,
  InviteRevokedError,
  InvalidImageError,
  MissingPermissionsError,
  NotFoundError,
  UnknownUploadError,
  UploadTooLargeError,
  ValidationError,
} from '@/lib/errors'

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (err instanceof MissingPermissionsError) {
    return NextResponse.json({ error: 'MissingPermissions', message: err.message }, { status: 403 })
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: 'ValidationError', issues: err.flatten() },
      { status: 400 },
    )
  }
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: 'ValidationError', message: err.message }, { status: 400 })
  }
  if (err instanceof UnknownUploadError) {
    return NextResponse.json({ error: 'UnknownUpload', message: err.message }, { status: 400 })
  }
  if (err instanceof InvalidImageError) {
    return NextResponse.json({ error: 'InvalidImage', message: err.message }, { status: 400 })
  }
  if (err instanceof UploadTooLargeError) {
    return NextResponse.json({ error: 'UploadTooLarge', message: err.message }, { status: 413 })
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: 'NotFound', message: err.message }, { status: 404 })
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: 'Conflict', message: err.message }, { status: 409 })
  }
  if (err instanceof InviteExpiredError) {
    return NextResponse.json({ error: 'InviteExpired' }, { status: 410 })
  }
  if (err instanceof InviteRevokedError) {
    return NextResponse.json({ error: 'InviteRevoked' }, { status: 410 })
  }
  if (err instanceof InviteExhaustedError) {
    return NextResponse.json({ error: 'InviteExhausted' }, { status: 410 })
  }

  console.error('Unhandled API error:', err)
  return NextResponse.json({ error: 'InternalServerError' }, { status: 500 })
}

export interface AdminRequest<P> {
  req: NextRequest
  params: P
  session: Session
}

/** An `/api/admin` handler: requireAdmin first, and thrown errors become responses. */
export function adminRoute<P = Record<string, never>>(
  handler: (ctx: AdminRequest<P>) => Promise<NextResponse>,
): (req: NextRequest, ctx: { params: Promise<P> }) => Promise<NextResponse> {
  return async (req, ctx) => {
    try {
      const session = await requireAdmin()
      return await handler({ req, params: await ctx.params, session })
    } catch (err) {
      return errorResponse(err)
    }
  }
}

/**
 * Parse a JSON body against `schema`. A malformed/empty body becomes `{}` so
 * it fails validation with a clean 400 instead of a 500 from `req.json()`.
 */
export async function parseBody<T>(req: NextRequest, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const body: unknown = await req.json().catch(() => ({}))
  return schema.parse(body)
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 })
}

/**
 * `/users/@me/...` lives under `users/[id]` because a literal `@me` folder
 * would be read by Next as a parallel-route slot. Throws 404 for any other id
 * on a self-only route.
 */
export function isMe(id: string): boolean {
  return id === '@me' || id === '%40me'
}

export function requireMe(id: string): void {
  if (!isMe(id)) throw new NotFoundError()
}
