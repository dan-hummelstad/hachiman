/**
 * Unit tests for the pure bin-packing island scorer (`scheduler.ts`).
 *
 * Mirrors `placement.test.ts`: Oracle has no vitest/jest wired and we must not
 * add deps, so this is a self-contained, tsx-runnable assertion script
 * (`node:assert/strict` + a tiny harness). Run it with
 * `pnpm -F @hachiman/oracle test:scheduler` (→ `tsx src/lib/scheduler.test.ts`),
 * or directly with `node --import tsx/esm src/lib/scheduler.test.ts`. Exits
 * non-zero if any case fails so it works in CI.
 *
 * Only the PURE scorer is covered here — `scheduleVServerPlacement` touches the
 * DB and is out of scope for a no-IO unit test.
 */
import assert from 'node:assert/strict'

import type { IslandScoringInput } from './islands'
import { LOAD_WEIGHTS } from './placement'
import {
  ISLAND_LOAD_WEIGHTS,
  isAtCapacity,
  islandLoadScore,
  scoreIslandPlacement,
} from './scheduler'

// --- tiny test harness ------------------------------------------------------
let passed = 0
const failures: string[] = []
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}\n    ${(err as Error).message.replace(/\n/g, '\n    ')}`)
  }
}

// --- fixtures ---------------------------------------------------------------
// Build a candidate with sensible defaults; override per case. Region is fixed
// ('us-east') because the scorer assumes the caller already filtered by region.
function island(
  islandId: string,
  over: {
    maxVservers?: number
    currentVserverCount?: number
    activeUsers?: number
    cpuPct?: number
    bandwidthPct?: number
  } = {},
): IslandScoringInput {
  return {
    islandId,
    region: 'us-east',
    maxVservers: over.maxVservers ?? 10,
    currentVserverCount: over.currentVserverCount ?? 0,
    metrics: {
      activeUsers: over.activeUsers ?? 0,
      cpuPct: over.cpuPct ?? 0,
      bandwidthPct: over.bandwidthPct ?? 0,
    },
  }
}

// --- weight math ------------------------------------------------------------

test('ISLAND_LOAD_WEIGHTS reuse placement.ts LOAD_WEIGHTS as the single source', () => {
  // Same numbers, fill-oriented names — NOT a second hardcoded copy.
  assert.equal(ISLAND_LOAD_WEIGHTS.fill, LOAD_WEIGHTS.users)
  assert.equal(ISLAND_LOAD_WEIGHTS.cpu, LOAD_WEIGHTS.cpu)
  assert.equal(ISLAND_LOAD_WEIGHTS.bandwidth, LOAD_WEIGHTS.bandwidth)
  assert.equal(ISLAND_LOAD_WEIGHTS.fill, 0.5)
  assert.equal(ISLAND_LOAD_WEIGHTS.cpu, 0.3)
  assert.equal(ISLAND_LOAD_WEIGHTS.bandwidth, 0.2)
  assert.ok(
    Math.abs(
      ISLAND_LOAD_WEIGHTS.fill + ISLAND_LOAD_WEIGHTS.cpu + ISLAND_LOAD_WEIGHTS.bandwidth - 1,
    ) < 1e-9,
  )
})

test('islandLoadScore applies the (0.5/0.3/0.2) weights exactly to fill/cpu/bw', () => {
  // fill = 5/10 = 0.5 → 0.5*0.5 = 0.25; cpu 0.4 → 0.12; bw 0.25 → 0.05 → 0.42.
  const s = islandLoadScore(
    island('a', { maxVservers: 10, currentVserverCount: 5, cpuPct: 0.4, bandwidthPct: 0.25 }),
  )
  assert.ok(Math.abs(s - 0.42) < 1e-9, `expected 0.42, got ${s}`)
})

test('full saturation scores 1.0; full idle scores 0.0', () => {
  assert.equal(
    islandLoadScore(
      island('a', { maxVservers: 10, currentVserverCount: 10, cpuPct: 1, bandwidthPct: 1 }),
    ),
    1,
  )
  assert.equal(
    islandLoadScore(
      island('a', { maxVservers: 10, currentVserverCount: 0, cpuPct: 0, bandwidthPct: 0 }),
    ),
    0,
  )
})

test('activeUsers does NOT influence the score (fill is the capacity term, not users)', () => {
  const lots = islandLoadScore(island('a', { activeUsers: 9999 }))
  const none = islandLoadScore(island('a', { activeUsers: 0 }))
  assert.equal(lots, none)
})

// --- capacity filtering -----------------------------------------------------

test('isAtCapacity is true at/over the cap and on a non-positive maxVservers', () => {
  assert.equal(isAtCapacity(island('a', { maxVservers: 10, currentVserverCount: 9 })), false)
  assert.equal(isAtCapacity(island('a', { maxVservers: 10, currentVserverCount: 10 })), true)
  assert.equal(isAtCapacity(island('a', { maxVservers: 10, currentVserverCount: 11 })), true)
  assert.equal(isAtCapacity(island('a', { maxVservers: 0, currentVserverCount: 0 })), true)
  assert.equal(isAtCapacity(island('a', { maxVservers: -5, currentVserverCount: 0 })), true)
})

test('islands at the hard cap are dropped from candidacy and reported in atCapacity', () => {
  const result = scoreIslandPlacement([
    island('full', { maxVservers: 5, currentVserverCount: 5 }),
    island('open', { maxVservers: 5, currentVserverCount: 1 }),
  ])
  assert.equal(result.chosen, 'open')
  assert.deepEqual(
    result.ranking.map((r) => r.islandId),
    ['open'],
  )
  assert.deepEqual(result.atCapacity, ['full'])
})

// --- least-loaded wins ------------------------------------------------------

test('the least-loaded island wins; ranking is best→worst', () => {
  const result = scoreIslandPlacement([
    island('busy', { currentVserverCount: 8, cpuPct: 0.9, bandwidthPct: 0.8 }),
    island('idle', { currentVserverCount: 1, cpuPct: 0.05, bandwidthPct: 0.05 }),
    island('mid', { currentVserverCount: 5, cpuPct: 0.5, bandwidthPct: 0.4 }),
  ])
  assert.equal(result.chosen, 'idle')
  assert.deepEqual(
    result.ranking.map((r) => r.islandId),
    ['idle', 'mid', 'busy'],
  )
  assert.equal(result.reason, null)
  assert.deepEqual(result.atCapacity, [])
})

test('fewer vServers but higher CPU can lose to more vServers but low CPU (weights matter)', () => {
  // 'feweVS': fill 1/10=0.1*0.5=0.05, cpu 1.0*0.3=0.3 → 0.35.
  // 'lowCpu': fill 6/10=0.6*0.5=0.30, cpu 0.0      → 0.30. lowCpu wins.
  const result = scoreIslandPlacement([
    island('feweVS', { currentVserverCount: 1, cpuPct: 1, bandwidthPct: 0 }),
    island('lowCpu', { currentVserverCount: 6, cpuPct: 0, bandwidthPct: 0 }),
  ])
  assert.equal(result.chosen, 'lowCpu')
})

// --- deterministic ties -----------------------------------------------------

test('exact score ties break deterministically by lower islandId (input-order independent)', () => {
  const mk = (): IslandScoringInput[] => [
    island('b-isl', { currentVserverCount: 2, cpuPct: 0.2, bandwidthPct: 0.2 }),
    island('a-isl', { currentVserverCount: 2, cpuPct: 0.2, bandwidthPct: 0.2 }),
    island('c-isl', { currentVserverCount: 2, cpuPct: 0.2, bandwidthPct: 0.2 }),
  ]
  const forward = scoreIslandPlacement(mk())
  const reversed = scoreIslandPlacement([...mk()].reverse())
  assert.equal(forward.chosen, 'a-isl')
  assert.equal(reversed.chosen, 'a-isl')
  assert.deepEqual(
    forward.ranking.map((r) => r.islandId),
    ['a-isl', 'b-isl', 'c-isl'],
  )
  assert.deepEqual(
    reversed.ranking.map((r) => r.islandId),
    ['a-isl', 'b-isl', 'c-isl'],
  )
})

// --- all-full → provision signal --------------------------------------------

test('all candidates at capacity → chosen null with reason "no-capacity"', () => {
  const result = scoreIslandPlacement([
    island('a', { maxVservers: 3, currentVserverCount: 3 }),
    island('b', { maxVservers: 1, currentVserverCount: 5 }),
  ])
  assert.equal(result.chosen, null)
  assert.equal(result.reason, 'no-capacity')
  assert.deepEqual(result.ranking, [])
  assert.deepEqual(result.atCapacity.sort(), ['a', 'b'])
})

// --- empty input ------------------------------------------------------------

test('empty candidate list → chosen null with reason "no-capacity"', () => {
  const result = scoreIslandPlacement([])
  assert.equal(result.chosen, null)
  assert.equal(result.reason, 'no-capacity')
  assert.deepEqual(result.ranking, [])
  assert.deepEqual(result.atCapacity, [])
})

// --- out-of-range clamping --------------------------------------------------

test('out-of-range metric fractions are clamped into [0,1]', () => {
  // cpu 2 and bw 5 must clamp to 1; negative clamps to 0. fill 0 here.
  const s = islandLoadScore(island('a', { cpuPct: 2, bandwidthPct: 5 }))
  // 0*0.5 + 1*0.3 + 1*0.2 = 0.5
  assert.ok(Math.abs(s - 0.5) < 1e-9, `expected 0.5, got ${s}`)

  const sNeg = islandLoadScore(island('a', { cpuPct: -1, bandwidthPct: -3 }))
  assert.equal(sNeg, 0)
})

test('NaN / Infinity metric fractions clamp to 0 (treated as no observed pressure)', () => {
  const s = islandLoadScore(
    island('a', { cpuPct: Number.NaN, bandwidthPct: Number.POSITIVE_INFINITY }),
  )
  assert.equal(s, 0)
})

test('a ranked entry exposes the clamped components actually used in the score', () => {
  const result = scoreIslandPlacement([
    island('a', { maxVservers: 4, currentVserverCount: 2, cpuPct: 1.5, bandwidthPct: -0.2, activeUsers: 7 }),
  ])
  const top = result.ranking[0]
  assert.ok(top)
  assert.equal(top.fillFrac, 0.5) // 2/4
  assert.equal(top.cpuPct, 1) // clamped from 1.5
  assert.equal(top.bandwidthPct, 0) // clamped from -0.2
  assert.equal(top.activeUsers, 7) // raw, observability only
  // score = 0.5*0.5 + 1*0.3 + 0*0.2 = 0.55
  assert.ok(Math.abs(top.loadScore - 0.55) < 1e-9)
})

// --- realistic scenario -----------------------------------------------------

test('realistic mix: least-loaded with capacity wins; full ones reported; ranking complete', () => {
  const result = scoreIslandPlacement([
    island('isl-saturated', { maxVservers: 20, currentVserverCount: 20, cpuPct: 0.95 }),
    island('isl-hot', { maxVservers: 20, currentVserverCount: 12, cpuPct: 0.85, bandwidthPct: 0.7 }),
    island('isl-warm', { maxVservers: 20, currentVserverCount: 6, cpuPct: 0.4, bandwidthPct: 0.3 }),
    island('isl-cool', { maxVservers: 20, currentVserverCount: 2, cpuPct: 0.1, bandwidthPct: 0.05 }),
  ])
  assert.equal(result.chosen, 'isl-cool')
  assert.deepEqual(
    result.ranking.map((r) => r.islandId),
    ['isl-cool', 'isl-warm', 'isl-hot'],
  )
  assert.deepEqual(result.atCapacity, ['isl-saturated'])
  assert.equal(result.reason, null)
})

// --- report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ island scheduler scorer: ${failures.length} failed, ${passed} passed\n`)
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`✓ island scheduler scorer: ${passed} passed`)
