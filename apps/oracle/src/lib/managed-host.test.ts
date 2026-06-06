/**
 * Unit tests for `resolveServerEndpoint` / `ManagedGatewayNotConfiguredError`.
 *
 * Lives in this DB-free sibling on purpose: importing `lib/servers.ts` boots
 * `db/client.ts`, which throws when `DATABASE_URL` is unset and would make
 * the test file unrunnable in pure CI. `lib/managed-host.ts` has zero side
 * effects, so we can exercise the env-not-set 503 path with just a
 * `delete process.env.TAKUSEN_MANAGED_GATEWAY_HOST`.
 *
 * Mirrors the harness used in the sibling test files
 * (`placement.test.ts`, `scheduler.test.ts`, `island-metrics.test.ts`,
 * `server-schemas.test.ts`): `node:assert/strict` + a tiny harness, runnable
 * via `node --import tsx src/lib/managed-host.test.ts` (or `pnpm -F
 * @hachiman/oracle test`, which `&&`s all the test files together).
 */
import assert from 'node:assert/strict'

import {
  MANAGED_GATEWAY_HOST_ENV,
  MANAGED_SERVER_PORT,
  ManagedGatewayNotConfiguredError,
  resolveServerEndpoint,
} from './managed-host'
import type { z } from 'zod'

import type { createServerSchema } from './server-schemas'

type ParsedCreateServer = z.infer<typeof createServerSchema>

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

// Each test snapshots + restores TAKUSEN_MANAGED_GATEWAY_HOST so they don't
// leak through global env state.
function withEnv(value: string | undefined, fn: () => void): void {
  const before = process.env[MANAGED_GATEWAY_HOST_ENV]
  if (value === undefined) {
    delete process.env[MANAGED_GATEWAY_HOST_ENV]
  } else {
    process.env[MANAGED_GATEWAY_HOST_ENV] = value
  }
  try {
    fn()
  } finally {
    if (before === undefined) {
      delete process.env[MANAGED_GATEWAY_HOST_ENV]
    } else {
      process.env[MANAGED_GATEWAY_HOST_ENV] = before
    }
  }
}

// --- self-hosted branch -----------------------------------------------------
test('self-hosted echoes the supplied host + port', () => {
  const input: ParsedCreateServer = {
    mode: 'self-hosted',
    name: 'X',
    slug: 'x',
    host: 'mumble.example.com',
    port: 64737,
  }
  const result = resolveServerEndpoint(input)
  assert.deepEqual(result, { host: 'mumble.example.com', port: 64737 })
})

test('self-hosted defaults port to 64738 when omitted', () => {
  const input: ParsedCreateServer = {
    mode: 'self-hosted',
    name: 'X',
    slug: 'x',
    host: 'mumble.example.com',
  }
  const result = resolveServerEndpoint(input)
  assert.equal(result.port, 64738)
})

test('self-hosted ignores the env even when set', () => {
  // Defensive: a managed gateway env must NEVER override a user-supplied
  // self-host. The schema's discriminated union already guarantees we hit
  // the self-hosted branch here, but the resolver is the last line of
  // defense — explicitly assert it does not consult the env on this path.
  withEnv('gateway.example.com', () => {
    const result = resolveServerEndpoint({
      mode: 'self-hosted',
      name: 'X',
      slug: 'x',
      host: 'mumble.example.com',
    })
    assert.equal(result.host, 'mumble.example.com')
  })
})

// --- managed branch ---------------------------------------------------------
test('managed throws ManagedGatewayNotConfiguredError when env is unset', () => {
  withEnv(undefined, () => {
    assert.throws(
      () =>
        resolveServerEndpoint({
          mode: 'managed',
          name: 'X',
          slug: 'x',
        }),
      ManagedGatewayNotConfiguredError,
    )
  })
})

test('managed throws when env is set to an empty string', () => {
  withEnv('', () => {
    assert.throws(
      () =>
        resolveServerEndpoint({
          mode: 'managed',
          name: 'X',
          slug: 'x',
        }),
      ManagedGatewayNotConfiguredError,
    )
  })
})

test('managed throws when env is whitespace-only', () => {
  withEnv('   ', () => {
    assert.throws(
      () =>
        resolveServerEndpoint({
          mode: 'managed',
          name: 'X',
          slug: 'x',
        }),
      ManagedGatewayNotConfiguredError,
    )
  })
})

test('managed stamps host from env, port from MANAGED_SERVER_PORT', () => {
  withEnv('gateway.hachiman.moe', () => {
    const result = resolveServerEndpoint({
      mode: 'managed',
      name: 'X',
      slug: 'x',
    })
    assert.deepEqual(result, {
      host: 'gateway.hachiman.moe',
      port: MANAGED_SERVER_PORT,
    })
  })
})

test('managed trims whitespace around the env value', () => {
  withEnv('  gateway.hachiman.moe  ', () => {
    const result = resolveServerEndpoint({
      mode: 'managed',
      name: 'X',
      slug: 'x',
    })
    assert.equal(result.host, 'gateway.hachiman.moe')
  })
})

test('error message names the env var verbatim', () => {
  // The 503 surface forwards `error.message` to the dashboard. We rely on
  // the env var name appearing in the message so the operator can find
  // exactly what to set without leaving the failure toast.
  withEnv(undefined, () => {
    try {
      resolveServerEndpoint({
        mode: 'managed',
        name: 'X',
        slug: 'x',
      })
      assert.fail('expected throw')
    } catch (err) {
      assert.ok(err instanceof ManagedGatewayNotConfiguredError)
      assert.match(err.message, /TAKUSEN_MANAGED_GATEWAY_HOST/)
    }
  })
})

// --- report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`✗ managed-host: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ managed-host: ${passed} passed`)
