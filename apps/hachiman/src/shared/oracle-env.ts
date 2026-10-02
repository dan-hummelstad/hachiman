/**
 * Takusen issuer, client_id and endpoint bases, from the host app's Vite env:
 *   VITE_TAKUSEN_OIDC_ISSUER      (default: http://localhost:3000/api/oidc)
 *   VITE_TAKUSEN_OIDC_CLIENT_ID   (default: hachiman-client)
 *   VITE_TAKUSEN_API_BASE         (default: <issuer-origin>/api, NOT <issuer>/api —
 *                                  the issuer URL includes panva's mount path)
 *   VITE_HACHIMAN_GATEWAY_URL     (default: ws://localhost:8080/gateway)
 *
 * Pure and import-free so the Electron main process can derive its CSP from the
 * same values the renderer connects to (apps/hachiman-electron/src/main/csp.ts).
 * The package exports it alone as `@hachiman/hachiman/oracle-env`.
 */
export interface OracleEnv {
  issuer: string
  /** `issuer` without panva's mount path; Oracle's own pages (bridge, invites) live here. */
  issuerOrigin: string
  clientId: string
  apiBase: string
  gatewayUrl: string
}

export function resolveOracleEnv(env: Readonly<Record<string, unknown>>): OracleEnv {
  const str = (k: string): string | undefined => {
    const v = env[k]
    return typeof v === 'string' ? v : undefined
  }
  const issuer = str('VITE_TAKUSEN_OIDC_ISSUER') ?? 'http://localhost:3000/api/oidc'
  const clientId = str('VITE_TAKUSEN_OIDC_CLIENT_ID') ?? 'hachiman-client'
  // /api/me/* and /api/invites/* live at the issuer's *origin*, not under the
  // panva mount path. Derive from the origin so the issuer can carry the
  // /api/oidc suffix without polluting the rest-API base.
  const issuerOrigin = new URL(issuer).origin
  const apiBase = str('VITE_TAKUSEN_API_BASE') ?? `${issuerOrigin}/api`
  const gatewayUrl = str('VITE_HACHIMAN_GATEWAY_URL') ?? 'ws://localhost:8080/gateway'
  return { issuer, issuerOrigin, clientId, apiBase, gatewayUrl }
}
