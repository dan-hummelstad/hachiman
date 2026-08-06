/**
 * Integration tests for placeMediaSession + pickPlacement.
 *
 * These tests exercise the REAL gRPC handler (placeMediaSession) and the
 * REAL DB-orchestration helper (pickPlacement) — the only swap is the
 * MediaNodesRepo seam, which points at InMemoryMediaNodesRepo here so the
 * suite runs without DATABASE_URL or a live Postgres. The in-memory impl
 * mirrors the Drizzle impl behaviour-for-behaviour (see repo.in-memory.ts);
 * any divergence between them would surface as a test failure.
 *
 * Why this shape: an earlier slice tested a pure `rankPlacement` helper that
 * was dead code in production (placement.ts had its own SQL). The split
 * meant ranker bugs could pass while the production SQL silently drifted.
 * Moving the seam down to the repo level eliminates that gap.
 *
 * Run with `pnpm -F @hachiman/oracle test:grpc`.
 */
import assert from 'node:assert/strict'

import * as grpc from '@grpc/grpc-js'

import { HEARTBEAT_STALE_AFTER_MS, pickPlacement, placeMediaSession } from './placement'
import type { PlaceMediaSessionRequest, PlaceMediaSessionResponse } from './proto'
import { InMemoryMediaNodesRepo, type InMemoryNodeRow } from './repo.in-memory'

// --- tiny test harness ------------------------------------------------------
let passed = 0
const failures: string[] = []
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
  } catch (err) {
    failures.push(`${name}\n    ${(err as Error).message.replace(/\n/g, '\n    ')}`)
  }
}

// --- fixtures ---------------------------------------------------------------
// Fixed "now" so heartbeat-staleness arithmetic is reproducible.
const NOW = new Date('2026-06-07T12:00:00Z')
const fresh = new Date(NOW.getTime() - 1_000) // 1s old
const stale = new Date(NOW.getTime() - HEARTBEAT_STALE_AFTER_MS - 1_000) // > window

function seed(repo: InMemoryMediaNodesRepo, over: Partial<InMemoryNodeRow> & { nodeId: string }) {
  return repo.seed({
    region: 'us-east',
    lastHeartbeatAt: fresh,
    status: 'active',
    tenantId: null,
    activeSessions: 0,
    sidechannelAddr: 'media-default:7881',
    ...over,
  })
}

// --- helpers ----------------------------------------------------------------
/** Wrap pickPlacement against an in-memory repo with NOW frozen. */
async function pick(repo: InMemoryMediaNodesRepo, opts: { homeRegion: string; tenantId: string }) {
  return pickPlacement({ homeRegion: opts.homeRegion, tenantId: opts.tenantId, now: NOW }, repo)
}

/** Invoke the real placeMediaSession handler with a synthetic ServerUnaryCall.
 *  Returns the callback's (err, resp) pair so tests can assert codes. */
async function placeViaHandler(
  repo: InMemoryMediaNodesRepo,
  req: PlaceMediaSessionRequest,
): Promise<{ code: grpc.status; resp: PlaceMediaSessionResponse | null }> {
  return new Promise((resolve) => {
    const call = { request: req } as unknown as grpc.ServerUnaryCall<
      PlaceMediaSessionRequest,
      PlaceMediaSessionResponse
    >
    void placeMediaSession(
      call,
      (err, value) => {
        if (err) {
          const e = err as { code?: grpc.status }
          resolve({ code: e.code ?? grpc.status.UNKNOWN, resp: null })
        } else {
          resolve({ code: grpc.status.OK, resp: value as PlaceMediaSessionResponse })
        }
      },
      repo,
    )
  })
}

// --- region match -----------------------------------------------------------

await test('region match: only same-region candidates are considered', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', region: 'us-east' })
  seed(repo, { nodeId: 'b', region: 'eu-west' })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked?.nodeId, 'a')
})

await test('region match: returns undefined when no region matches', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', region: 'eu-west' })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked, undefined)
})

