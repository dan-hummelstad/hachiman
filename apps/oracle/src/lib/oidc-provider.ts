/**
 * Lazy singleton wrapper around the panva `oidc-provider` `Provider`.
 *
 * Why lazy?  The Provider's constructor reaches into Node-only modules
 * (jose, koa, …) and is incompatible with the Edge runtime; we only want
 * to construct it on first hit of an API route, never at module-evaluation
 * time. We also want a single instance per process — both for cookie-key
 * stability and so the in-memory dev JWKS aren't regenerated per request.
 */
import type Provider from 'oidc-provider'
import type { Configuration, ResourceServer } from 'oidc-provider'

import { db } from '@/db/client'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'

import { DrizzleAdapter } from './oidc-adapter'

const ONE_HOUR = 60 * 60
const TEN_MINUTES = 60 * 10
const FOURTEEN_DAYS = 60 * 60 * 24 * 14

function readCookieKeys(): string[] {
  const raw = process.env.OIDC_COOKIES_KEY
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'OIDC_COOKIES_KEY must be set in production (comma-separated list).',
      )
    }
    // Dev fallback — stable across reloads via globalThis below.
    return ['dev-oidc-cookie-key-do-not-use-in-prod']
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function readJwks(): Configuration['jwks'] {
  const raw = process.env.OIDC_JWKS_JSON
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Configuration['jwks']
    return parsed
  } catch (err) {
    throw new Error(
      `OIDC_JWKS_JSON is set but not valid JSON: ${(err as Error).message}`,
    )
  }
}

function buildConfiguration(): Configuration {
  const jwks = readJwks()

  const config: Configuration = {
    adapter: DrizzleAdapter,
    cookies: {
      keys: readCookieKeys(),
    },
    pkce: {
      required: () => true,
      methods: ['S256'],
    },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: true },
      introspection: { enabled: true },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        // v1: always issue opaque + introspectable tokens regardless of the
        // requested audience. Federated Mumble servers will pull user info
        // by introspecting against /api/oidc/token/introspection.
        getResourceServerInfo: (_ctx, resourceIndicator): ResourceServer => ({
          scope: 'openid profile email',
          audience: resourceIndicator,
          accessTokenTTL: ONE_HOUR,
          accessTokenFormat: 'opaque',
        }),
        defaultResource: () => '',
        useGrantedResource: () => true,
      },
    },
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name', 'preferred_username'],
    },
    scopes: ['openid', 'email', 'profile', 'offline_access'],
    clientAuthMethods: ['client_secret_basic', 'client_secret_post', 'none'],
    // panva builds discovery URLs as `issuer.origin + routes[name]` — the
    // issuer's PATH component (`/api/oidc`) is just an identifier, not a
    // route prefix. Since we mount the bridge at /api/oidc/[...path], we
    // have to mirror that prefix in every route here so discovery advertises
    // working URLs. Keep these in sync with the catch-all route's mount.
    routes: {
      authorization: '/api/oidc/auth',
      backchannel_authentication: '/api/oidc/backchannel',
      code_verification: '/api/oidc/device',
      device_authorization: '/api/oidc/device/auth',
      end_session: '/api/oidc/session/end',
      introspection: '/api/oidc/token/introspection',
      jwks: '/api/oidc/jwks',
      pushed_authorization_request: '/api/oidc/request',
      registration: '/api/oidc/reg',
      revocation: '/api/oidc/token/revocation',
      token: '/api/oidc/token',
      userinfo: '/api/oidc/me',
    },
    ttl: {
      AccessToken: ONE_HOUR,
      IdToken: ONE_HOUR,
      RefreshToken: FOURTEEN_DAYS,
      AuthorizationCode: TEN_MINUTES,
      Interaction: ONE_HOUR,
      Session: FOURTEEN_DAYS,
      Grant: FOURTEEN_DAYS,
    },
    interactions: {
      url: (_ctx, interaction) => `/oidc/interaction/${interaction.uid}`,
    },
    // panva defaults clientBasedCORS to `() => false`, so browser-based
    // public clients (PKCE) get a 400 "origin not allowed" on the token
    // endpoint. Allow any origin that matches a registered redirect URI's
    // origin — the redirect_uris list is the per-client allowlist we already
    // curate at registration time.
    clientBasedCORS: (_ctx, origin, client) => {
      const redirects =
        (client.metadata() as { redirect_uris?: string[] }).redirect_uris ?? []
      for (const uri of redirects) {
        try {
          if (new URL(uri).origin === origin) return true
        } catch {
          // Custom-scheme URIs (e.g. app.hachiman://...) don't have an
          // origin in the HTTP sense — they're never the source of a CORS
          // preflight, so skipping them is correct.
        }
      }
      return false
    },
    async findAccount(_ctx, id) {
      const row = await db.query.users.findFirst({
        where: eq(users.id, id),
      })
      if (!row) return undefined

      return {
        accountId: id,
        async claims(_use, scope) {
          const scopes = new Set(scope.split(' '))
          const out: Record<string, unknown> = { sub: id }
          if (scopes.has('email')) {
            out.email = row.email
            out.email_verified = row.emailVerifiedAt != null
          }
          if (scopes.has('profile')) {
            out.name = row.displayName
            out.preferred_username = row.displayName
          }
          return out as { sub: string; [k: string]: unknown }
        },
      }
    },
  }

  if (jwks) {
    config.jwks = jwks
  }

  return config
}

declare global {
   
  var __oracleOidcProvider: Promise<Provider> | undefined
}

async function constructProvider(): Promise<Provider> {
  const issuer = process.env.OIDC_ISSUER_URL
  if (!issuer) {
    throw new Error('OIDC_ISSUER_URL is not set')
  }

  // Dynamic import — `oidc-provider` is marked as a server external in
  // next.config.ts and uses dynamic requires under the hood. Loading it
  // lazily keeps it off the Edge bundle.
  const mod = await import('oidc-provider')
  const ProviderCtor = mod.default
  const provider = new ProviderCtor(issuer, buildConfiguration())

  // Trust the X-Forwarded-* headers set by Next's request proxy so the
  // issuer URL matching works behind reverse proxies in production.
  provider.proxy = true

  return provider
}

export async function getOidcProvider(): Promise<Provider> {
  if (!globalThis.__oracleOidcProvider) {
    globalThis.__oracleOidcProvider = constructProvider()
  }
  return globalThis.__oracleOidcProvider
}
