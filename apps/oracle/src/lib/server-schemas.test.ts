/**
 * Unit tests for the `createServerSchema` discriminated union.
 *
 * Pure (no DB / no env) — mirrors the other Oracle test files
 * (`placement.test.ts`, `scheduler.test.ts`, `island-metrics.test.ts`):
 * `node:assert/strict` + a tiny harness, runnable via
 * `node --import tsx src/lib/server-schemas.test.ts` (or `pnpm -F
 * @hachiman/oracle test`, which `&&`s all four files together).
 */
import assert from 'node:assert/strict'

import { createServerSchema } from './server-schemas'

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

// --- self-hosted branch -----------------------------------------------------
test('self-hosted accepts a valid DNS host + custom port', () => {
  const parsed = createServerSchema.parse({
    mode: 'self-hosted',
    name: 'My Server',
    slug: 'my-server',
    host: 'mumble.example.com',
    port: 64737,
  })
  assert.equal(parsed.mode, 'self-hosted')
  // Type-narrowed: only the self-hosted branch has host/port.
  if (parsed.mode === 'self-hosted') {
    assert.equal(parsed.host, 'mumble.example.com')
    assert.equal(parsed.port, 64737)
  }
})

test('self-hosted accepts "localhost" (relaxed for dev / single-island deployments)', () => {
  // The strict DNS-only rule was relaxed so localhost / IPv4 / IPv6 are
  // accepted; public-directory inclusion is still gated by the separate DNS
  // verification challenge, so the relaxation doesn't expose non-DNS rows.
  const res = createServerSchema.safeParse({
    mode: 'self-hosted',
    name: 'Dev Server',
    slug: 'dev-server',
    host: 'localhost',
  })
  assert.equal(res.success, true)
})

test('self-hosted accepts an IPv4 literal', () => {
  const res = createServerSchema.safeParse({
    mode: 'self-hosted',
    name: 'Internal',
    slug: 'internal',
    host: '10.0.0.4',
  })
  assert.equal(res.success, true)
})

test('self-hosted rejects garbage (whitespace, no dots, not an IP)', () => {
  const res = createServerSchema.safeParse({
    mode: 'self-hosted',
    name: 'Broken',
    slug: 'broken',
    host: 'not a host',
  })
  assert.equal(res.success, false)
})

test('self-hosted rejects a missing host', () => {
  const res = createServerSchema.safeParse({
    mode: 'self-hosted',
    name: 'My Server',
    slug: 'my-server',
  })
  assert.equal(res.success, false)
})

test('self-hosted allows port to be omitted (server defaults to 64738)', () => {
  const res = createServerSchema.safeParse({
    mode: 'self-hosted',
    name: 'My Server',
    slug: 'my-server',
    host: 'mumble.example.com',
  })
  assert.equal(res.success, true)
})

test('self-hosted rejects a port outside 1..65535', () => {
  const res = createServerSchema.safeParse({
    mode: 'self-hosted',
    name: 'My Server',
    slug: 'my-server',
    host: 'mumble.example.com',
    port: 70000,
  })
  assert.equal(res.success, false)
})

// --- managed branch ---------------------------------------------------------
test('managed accepts the minimal payload (name + slug)', () => {
  const parsed = createServerSchema.parse({
    mode: 'managed',
    name: 'My Managed Server',
    slug: 'my-managed-server',
  })
  assert.equal(parsed.mode, 'managed')
  assert.equal(parsed.name, 'My Managed Server')
  assert.equal(parsed.slug, 'my-managed-server')
})

test('managed accepts region + description', () => {
  const parsed = createServerSchema.parse({
    mode: 'managed',
    name: 'My Managed Server',
    slug: 'my-managed-server',
    region: 'us-east',
    description: 'Friends-only',
  })
  assert.equal(parsed.region, 'us-east')
  assert.equal(parsed.description, 'Friends-only')
})

test('managed STRIPS any host/port the client tries to send', () => {
  // Defense-in-depth: even if a stale or malicious client sends host/port on
  // the managed branch, the schema must not propagate them — the server
  // stamps host from TAKUSEN_MANAGED_GATEWAY_HOST and port from the
  // hardcoded Mumble default.
  const parsed = createServerSchema.parse({
    mode: 'managed',
    name: 'My Managed Server',
    slug: 'my-managed-server',
    host: 'attacker.example.com',
    port: 1234,
  })
  assert.ok(!('host' in parsed), 'managed branch must not pass through host')
  assert.ok(!('port' in parsed), 'managed branch must not pass through port')
})

test('managed still rejects an invalid slug', () => {
  const res = createServerSchema.safeParse({
    mode: 'managed',
    name: 'My Managed Server',
    slug: 'No Spaces Allowed',
  })
  assert.equal(res.success, false)
})

// --- discriminator ----------------------------------------------------------
test('missing mode is rejected (discriminator required)', () => {
  const res = createServerSchema.safeParse({
    name: 'My Server',
    slug: 'my-server',
    host: 'mumble.example.com',
  })
  assert.equal(res.success, false)
})

test('unknown mode value is rejected', () => {
  const res = createServerSchema.safeParse({
    mode: 'shared',
    name: 'My Server',
    slug: 'my-server',
  })
  assert.equal(res.success, false)
})

// --- report ------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`✗ createServerSchema: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ createServerSchema: ${passed} passed`)
