import { describe, expect, it } from 'vitest'
import { RESYNC_MAX_ATTEMPTS, ResyncBackoff } from './resync-backoff'

describe('ResyncBackoff', () => {
  it('doubles from 1 s, stops after the last attempt and starts again on reset', () => {
    const b = new ResyncBackoff()
    const delays = Array.from({ length: RESYNC_MAX_ATTEMPTS + 1 }, () => b.next())
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, null])
    expect(b.next()).toBeNull()
    b.reset()
    expect(b.next()).toBe(1_000)
  })
})
