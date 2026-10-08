/** Wrong current passwords on the account page (password-attempts.ts). */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  checkCurrentPassword,
  InMemoryAttemptStore,
  PASSWORD_ATTEMPTS_MAX,
  PASSWORD_ATTEMPTS_WINDOW_SECONDS,
} from './password-attempts'

describe('checkCurrentPassword', () => {
  test('counts down, pauses after the last miss, and skips verify while paused', async () => {
    let now = 0
    const store = new InMemoryAttemptStore(() => now)
    let verifies = 0
    const wrong = async () => {
      verifies++
      return false
    }
    for (let left = PASSWORD_ATTEMPTS_MAX - 1; left > 0; left--) {
      assert.deepEqual(await checkCurrentPassword(store, 'u', wrong), { ok: false, paused: false, attemptsLeft: left })
    }
    assert.deepEqual(await checkCurrentPassword(store, 'u', wrong), {
      ok: false,
      paused: true,
      retryAfterSeconds: PASSWORD_ATTEMPTS_WINDOW_SECONDS,
    })
    const paused = await checkCurrentPassword(store, 'u', async () => true)
    assert.equal(paused.ok, false)
    assert.equal(verifies, PASSWORD_ATTEMPTS_MAX)

    now += PASSWORD_ATTEMPTS_WINDOW_SECONDS * 1000
    assert.deepEqual(await checkCurrentPassword(store, 'u', async () => true), { ok: true })
  })

  test('a correct password clears the misses', async () => {
    const store = new InMemoryAttemptStore(() => 0)
    await checkCurrentPassword(store, 'u', async () => false)
    assert.deepEqual(await checkCurrentPassword(store, 'u', async () => true), { ok: true })
    assert.deepEqual(await store.read('u'), { misses: 0, ttlSeconds: 0 })
  })

  test('users do not share a counter', async () => {
    const store = new InMemoryAttemptStore(() => 0)
    await checkCurrentPassword(store, 'a', async () => false)
    assert.deepEqual(await checkCurrentPassword(store, 'b', async () => false), {
      ok: false,
      paused: false,
      attemptsLeft: PASSWORD_ATTEMPTS_MAX - 1,
    })
  })
})
