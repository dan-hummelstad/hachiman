import { useOracleStore, type OracleSession, type OracleUser } from '@/stores/oracleStore'
import type { Server } from '@/stores/serverStore'

/**
 * Resolve the Takusen issuer + client_id at runtime. These come from the host
 * app's Vite env. We avoid `import.meta.env` typing issues in the shared lib
 * by reading off `globalThis` — both Electron-vite and the browser Vite shim
 * inject `import.meta.env` and we mirror it onto a known global at boot.
 *
 * Host apps should set:
 *   VITE_TAKUSEN_OIDC_ISSUER      (default: http://localhost:3000/api/oidc)
 *   VITE_TAKUSEN_OIDC_CLIENT_ID   (default: hachiman-client)
 *   VITE_TAKUSEN_API_BASE         (default: <issuer-origin>/api, NOT <issuer>/api —
 *                                  the issuer URL includes panva's mount path)
 *   VITE_HACHIMAN_OIDC_REDIRECT   (per-host: app.hachiman://oauth-callback or http://localhost:5173/oauth/callback)
 */
interface OracleEnv {
  issuer: string
  clientId: string
  apiBase: string
  redirectUri: string
}

function resolveEnv(): OracleEnv {
  // Vite replaces `import.meta.env.VITE_*` at build time in every package
  // that imports this file. Casting keeps the shared lib free of vite/client.d.ts.
  const env = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ??
    {}) as Record<string, string | undefined>
  const issuer = env.VITE_TAKUSEN_OIDC_ISSUER ?? 'http://localhost:3000/api/oidc'
  const clientId = env.VITE_TAKUSEN_OIDC_CLIENT_ID ?? 'hachiman-client'
  // /api/me/* and /api/invites/* live at the issuer's *origin*, not under the
  // panva mount path. Derive from the origin so the issuer can carry the
  // /api/oidc suffix without polluting the rest-API base.
  const issuerOrigin = (() => {
    try {
      return new URL(issuer).origin
    } catch {
      return issuer.replace(/\/api\/oidc\/?$/, '').replace(/\/$/, '')
    }
  })()
  const apiBase = env.VITE_TAKUSEN_API_BASE ?? `${issuerOrigin}/api`
  // Electron renderer detection: the preload script exposes `window.electron`
  // (from @electron-toolkit/preload). In that case the redirect must be a
  // custom-scheme deep link so the OS routes the callback back to the app —
  // but the system browser can't *render* a custom-scheme URL, so we point
  // Oracle at an HTTP bridge page that does the hand-off (showing a splash
  // while triggering `app.hachiman://oauth-callback?...`).
  const isElectron =
    typeof window !== 'undefined' &&
    (window as unknown as { electron?: unknown }).electron !== undefined
  const defaultRedirect =
    env.VITE_HACHIMAN_OIDC_REDIRECT ??
    (isElectron
      ? `${issuerOrigin}/oauth/electron-bridge`
      : typeof window !== 'undefined' && window.location?.origin
        ? `${window.location.origin}/oauth/callback`
        : 'app.hachiman://oauth-callback')
  return { issuer, clientId, apiBase, redirectUri: defaultRedirect }
}

interface DiscoveryDoc {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

interface ServerTokenResponse {
  accessToken: string
  expiresAt: number // unix ms
  scope?: string
}

interface RemoteServerRecord {
  id: string // server-side UUID
  host: string
  port: number
  name: string
  updatedAt: number
  lastUsedAt?: number
  /**
   * The server's voice region code (e.g. "us-east"). Forward-declared for
   * region-aware client code (Team B); NOT yet populated — `/api/me/servers`
   * serializes `user_servers` rows, which have no region column. The eventual
   * source is the Oracle `servers` registry table.
   */
  region?: string | null
}

// --- PKCE helpers (WebCrypto; works in renderer + browser) ---
//
// NOTE: We considered using `oauth4webapi` (declared as a dep) but its
// discovery + token endpoints expect an `AuthorizationServer` object built
// from the discovery doc, and the small surface we exercise (PKCE
// authorize, token, refresh, userinfo) is cleaner with direct fetches —
// especially since we want resilient discovery caching. Keep oauth4webapi
// in deps so a future migration is a one-liner away.

function base64UrlEncode(bytes: Uint8Array): string {
  let str = ''
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomBytes(len: number): Uint8Array {
  const arr = new Uint8Array(len)
  crypto.getRandomValues(arr)
  return arr
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hash)
}

export interface PKCEFlow {
  state: string
  codeVerifier: string
  codeChallenge: string
  nonce: string
  authorizationUrl: string
  redirectUri: string
}

/**
 * Singleton service that owns the Takusen OIDC session and the Oracle REST
 * client surface. The service is intentionally framework-agnostic so it can
 * be invoked from singletons (ServersService) without React.
 */
export class OracleService {
  private discoveryPromise: Promise<DiscoveryDoc> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  /** Configurable for tests; default reads from Vite env. */
  private env: OracleEnv = resolveEnv()