// --- heartbeat staleness ----------------------------------------------------

await test('heartbeat-staleness filter: stale nodes are excluded', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'fresh', lastHeartbeatAt: fresh })
  seed(repo, { nodeId: 'stale', lastHeartbeatAt: stale })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked?.nodeId, 'fresh')
})

await test('heartbeat-staleness filter: all-stale fleet returns undefined', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', lastHeartbeatAt: stale })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked, undefined)
})

// --- status filter ----------------------------------------------------------

await test('status filter: draining nodes excluded; only active wins', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'draining', status: 'draining' })
  seed(repo, { nodeId: 'active', status: 'active' })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked?.nodeId, 'active')
})

// --- tenant enforcement -----------------------------------------------------

await test('tenant enforcement: NULL tenant_id matches any incoming tenant', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'unassigned', tenantId: null })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: 'tenant-x' })
  assert.equal(picked?.nodeId, 'unassigned')
  // Phase 3a tenant stamp: a non-empty tenant claims the NULL row.
  assert.equal(repo.rows.get('unassigned')?.tenantId, 'tenant-x')
})

await test('tenant enforcement: matching tenant_id wins (idempotent, no re-stamp)', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'theirs', tenantId: 'tenant-x' })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: 'tenant-x' })
  assert.equal(picked?.nodeId, 'theirs')
  // Tenant binding unchanged — no spurious re-write.
  assert.equal(repo.rows.get('theirs')?.tenantId, 'tenant-x')
})

await test('tenant enforcement: non-matching tenant_id excluded', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'taken', tenantId: 'tenant-other', activeSessions: 0 })
  seed(repo, { nodeId: 'free', tenantId: null, activeSessions: 10 })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: 'tenant-x' })
  // tenant-other excluded → free (NULL) wins despite higher load.
  assert.equal(picked?.nodeId, 'free')
})

await test('tenant enforcement: empty incoming tenant_id matches everything', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'taken', tenantId: 'tenant-other', activeSessions: 0 })
  seed(repo, { nodeId: 'free', tenantId: null, activeSessions: 10 })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  // Empty tenant: tenant filter is a no-op, lowest-load wins. No stamp.
  assert.equal(picked?.nodeId, 'taken')
  assert.equal(repo.rows.get('taken')?.tenantId, 'tenant-other')
})

// --- deterministic ranking --------------------------------------------------

await test('ranking: lowest activeSessions wins', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', activeSessions: 5 })
  seed(repo, { nodeId: 'b', activeSessions: 1 })
  seed(repo, { nodeId: 'c', activeSessions: 9 })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked?.nodeId, 'b')
})

await test('ranking: tie on activeSessions broken by nodeId ascending (deterministic)', async () => {
  const repo = new InMemoryMediaNodesRepo()
  // Same activeSessions; insertion order shuffled.
  seed(repo, { nodeId: 'zulu', activeSessions: 3 })
  seed(repo, { nodeId: 'alpha', activeSessions: 3 })
  seed(repo, { nodeId: 'mike', activeSessions: 3 })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked?.nodeId, 'alpha')
})

// --- RESOURCE_EXHAUSTED on empty --------------------------------------------

await test('RESOURCE_EXHAUSTED contract: empty store returns undefined', async () => {
  const repo = new InMemoryMediaNodesRepo()
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: '' })
  assert.equal(picked, undefined)
})

await test('RESOURCE_EXHAUSTED contract: candidates exist but all filtered → undefined', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', region: 'eu-west' })
  seed(repo, { nodeId: 'b', status: 'draining' })
  seed(repo, { nodeId: 'c', lastHeartbeatAt: stale })
  seed(repo, { nodeId: 'd', tenantId: 'tenant-other' })
  const picked = await pick(repo, { homeRegion: 'us-east', tenantId: 'tenant-x' })
  assert.equal(picked, undefined)
})

// --- handler-level wire codes -----------------------------------------------

