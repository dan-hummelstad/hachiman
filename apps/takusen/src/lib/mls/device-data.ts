/**
 * Handshake reads, the device inbox, backups, history bundles and device
 * linking (docs/gateway-protocol.md §12.5, §12.7.6, §12.7.9, §12.11, §12.12).
 */
import { ApiError } from '@/lib/errors'

import { toB64 } from './bytes'
import {
  BACKUP_BLOB_MAX_BYTES,
  BACKUP_IDENTITY_MAX_BYTES,
  BACKUP_USER_MAX_BYTES,
  INBOX_DEVICE_MAX_BYTES,
  INBOX_ITEM_MAX_BYTES,
  INBOX_RETENTION_MS,
  LINK_MESSAGE_MAX_BYTES,
} from './config'
import { HISTORY_BUNDLE_MAX_BYTES, LINK_SESSION_TTL_MS, type WireHandshake } from './crypto'
import type { Outbox } from './events'
import { requireReadableGroup } from './groups'
import type { DeviceRow, HandshakeRow, MlsRepo } from './repo'
import { toWireInboxItem } from './shapes'
import { parseLinkOffer, parseSealedDeviceMessage } from './wire-format'

// MARK: - Handshakes (§12.7.9)

export const HANDSHAKES_DEFAULT_LIMIT = 100
export const HANDSHAKES_MAX_LIMIT = 200

function toWireHandshake(h: HandshakeRow): WireHandshake {
  return {
    seq: h.seq,
    epoch: h.epoch,
    kind: h.kind,
    senderDevice: h.senderDevice,
    message: toB64(h.message),
    next: h.treeHash && h.confirmedTranscriptHash ? { treeHash: toB64(h.treeHash), confirmedTranscriptHash: toB64(h.confirmedTranscriptHash) } : null,
    createdAt: h.createdAt.toISOString(),
  }
}

export async function fetchHandshakes(repo: MlsRepo, userId: string, groupId: Uint8Array, after: number, limit: number) {
  const { group } = await requireReadableGroup(repo, groupId, userId)
  if (after < group.latestSeq) {
    const min = await repo.minHandshakeSeq(groupId)
    // The next handshake the client needs (after + 1) is gone.
    if (min === null || after + 1 < min) throw new ApiError('HandshakesExpired', 410, 'resync by external commit')
  }
  const rows = await repo.listHandshakes(groupId, after, limit)
  return { handshakes: rows.map(toWireHandshake), latestSeq: group.latestSeq }
}

// MARK: - Device inbox (§12.7.6)

export async function listInbox(repo: MlsRepo, device: DeviceRow, after: number, limit: number, now: Date) {
  return (await repo.listInbox(device.id, after, limit, now)).map(toWireInboxItem)
}

export async function ackInbox(repo: MlsRepo, device: DeviceRow, id: string): Promise<void> {
  await repo.deleteInboxItem(device.id, id)
}

/** POST /devices/:id/inbox: a sealed device message to another device of the same user (§12.5). */
export async function postInbox(
  repo: MlsRepo,
  out: Outbox,
  caller: { userId: string; device: DeviceRow },
  targetId: string,
  body: { kind: 'dsk_transfer' | 'history_keys'; body: Uint8Array },
  now: Date,
): Promise<void> {
  if (body.body.length > INBOX_ITEM_MAX_BYTES) throw new ApiError('InboxFull', 413, 'the item is above 1 MiB')
  let sealed
  try {
    sealed = parseSealedDeviceMessage(body.body)
  } catch {
    throw new ApiError('ValidationError', 400, 'the body is not a SealedDeviceMessage')
  }
  if (sealed.kind !== body.kind || sealed.senderDeviceId !== caller.device.id) {
    throw new ApiError('ValidationError', 400, 'the sealed kind or sender differs from the request')
  }
  await repo.transaction(async (r) => {
    const target = await r.getDevice(targetId)
    if (!target || target.userId !== caller.userId) throw new ApiError('UnknownDevice', 404, 'unknown device')
    if (target.status === 'revoked') throw new ApiError('DeviceNotActive', 403, 'the device is revoked')
    if ((await r.inboxBytes(target.id, now)) + body.body.length > INBOX_DEVICE_MAX_BYTES) {
      throw new ApiError('InboxFull', 413, 'the inbox of the device is full')
    }
    const row = await r.insertInboxItem({
      deviceId: target.id,
      kind: body.kind,
      senderDevice: caller.device.id,
      body: body.body,
      size: body.body.length,
      expiresAt: new Date(now.getTime() + INBOX_RETENTION_MS),
    })
    out.toDevice(target.id, 'DEVICE_INBOX', { id: row.id, seq: row.seq, kind: row.kind })
  })
}

