/**
 * The dependencies of the DS services. Routes and the gRPC process build the
 * production set with `dsDeps()`. Tests build their own with fakes.
 */
import { ApiError } from '@/lib/errors'
import { redis } from '@/lib/events'

import { dsConfig, FALSE_REJECTION_LIMIT, FALSE_REJECTION_TTL_SEC, type DsConfig } from './config'
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

/**
 * False `not_reader` reports of committers, per device (§12.7.5). The
 * scheduler gives no batch to a device with FALSE_REJECTION_LIMIT reports.
 */
export interface CommitterStrikes {
  /** Adds one false report of the device. Returns the new count. */
  add(deviceId: string): Promise<number>
  /** The devices of `deviceIds` that have FALSE_REJECTION_LIMIT or more reports. */
  barred(deviceIds: readonly string[]): Promise<Set<string>>
}

export interface DsDeps {
  ds: DsModule
  signer: DsSigner
  config: DsConfig
  presence: Presence
  rate: RateLimiter
  strikes: CommitterStrikes
  now(): Date
}

/** The parts of DsDeps that need no ts-mls (membership changes, scheduler choice). */
export type LightDeps = Pick<DsDeps, 'config' | 'presence' | 'strikes' | 'now'>

export const redisPresence: Presence = {
  async onlineDevices(deviceIds) {
    if (deviceIds.length === 0) return new Set()
    const values = await redis().mget(...deviceIds.map((id) => `device_online:${id}`))
    return new Set(deviceIds.filter((_, i) => values[i] !== null))
  },
}

export const redisCommitterStrikes: CommitterStrikes = {
  async add(deviceId) {
    const key = `takusen:mls_false_reject:${deviceId}`
    const client = redis()
    const n = await client.incr(key)
    await client.expire(key, FALSE_REJECTION_TTL_SEC)
    return n
  },
  async barred(deviceIds) {
    if (deviceIds.length === 0) return new Set()
    const values = await redis().mget(...deviceIds.map((id) => `takusen:mls_false_reject:${id}`))
    return new Set(deviceIds.filter((_, i) => Number(values[i] ?? 0) >= FALSE_REJECTION_LIMIT))
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

/**
 * The §12.12 rate limits. `limit` is per subject (a device, or a user for
 * linkSessions and reports). `userLimit` is a second bucket per user for the
 * device limits, so a user cannot get more by adding devices.
 */
export const RateLimits = {
  keyPackages: { bucket: 'kp', limit: 10, userLimit: 30, windowSec: 60 },
  commits: { bucket: 'commit', limit: 30, userLimit: 90, windowSec: 60 },
  joinRequests: { bucket: 'join', limit: 30, userLimit: 90, windowSec: 60 },
  inboxPosts: { bucket: 'inbox', limit: 60, userLimit: 180, windowSec: 60 },
  linkMessages: { bucket: 'linkmsg', limit: 30, userLimit: 90, windowSec: 60 },
  linkSessions: { bucket: 'linksess', limit: 5, windowSec: 3600 },
  backups: { bucket: 'backup', limit: 60, userLimit: 120, windowSec: 3600 },
  /** Per user, not per device. */
  reports: { bucket: 'report', limit: 10, windowSec: 3600 },
} as const

type Limits = typeof RateLimits
/** The limits that have a device bucket and a user bucket. */
export type DeviceRateLimit = { [K in keyof Limits]: Limits[K] extends { userLimit: number } ? K : never }[keyof Limits]

export async function rateLimit(deps: Pick<DsDeps, 'rate'>, which: keyof Limits, subject: string): Promise<void> {
  const r = RateLimits[which]
  await deps.rate.hit(r.bucket, subject, r.limit, r.windowSec)
}

/** Hits the device bucket and the user bucket of `which`. */
export async function rateLimitDevice(deps: Pick<DsDeps, 'rate'>, which: DeviceRateLimit, device: { id: string; userId: string }): Promise<void> {
  const r = RateLimits[which]
  await deps.rate.hit(r.bucket, device.id, r.limit, r.windowSec)
  await deps.rate.hit(`${r.bucket}:user`, device.userId, r.userLimit, r.windowSec)
}

let cached: Promise<DsDeps> | null = null

/** The production dependencies. One set per process. */
export function dsDeps(): Promise<DsDeps> {
  cached ??= (async () => {
    const config = dsConfig()
    const ds = await getDsModule()
    const signer = await getDsSigner(() => loadOrCreateSeed(config.dsKeyPath))
    return { ds, signer, config, presence: redisPresence, rate: redisRateLimiter, strikes: redisCommitterStrikes, now: () => new Date() }
  })()
  cached.catch(() => {
    cached = null
  })
  return cached
}

export function lightDeps(): LightDeps {
  return { config: dsConfig(), presence: redisPresence, strikes: redisCommitterStrikes, now: () => new Date() }
}
