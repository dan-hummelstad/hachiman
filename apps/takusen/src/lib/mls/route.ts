/**
 * The handler wrapper of the §12.12 routes: auth, the device header, error
 * mapping, and the outbox flush after the transaction commits.
 */
import { NextResponse, type NextRequest } from 'next/server'
import type { ZodType, ZodTypeDef } from 'zod'

import { errorResponse, isMe, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ApiError } from '@/lib/errors'

import { dsDeps, type DsDeps } from './context'
import { requireDevice } from './device-auth'
import { Outbox } from './events'
import { flushWithProposals } from './membership'
import { drizzleMlsRepo } from './repo.drizzle'
import type { DeviceRow, MlsRepo } from './repo'

export interface DsRouteContext<P> {
  req: NextRequest
  params: P
  userId: string
  /** The X-Hachiman-Device row. Null when the route needs no device. */
  device: DeviceRow | null
  repo: MlsRepo
  /** Collects events. The wrapper publishes them after the handler returns. */
  out: Outbox
  deps: () => Promise<DsDeps>
}

type Handler<P> = (ctx: DsRouteContext<P>) => Promise<Response>

/**
 * `device`: 'none' (auth only), 'pending' (a pending device is fine: device
 * and link routes), or 'active' (every other D route).
 */
export function dsRoute<P = Record<string, never>>(device: 'none' | 'pending' | 'active', handler: Handler<P>) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      const session = await requireUser()
      const userId = session.user.id
      const row = device === 'none' ? null : await requireDevice(req, userId, { allowPending: device === 'pending' })
      const repo = drizzleMlsRepo()
      const out = new Outbox()
      const res = await handler({ req, params: await ctx.params, userId, device: row, repo, out, deps: dsDeps })
      await flushWithProposals(repo, out)
      return res
    } catch (err) {
      return errorResponse(err)
    }
  }
}

export function requireRouteDevice(ctx: { device: DeviceRow | null }): DeviceRow {
  if (!ctx.device) throw new ApiError('DeviceRequired', 400, 'X-Hachiman-Device is required')
  return ctx.device
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status })
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 })
}

export async function body<T>(req: NextRequest, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  return parseBody(req, schema)
}

/** `@me` → the caller's id. */
export function meOr(id: string, self: string): string {
  return isMe(id) ? self : id
}

/** A non-negative integer query parameter with a default and a cap. */
export function intQuery(params: URLSearchParams, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = params.get(name)
  if (v === null || v === '') return fallback
  if (!/^\d+$/.test(v)) throw new ApiError('ValidationError', 400, `${name} must be a non-negative integer`)
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n > max) throw new ApiError('ValidationError', 400, `${name} must be at most ${max}`)
  return n
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function uuidParam(v: string, what: string, code = 'NotFound'): string {
  const id = v.toLowerCase()
  if (!UUID_RE.test(id)) throw new ApiError(code, 404, `unknown ${what}`)
  return id
}