// MARK: - Backups (§12.11.3)

export async function backupIndex(repo: MlsRepo, userId: string) {
  const items = await repo.listBackups(userId)
  const identity = items.find((b) => b.kind === 'identity')
  return {
    keyId: identity ? toB64(identity.keyId) : items[0] ? toB64(items[0].keyId) : null,
    items: items.map((b) => ({
      id: b.id,
      kind: b.kind,
      groupId: b.groupId ? toB64(b.groupId) : null,
      epochFrom: b.epochFrom,
      epochTo: b.epochTo,
      size: b.size,
      createdAt: b.createdAt.toISOString(),
    })),
  }
}

export async function putIdentityBackup(repo: MlsRepo, userId: string, keyId: Uint8Array, blob: Uint8Array): Promise<void> {
  if (blob.length > BACKUP_IDENTITY_MAX_BYTES) throw new ApiError('BackupTooLarge', 413, 'the identity blob is above 64 KiB')
  await repo.transaction(async (r) => {
    const others = (await r.listBackups(userId)).filter((b) => b.kind !== 'identity').reduce((n, b) => n + b.size, 0)
    if (others + blob.length > BACKUP_USER_MAX_BYTES) throw new ApiError('BackupTooLarge', 413, 'the backups of the user are above 256 MiB')
    await r.putIdentityBackup({ userId, keyId, kind: 'identity', groupId: null, epochFrom: null, epochTo: null, blob, size: blob.length })
  })
}

export async function postHistoryBackup(
  repo: MlsRepo,
  userId: string,
  body: { keyId: Uint8Array; groupId: Uint8Array; epochFrom: number; epochTo: number; blob: Uint8Array },
): Promise<{ id: string }> {
  if (body.blob.length > BACKUP_BLOB_MAX_BYTES) throw new ApiError('BackupTooLarge', 413, 'the history blob is above 1 MiB')
  if (body.epochFrom > body.epochTo) throw new ApiError('ValidationError', 400, 'epochFrom is above epochTo')
  return repo.transaction(async (r) => {
    const items = await r.listBackups(userId)
    const stored = items.find((b) => b.kind === 'identity') ?? items[0]
    if (stored && Buffer.compare(Buffer.from(stored.keyId), Buffer.from(body.keyId)) !== 0) {
      throw new ApiError('WrongBackupKey', 409, 'the keyId differs from the stored backup key id')
    }
    if ((await r.backupBytes(userId)) + body.blob.length > BACKUP_USER_MAX_BYTES) {
      throw new ApiError('BackupTooLarge', 413, 'the backups of the user are above 256 MiB')
    }
    const id = await r.insertBackup({ userId, keyId: body.keyId, kind: 'history', groupId: body.groupId, epochFrom: body.epochFrom, epochTo: body.epochTo, blob: body.blob, size: body.blob.length })
    return { id }
  })
}

export async function getBackup(repo: MlsRepo, userId: string, id: string) {
  const b = await repo.getBackup(userId, id)
  if (!b) throw new ApiError('NotFound', 404, 'unknown backup')
  return { blob: toB64(b.blob) }
}

// MARK: - History bundles (§12.11.2)

export async function postHistoryBundle(
  repo: MlsRepo,
  caller: { userId: string; device: DeviceRow },
  groupId: Uint8Array,
  body: { epoch: number; blob: Uint8Array },
): Promise<void> {
  if (body.blob.length > HISTORY_BUNDLE_MAX_BYTES) throw new ApiError('ValidationError', 400, 'the bundle is above 512 KiB')
  const { group } = await requireReadableGroup(repo, groupId, caller.userId)
  if (group.epoch === null || body.epoch > group.epoch) throw new ApiError('ValidationError', 400, 'the epoch is ahead of the group')
  if (!(await repo.memberByDevice(groupId, caller.device.id))) throw new ApiError('NotMember', 403, 'the device has no leaf in the group')
  const ok = await repo.insertHistoryBundle({ groupId, epoch: body.epoch, senderDevice: caller.device.id, blob: body.blob })
  if (!ok) throw new ApiError('Conflict', 409, 'one bundle per (group, epoch, sender)')
}

