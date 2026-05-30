/**
 * Unit tests for the live island-metrics consumer (`island-metrics.ts`).
 *
 * Self-contained, tsx-runnable assertion script using the same harness style as
 * `placement.test.ts` and `scheduler.test.ts` — no test framework dep. Run it
 * with:
 *
 *   node --import tsx/esm src/lib/island-metrics.test.ts
 *
 * The tests focus on the PARSING + the empty-input / no-Redis fallbacks. We do
 * NOT exercise a real Redis here — the publisher side already has a
 * miniredis-backed integration test (Go side), and exercising ioredis against
 * a real socket here would require docker-up + a port, which is the smoke-test
 * scope, not unit.
 */
import assert from 'node:assert/strict'

import {
  closeIslandMetricsClient,
  getIslandMetrics,
  islandMetricsKey,
  parseMetricsHash,
  setIslandMetricsClient,
  ISLAND_METRICS_FIELDS,
} from './island-metrics'

// --- tiny test harness ------------------------------------------------------
let passed = 0
const failures: string[] = []
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
  } catch (err) {
    failures.push(`${name}\n    ${(err as Error).message.replace(/\n/g, '\n    ')}`)
  }
}

// --- wire-format constants are NOT reinvented per-call ---------------------

await test('islandMetricsKey matches the publisher contract', () => {
  assert.equal(
    islandMetricsKey('550e8400-e29b-41d4-a716-446655440000'),
    'island:550e8400-e29b-41d4-a716-446655440000:metrics',
  )
})

await test('ISLAND_METRICS_FIELDS uses the exact names the publisher writes', () => {
  // These must stay in lock-step with pkg/islandmetrics/publisher.go's
  // Snapshot.fields(). Any rename on one side without the other = silent
  // breakage at runtime; encoding the four names as constants makes a typo
  // surface in this assertion.
  assert.equal(ISLAND_METRICS_FIELDS.activeUsers, 'activeUsers')
  assert.equal(ISLAND_METRICS_FIELDS.cpuPct, 'cpuPct')
  assert.equal(ISLAND_METRICS_FIELDS.bandwidthPct, 'bandwidthPct')
  assert.equal(ISLAND_METRICS_FIELDS.publishedAt, 'publishedAt')
})

// --- parseMetricsHash: happy path -----------------------------------------

await test('parseMetricsHash returns the full reading for a well-formed hash', () => {
  const got = parseMetricsHash({
    activeUsers: '42',
    cpuPct: '0.37',
    bandwidthPct: '0.12',
    publishedAt: '1700000000123',
  })
  assert.deepEqual(got, {
    metrics: { activeUsers: 42, cpuPct: 0.37, bandwidthPct: 0.12 },
    publishedAt: 1700000000123,
  })
})

await test('parseMetricsHash accepts integer-string and float-string fractions', () => {
  // "0" must parse to 0 (publisher writes integer 0 for stubbed CPU/bw).
  const got = parseMetricsHash({
    activeUsers: '0',
    cpuPct: '0',
    bandwidthPct: '1',
    publishedAt: '1',
  })
  assert.deepEqual(got, {
    metrics: { activeUsers: 0, cpuPct: 0, bandwidthPct: 1 },
    publishedAt: 1,
  })
})

await test('parseMetricsHash ignores extra/unknown fields (forward-compatibility)', () => {
  const got = parseMetricsHash({
    activeUsers: '1',
    cpuPct: '0',
    bandwidthPct: '0',
    publishedAt: '0',
    // A future publisher might add e.g. `regionLabel: 'us-east'` — we MUST
    // tolerate that without breaking, so existing islands keep being read
    // during a rolling upgrade.
    futureField: 'whatever',
  })
  assert.ok(got !== null)
  assert.equal(got!.metrics.activeUsers, 1)
})

// --- parseMetricsHash: absence + malformed -------------------------------

await test('parseMetricsHash returns null for null / undefined / empty hash', () => {
  assert.equal(parseMetricsHash(null), null)
  assert.equal(parseMetricsHash(undefined), null)
  assert.equal(parseMetricsHash({}), null)
})

