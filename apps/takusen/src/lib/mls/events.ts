/**
 * The E2EE gateway events (docs/gateway-protocol.md §12.13) and the outbox
 * that collects them inside a transaction. Routes publish the outbox after the
 * commit (`flushOutbox`), so no event describes a write that rolled back.
 */
import { publishEvents, publishJson, redis, type BusEvent } from '@/lib/events'

import { toB64 } from './bytes'
import { redisDeviceBindings, revokeDeviceGrants } from './device-binding'
import { HANDSHAKE_INLINE_MAX_BYTES, type WireBatchAssign, type WireKtTreeHead, type WireMlsGroup } from './crypto'
import type { GroupRow, HandshakeRow, MlsRepo } from './repo'

export interface E2eeEvents {
  MLS_HANDSHAKE: {
    groupId: string
    seq: number
    epoch: number
    kind: HandshakeRow['kind']
    senderDevice: string | null
    message: string | null
    next: { treeHash: string; confirmedTranscriptHash: string } | null
  }
  MLS_GROUP_UPDATE: WireMlsGroup
  MLS_BATCH_ASSIGN: WireBatchAssign
  MLS_JOIN_UPDATE: { requestId: string; groupId: string; status: string; reason: string | null }
  DEVICE_INBOX: { id: string; seq: number; kind: 'welcome' | 'dsk_transfer' | 'history_keys' }
  DEVICE_LINK: { sessionId: string; seq: number; fromDevice: string }
  USER_KEYS_UPDATE: { userId: string; kind: 'device_added' | 'device_revoked' | 'master_key_changed' | 'dsk_rotated'; deviceId: string | null }
  KEY_PACKAGES_LOW: { deviceId: string; cipherSuite: number; remaining: number }
  KT_TREE_HEAD: WireKtTreeHead
  /** Internal: the gateway closes the sessions of the device with 4013 (§12.13). */
  DEVICE_REVOKED: { deviceId: string }
}
export type E2eeEventName = keyof E2eeEvents

/** The Redis channel that wakes the scheduler in the gRPC process (§5). */
export const MLS_WAKEUP_CHANNEL = 'takusen:mls_wakeup'

/** Events and scheduler wakeups that a transaction produced. */
export class Outbox {
  readonly events: BusEvent[] = []
  /** Group ids (base64url) whose pending items changed. */
  readonly wake = new Set<string>()
  /** Revoked devices whose OIDC grants die after the commit (device-binding.ts). */
  readonly revokedDevices = new Set<string>()

  emit<T extends E2eeEventName>(channel: string, t: T, d: E2eeEvents[T], channelId?: string): void {
    this.events.push(channelId ? { channel, t, d, channelId } : { channel, t, d })
  }
  toDevice<T extends E2eeEventName>(deviceId: string, t: T, d: E2eeEvents[T]): void {
    this.emit(`device:${deviceId}`, t, d)
  }
  toUser<T extends E2eeEventName>(userId: string, t: T, d: E2eeEvents[T]): void {
    this.emit(`user:${userId}`, t, d)
  }
  wakeGroup(groupId: Uint8Array): void {
    this.wake.add(toB64(groupId))
  }
  merge(other: Outbox): void {
    this.events.push(...other.events)
    for (const g of other.wake) this.wake.add(g)
    for (const d of other.revokedDevices) this.revokedDevices.add(d)
  }
}

/** Revokes the tokens of revoked devices, then publishes the events, then the wakeups. */
export async function flushOutbox(out: Outbox): Promise<void> {
  if (out.revokedDevices.size > 0) {
    // Lazy: the DB client loads only when a device was revoked.
    // A failure must not drop the events: the revoked status already blocks the
    // device header, and the binding keeps the grant off every other device.
    try {
      const { deleteGrantOidcRows } = await import('@/lib/session-revocation')
      await revokeDeviceGrants(redisDeviceBindings(redis()), deleteGrantOidcRows, out.revokedDevices)
    } catch (err) {
      console.error('[mls] token revocation of revoked devices failed', err)
    }
  }
  await publishEvents(out.events)
  for (const groupId of out.wake) await publishJson(MLS_WAKEUP_CHANNEL, { groupId })
}

/**
 * Where MLS_HANDSHAKE and MLS_GROUP_UPDATE go (§12.13): public_set → guild:{g};
 * channel → guild:{g} with channelId (VIEW_CHANNEL filter); dm → user:{p}.
 */
export async function groupScope(repo: MlsRepo, group: Pick<GroupRow, 'kind' | 'guildId' | 'channelId'>): Promise<{ channel: string; channelId?: string }[]> {
  if (group.kind === 'public_set' && group.guildId) return [{ channel: `guild:${group.guildId}` }]
  if (group.kind === 'channel' && group.guildId && group.channelId) return [{ channel: `guild:${group.guildId}`, channelId: group.channelId }]
  if (group.kind === 'dm' && group.channelId) {
    const users = await repo.getDmParticipants(group.channelId)
    return users.map((u) => ({ channel: `user:${u}` }))
  }
  return []
}

export async function emitToGroup<T extends 'MLS_HANDSHAKE' | 'MLS_GROUP_UPDATE'>(
  repo: MlsRepo,
  out: Outbox,
  group: Pick<GroupRow, 'kind' | 'guildId' | 'channelId'>,
  t: T,
  d: E2eeEvents[T],
): Promise<void> {
  for (const s of await groupScope(repo, group)) out.emit(s.channel, t, d, s.channelId)
}

export function handshakeEvent(h: Pick<HandshakeRow, 'groupId' | 'seq' | 'epoch' | 'kind' | 'senderDevice' | 'message' | 'treeHash' | 'confirmedTranscriptHash'>): E2eeEvents['MLS_HANDSHAKE'] {
  return {
    groupId: toB64(h.groupId),
    seq: h.seq,
    epoch: h.epoch,
    kind: h.kind,
    senderDevice: h.senderDevice,
    message: h.message.length > HANDSHAKE_INLINE_MAX_BYTES ? null : toB64(h.message),
    next: h.treeHash && h.confirmedTranscriptHash ? { treeHash: toB64(h.treeHash), confirmedTranscriptHash: toB64(h.confirmedTranscriptHash) } : null,
  }
}

/** USER_KEYS_UPDATE goes to the owner, each guild of the owner and each DM partner (§12.13). */
export async function emitUserKeysUpdate(repo: MlsRepo, out: Outbox, d: E2eeEvents['USER_KEYS_UPDATE']): Promise<void> {
  out.toUser(d.userId, 'USER_KEYS_UPDATE', d)
  for (const g of await repo.guildIdsOfUser(d.userId)) out.emit(`guild:${g}`, 'USER_KEYS_UPDATE', d)
  for (const p of await repo.dmPartners(d.userId)) out.toUser(p, 'USER_KEYS_UPDATE', d)
}
