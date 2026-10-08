/**
 * Wrong current passwords on the account page (Redis
 * `takusen:password_attempts:{userId}`, contract §5). After
 * `PASSWORD_ATTEMPTS_MAX` misses in a row, the form pauses for the rest of the
 * window. The window starts at the first miss. A correct password clears it.
 */
import type { Redis } from 'ioredis'

export const PASSWORD_ATTEMPTS_MAX = 5
export const PASSWORD_ATTEMPTS_WINDOW_SECONDS = 15 * 60

export function passwordAttemptsKey(userId: string): string {
  return `takusen:password_attempts:${userId}`
}

export interface AttemptStore {
  /** Misses so far and the seconds until the window ends (0 when there is none). */
  read(userId: string): Promise<{ misses: number; ttlSeconds: number }>
  /** Counts one miss. Returns the misses and the seconds left in the window. */
  miss(userId: string): Promise<{ misses: number; ttlSeconds: number }>
  clear(userId: string): Promise<void>
}

export type AttemptState = { paused: false; attemptsLeft: number } | { paused: true; retryAfterSeconds: number }

export function attemptState(misses: number, ttlSeconds: number): AttemptState {
  if (misses >= PASSWORD_ATTEMPTS_MAX) {
    return { paused: true, retryAfterSeconds: Math.max(1, ttlSeconds) }
  }
  return { paused: false, attemptsLeft: PASSWORD_ATTEMPTS_MAX - misses }
}

const MISS = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('TTL', KEYS[1])}`

export function redisAttemptStore(client: Redis): AttemptStore {
  return {
    async read(userId) {
      const key = passwordAttemptsKey(userId)
      const [misses, ttl] = await Promise.all([client.get(key), client.ttl(key)])
      return { misses: Number(misses ?? 0), ttlSeconds: Math.max(0, ttl) }
    },
    async miss(userId) {
      const [misses, ttl] = (await client.eval(
        MISS,
        1,
        passwordAttemptsKey(userId),
        PASSWORD_ATTEMPTS_WINDOW_SECONDS,
      )) as [number, number]
      return { misses: Number(misses), ttlSeconds: Math.max(0, Number(ttl)) }
    },
    async clear(userId) {
      await client.del(passwordAttemptsKey(userId))
    },
  }
}

/** For tests. */
export class InMemoryAttemptStore implements AttemptStore {
  private readonly rows = new Map<string, { misses: number; endsAt: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  private live(userId: string) {
    const row = this.rows.get(userId)
    if (row && row.endsAt <= this.now()) {
      this.rows.delete(userId)
      return undefined
    }
    return row
  }
  async read(userId: string) {
    const row = this.live(userId)
    return row
      ? { misses: row.misses, ttlSeconds: Math.ceil((row.endsAt - this.now()) / 1000) }
      : { misses: 0, ttlSeconds: 0 }
  }
  async miss(userId: string) {
    const row = this.live(userId) ?? { misses: 0, endsAt: this.now() + PASSWORD_ATTEMPTS_WINDOW_SECONDS * 1000 }
    row.misses++
    this.rows.set(userId, row)
    return this.read(userId)
  }
  async clear(userId: string) {
    this.rows.delete(userId)
  }
}

export type PasswordCheckResult = { ok: true } | ({ ok: false } & AttemptState)

/**
 * Checks the current password unless the user is paused. `verify` runs only
 * when the user may try. A miss after the last try returns the pause.
 */
export async function checkCurrentPassword(
  store: AttemptStore,
  userId: string,
  verify: () => Promise<boolean>,
): Promise<PasswordCheckResult> {
  const before = await store.read(userId)
  const state = attemptState(before.misses, before.ttlSeconds)
  if (state.paused) return { ok: false, ...state }
  if (await verify()) {
    if (before.misses > 0) await store.clear(userId)
    return { ok: true }
  }
  const after = await store.miss(userId)
  return { ok: false, ...attemptState(after.misses, after.ttlSeconds) }
}
