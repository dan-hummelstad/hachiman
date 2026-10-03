/**
 * Gateway event bus publisher (docs/gateway-protocol.md §5).
 *
 * REST mutations call these AFTER their DB commit; every gateway node
 * PSUBSCRIBEs `guild:*` / `user:*` / `device:*` and dispatches to its sessions.
 * The envelope is `{ t, d, channelId? }` — `channelId` marks events scoped to
 * one guild channel so the gateway can VIEW_CHANNEL-filter them.
 *
 * Publish failures are logged, not thrown: the mutation already committed, so
 * failing the request would invite a client retry that duplicates it. A
 * missing REDIS_URL is a deploy misconfiguration and does throw.
 */
import { Redis } from 'ioredis'
import type { BusEnvelope, GatewayEventName, GatewayEvents } from '@hachiman/client/types'

import type { E2eeEventName, E2eeEvents } from '@/lib/mls/events'

declare global {
  var __takusenRedis: Redis | undefined
}

/** Shared ioredis client (lazy; survives Next dev hot reloads). */
export function redis(): Redis {
  if (globalThis.__takusenRedis) return globalThis.__takusenRedis
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error('REDIS_URL is not set — Takusen needs Redis to publish gateway events')
  }
  const client = new Redis(url, { maxRetriesPerRequest: 3 })
  client.on('error', (err) => console.error('[events] redis error', err))
  globalThis.__takusenRedis = client
  return client
}

/** One event on one bus channel. The E2EE code collects these and publishes them after the commit. */
export interface BusEvent {
  channel: string
  t: string
  d: unknown
  channelId?: string
}

/** The publish function. Tests replace it with `setBusPublisher`. */
type Publisher = (channel: string, payload: string) => Promise<unknown>
let publisher: Publisher | null = null

/** Tests only: capture publishes instead of sending them to Redis (null restores Redis). */
export function setBusPublisher(p: Publisher | null): void {
  publisher = p
}

async function publishRaw(channel: string, envelope: { t: string; d: unknown; channelId?: string }): Promise<void> {
  await publishJson(channel, envelope, envelope.t)
}

/** Publishes any JSON value (for Takusen-internal channels such as `takusen:mls_wakeup`). */
export async function publishJson(channel: string, value: unknown, label = channel): Promise<void> {
  let send = publisher
  if (!send) {
    const client = redis() // throws on a missing REDIS_URL
    send = (c, p) => client.publish(c, p)
  }
  try {
    await send(channel, JSON.stringify(value))
  } catch (err) {
    console.error(`[events] publish ${label} → ${channel} failed`, err)
  }
}

async function publish(channel: string, envelope: BusEnvelope): Promise<void> {
  await publishRaw(channel, envelope)
}

export async function publishToGuild<T extends GatewayEventName>(
  guildId: string,
  t: T,
  d: GatewayEvents[T],
  channelId?: string,
): Promise<void> {
  const envelope: BusEnvelope = channelId ? { t, d, channelId } : { t, d }
  await publish(`guild:${guildId}`, envelope)
}

export async function publishToUser<T extends GatewayEventName>(
  userId: string,
  t: T,
  d: GatewayEvents[T],
): Promise<void> {
  await publish(`user:${userId}`, { t, d } as BusEnvelope)
}

/**
 * `device:{id}` delivery (§5, §12.13). The gateway sends the event to every
 * session of that device. `DEVICE_REVOKED` is internal: the gateway closes the
 * sessions of the device with 4013 and does not forward it.
 */
export async function publishToDevice<T extends E2eeEventName>(deviceId: string, t: T, d: E2eeEvents[T]): Promise<void> {
  await publishRaw(`device:${deviceId}`, { t, d })
}

/** Publishes collected events in order. Call after the transaction commits. */
export async function publishEvents(events: readonly BusEvent[]): Promise<void> {
  for (const e of events) {
    await publishRaw(e.channel, e.channelId ? { t: e.t, d: e.d, channelId: e.channelId } : { t: e.t, d: e.d })
  }
}
