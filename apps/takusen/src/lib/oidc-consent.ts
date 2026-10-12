/**
 * Pure helpers for the OIDC consent page and the admin client page: what an
 * authorization request asks for, and what each redirect URI serves. No
 * imports: client components use it too.
 */

export interface ConsentRequest {
  /** `login` (continue as) or `consent` (allow access). */
  prompt: string
  clientId: string
  /** The requested OIDC scopes, in request order, without repeats. */
  scopes: string[]
  /** Where the browser goes after the answer (the request's `redirect_uri`), or null. */
  redirectUri: string | null
  /** The request carries a PKCE challenge (Takusen requires S256, oidc-provider.ts). */
  pkce: boolean
}

/** From oidc-provider's `Interaction` (`prompt.name`, `params`). */
export function consentRequest(interaction: {
  prompt: { name: string }
  params: Record<string, unknown>
}): ConsentRequest {
  const p = interaction.params
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    prompt: interaction.prompt.name,
    clientId: str(p.client_id),
    scopes: [...new Set(str(p.scope).split(' ').filter(Boolean))],
    redirectUri: str(p.redirect_uri) || null,
    pkce: str(p.code_challenge) !== '',
  }
}

/**
 * `app`: a custom scheme the OS hands to the app (the iOS app, and the desktop app through the bridge).
 * `desktop_bridge`: the Takusen page that forwards to the desktop app. `web`: any other http(s) URI.
 */
export type RedirectUriKind = 'app' | 'desktop_bridge' | 'web' | 'other'

export function redirectUriKind(uri: string): RedirectUriKind {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return 'other'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'app'
  return url.pathname === '/oauth/electron-bridge' ? 'desktop_bridge' : 'web'
}