await test('placeMediaSession: INVALID_ARGUMENT on empty home_region', async () => {
  const repo = new InMemoryMediaNodesRepo()
  const { code } = await placeViaHandler(repo, {
    channel_id: 1,
    home_region: '',
    tenant_id: '',
  })
  assert.equal(code, grpc.status.INVALID_ARGUMENT)
})

await test('placeMediaSession: RESOURCE_EXHAUSTED on empty store', async () => {
  const repo = new InMemoryMediaNodesRepo()
  const { code } = await placeViaHandler(repo, {
    channel_id: 1,
    home_region: 'us-east',
    tenant_id: '',
  })
  assert.equal(code, grpc.status.RESOURCE_EXHAUSTED)
})

await test('placeMediaSession: OK + assigned_ssrc=0 when a node is available', async () => {
  const repo = new InMemoryMediaNodesRepo()
  // Handler uses `new Date()` internally for now; seed with wall-time
  // freshness so the staleness filter doesn't reject the row when wall-
  // clock drifts past NOW.
  seed(repo, { nodeId: 'node-1', sidechannelAddr: 'media-1:7881', lastHeartbeatAt: new Date() })
  const { code, resp } = await placeViaHandler(repo, {
    channel_id: 1,
    home_region: 'us-east',
    tenant_id: '',
  })
  assert.equal(code, grpc.status.OK)
  assert.equal(resp?.node_id, 'node-1')
  assert.equal(resp?.addr, 'media-1:7881')
  // Phase 3a contract pinned in test — see placement.ts header rationale.
  assert.equal(resp?.assigned_ssrc, 0)
})

// --- CRITICAL #2 — TOCTOU race on tenant stamping --------------------------

await test('concurrent placements on the same NULL-tenant node: only one wins', async () => {
  // Two tenants race on a single shared NULL-tenant node. The atomic
  // conditional UPDATE in pickPlacement must let only ONE tenant land the
  // stamp; the loser must come back undefined so the caller surfaces
  // RESOURCE_EXHAUSTED (rather than both succeeding and silently violating
  // the single-tenant-per-node invariant).
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'shared', tenantId: null })
  const [a, b] = await Promise.all([
    pick(repo, { homeRegion: 'us-east', tenantId: 'tenant-a' }),
    pick(repo, { homeRegion: 'us-east', tenantId: 'tenant-b' }),
  ])
  const aWon = a !== undefined
  const bWon = b !== undefined
  assert.equal(
    aWon !== bWon, // exactly one
    true,
    `expected exactly one winner; got a=${JSON.stringify(a)} b=${JSON.stringify(b)}`,
  )
  // The winning tenant is the one stamped on the row.
  const stampedTenant = repo.rows.get('shared')?.tenantId
  if (aWon) {
    assert.equal(stampedTenant, 'tenant-a')
  } else {
    assert.equal(stampedTenant, 'tenant-b')
  }
})

await test('concurrent placements: second placeMediaSession returns RESOURCE_EXHAUSTED when only one shared node exists', async () => {
  // Same scenario as above but driven through the gRPC handler so we also
  // exercise the loser's RESOURCE_EXHAUSTED mapping. Handler uses
  // `new Date()` for staleness — seed with wall-time freshness.
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'shared', tenantId: null, lastHeartbeatAt: new Date() })
  const [a, b] = await Promise.all([
    placeViaHandler(repo, { channel_id: 1, home_region: 'us-east', tenant_id: 'tenant-a' }),
    placeViaHandler(repo, { channel_id: 1, home_region: 'us-east', tenant_id: 'tenant-b' }),
  ])
  const codes = [a.code, b.code].sort()
  assert.deepEqual(codes, [grpc.status.OK, grpc.status.RESOURCE_EXHAUSTED])
})

// --- finalise ---------------------------------------------------------------
if (failures.length === 0) {
  console.log(`placement: ${passed} tests passed`)
} else {
  console.log(`placement: ${passed} tests passed, ${failures.length} failed`)
  for (const f of failures) console.error('  FAIL', f)
  process.exit(1)
}
