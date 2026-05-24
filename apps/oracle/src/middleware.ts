/**
 * Edge middleware: CORS for the public-facing `/api/*` surface.
 *
 * Why middleware (rather than per-route OPTIONS handlers or
 * `next.config.ts` headers())?
 *   - We need to short-circuit OPTIONS preflights before they hit the
 *     route handler. `next.config.ts` only sets response headers — it
 *     doesn't reply to preflights.
 *   - All `/api/*` routes (Auth.js, OIDC catch-all, /api/me, /api/invites)
 *     should share one CORS policy. Centralising it here avoids per-route
 *     drift.
 *
 * Electron renderer note: when `nodeIntegration: true` + `contextIsolation: false`
 * (our dev config), Chromium treats fetch() as a privileged origin and the
 * CORS preflight is generally bypassed. CORS here is for the browser host
 * (Vite dev server on :5173/:5174) plus any production deployment using a
 * separately-hosted Hachiman web shell.
 *
 * Allowed origins are read from `TAKUSEN_ALLOWED_ORIGINS` (comma-separated).
 * In dev the default list covers Vite's standard dev ports.
 */
import { NextResponse, type NextRequest } from 'next/server'

const DEFAULT_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]

function getAllowedOrigins(): string[] {
  const raw = process.env.TAKUSEN_ALLOWED_ORIGINS
  if (!raw) return DEFAULT_DEV_ORIGINS
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function pickOrigin(requestOrigin: string | null): string | null {
  if (!requestOrigin) return null
  const allowed = getAllowedOrigins()
  return allowed.includes(requestOrigin) ? requestOrigin : null
}

function applyCorsHeaders(res: NextResponse, origin: string): void {
  res.headers.set('Access-Control-Allow-Origin', origin)
  res.headers.set('Vary', 'Origin')
  res.headers.set('Access-Control-Allow-Credentials', 'true')
  res.headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  )
  res.headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Requested-With',
  )
  res.headers.set('Access-Control-Max-Age', '600')
}

export function middleware(req: NextRequest): NextResponse {
  const origin = pickOrigin(req.headers.get('origin'))

  // Preflight: short-circuit with 204 + headers. If the origin isn't in the
  // allowlist we still return 204 but WITHOUT the Allow-Origin header — the
  // browser's preflight check then fails closed, which is what we want.
  if (req.method === 'OPTIONS') {
    const res = new NextResponse(null, { status: 204 })
    if (origin) applyCorsHeaders(res, origin)
    return res
  }

  const res = NextResponse.next()
  if (origin) applyCorsHeaders(res, origin)
  return res
}

export const config = {
  // Only run for the API surface. Page routes don't need CORS.
  matcher: ['/api/:path*'],
}