await test('parseMetricsHash returns null when a required field is missing', () => {
  // Each required-field omission must yield null — these are all separate
  // cases so a regression in one doesn't hide behind another.
  assert.equal(
    parseMetricsHash({ cpuPct: '0', bandwidthPct: '0', publishedAt: '0' }),
    null,
    'missing activeUsers',
  )
  assert.equal(
    parseMetricsHash({ activeUsers: '0', bandwidthPct: '0', publishedAt: '0' }),
    null,
    'missing cpuPct',
  )
  assert.equal(
    parseMetricsHash({ activeUsers: '0', cpuPct: '0', publishedAt: '0' }),
    null,
    'missing bandwidthPct',
  )
  assert.equal(
    parseMetricsHash({ activeUsers: '0', cpuPct: '0', bandwidthPct: '0' }),
    null,
    'missing publishedAt',
  )
})

await test('parseMetricsHash returns null when a numeric field is not parseable', () => {
  // Non-numeric in any required field = "no reading" rather than fabricating
  // 0 (which would silently corrupt scoring with a fake "idle" island).
  for (const field of ['activeUsers', 'cpuPct', 'bandwidthPct', 'publishedAt'] as const) {
    const h: Record<string, string> = {
      activeUsers: '1',
      cpuPct: '0.1',
      bandwidthPct: '0.1',
      publishedAt: '1',
    }
    h[field] = 'not-a-number'
    assert.equal(parseMetricsHash(h), null, `field ${field} unparseable`)
  }
})

await test('parseMetricsHash returns null for Infinity / NaN', () => {
  // ioredis returns strings; if an operator HSET's "Infinity" by hand we
  // must treat it as no-reading rather than letting it propagate into the
  // scoring math (where it would dominate the load score).
  assert.equal(
    parseMetricsHash({
      activeUsers: '1',
      cpuPct: 'Infinity',
      bandwidthPct: '0',
      publishedAt: '1',
    }),
    null,
  )
})

// --- getIslandMetrics: empty-input + no-Redis fallbacks ------------------

await test('getIslandMetrics resolves to empty Map for empty input (no Redis call)', async () => {
  // Should NOT touch the client at all — return shape is a real Map.
  const got = await getIslandMetrics([])
  assert.ok(got instanceof Map)
  assert.equal(got.size, 0)
})

await test('getIslandMetrics resolves to empty Map when REDIS_URL is unset', async () => {
  // The singleton client + latched-disabled flag are sticky. Reset via
  // setIslandMetricsClient(null), then unset REDIS_URL to simulate the
  // self-host config and ensure we get the silent no-op fallback.
  await closeIslandMetricsClient()
  const prev = process.env.REDIS_URL
  delete process.env.REDIS_URL
  setIslandMetricsClient(null)
  try {
    const got = await getIslandMetrics(['isl-1', 'isl-2'])
    assert.equal(got.size, 0)
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev
    await closeIslandMetricsClient()
  }
})

// --- getIslandMetrics: with an injected fake client ----------------------

/**
 * The smallest ioredis-shaped fake we need for this code path:
 *   - pipeline() returns an object with hgetall() and exec()
 *   - exec() returns [err, result] tuples per call (ioredis's wire shape)
 *   - quit() is awaited by closeIslandMetricsClient on teardown
 *
 * We intentionally don't reach for a full ioredis mock — only the surface
 * `getIslandMetrics` actually uses, so the test breaks loudly if the consumer
 * starts depending on new methods.
 */
function makeFakeRedis(
  responses: Record<string, Record<string, string>>,
  opts: { execThrows?: boolean; perCallError?: Set<string> } = {},
) {
  const calls: string[] = []
  const pipelineFns = {
    hgetall(key: string) {
      calls.push(key)
      return this
    },
    async exec() {
      if (opts.execThrows) throw new Error('simulated redis transport error')
      return calls.map((k) => {
        if (opts.perCallError?.has(k)) {
          return [new Error('per-key error'), null] as [Error, null]
        }
        const r = responses[k]
        return [null, r ?? null] as [null, Record<string, string> | null]
      })
    },
  }
  return {
    pipeline() {
      // Each pipeline call must start with an empty calls list; reset here
      // (a real ioredis pipeline is one-shot).
      calls.length = 0
      return pipelineFns
    },
    async quit() {
      return 'OK'
    },
  } as unknown as Parameters<typeof setIslandMetricsClient>[0]
}

