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
