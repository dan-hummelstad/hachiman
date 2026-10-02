/**
 * CORS for `/api/*`. Edge-safe: `src/middleware.ts` uses it for every API
 * route, and `/api/v1/uploads` (which middleware skips) uses it directly.
 *
 * A disallowed origin gets no Allow-Origin header, so the browser fails the
 * request closed. Every response varies by Origin so no cache mixes them.
 */
import { NextResponse } from 'next/server'

import { isAllowedOrigin } from '@/lib/allowed-origins'

export function applyCors(res: Response, requestOrigin: string | null): void {
  if (requestOrigin && isAllowedOrigin(requestOrigin)) {
    res.headers.set('Access-Control-Allow-Origin', requestOrigin)
    res.headers.set('Access-Control-Allow-Credentials', 'true')
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With')
    res.headers.set('Access-Control-Max-Age', '600')
  }
  res.headers.set('Vary', 'Origin')
}

export function preflight(requestOrigin: string | null): NextResponse {
  const res = new NextResponse(null, { status: 204 })
  applyCors(res, requestOrigin)
  return res
}
