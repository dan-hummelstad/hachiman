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
import { ServerTokenServerNotFoundError } from '@/lib/server-tokens'
import {
  GrumbleManagementError,
  GrumbleManagementNotConfiguredError,
} from '@/lib/grumble-management'
import {
  ManagedGatewayNotConfiguredError,
  ServerNotFoundError,
  SlugTakenError,
} from '@/lib/servers'
import { UserServerNotFoundError } from '@/lib/user-servers'
import {
  InvalidVServerTransitionError,
  VirtualServerNotFoundError,
} from '@/lib/virtual-servers'

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
  if (err instanceof ManagedGatewayNotConfiguredError) {
    // 503: the server is up but a hosting prerequisite (the managed gateway
    // host env var) isn't configured. Surfacing the descriptive message
    // means the form can show the operator exactly what to set.
    return NextResponse.json(
      { error: 'ManagedGatewayNotConfigured', message: err.message },
      { status: 503 },
    )
  }
  if (err instanceof GrumbleManagementNotConfiguredError) {
    // Same 503 class as ManagedGatewayNotConfigured but a different env
    // var (the gRPC endpoint, not the user-facing hostname). Pass the
    // message through so the dashboard can name the env var verbatim.
    return NextResponse.json(
      { error: 'GrumbleManagementNotConfigured', message: err.message },
      { status: 503 },
    )
  }
  if (err instanceof GrumbleManagementError) {
    // 502: we were able to reach the upstream but it failed (network down,
    // gRPC error, transport-level issue). Distinct from 503-not-configured
    // so the dashboard can show a different recovery hint.
    return NextResponse.json(
      { error: 'GrumbleManagementUnavailable', message: err.message },
      { status: 502 },
    )
  }
  if (err instanceof ServerNotFoundError) {
    return NextResponse.json({ error: 'NotFound' }, { status: 404 })
  }
  if (err instanceof UserServerNotFoundError) {
    return NextResponse.json({ error: 'NotFound' }, { status: 404 })
  }
  if (err instanceof ServerTokenServerNotFoundError) {
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
  if (err instanceof VirtualServerNotFoundError) {
    return NextResponse.json({ error: 'NotFound', message: err.message }, { status: 404 })
  }
  if (err instanceof InvalidVServerTransitionError) {
    // 409: the row exists but its current status disallows the requested
    // operation (typically place-now on a vServer that isn't `inactive`).
    return NextResponse.json(
      { error: 'InvalidVServerTransition', message: err.message },
      { status: 409 },
    )
  }


  console.error('Unhandled API error:', err)
  return NextResponse.json({ error: 'InternalServerError' }, { status: 500 })
}
