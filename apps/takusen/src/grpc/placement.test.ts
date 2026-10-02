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
 * Run with `pnpm -F @hachiman/takusen test:grpc`.
 */
import assert from 'node:assert/strict'

import * as grpc from '@grpc/grpc-js'

import { HEARTBEAT_STALE_AFTER_MS } from '@/grpc/repo'
import { pickPlacement, placeMediaSession } from './placement'
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
    activeSessions: 0,
    signalingUrl: 'wss://media-default/voice',
    ...over,
  })
}

// --- helpers ----------------------------------------------------------------
/** Wrap pickPlacement against an in-memory repo with NOW frozen. */
async function pick(repo: InMemoryMediaNodesRepo, opts: { homeRegion: string }) {
  return pickPlacement({ homeRegion: opts.homeRegion, now: NOW }, repo)
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
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked?.nodeId, 'a')
})

await test('region match: returns undefined when no region matches', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', region: 'eu-west' })
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked, undefined)
})

// --- heartbeat staleness ----------------------------------------------------

await test('heartbeat-staleness filter: stale nodes are excluded', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'fresh', lastHeartbeatAt: fresh })
  seed(repo, { nodeId: 'stale', lastHeartbeatAt: stale })
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked?.nodeId, 'fresh')
})

await test('heartbeat-staleness filter: all-stale fleet returns undefined', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', lastHeartbeatAt: stale })
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked, undefined)
})

// --- status filter ----------------------------------------------------------

await test('status filter: draining nodes excluded; only active wins', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'draining', status: 'draining' })
  seed(repo, { nodeId: 'active', status: 'active' })
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked?.nodeId, 'active')
})

// --- deterministic ranking --------------------------------------------------

await test('ranking: lowest activeSessions wins', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', activeSessions: 5 })
  seed(repo, { nodeId: 'b', activeSessions: 1 })
  seed(repo, { nodeId: 'c', activeSessions: 9 })
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked?.nodeId, 'b')
})

await test('ranking: tie on activeSessions broken by nodeId ascending (deterministic)', async () => {
  const repo = new InMemoryMediaNodesRepo()
  // Same activeSessions; insertion order shuffled.
  seed(repo, { nodeId: 'zulu', activeSessions: 3 })
  seed(repo, { nodeId: 'alpha', activeSessions: 3 })
  seed(repo, { nodeId: 'mike', activeSessions: 3 })
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked?.nodeId, 'alpha')
})

// --- RESOURCE_EXHAUSTED on empty --------------------------------------------

await test('RESOURCE_EXHAUSTED contract: empty store returns undefined', async () => {
  const repo = new InMemoryMediaNodesRepo()
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked, undefined)
})

await test('RESOURCE_EXHAUSTED contract: candidates exist but all filtered → undefined', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'a', region: 'eu-west' })
  seed(repo, { nodeId: 'b', status: 'draining' })
  seed(repo, { nodeId: 'c', lastHeartbeatAt: stale })
  const picked = await pick(repo, { homeRegion: 'us-east' })
  assert.equal(picked, undefined)
})

// --- handler-level wire codes -----------------------------------------------

await test('placeMediaSession: empty home_region places in any region', async () => {
  const repo = new InMemoryMediaNodesRepo()
  seed(repo, { nodeId: 'eu-1', region: 'eu-west', lastHeartbeatAt: new Date() })
  const { code, resp } = await placeViaHandler(repo, {
    channel_id: 'chan-1',
    home_region: '',
    guild_id: 'guild-1',
  })
  assert.equal(code, grpc.status.OK)
  assert.equal(resp?.node_id, 'eu-1')
})

await test('placeMediaSession: RESOURCE_EXHAUSTED on empty store', async () => {
  const repo = new InMemoryMediaNodesRepo()
  const { code } = await placeViaHandler(repo, {
    channel_id: 'chan-1',
    home_region: 'us-east',
    guild_id: 'guild-1',
  })
  assert.equal(code, grpc.status.RESOURCE_EXHAUSTED)
})

await test('placeMediaSession: OK + signaling_url when a node is available', async () => {
  const repo = new InMemoryMediaNodesRepo()
  // Handler uses `new Date()` internally for now; seed with wall-time
  // freshness so the staleness filter doesn't reject the row when wall-
  // clock drifts past NOW.
  seed(repo, { nodeId: 'node-1', signalingUrl: 'wss://media-1/voice', lastHeartbeatAt: new Date() })
  const { code, resp } = await placeViaHandler(repo, {
    channel_id: 'chan-1',
    home_region: 'us-east',
    guild_id: 'guild-1',
  })
  assert.equal(code, grpc.status.OK)
  assert.equal(resp?.node_id, 'node-1')
  assert.equal(resp?.signaling_url, 'wss://media-1/voice')
})

// --- finalise ---------------------------------------------------------------
if (failures.length === 0) {
  console.log(`placement: ${passed} tests passed`)
} else {
  console.log(`placement: ${passed} tests passed, ${failures.length} failed`)
  for (const f of failures) console.error('  FAIL', f)
  process.exit(1)
}
