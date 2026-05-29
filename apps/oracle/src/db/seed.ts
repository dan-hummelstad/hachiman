/**
 * Idempotent dev seed for Oracle/Takusen.
 *
 * Currently seeds:
 *   - the first-party `hachiman-client` public OIDC client used by the
 *     Hachiman desktop + browser apps for end-user PKCE sign-in.
 *   - the fixed set of voice `regions` (us-east, us-west, eu-west,
 *     ap-southeast) a server can be homed in.
 *
 * Safe to re-run: each upsert is keyed on its natural key (client_id /
 * region code) so re-running refreshes mutable fields and leaves the rest
 * alone.
 *
 * Invoked by `pnpm -F @hachiman/oracle db:seed`.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

import { oidcClients, regions } from './schema'

const HACHIMAN_CLIENT_ID = 'hachiman-client'

// Fixed dev region set. lat/lon are rough region centroids — good enough for a
// future geodesic placement scorer, not meant to be precise. Keep this list
// small and stable; it is the authoritative seed for the `regions` table.
const REGIONS: ReadonlyArray<{
  code: string
  displayName: string
  lat: number
  lon: number
}> = [
  { code: 'us-east', displayName: 'US East', lat: 39.0438, lon: -77.4874 },
  { code: 'us-west', displayName: 'US West', lat: 45.5946, lon: -121.1787 },
  { code: 'eu-west', displayName: 'EU West', lat: 53.3331, lon: -6.2489 },
  { code: 'ap-southeast', displayName: 'Asia Pacific (Southeast)', lat: 1.3521, lon: 103.8198 },
]

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

  // --- Regions ------------------------------------------------------------
  // Idempotent upsert keyed on the `code` primary key: re-running refreshes
  // displayName/lat/lon and leaves any servers referencing the code intact.
  for (const r of REGIONS) {
    await db
      .insert(regions)
      .values({ code: r.code, displayName: r.displayName, lat: r.lat, lon: r.lon })
      .onConflictDoUpdate({
        target: regions.code,
        set: { displayName: r.displayName, lat: r.lat, lon: r.lon },
      })
  }
  console.log(`[seed] upserted ${REGIONS.length} regions (${REGIONS.map((r) => r.code).join(', ')})`)

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
