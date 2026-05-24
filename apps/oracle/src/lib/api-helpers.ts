/**
 * Shared API route helpers — error -> NextResponse mapping.
 */
import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

import { ForbiddenError, UnauthorizedError } from '@/lib/auth-helpers'
import {
  InviteExhaustedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
} from '@/lib/invite-signing'
import { ServerNotFoundError, SlugTakenError } from '@/lib/servers'

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (err instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: 'ValidationError', issues: err.flatten() },
      { status: 400 },
    )
  }
  if (err instanceof SlugTakenError) {
    return NextResponse.json({ error: 'SlugTaken' }, { status: 409 })
  }
  if (err instanceof ServerNotFoundError) {
    return NextResponse.json({ error: 'NotFound' }, { status: 404 })
  }
  if (err instanceof InviteNotFoundError) {
    return NextResponse.json({ error: 'InviteNotFound' }, { status: 404 })
  }
  if (err instanceof InviteExpiredError) {
    return NextResponse.json({ error: 'InviteExpired' }, { status: 410 })
  }
  if (err instanceof InviteRevokedError) {
    return NextResponse.json({ error: 'InviteRevoked' }, { status: 410 })
  }
  if (err instanceof InviteExhaustedError) {
    return NextResponse.json({ error: 'InviteExhausted' }, { status: 429 })
  }

  // eslint-disable-next-line no-console
  console.error('Unhandled API error:', err)
  return NextResponse.json({ error: 'InternalServerError' }, { status: 500 })
}
