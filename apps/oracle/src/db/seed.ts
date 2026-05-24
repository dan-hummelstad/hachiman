/**
 * Idempotent dev seed for Oracle/Takusen.
 *
 * Currently seeds:
 *   - the first-party `hachiman-client` public OIDC client used by the
 *     Hachiman desktop + browser apps for end-user PKCE sign-in.
 *
 * Safe to re-run: each upsert is keyed on `client_id` so re-running updates
 * the redirect URI list and leaves everything else alone.
 *
 * Invoked by `pnpm -F @hachiman/oracle db:seed`.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

import { oidcClients } from './schema'

const HACHIMAN_CLIENT_ID = 'hachiman-client'

// Defaults match the dev hosts:
//   - app.hachiman://oauth-callback     — Electron's custom-scheme deep link
//     (reverse-DNS form is required by RFC 8252 / panva's native client check)
//   - http://localhost:3000/oauth/electron-bridge — Oracle-hosted splash page
//     that triggers the deep link after Electron sign-in completes in the
//     system browser (the browser can't render a custom-scheme URL)
//   - http://localhost:5173|5174/oauth/callback — browser shell's own callback
// Override with HACHIMAN_CLIENT_REDIRECT_URIS (comma-separated) when running
// on different ports or behind a proxy.
const DEFAULT_REDIRECT_URIS = [
  'app.hachiman://oauth-callback',
  'http://localhost:3000/oauth/electron-bridge',
  'http://localhost:5173/oauth/callback',
  'http://localhost:5174/oauth/callback',
]

function readRedirectUris(): string[] {
  const raw = process.env.HACHIMAN_CLIENT_REDIRECT_URIS
  if (!raw) return DEFAULT_REDIRECT_URIS
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  const sql = postgres(databaseUrl, { max: 1 })
  const db = drizzle(sql)

  const redirectUris = readRedirectUris()

  const existing = await db
    .select({ id: oidcClients.id, redirectUris: oidcClients.redirectUris })
    .from(oidcClients)
    .where(eq(oidcClients.clientId, HACHIMAN_CLIENT_ID))
    .limit(1)
    .then((rows) => rows[0])

  if (existing) {
    await db
      .update(oidcClients)
      .set({ redirectUris, isPublic: true, clientSecret: '', serverId: null })
      .where(eq(oidcClients.id, existing.id))
    console.log(
      `[seed] updated ${HACHIMAN_CLIENT_ID} (redirect_uris=${redirectUris.join(', ')})`,
    )
  } else {
    await db.insert(oidcClients).values({
      clientId: HACHIMAN_CLIENT_ID,
      clientSecret: '', // ignored for public clients; the adapter omits it
      isPublic: true,
      serverId: null,
      redirectUris,
      scopes: ['openid', 'profile', 'email'],
    })
    console.log(
      `[seed] created ${HACHIMAN_CLIENT_ID} (redirect_uris=${redirectUris.join(', ')})`,
    )
  }

  await sql.end()
}

main().catch((err) => {
  console.error('[seed] failed', err)
  process.exit(1)
})
