/**
 * The dependencies of the DS services. Routes and the gRPC process build the
 * production set with `dsDeps()`. Tests build their own with fakes.
 */
import { ApiError } from '@/lib/errors'
import { redis } from '@/lib/events'

import { dsConfig, type DsConfig } from './config'
import { getDsModule, getDsSigner, type DsModule, type DsSigner } from './crypto'
import { loadOrCreateSeed } from './keys'

/** Who is online: the gateway key `device_online:{deviceId}` (§5). */
export interface Presence {
  onlineDevices(deviceIds: readonly string[]): Promise<Set<string>>
}

/** Fixed-window counters. `hit` throws 429 RateLimited with Retry-After. */
export interface RateLimiter {
  hit(bucket: string, subject: string, limit: number, windowSec: number): Promise<void>
}

export interface DsDeps {
  ds: DsModule
  signer: DsSigner
  config: DsConfig
  presence: Presence
  rate: RateLimiter
  now(): Date
}

/** The parts of DsDeps that need no ts-mls (membership changes, scheduler choice). */
export type LightDeps = Pick<DsDeps, 'config' | 'presence' | 'now'>

export const redisPresence: Presence = {
  async onlineDevices(deviceIds) {
    if (deviceIds.length === 0) return new Set()
    const values = await redis().mget(...deviceIds.map((id) => `device_online:${id}`))
    return new Set(deviceIds.filter((_, i) => values[i] !== null))
  },
}

export const redisRateLimiter: RateLimiter = {
  async hit(bucket, subject, limit, windowSec) {
    const window = Math.floor(Date.now() / 1000 / windowSec)
    const key = `takusen:rl:${bucket}:${subject}:${window}`
    const client = redis()
    const n = await client.incr(key)
    if (n === 1) await client.expire(key, windowSec)
    if (n > limit) {
      const retryAfter = (window + 1) * windowSec - Date.now() / 1000
      throw new ApiError('RateLimited', 429, `rate limit: ${limit} per ${windowSec} s`, undefined, retryAfter)
    }
  },
}

/** The §12.12 rate limits. */
export const RateLimits = {
  keyPackages: { bucket: 'kp', limit: 10, windowSec: 60 },
  commits: { bucket: 'commit', limit: 30, windowSec: 60 },
  joinRequests: { bucket: 'join', limit: 30, windowSec: 60 },
  inboxPosts: { bucket: 'inbox', limit: 60, windowSec: 60 },
  linkMessages: { bucket: 'linkmsg', limit: 30, windowSec: 60 },
  linkSessions: { bucket: 'linksess', limit: 5, windowSec: 3600 },
  backups: { bucket: 'backup', limit: 60, windowSec: 3600 },
  /** Per user, not per device. */
  reports: { bucket: 'report', limit: 10, windowSec: 3600 },
} as const

export async function rateLimit(deps: Pick<DsDeps, 'rate'>, which: keyof typeof RateLimits, subject: string): Promise<void> {
  const r = RateLimits[which]
  await deps.rate.hit(r.bucket, subject, r.limit, r.windowSec)
}

let cached: Promise<DsDeps> | null = null

/** The production dependencies. One set per process. */
export function dsDeps(): Promise<DsDeps> {
  cached ??= (async () => {
    const config = dsConfig()
    const ds = await getDsModule()
    const signer = await getDsSigner(() => loadOrCreateSeed(config.dsKeyPath))
    return { ds, signer, config, presence: redisPresence, rate: redisRateLimiter, now: () => new Date() }
  })()
  cached.catch(() => {
    cached = null
  })
  return cached
}

export function lightDeps(): LightDeps {
  return { config: dsConfig(), presence: redisPresence, now: () => new Date() }
}
