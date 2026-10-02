/**
 * Unit tests for the pure admin API helpers: list paging, the self-change
 * guard and the media-node summary. No DB / Redis.
 *
 * Run with `tsx src/lib/admin.test.ts` (part of `pnpm -F @hachiman/takusen test`).
 */
import assert from 'node:assert/strict'

import type { MediaNode } from '@/db/schema'
import { ConflictError, ValidationError } from './errors'
import {
  ADMIN_PAGE_DEFAULT,
  assertAdminChange,
  decodeCursor,
  encodeCursor,
  likePattern,
  parseListQuery,
  summarizeMediaNodes,
  toAdminMediaNode,
  toPage,
} from './admin'

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

const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000a2'
const C = '00000000-0000-4000-8000-0000000000a3'
const TS = '2026-10-02T12:00:00.123456Z'

// --- cursor -----------------------------------------------------------------
test('cursor round-trips the microsecond timestamp and id', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ ts: TS, id: A })), { ts: TS, id: A })
})

test('cursor rejects garbage, a bad id, a bad timestamp and extra fields', () => {
  const bad = (s: string) => Buffer.from(s).toString('base64url')
  for (const raw of ['', 'nope', bad(`${TS}|x`), bad(`yesterday|${A}`), bad(`2026-10-02 12:00:00+00|${A}`), bad(`${TS}|${A}|1`), bad(`'; drop|${A}`)]) {
    assert.throws(() => decodeCursor(raw), ValidationError, raw)
  }
})

test('toPage returns a cursor only when the extra row exists', () => {
  const rows = [A, B, C].map((id) => ({ id, cursor: TS }))
  const full = toPage(rows, 2, (r) => r.id)
  assert.deepEqual(full.items, [A, B])
  assert.deepEqual(decodeCursor(full.nextCursor ?? ''), { ts: TS, id: B })
  assert.equal(toPage(rows, 3, (r) => r.id).nextCursor, null)
  assert.deepEqual(toPage([], 3, (r: { id: string; cursor: string }) => r.id), { items: [], nextCursor: null })
})

// --- list query -------------------------------------------------------------
test('list query defaults and trims', () => {
  assert.deepEqual(parseListQuery(new URLSearchParams()), { query: '', cursor: null, limit: ADMIN_PAGE_DEFAULT })
  const q = parseListQuery(new URLSearchParams({ query: '  bob ', limit: '10', cursor: encodeCursor({ ts: TS, id: A }) }))
  assert.deepEqual(q, { query: 'bob', cursor: { ts: TS, id: A }, limit: 10 })
  assert.equal(parseListQuery(new URLSearchParams({ cursor: '' })).cursor, null)
})

test('list query rejects bad limits and cursors', () => {
  assert.throws(() => parseListQuery(new URLSearchParams({ limit: '0' })))
  assert.throws(() => parseListQuery(new URLSearchParams({ limit: '101' })))
  assert.throws(() => parseListQuery(new URLSearchParams({ cursor: 'nope' })), ValidationError)
})

test('likePattern escapes LIKE metacharacters', () => {
  assert.equal(likePattern('bob'), '%bob%')
  assert.equal(likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%')
})

// --- self-change guard ------------------------------------------------------
test('an admin cannot demote or delete themselves', () => {
  assert.throws(() => assertAdminChange(A, A, 'demote'), ConflictError)
  assert.throws(() => assertAdminChange(A, A, 'demote'), /own admin role/)
  assert.throws(() => assertAdminChange(A, A, 'delete'), /own account/)
})

test('other users can be changed', () => {
  assert.doesNotThrow(() => assertAdminChange(A, B, 'demote'))
  assert.doesNotThrow(() => assertAdminChange(A, C, 'delete'))
})

// --- media nodes ------------------------------------------------------------
const NOW = new Date('2026-10-02T12:00:00Z')
function node(nodeId: string, status: string, ageMs: number, activeSessions: number): MediaNode {
  return {
    nodeId,
    region: 'us-east',
    capacity: { cpu_cores: 0, max_sessions: 100 },
    activeSessions,
    cpuFraction: 0,
    lastHeartbeatAt: new Date(NOW.getTime() - ageMs),
    version: 'v',
    status,
    adminDrain: false,
    signalingUrl: '',
  }
}

test('stale uses the same boundary as placement (fresh only strictly inside the window)', () => {
  assert.equal(toAdminMediaNode(node('a', 'active', 29_999, 0), NOW, 30_000).stale, false)
  assert.equal(toAdminMediaNode(node('a', 'active', 30_000, 0), NOW, 30_000).stale, true)
})

test('summary counts fresh nodes by status and stale ones apart', () => {
  const nodes = [
    node('a', 'active', 1_000, 5),
    node('b', 'draining', 1_000, 2),
    node('c', 'active', 60_000, 9),
    node('d', 'dead', 60_000, 0),
  ].map((n) => toAdminMediaNode(n, NOW, 30_000))
  assert.deepEqual(summarizeMediaNodes(nodes), {
    total: 4,
    active: 1,
    draining: 1,
    stale: 2,
    sessions: 7,
    capacity: 100,
  })
})

// --- report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`admin.test: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`admin.test: ${passed} passed`)
