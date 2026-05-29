/**
 * Unit tests for the pure placement scorer (`placement.ts`).
 *
 * Oracle has no vitest/jest wired and we must not add deps, so this is a
 * self-contained, tsx-runnable assertion script (`node:assert/strict` + a tiny
 * harness). Run it with `pnpm -F @hachiman/oracle test` (→ `tsx src/lib/placement.test.ts`).
 * Exits non-zero if any case fails so it works in CI.
 */
import assert from 'node:assert/strict'

import {
  LOAD_WEIGHTS,
  loadScore,
  scorePlacement,
  type RegionCandidate,
} from './placement'

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

// --- affinity dominance -----------------------------------------------------

test('lowest RTT wins outright when RTTs differ beyond the tolerance band', () => {
  const result = scorePlacement([
    { code: 'us-east', rttMs: 80 },
    { code: 'us-west', rttMs: 20 },
    { code: 'eu-west', rttMs: 140 },
  ])
  assert.equal(result.recommended, 'us-west')
  assert.deepEqual(
    result.ranking.map((r) => r.code),
    ['us-west', 'us-east', 'eu-west'],
  )
})

test('a far but empty region NEVER beats a near but busy region (affinity dominates load)', () => {
  // us-west is 20ms and fully loaded; eu-west is 120ms and idle. Affinity must
  // dominate: the 100ms gap is far outside the tolerance band, so us-west wins
  // despite being maxed out.
  const result = scorePlacement([
    {
      code: 'us-west',
      rttMs: 20,
      load: { activeUsers: 100, maxUsers: 100, cpuPct: 0.99, bandwidthPct: 0.99 },
    },
    {
      code: 'eu-west',
      rttMs: 120,
      load: { activeUsers: 0, maxUsers: 100, cpuPct: 0, bandwidthPct: 0 },
    },
  ])
  assert.equal(result.recommended, 'us-west')
})

test('a small RTT edge outside tolerance still wins regardless of heavy load', () => {
  // Gap is 16ms (> default 15ms tolerance) so RTT decides; the closer region is
  // saturated, the farther one idle — closer still wins.
  const result = scorePlacement([
    { code: 'near', rttMs: 30, load: { activeUsers: 99, maxUsers: 100, cpuPct: 0.95, bandwidthPct: 0.9 } },
    { code: 'far', rttMs: 46, load: { activeUsers: 0, maxUsers: 100, cpuPct: 0, bandwidthPct: 0 } },
  ])
  assert.equal(result.recommended, 'near')
})

// --- load tiebreak (within tolerance band) ----------------------------------

test('within the RTT tolerance band, the less-loaded region wins', () => {
  // 25ms vs 30ms → within default 15ms band → load decides. eu is less loaded.
  const result = scorePlacement([
    { code: 'us', rttMs: 25, load: { activeUsers: 90, maxUsers: 100, cpuPct: 0.8, bandwidthPct: 0.7 } },
    { code: 'eu', rttMs: 30, load: { activeUsers: 10, maxUsers: 100, cpuPct: 0.1, bandwidthPct: 0.1 } },
  ])
  assert.equal(result.recommended, 'eu')
})

test('custom (tighter) tolerance flips a load tiebreak back to pure RTT', () => {
  // Same inputs as above but tolerance 3ms < 5ms gap → RTT dominates → us wins
  // even though it is more loaded.
  const result = scorePlacement(
    [
      { code: 'us', rttMs: 25, load: { activeUsers: 90, maxUsers: 100, cpuPct: 0.8, bandwidthPct: 0.7 } },
      { code: 'eu', rttMs: 30, load: { activeUsers: 10, maxUsers: 100, cpuPct: 0.1, bandwidthPct: 0.1 } },
    ],
    { rttToleranceMs: 3 },
  )
  assert.equal(result.recommended, 'us')
})

// --- weight math ------------------------------------------------------------

test('loadScore applies the (0.5/0.3/0.2) weights exactly', () => {
  const s = loadScore({ activeUsers: 50, maxUsers: 100, cpuPct: 0.4, bandwidthPct: 0.25 })
  // 0.5*0.5 + 0.4*0.3 + 0.25*0.2 = 0.25 + 0.12 + 0.05 = 0.42
  assert.ok(s !== null)
  assert.ok(Math.abs(s! - 0.42) < 1e-9, `expected 0.42, got ${s}`)
})

test('LOAD_WEIGHTS sum to 1 and match the documented split', () => {
  assert.equal(LOAD_WEIGHTS.users, 0.5)
  assert.equal(LOAD_WEIGHTS.cpu, 0.3)
  assert.equal(LOAD_WEIGHTS.bandwidth, 0.2)
  assert.ok(
    Math.abs(LOAD_WEIGHTS.users + LOAD_WEIGHTS.cpu + LOAD_WEIGHTS.bandwidth - 1) < 1e-9,
  )
})

test('full saturation scores 1.0; full idle scores 0.0', () => {
  assert.equal(loadScore({ activeUsers: 100, maxUsers: 100, cpuPct: 1, bandwidthPct: 1 }), 1)
  assert.equal(loadScore({ activeUsers: 0, maxUsers: 100, cpuPct: 0, bandwidthPct: 0 }), 0)
})

test('out-of-range load components are clamped into [0,1]', () => {
  // activeUsers > maxUsers and cpu/bandwidth > 1 must not push the score past 1.
  const s = loadScore({ activeUsers: 200, maxUsers: 100, cpuPct: 2, bandwidthPct: 5 })
  assert.equal(s, 1)
})

