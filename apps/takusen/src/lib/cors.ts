/**
 * CORS for `/api/*`. Edge-safe: `src/middleware.ts` uses it for every API
 * route. The routes that middleware skips (`MIDDLEWARE_SKIPPED_ROUTES`) use it
 * directly: `withCors` for the handlers and `preflight` for OPTIONS.
 *
 * A disallowed origin gets no Allow-Origin header, so the browser fails the
 * request closed. Every response varies by Origin so no cache mixes them.
 *
 * The E2EE routes read `X-Hachiman-Device` and `X-Hachiman-Signed-Action`, and
 * rate limits send `Retry-After` (docs/gateway-protocol.md §4, §12.12).
 */
import { NextResponse } from 'next/server'

import { isAllowedOrigin } from '@/lib/allowed-origins'

export const CORS_ALLOW_HEADERS = 'Authorization, Content-Type, X-Requested-With, X-Hachiman-Device, X-Hachiman-Signed-Action'
export const CORS_EXPOSE_HEADERS = 'Retry-After'

export function applyCors(res: Response, requestOrigin: string | null): void {
  if (requestOrigin && isAllowedOrigin(requestOrigin)) {
    res.headers.set('Access-Control-Allow-Origin', requestOrigin)
    res.headers.set('Access-Control-Allow-Credentials', 'true')
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
    res.headers.set('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS)
    res.headers.set('Access-Control-Max-Age', '600')
  }
  res.headers.set('Vary', 'Origin')
}

export function preflight(requestOrigin: string | null): NextResponse {
  const res = new NextResponse(null, { status: 204 })
  applyCors(res, requestOrigin)
  return res
}

/**
 * The routes that src/middleware.ts does not match, because Next buffers the
 * request body for middleware and truncates it at 10 MB. Each one applies CORS
 * itself. Keep in step with the `matcher` there (it must be a literal).
 */
export const MIDDLEWARE_SKIPPED_ROUTES = ['/api/v1/uploads', '/api/v1/mls/groups/:groupId/commits'] as const

/** Adds the CORS headers of the request origin to the response of `handler`. */
export function withCors<R extends Request, C>(handler: (req: R, ctx: C) => Promise<Response>): (req: R, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    const res = await handler(req, ctx)
    applyCors(res, req.headers.get('origin'))
    return res
  }
}

/** The OPTIONS handler of a route that middleware skips. */
export function corsPreflight(req: Request): NextResponse {
  return preflight(req.headers.get('origin'))
}