  constructor() {
    this.scheduleRefreshFromStore()
  }

  // ---- Discovery ----------------------------------------------------------

  private async discover(): Promise<DiscoveryDoc> {
    if (!this.discoveryPromise) {
      const url = `${this.env.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
      this.discoveryPromise = fetch(url, { headers: { accept: 'application/json' } }).then(
        async (r) => {
          if (!r.ok) {
            this.discoveryPromise = null
            throw new Error(`OIDC discovery failed: ${r.status} ${r.statusText}`)
          }
          return (await r.json()) as DiscoveryDoc
        }
      )
    }
    return this.discoveryPromise
  }

  // ---- PKCE flow ----------------------------------------------------------

  async beginSignIn(opts?: { redirectUri?: string }): Promise<PKCEFlow> {
    const discovery = await this.discover()
    const state = base64UrlEncode(randomBytes(16))
    const nonce = base64UrlEncode(randomBytes(16))
    const codeVerifier = base64UrlEncode(randomBytes(32))
    const codeChallenge = base64UrlEncode(await sha256(codeVerifier))
    const redirectUri = opts?.redirectUri ?? this.env.redirectUri

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.env.clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })
    const authorizationUrl = `${discovery.authorization_endpoint}?${params.toString()}`

    useOracleStore.getState().setPendingFlow({
      state,
      codeVerifier,
      nonce,
      redirectUri,
      createdAt: Date.now()
    })

    return { state, codeVerifier, codeChallenge, nonce, authorizationUrl, redirectUri }
  }

  /**
   * Complete the PKCE handshake by exchanging the authorization code for tokens.
   * Reads the pending flow from the store, validates state, then exchanges and
   * stores the session.
   */
  async completeSignIn(params: { code: string; state: string }): Promise<OracleSession> {
    const pending = useOracleStore.getState().pendingFlow
    if (!pending) throw new Error('No pending Oracle sign-in flow')
    if (pending.state !== params.state) {
      throw new Error('OIDC state mismatch (possible CSRF)')
    }
    // 24h hard cap on pending flows.
    if (Date.now() - pending.createdAt > 24 * 60 * 60 * 1000) {
      useOracleStore.getState().setPendingFlow(null)
      throw new Error('OIDC sign-in flow expired; restart')
    }

    const discovery = await this.discover()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: pending.redirectUri,
      client_id: this.env.clientId,
      code_verifier: pending.codeVerifier
    })
    const r = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body
    })
    if (!r.ok) {
      throw new Error(`Token exchange failed: ${r.status} ${await r.text()}`)
    }
    const tokenJson = (await r.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      id_token?: string
    }

    const user = await this.fetchUserInfo(tokenJson.access_token, discovery)
    const expiresAt = Date.now() + (tokenJson.expires_in ?? 3600) * 1000
    const session: OracleSession = {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token ?? null,
      expiresAt,
      user
    }

    useOracleStore.getState().setSession(session)
    useOracleStore.getState().setPendingFlow(null)
    this.scheduleRefresh(session)
    return session
  }

  private async fetchUserInfo(accessToken: string, discovery: DiscoveryDoc): Promise<OracleUser> {
    if (!discovery.userinfo_endpoint) {
      // Fallback: synthesize a stub. Agent B's userinfo is required for handle/email
      // — but we keep this resilient so the rest of the app keeps booting.
      return { id: 'unknown', handle: 'unknown', email: 'unknown@takusen.local' }
    }
    const r = await fetch(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
    })
    if (!r.ok) throw new Error(`userinfo failed: ${r.status}`)
    const j = (await r.json()) as { sub: string; handle?: string; email?: string; name?: string }
    return {
      id: j.sub,
      handle: j.handle ?? j.name ?? j.email ?? j.sub,
      email: j.email ?? ''
    }
  }

  // ---- Refresh -------------------------------------------------------------

  private scheduleRefreshFromStore(): void {
    const session = useOracleStore.getState().session
    if (session) this.scheduleRefresh(session)
  }

  private scheduleRefresh(session: OracleSession): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (!session.refreshToken) return
    const fiveMinutes = 5 * 60 * 1000
    const delay = Math.max(0, session.expiresAt - Date.now() - fiveMinutes)
    this.refreshTimer = setTimeout(() => {
      void this.refresh().catch((e) => console.error('[oracle] refresh failed', e))
    }, delay)
  }

  async refresh(): Promise<OracleSession | null> {
    const session = useOracleStore.getState().session
    if (!session?.refreshToken) return null
    const discovery = await this.discover()
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: this.env.clientId
    })
    const r = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!r.ok) {
      // 4xx → invalid refresh, sign out. 5xx → keep the session, retry later.
      if (r.status >= 400 && r.status < 500) {
        this.signOut()
      }
      return null
    }
    const j = (await r.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }
    const refreshed: OracleSession = {
      ...session,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000
    }
    useOracleStore.getState().setSession(refreshed)
    this.scheduleRefresh(refreshed)
    return refreshed
  }

  signOut(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    useOracleStore.getState().clearSession()
  }

  // ---- REST: per-server token mint ----------------------------------------

  /**
   * POST /api/me/server-tokens { serverId } → { accessToken, expiresAt, scope }
   * Returns undefined on failure so callers can fall back to anonymous connect.
   */
  async mintServerToken(serverId: string): Promise<string | undefined> {
    const session = useOracleStore.getState().session
    if (!session) return undefined
    try {
      const r = await this.authedFetch('/me/server-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverId })
      })
      if (!r.ok) return undefined
      const j = (await r.json()) as ServerTokenResponse
      return j.accessToken
    } catch (e) {
      console.warn('[oracle] mintServerToken failed', e)
      return undefined
    }
  }

  // ---- REST: server-list sync ---------------------------------------------

  async listRemoteServers(): Promise<RemoteServerRecord[]> {
    const r = await this.authedFetch('/me/servers')
    if (!r.ok) throw new Error(`listRemoteServers failed: ${r.status}`)
    return (await r.json()) as RemoteServerRecord[]
  }

  async pushServer(server: Server): Promise<RemoteServerRecord | null> {
    const r = await this.authedFetch('/me/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: server.id,
        port: server.port,
        name: server.name,
        updatedAt: server.updatedAt ?? Date.now()
      })
    })
    if (!r.ok) return null
    return (await r.json()) as RemoteServerRecord
  }

  async touchLastUsed(serverId: string): Promise<void> {
    if (!useOracleStore.getState().session) return
    await this.authedFetch(`/me/servers/${encodeURIComponent(serverId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lastUsedAt: new Date().toISOString() })
    }).catch((e) => console.warn('[oracle] touchLastUsed failed', e))
  }

  async deleteRemoteServer(serverId: string): Promise<void> {
    if (!useOracleStore.getState().session) return
    await this.authedFetch(`/me/servers/${encodeURIComponent(serverId)}`, {
      method: 'DELETE'
    }).catch((e) => console.warn('[oracle] deleteRemoteServer failed', e))
  }

  // ---- Internal -----------------------------------------------------------

  private async authedFetch(path: string, init?: RequestInit): Promise<Response> {
    const session = useOracleStore.getState().session
    if (!session) throw new Error('Not signed in to Oracle')

    // If token is expired (or expires in < 30s), try to refresh first.
    if (session.expiresAt - Date.now() < 30_000) {
      await this.refresh()
    }
    const current = useOracleStore.getState().session
    if (!current) throw new Error('Oracle session lost during refresh')

    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${current.accessToken}`)
    headers.set('accept', headers.get('accept') ?? 'application/json')
    const url = `${this.env.apiBase.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    return fetch(url, { ...init, headers })
  }
}

export const oracleService = new OracleService()
