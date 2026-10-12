/**
 * The cross-origin allowlist shared by `/api/*` CORS (src/middleware.ts) and
 * panva's per-client CORS (oidc-provider.ts `clientBasedCORS`). Edge-safe: no
 * Node imports, because the middleware runs on the Edge runtime.
 *
 * `null` is never an allowed origin: `file://` pages and sandboxed iframes
 * all send `Origin: null`, so it identifies no caller.
 */

/** Packaged Electron renderer (apps/hachiman-electron/src/main/renderer-protocol.ts). */
export const ELECTRON_RENDERER_ORIGIN = 'hachiman://app'

/** Used when `TAKUSEN_ALLOWED_ORIGINS` is unset: Vite dev ports + the packaged desktop app. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  ELECTRON_RENDERER_ORIGIN,
]

const isRealOrigin = (origin: string | null | undefined): origin is string =>
  !!origin && origin !== 'null'

/** `TAKUSEN_ALLOWED_ORIGINS` (comma-separated) when set, else the defaults. */
export function getAllowedOrigins(
  raw: string | undefined = process.env.TAKUSEN_ALLOWED_ORIGINS,
): string[] {
  if (!raw?.trim()) return [...DEFAULT_ALLOWED_ORIGINS]
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(isRealOrigin)
}

export function isAllowedOrigin(
  origin: string | null | undefined,
  allowed: readonly string[] = getAllowedOrigins(),
): boolean {
  return isRealOrigin(origin) && allowed.includes(origin)
}

export interface AdminFetch {
  method: string
  secFetchSite: string | null
  origin: string | null
  /** Takusen's own origin (`req.nextUrl.origin`). */
  selfOrigin: string
}

/**
 * `/api/admin` takes same-origin requests only (the Takusen dashboard). The
 * Hachiman app origins are often same-site with Takusen, so a SameSite=Lax
 * cookie alone would still let a page there send a simple POST.
 * `Sec-Fetch-Site` decides when present. Without it, a mutation that carries a
 * foreign `Origin` is refused; a request with no `Origin` is a non-browser
 * client, which has no ambient cookie to abuse.
 */
export function isSameOriginFetch({ method, secFetchSite, origin, selfOrigin }: AdminFetch): boolean {
  if (secFetchSite !== null) return secFetchSite === 'same-origin' || secFetchSite === 'none'
  if (method === 'GET' || method === 'HEAD') return true
  return origin === null || origin === selfOrigin
}
