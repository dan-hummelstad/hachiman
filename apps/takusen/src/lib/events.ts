/**
 * Gateway event bus publisher (docs/gateway-protocol.md §5).
 *
 * REST mutations call these AFTER their DB commit; every gateway node
 * PSUBSCRIBEs `guild:*` / `user:*` and dispatches to its sessions. The
 * envelope is `{ t, d, channelId? }` — `channelId` marks events scoped to one
 * guild channel so the gateway can VIEW_CHANNEL-filter them.
 *
 * Publish failures are logged, not thrown: the mutation already committed, so
 * failing the request would invite a client retry that duplicates it. A
 * missing REDIS_URL is a deploy misconfiguration and does throw.
 */
import { Redis } from 'ioredis'
import type { BusEnvelope, GatewayEventName, GatewayEvents } from '@hachiman/client/types'

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

async function publish(channel: string, envelope: BusEnvelope): Promise<void> {
  const client = redis()
  try {
    await client.publish(channel, JSON.stringify(envelope))
  } catch (err) {
    console.error(`[events] publish ${envelope.t} → ${channel} failed`, err)
  }
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
