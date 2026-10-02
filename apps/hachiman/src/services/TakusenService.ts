import { useTakusenStore, type TakusenSession, type TakusenUser } from '@/stores/takusenStore'
import { resolveTakusenEnv, type TakusenEnv } from '@/shared/takusen-env'

export type { TakusenEnv }

interface DiscoveryDoc {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

/**
 * A voice region exposed by Takusen's public `GET /api/regions`, including the
 * endpoint a latency-capable host probes to measure client→region RTT.
 * `probeHost` is null until the managed-infra hosts exist (the seed fills dev
 * placeholders); a null host is simply skipped by the prober.
 */
export interface RegionInfo {
  code: string
  displayName: string
  probeHost: string | null
  probePort: number
}

/** One client-measured region RTT, POSTed to `regions/recommend`. */
export interface RegionMeasurement {
  region: string
  /** Best measured RTT in ms, or `null` if the probe failed / was skipped. */
  rttMs: number | null
}

/** Shape returned by `POST /api/v1/regions/recommend`. */
export interface RegionRecommendation {
  /** Recommended region code, or `null` if nothing was rankable. */
  recommended: string | null
  ranking: Array<{ code: string; rttMs: number; loadScore: number | null }>
  /** Known regions with no usable RTT this round. */
  unmeasured: string[]
  /** Code → display-name labels for the candidate set. */
  regions: Array<{ code: string; displayName: string }>
}

// --- PKCE helpers (WebCrypto; works in renderer + browser) ---

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

/**
 * Singleton that owns the Takusen OIDC session. Framework-agnostic so the
 * HachimanClient token provider can call it without React.
 */
export class TakusenService {
  private discoveryPromise: Promise<DiscoveryDoc> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private refreshInFlight: Promise<TakusenSession | null> | null = null

  // Vite replaces `import.meta.env` at build time in every package that imports
  // this file. Casting keeps the shared lib free of vite/client.d.ts.
  readonly env: TakusenEnv = resolveTakusenEnv(
    (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {}
  )

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

  /**
   * Start a PKCE flow and return the authorization URL for the host to open.
   * `redirectUri` is the host's (`IPlatformService.oauthRedirectUri`); `completeSignIn`
   * reuses it from the pending flow. `inviteCode` is the invite sign-in started from, kept
   * with the flow so the UI can reopen it after the redirect (a same-tab redirect reloads the page).
   */
  async beginSignIn(redirectUri: string, inviteCode: string | null = null): Promise<string> {
    useTakusenStore.getState().setAuthError(null)
    const discovery = await this.discover()
    const state = base64UrlEncode(randomBytes(16))
    const codeVerifier = base64UrlEncode(randomBytes(32))
    const codeChallenge = base64UrlEncode(await sha256(codeVerifier))

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.env.clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })
    useTakusenStore.getState().setPendingFlow({
      state,
      codeVerifier,
      redirectUri,
      inviteCode,
      createdAt: Date.now()
    })
    return `${discovery.authorization_endpoint}?${params.toString()}`
  }

  /**
   * Exchange the authorization code in the OAuth redirect URL (as delivered by
   * `platform.onOAuthCallback`) for tokens.
   */
  async completeSignIn(url: string): Promise<void> {
    const params = parseCallbackUrl(url)
    const pending = useTakusenStore.getState().pendingFlow
    if (!pending) throw new Error('this app did not start a sign-in')
    if (pending.state !== params.state) {
      throw new Error('the sign-in response does not match the sign-in this app started')
    }
    // 24h hard cap on pending flows.
    if (Date.now() - pending.createdAt > 24 * 60 * 60 * 1000) {
      useTakusenStore.getState().setPendingFlow(null)
      throw new Error('the sign-in started more than 24 hours ago')
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
    }

    const user = await this.fetchUserInfo(tokenJson.access_token, discovery)
    const expiresAt = Date.now() + (tokenJson.expires_in ?? 3600) * 1000
    const session: TakusenSession = {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token ?? null,
      expiresAt,
      user
    }

    useTakusenStore.getState().setSession(session)
    useTakusenStore.getState().setPendingFlow(null)
    this.scheduleRefresh(session)
  }

  private async fetchUserInfo(accessToken: string, discovery: DiscoveryDoc): Promise<TakusenUser> {
    if (!discovery.userinfo_endpoint) {
      throw new Error('Takusen does not publish a userinfo endpoint')
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
    const session = useTakusenStore.getState().session
    if (session) this.scheduleRefresh(session)
  }

  private scheduleRefresh(session: TakusenSession): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (!session.refreshToken) return
    const fiveMinutes = 5 * 60 * 1000
    const delay = Math.max(0, session.expiresAt - Date.now() - fiveMinutes)
    this.refreshTimer = setTimeout(() => {
      void this.refresh().catch((e) => console.error('[takusen] refresh failed', e))
    }, delay)
  }

  /** Single-flight: concurrent callers share one refresh request. */
  private refresh(): Promise<TakusenSession | null> {
    this.refreshInFlight ??= this.doRefresh().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  /** Fresh Takusen access token (refreshes when < 30 s left). Throws when signed out. */
  getAccessToken = async (): Promise<string> => {
    let session = useTakusenStore.getState().session
    if (session && session.expiresAt - Date.now() < 30_000) session = await this.refresh()
    if (!session) throw new Error('Not signed in to Takusen')
    return session.accessToken
  }

  private async doRefresh(): Promise<TakusenSession | null> {
    const session = useTakusenStore.getState().session
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
    const refreshed: TakusenSession = {
      ...session,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000
    }
    useTakusenStore.getState().setSession(refreshed)
    this.scheduleRefresh(refreshed)
    return refreshed
  }

  signOut(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    useTakusenStore.getState().clearSession()
  }

  // ---- REST: region placement ---------------------------------------------

  /**
   * GET /api/regions → the known voice regions + their probe endpoints. Public
   * (no auth) — a latency-capable host fetches this, probes each region, and
   * POSTs the measurements to {@link recommendRegion}.
   */
  async listRegions(): Promise<RegionInfo[]> {
    const url = `${this.env.apiBase.replace(/\/$/, '')}/regions`
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`listRegions failed: ${r.status}`)
    return (await r.json()) as RegionInfo[]
  }

  /**
   * POST /api/v1/regions/recommend with client-measured RTTs → the ranked
   * recommendation. Requires a Takusen session (the endpoint requires an
   * authenticated user). Returns undefined if not signed in or the request
   * fails, so callers can fall back to the honest "not measured" hint.
   */
  async recommendRegion(
    measurements: RegionMeasurement[]
  ): Promise<RegionRecommendation | undefined> {
    if (!useTakusenStore.getState().session) return undefined
    try {
      const r = await this.authedFetch('/v1/regions/recommend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measurements })
      })
      if (!r.ok) return undefined
      return (await r.json()) as RegionRecommendation
    } catch (e) {
      console.warn('[takusen] recommendRegion failed', e)
      return undefined
    }
  }

  // ---- Internal -----------------------------------------------------------

  private async authedFetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${await this.getAccessToken()}`)
    headers.set('accept', headers.get('accept') ?? 'application/json')
    const url = `${this.env.apiBase.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
    return fetch(url, { ...init, headers })
  }
}

function parseCallbackUrl(url: string): { code: string; state: string } {
  const q = new URL(url).searchParams
  const code = q.get('code')
  const state = q.get('state')
  if (!code || !state)
    throw new Error(
      q.get('error_description') ?? q.get('error') ?? 'OAuth callback missing code/state'
    )
  return { code, state }
}

export const takusenService = new TakusenService()