await test('getIslandMetrics returns one reading per island when all hashes are valid', async () => {
  const client = makeFakeRedis({
    'island:a:metrics': {
      activeUsers: '3',
      cpuPct: '0.2',
      bandwidthPct: '0.1',
      publishedAt: '1000',
    },
    'island:b:metrics': {
      activeUsers: '5',
      cpuPct: '0.4',
      bandwidthPct: '0.3',
      publishedAt: '2000',
    },
  })
  setIslandMetricsClient(client)
  try {
    const got = await getIslandMetrics(['a', 'b'])
    assert.equal(got.size, 2)
    assert.deepEqual(got.get('a'), {
      metrics: { activeUsers: 3, cpuPct: 0.2, bandwidthPct: 0.1 },
      publishedAt: 1000,
    })
    assert.deepEqual(got.get('b'), {
      metrics: { activeUsers: 5, cpuPct: 0.4, bandwidthPct: 0.3 },
      publishedAt: 2000,
    })
  } finally {
    setIslandMetricsClient(null)
  }
})

await test('getIslandMetrics OMITS ids whose key is absent (TTL-expired / never-published)', async () => {
  // The CORE staleness semantic: a missing key → omitted from the map, NOT a
  // fabricated zero reading. The scheduler caller falls back to
  // MISSING_ISLAND_METRICS for absent ids, which is the documented contract.
  const client = makeFakeRedis({
    'island:present:metrics': {
      activeUsers: '1',
      cpuPct: '0',
      bandwidthPct: '0',
      publishedAt: '1',
    },
    // 'island:absent:metrics' intentionally not in the map → fake returns null
  })
  setIslandMetricsClient(client)
  try {
    const got = await getIslandMetrics(['present', 'absent'])
    assert.equal(got.size, 1)
    assert.ok(got.has('present'))
    assert.equal(got.has('absent'), false, 'absent island must be OMITTED, not zeroed')
  } finally {
    setIslandMetricsClient(null)
  }
})

await test('getIslandMetrics tolerates per-key errors (one bad key does not mask the rest)', async () => {
  const client = makeFakeRedis(
    {
      'island:ok:metrics': {
        activeUsers: '2',
        cpuPct: '0',
        bandwidthPct: '0',
        publishedAt: '1',
      },
    },
    { perCallError: new Set(['island:bad:metrics']) },
  )
  setIslandMetricsClient(client)
  try {
    const got = await getIslandMetrics(['ok', 'bad'])
    assert.equal(got.size, 1)
    assert.ok(got.has('ok'))
    assert.equal(got.has('bad'), false)
  } finally {
    setIslandMetricsClient(null)
  }
})

await test('getIslandMetrics returns empty Map when the pipeline transport throws', async () => {
  // Connection refused / timeout / RESP protocol error etc. Must be swallowed
  // — the scheduler keeps going on the MISSING fallback, never throws.
  const client = makeFakeRedis({}, { execThrows: true })
  setIslandMetricsClient(client)
  try {
    const got = await getIslandMetrics(['a', 'b', 'c'])
    assert.equal(got.size, 0)
  } finally {
    setIslandMetricsClient(null)
  }
})

await test('getIslandMetrics omits ids whose hash is malformed (defensive parsing)', async () => {
  const client = makeFakeRedis({
    'island:good:metrics': {
      activeUsers: '1',
      cpuPct: '0',
      bandwidthPct: '0',
      publishedAt: '1',
    },
    'island:bad:metrics': {
      activeUsers: 'NOT_A_NUMBER',
      cpuPct: '0',
      bandwidthPct: '0',
      publishedAt: '1',
    },
  })
  setIslandMetricsClient(client)
  try {
    const got = await getIslandMetrics(['good', 'bad'])
    assert.equal(got.size, 1)
    assert.ok(got.has('good'))
    assert.equal(got.has('bad'), false)
  } finally {
    setIslandMetricsClient(null)
  }
})

// --- report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n✗ island-metrics consumer: ${failures.length} failed, ${passed} passed\n`)
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`✓ island-metrics consumer: ${passed} passed`)
