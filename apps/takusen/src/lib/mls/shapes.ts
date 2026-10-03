/**
 * DS rows → the §12.12 wire shapes (the `Wire*` types of @hachiman/crypto).
 */
import { toB64 } from './bytes'
import type { WireDevice, WireInboxItem, WireJoinRequest, WireMlsGroup } from './crypto'
import type { DeviceRow, GroupRow, InboxRow, JoinRequestRow, RevocationRow } from './repo'

export function toWireDevice(d: DeviceRow, revocation: RevocationRow | null): WireDevice {
  return {
    id: d.id,
    userId: d.userId,
    status: d.status,
    name: d.name,
    platform: d.platform,
    clientVersion: d.clientVersion,
    certificate: d.certificate ? toB64(d.certificate) : null,
    revocation: revocation?.revocation ? toB64(revocation.revocation) : null,
    revokeReason: revocation?.reason ?? null,
    createdAt: d.createdAt.toISOString(),
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    revokedAt: d.revokedAt?.toISOString() ?? null,
  }
}

export function toWireGroup(g: GroupRow, member: boolean): WireMlsGroup {
  return {
    groupId: toB64(g.groupId),
    kind: g.kind,
    guildId: g.guildId,
    channelId: g.kind === 'public_set' ? null : g.channelId,
    generation: g.generation,
    cipherSuite: g.cipherSuite as WireMlsGroup['cipherSuite'],
    status: g.status,
    epoch: g.epoch,
    historyVisibility: g.historyVisibility,
    latestSeq: g.latestSeq,
    member,
  }
}

export function toWireJoinRequest(j: JoinRequestRow): WireJoinRequest {
  return { id: j.id, groupId: toB64(j.groupId), deviceId: j.deviceId, status: j.status, reason: j.reason, createdAt: j.createdAt.toISOString() }
}

export function toWireInboxItem(i: InboxRow): WireInboxItem {
  return { id: i.id, seq: i.seq, kind: i.kind, senderDevice: i.senderDevice, body: toB64(i.body), createdAt: i.createdAt.toISOString() }
}
