/**
 * Edge middleware: CORS for the public-facing `/api/*` surface.
 *
 * Why middleware (rather than per-route OPTIONS handlers or
 * `next.config.ts` headers())?
 *   - We need to short-circuit OPTIONS preflights before they hit the
 *     route handler. `next.config.ts` only sets response headers — it
 *     doesn't reply to preflights.
 *   - All `/api/*` routes (Auth.js, OIDC catch-all, /api/v1)
 *     should share one CORS policy. Centralising it here avoids per-route
 *     drift.
 *
 * Allowed origins come from `src/lib/allowed-origins.ts` (shared with panva's
 * per-client CORS): `TAKUSEN_ALLOWED_ORIGINS` (comma-separated) when set, else
 * Vite's dev ports plus the packaged Electron renderer (`hachiman://app`).
 * `Origin: null` is never allowed.
 *
 * This is the ONLY CORS owner for /api/oidc too: it answers every preflight
 * (panva never sees OPTIONS), and the OIDC route drops panva's own CORS
 * headers. panva's `clientBasedCORS` still rejects (400) a disallowed origin
 * on token / userinfo / revocation with the same allowlist.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { applyCors, preflight } from '@/lib/cors'

export function middleware(req: NextRequest): NextResponse {
  const origin = req.headers.get('origin')
  if (req.method === 'OPTIONS') return preflight(origin)
  const res = NextResponse.next()
  applyCors(res, origin)
  return res
}

export const config = {
  // Only the API surface needs CORS. `/api/v1/uploads` is excluded: when
  // middleware runs, Next buffers the whole request body for it and silently
  // truncates it at `middlewareClientMaxBodySize` (10 MB), which would break
  // streaming uploads. That route applies the same CORS itself.
  matcher: ['/api/((?!v1/uploads$).*)'],
}