// --- missing metrics --------------------------------------------------------

test('loadScore is null when no load object is provided', () => {
  assert.equal(loadScore(undefined), null)
})

test('loadScore is null when the load object has no usable fields', () => {
  assert.equal(loadScore({}), null)
  // activeUsers without maxUsers (or maxUsers 0) cannot form a utilisation frac.
  assert.equal(loadScore({ activeUsers: 10 }), null)
  assert.equal(loadScore({ activeUsers: 10, maxUsers: 0 }), null)
})

test('partial load metrics only count the dimensions present', () => {
  // Only cpu known → 0.6 * 0.3 = 0.18 (users + bandwidth contribute 0).
  const s = loadScore({ cpuPct: 0.6 })
  assert.ok(s !== null)
  assert.ok(Math.abs(s! - 0.18) < 1e-9, `expected 0.18, got ${s}`)
})

test('candidates with no measured RTT are unrankable, not chosen', () => {
  const result = scorePlacement([
    { code: 'us-east', rttMs: null },
    { code: 'us-west', rttMs: 40 },
    { code: 'eu-west' }, // rttMs undefined
    { code: 'ap-southeast', rttMs: Number.NaN },
  ])
  assert.equal(result.recommended, 'us-west')
  assert.deepEqual(
    result.ranking.map((r) => r.code),
    ['us-west'],
  )
  assert.deepEqual(result.unrankable.sort(), ['ap-southeast', 'eu-west', 'us-east'])
})

test('within the band, a region with KNOWN load beats one with UNKNOWN load', () => {
  // Both within tolerance (5ms apart). 'known' has explicit (low) load; 'mystery'
  // has none. We prefer the one we can actually balance against.
  const result = scorePlacement([
    { code: 'mystery', rttMs: 50 },
    { code: 'known', rttMs: 55, load: { activeUsers: 10, maxUsers: 100 } },
  ])
  assert.equal(result.recommended, 'known')
})

// --- exact ties / determinism ----------------------------------------------

test('identical RTT and identical load tie-break deterministically by code', () => {
  const load = { activeUsers: 10, maxUsers: 100, cpuPct: 0.1, bandwidthPct: 0.1 }
  const a = scorePlacement([
    { code: 'b-region', rttMs: 40, load },
    { code: 'a-region', rttMs: 40, load },
  ])
  const b = scorePlacement([
    { code: 'a-region', rttMs: 40, load },
    { code: 'b-region', rttMs: 40, load },
  ])
  // Order is input-independent (stable, deterministic) and alphabetical on code.
  assert.equal(a.recommended, 'a-region')
  assert.equal(b.recommended, 'a-region')
  assert.deepEqual(a.ranking.map((r) => r.code), b.ranking.map((r) => r.code))
})

test('equal-RTT, equal-load regions both rank (no candidate is dropped)', () => {
  const load = { activeUsers: 0, maxUsers: 100 }
  const result = scorePlacement([
    { code: 'x', rttMs: 30, load },
    { code: 'y', rttMs: 30, load },
    { code: 'z', rttMs: 30, load },
  ])
  assert.equal(result.ranking.length, 3)
  assert.deepEqual(result.ranking.map((r) => r.code), ['x', 'y', 'z'])
})

// --- empty / edge -----------------------------------------------------------

test('empty candidate list yields a null recommendation and empty ranking', () => {
  const result = scorePlacement([] as RegionCandidate[])
  assert.equal(result.recommended, null)
  assert.deepEqual(result.ranking, [])
  assert.deepEqual(result.unrankable, [])
})

test('all-unrankable list yields a null recommendation', () => {
  const result = scorePlacement([{ code: 'a' }, { code: 'b', rttMs: null }])
  assert.equal(result.recommended, null)
  assert.deepEqual(result.unrankable.sort(), ['a', 'b'])
})

test('a zero-RTT (loopback / co-located) measurement is valid and wins', () => {
  const result = scorePlacement([
    { code: 'local', rttMs: 0 },
    { code: 'remote', rttMs: 50 },
  ])
  assert.equal(result.recommended, 'local')
})

// --- realistic three-region scenario ----------------------------------------

test('realistic mix: nearest region chosen; ties broken by load; ranking complete', () => {
  const result = scorePlacement([
    { code: 'us-east', rttMs: 28, load: { activeUsers: 80, maxUsers: 100, cpuPct: 0.7, bandwidthPct: 0.6 } },
    { code: 'us-west', rttMs: 35, load: { activeUsers: 5, maxUsers: 100, cpuPct: 0.05, bandwidthPct: 0.05 } },
    { code: 'eu-west', rttMs: 95, load: { activeUsers: 1, maxUsers: 100, cpuPct: 0.02, bandwidthPct: 0.02 } },
    { code: 'ap-southeast', rttMs: 210 },
  ])
  // us-east (28) and us-west (35) are within the 15ms band → load decides → the
  // far-less-loaded us-west wins. eu-west (95) and ap-southeast (210) follow by RTT.
  assert.equal(result.recommended, 'us-west')
  assert.deepEqual(
    result.ranking.map((r) => r.code),
    ['us-west', 'us-east', 'eu-west', 'ap-southeast'],
  )
  assert.deepEqual(result.unrankable, [])
})

// --- report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ placement scorer: ${failures.length} failed, ${passed} passed\n`)
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`✓ placement scorer: ${passed} passed`)
