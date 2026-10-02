/**
 * Unit tests for the shared CORS allowlist (`allowed-origins.ts`), used by the
 * /api/* middleware and panva's `clientBasedCORS`. tsx-runnable assertion script
 * (`pnpm -F @hachiman/oracle test`); exits non-zero on failure.
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_ALLOWED_ORIGINS,
  ELECTRON_RENDERER_ORIGIN,
  getAllowedOrigins,
  isAllowedOrigin,
} from './allowed-origins'

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

const defaults = getAllowedOrigins(undefined)

test('Origin: null and empty origins are rejected', () => {
  for (const origin of ['null', '', null, undefined]) {
    assert.equal(isAllowedOrigin(origin, defaults), false)
  }
})

test('null in TAKUSEN_ALLOWED_ORIGINS is dropped, not allowed', () => {
  const allowed = getAllowedOrigins('https://a.example, null ,')
  assert.deepEqual(allowed, ['https://a.example'])
  assert.equal(isAllowedOrigin('null', allowed), false)
})

test('hachiman://app is allowed by default', () => {
  assert.ok(DEFAULT_ALLOWED_ORIGINS.includes(ELECTRON_RENDERER_ORIGIN))
  assert.equal(isAllowedOrigin('hachiman://app', defaults), true)
  assert.equal(isAllowedOrigin('http://localhost:5173', defaults), true)
  assert.equal(isAllowedOrigin('hachiman://evil', defaults), false)
  assert.equal(isAllowedOrigin('https://evil.example', defaults), false)
})

test('TAKUSEN_ALLOWED_ORIGINS overrides the defaults entirely', () => {
  const allowed = getAllowedOrigins(' https://hachiman.example.com ,hachiman://app')
  assert.deepEqual(allowed, ['https://hachiman.example.com', 'hachiman://app'])
  assert.equal(isAllowedOrigin('https://hachiman.example.com', allowed), true)
  assert.equal(isAllowedOrigin('hachiman://app', allowed), true)
  assert.equal(isAllowedOrigin('http://localhost:5173', allowed), false)

  const webOnly = getAllowedOrigins('https://hachiman.example.com')
  assert.equal(isAllowedOrigin('hachiman://app', webOnly), false)
})

test('default arg reads process.env.TAKUSEN_ALLOWED_ORIGINS', () => {
  const prev = process.env.TAKUSEN_ALLOWED_ORIGINS
  try {
    process.env.TAKUSEN_ALLOWED_ORIGINS = 'https://only.example'
    assert.equal(isAllowedOrigin('https://only.example'), true)
    assert.equal(isAllowedOrigin('hachiman://app'), false)
    delete process.env.TAKUSEN_ALLOWED_ORIGINS
    assert.equal(isAllowedOrigin('hachiman://app'), true)
  } finally {
    if (prev === undefined) delete process.env.TAKUSEN_ALLOWED_ORIGINS
    else process.env.TAKUSEN_ALLOWED_ORIGINS = prev
  }
})

// --- report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n✗ allowed origins: ${failures.length} failed, ${passed} passed\n`)
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`✓ allowed origins: ${passed} passed`)
