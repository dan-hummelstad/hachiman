/**
 * The §12.12 rate limits: every device limit has a second bucket per user.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ApiError } from '@/lib/errors'

import { RateLimits, rateLimitDevice, type DeviceRateLimit, type RateLimiter } from './context'

/** A fixed-window limiter in memory, with one window for the whole test. */
class MemoryRateLimiter implements RateLimiter {
  readonly counts = new Map<string, number>()
  async hit(bucket: string, subject: string, limit: number): Promise<void> {
    const key = `${bucket}:${subject}`
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    if (n > limit) throw new ApiError('RateLimited', 429, `rate limit: ${limit}`)
  }
}

async function hits(rate: RateLimiter, which: DeviceRateLimit, device: { id: string; userId: string }, n: number): Promise<number> {
  let ok = 0
  for (let i = 0; i < n; i++) {
    try {
      await rateLimitDevice({ rate }, which, device)
      ok++
    } catch (err) {
      assert.ok(err instanceof ApiError && err.code === 'RateLimited', String(err))
    }
  }
  return ok
}

const WHICH: DeviceRateLimit[] = ['commits', 'keyPackages', 'inboxPosts', 'backups', 'linkMessages', 'joinRequests', 'inviteBundles']

describe('per-user rate limits (§12.12)', () => {
  for (const which of WHICH) {
    test(`${which}: more devices of one user do not raise the user limit`, async () => {
      const rate = new MemoryRateLimiter()
      const { limit, userLimit } = RateLimits[which]
      assert.ok(userLimit > limit, 'the user limit is above the device limit')
      const devices = Array.from({ length: Math.ceil(userLimit / limit) + 2 }, (_, i) => ({ id: `d${i}`, userId: 'u1' }))
      let ok = 0
      for (const d of devices) ok += await hits(rate, which, d, limit)
      assert.equal(ok, userLimit)

      // The device limit stays: one device alone stops at `limit`.
      assert.equal(await hits(rate, which, { id: 'solo', userId: 'u2' }, limit + 5), limit)
      // Another user has its own bucket.
      assert.equal(await hits(rate, which, { id: 'other', userId: 'u3' }, 1), 1)
    })
  }
})
