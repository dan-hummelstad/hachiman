/**
 * Idempotent dev seed for Oracle/Takusen.
 *
 * Currently seeds:
 *   - the first-party `hachiman-client` public OIDC client used by the
 *     Hachiman desktop + browser apps for end-user PKCE sign-in.
 *   - the fixed set of voice `regions` (us-east, us-west, eu-west,
 *     ap-southeast) a server can be homed in.
 *   - a couple of DEV-FIXTURE managed `islands` + `virtual_servers` so the
 *     islands admin dashboard has something to render before the bin-packing
 *     scheduler + managed-infra runtime exist (see ISLAND-PLATFORM.md).
 *
 * Safe to re-run: each upsert is keyed on its natural key (client_id /
 * region code / island host / server slug) so re-running refreshes mutable
 * fields and leaves the rest alone.
 *
 * Invoked by `pnpm -F @hachiman/oracle db:seed`.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

import { islands, oidcClients, regions, servers, users, virtualServers } from './schema'

const HACHIMAN_CLIENT_ID = 'hachiman-client'

// Fixed dev region set. lat/lon are rough region centroids — good enough for a
// future geodesic placement scorer, not meant to be precise. Keep this list
// small and stable; it is the authoritative seed for the `regions` table.
//
// `probeHost`/`probePort` are the endpoint a latency-capable client (the
// Electron host) TCP-connect-probes to measure client→region RTT. THESE HOSTS
// ARE DEV PLACEHOLDERS: the managed-infra islands they should point at do not
// exist yet (see REGION-CONTRACT.md "Future"). They are intentionally
// well-known anycast/cloud public IPs that respond to a TCP connect so the
// probe path is exercisable end-to-end in dev; they are NOT Mumble servers and
// the measured RTT is only a rough geographic proxy. Swap these for the real
// per-region island hosts (on the Mumble port 64738) when that infra lands.
// `probePort` 443 here because the placeholders are public HTTPS endpoints that
// accept a TCP connect; real region hosts will use the Mumble default 64738.
const REGIONS: ReadonlyArray<{
  code: string
  displayName: string
  lat: number
  lon: number
  probeHost: string
  probePort: number
}> = [
  // DEV PLACEHOLDER probe hosts — see comment above. Not real region infra.
  { code: 'us-east', displayName: 'US East', lat: 39.0438, lon: -77.4874, probeHost: 'us-east-1.amazonaws.com', probePort: 443 },
  { code: 'us-west', displayName: 'US West', lat: 45.5946, lon: -121.1787, probeHost: 'us-west-2.amazonaws.com', probePort: 443 },
  { code: 'eu-west', displayName: 'EU West', lat: 53.3331, lon: -6.2489, probeHost: 'eu-west-1.amazonaws.com', probePort: 443 },
  { code: 'ap-southeast', displayName: 'Asia Pacific (Southeast)', lat: 1.3521, lon: 103.8198, probeHost: 'ap-southeast-1.amazonaws.com', probePort: 443 },
]

// ---------------------------------------------------------------------------
// DEV-FIXTURE managed islands + virtual servers.
//
// THESE ARE DEV FIXTURES, NOT REAL INFRA. The managed-infra runtime (k3s pods,
// HAProxy, the wake proxy, the bin-packing scheduler) does NOT exist yet — these
// rows exist purely so the islands admin dashboard renders something and so the
// `Island` / `VirtualServer` shapes are exercised end-to-end. The `host`s are
// placeholder hostnames that resolve to nothing; swap for real island pods when
// the scheduler + runtime land. LIVE metrics (active users / CPU / bandwidth)
// are NOT seeded — they live in Redis and are supplied to the scheduler at
// scoring time (see ISLAND-PLATFORM.md), so the dashboard shows them as "—".
//
// Idempotent: islands keyed on `host`, the dev owner on email, dev servers on
// `slug`, and each vServer on its (unique) `serverId`.
const ISLAND_FIXTURES: ReadonlyArray<{
  host: string
  grpcPort: number
  region: string
  status: 'provisioning' | 'active' | 'draining' | 'down'
  maxVservers: number
}> = [
  { host: 'island-use1-a.dev.invalid', grpcPort: 9090, region: 'us-east', status: 'active', maxVservers: 50 },
  { host: 'island-euw1-a.dev.invalid', grpcPort: 9090, region: 'eu-west', status: 'active', maxVservers: 25 },
]

// Dev owner for the fixture servers (the managed vServers each back a registry
// `servers` row — see the 1:1 modeling decision in schema.ts / ISLAND-PLATFORM.md).
const DEV_OWNER_EMAIL = 'dev-fixtures@hachiman.invalid'

// Each fixture vServer is a managed instance: a `servers` registry row + one
// `virtual_servers` row. `islandHost` ties it to a seeded island (null = leave
// it UNPLACED so the dashboard shows the unplaced state too).
const VSERVER_FIXTURES: ReadonlyArray<{
  slug: string
  name: string
  host: string
  region: string
  status: 'inactive' | 'starting' | 'active' | 'cooling'
  islandHost: string | null
  murmurId: number | null
  port: number
  maxUsers: number
  maxBandwidth: number
}> = [
  // Placed + running on the us-east island.
  { slug: 'dev-managed-alpha', name: 'Dev Managed Alpha', host: 'alpha.dev.invalid', region: 'us-east', status: 'active', islandHost: 'island-use1-a.dev.invalid', murmurId: 1, port: 64738, maxUsers: 100, maxBandwidth: 558000 },
  // Placed + booting on the eu-west island.
  { slug: 'dev-managed-bravo', name: 'Dev Managed Bravo', host: 'bravo.dev.invalid', region: 'eu-west', status: 'starting', islandHost: 'island-euw1-a.dev.invalid', murmurId: 2, port: 64739, maxUsers: 50, maxBandwidth: 558000 },
  // UNPLACED (islandId stays null) + inactive — awaiting the scheduler.
  { slug: 'dev-managed-charlie', name: 'Dev Managed Charlie', host: 'charlie.dev.invalid', region: 'us-east', status: 'inactive', islandHost: null, murmurId: null, port: 64740, maxUsers: 100, maxBandwidth: 558000 },
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
      .values({
        code: r.code,
        displayName: r.displayName,
        lat: r.lat,
        lon: r.lon,
        probeHost: r.probeHost,
        probePort: r.probePort,
      })
      .onConflictDoUpdate({
        target: regions.code,
        set: {
          displayName: r.displayName,
          lat: r.lat,
          lon: r.lon,
          probeHost: r.probeHost,
          probePort: r.probePort,
        },
      })
  }
  console.log(`[seed] upserted ${REGIONS.length} regions (${REGIONS.map((r) => r.code).join(', ')})`)

  // --- DEV-FIXTURE islands ------------------------------------------------
  // `islands.host` has no DB unique constraint (a region can legitimately have
  // many islands sharing a hostname pattern), so idempotency is done by
  // select-by-host-then-insert rather than onConflict. Map host -> island id so
  // the vServer fixtures below can resolve their placement.
  const islandIdByHost = new Map<string, string>()
  for (const isl of ISLAND_FIXTURES) {
    const found = await db
      .select({ id: islands.id })
      .from(islands)
      .where(eq(islands.host, isl.host))
      .limit(1)
    let id = found[0]?.id
    if (id) {
      await db
        .update(islands)
        .set({ grpcPort: isl.grpcPort, region: isl.region, status: isl.status, maxVservers: isl.maxVservers, updatedAt: new Date() })
        .where(eq(islands.id, id))
    } else {
      const inserted = await db
        .insert(islands)
        .values({ host: isl.host, grpcPort: isl.grpcPort, region: isl.region, status: isl.status, maxVservers: isl.maxVservers })
        .returning({ id: islands.id })
      id = inserted[0]!.id
    }
    islandIdByHost.set(isl.host, id)
  }
  console.log(`[seed] upserted ${ISLAND_FIXTURES.length} dev-fixture islands`)

  // --- DEV-FIXTURE managed virtual servers --------------------------------
  // Each managed vServer needs a backing registry `servers` row (the 1:1
  // serverId FK). Seed a single dev owner + the fixture servers, then the
  // vServer rows. All idempotent on natural keys (email / slug / serverId).
  const ownerFound = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEV_OWNER_EMAIL))
    .limit(1)
  let devOwnerId = ownerFound[0]?.id
  if (!devOwnerId) {
    const insertedOwner = await db
      .insert(users)
      .values({ email: DEV_OWNER_EMAIL, displayName: 'Dev Fixtures', name: 'Dev Fixtures' })
      .returning({ id: users.id })
    devOwnerId = insertedOwner[0]!.id
  }

  for (const vs of VSERVER_FIXTURES) {
    // Backing registry server (keyed on slug).
    const serverFound = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.slug, vs.slug))
      .limit(1)
    let serverId = serverFound[0]?.id
    if (serverId) {
      await db
        .update(servers)
        .set({ name: vs.name, host: vs.host, port: vs.port, region: vs.region, updatedAt: new Date() })
        .where(eq(servers.id, serverId))
    } else {
      const insertedServer = await db
        .insert(servers)
        .values({ ownerUserId: devOwnerId, slug: vs.slug, name: vs.name, host: vs.host, port: vs.port, region: vs.region })
        .returning({ id: servers.id })
      serverId = insertedServer[0]!.id
    }

    const islandId = vs.islandHost ? (islandIdByHost.get(vs.islandHost) ?? null) : null
    // Managed vServer row (keyed on the unique serverId).
    const vsFound = await db
      .select({ id: virtualServers.id })
      .from(virtualServers)
      .where(eq(virtualServers.serverId, serverId))
      .limit(1)
    if (vsFound[0]?.id) {
      await db
        .update(virtualServers)
        .set({ status: vs.status, islandId, murmurId: vs.murmurId, port: vs.port, region: vs.region, maxUsers: vs.maxUsers, maxBandwidth: vs.maxBandwidth, updatedAt: new Date() })
        .where(eq(virtualServers.id, vsFound[0].id))
    } else {
      await db.insert(virtualServers).values({
        serverId,
        status: vs.status,
        islandId,
        murmurId: vs.murmurId,
        port: vs.port,
        region: vs.region,
        maxUsers: vs.maxUsers,
        maxBandwidth: vs.maxBandwidth,
      })
    }
  }
  console.log(`[seed] upserted ${VSERVER_FIXTURES.length} dev-fixture managed virtual servers`)

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