export async function listHistoryBundles(repo: MlsRepo, userId: string, groupId: Uint8Array, epoch: number) {
  await requireReadableGroup(repo, groupId, userId)
  return (await repo.listHistoryBundles(groupId, epoch)).map((b) => ({
    id: b.id,
    groupId: toB64(b.groupId),
    epoch: b.epoch,
    senderDevice: b.senderDevice,
    blob: toB64(b.blob),
    createdAt: b.createdAt.toISOString(),
  }))
}

// MARK: - Device linking (§12.5)

export async function createLinkSession(repo: MlsRepo, out: Outbox, caller: { userId: string; device: DeviceRow }, offer: Uint8Array, now: Date) {
  let fields
  try {
    fields = parseLinkOffer(offer)
  } catch {
    throw new ApiError('ValidationError', 400, 'the offer does not decode')
  }
  if (fields.userId !== caller.userId || fields.deviceId !== caller.device.id) throw new ApiError('ValidationError', 400, 'the offer is for another device')
  if (caller.device.status !== 'pending') throw new ApiError('DeviceNotActive', 403, 'only a pending device links')
  const s = await repo.insertLinkSession({ userId: caller.userId, newDeviceId: caller.device.id, offer, expiresAt: new Date(now.getTime() + LINK_SESSION_TTL_MS) })
  out.toUser(caller.userId, 'DEVICE_LINK', { sessionId: s.id, seq: 0, fromDevice: caller.device.id })
  return { id: s.id, expiresAt: s.expiresAt.toISOString() }
}

export async function listLinkSessions(repo: MlsRepo, userId: string, now: Date) {
  return (await repo.listLinkSessions(userId, now)).map((s) => ({
    id: s.id,
    newDeviceId: s.newDeviceId,
    offer: toB64(s.offer),
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  }))
}

async function openSession(repo: MlsRepo, userId: string, id: string, now: Date) {
  const s = await repo.getLinkSession(id)
  if (!s || s.userId !== userId) throw new ApiError('LinkExpired', 410, 'the link session is gone')
  if (s.expiresAt <= now) throw new ApiError('LinkExpired', 410, 'the link session expired')
  return s
}

/**
 * Two devices talk on a session: the new device, and the first other device
 * of the user that posts (the accept). Other devices cannot post.
 */
export async function postLinkMessage(repo: MlsRepo, out: Outbox, caller: { userId: string; device: DeviceRow }, id: string, body: Uint8Array, now: Date) {
  if (body.length > LINK_MESSAGE_MAX_BYTES) throw new ApiError('ValidationError', 400, 'the message is too large')
  return repo.transaction(async (r) => {
    const s = await openSession(r, caller.userId, id, now)
    const messages = await r.listLinkMessages(s.id, 0)
    const existing = messages.find((m) => m.fromDevice !== s.newDeviceId)?.fromDevice ?? null
    const isNew = caller.device.id === s.newDeviceId
    if (!isNew) {
      if (caller.device.status !== 'active') throw new ApiError('DeviceNotActive', 403, 'only an active device accepts a link')
      if (existing && existing !== caller.device.id) throw new ApiError('DeviceNotActive', 403, 'another device accepted this link')
    }
    const seq = await r.insertLinkMessage({ sessionId: s.id, fromDevice: caller.device.id, body })
    const peer = isNew ? existing : s.newDeviceId
    const d = { sessionId: s.id, seq, fromDevice: caller.device.id }
    if (peer) out.toDevice(peer, 'DEVICE_LINK', d)
    else out.toUser(caller.userId, 'DEVICE_LINK', d)
    return { seq }
  })
}

export async function listLinkMessages(repo: MlsRepo, caller: { userId: string }, id: string, after: number, now: Date) {
  const s = await openSession(repo, caller.userId, id, now)
  return (await repo.listLinkMessages(s.id, after)).map((m) => ({ seq: m.seq, fromDevice: m.fromDevice, body: toB64(m.body), createdAt: m.createdAt.toISOString() }))
}

export async function deleteLinkSession(repo: MlsRepo, userId: string, id: string): Promise<void> {
  const s = await repo.getLinkSession(id)
  if (s && s.userId === userId) await repo.deleteLinkSession(id)
}
