/**
 * The main-thread DsTransport (§12.17): each method calls one RestClient route. The crypto Worker
 * never calls fetch itself. RestClient sends X-Hachiman-Device on every call.
 *
 * Errors: a RestError rejects as CryptoError('Transport') with `dsCode` = the REST error code, and
 * a network error as CryptoError('Transport') without one. Two answers are values, not errors:
 * postCommit 409 EpochConflict (RestClient resolves it) and getGroupForChannel 404 UnknownGroup
 * (null: the channel has no group yet).
 *
 * channelReaders and guildMembers come from the HachimanClient cache, with the §2 rules of
 * computeChannelPermissions. Unknown data gives no readers, so the Worker fails closed.
 */
import {
  Permissions,
  RestError,
  computeChannelPermissions,
  has,
  type HachimanCache,
  type RestClient
} from '@hachiman/client'
import { CryptoError, type DsTransport } from '@hachiman/crypto'

/** The RestClient routes that the transport uses. Tests pass a fake. */
export type DsRest = Pick<
  RestClient,
  | 'registerDevice'
  | 'putDeviceCertificate'
  | 'listDevices'
  | 'revokeDevice'
  | 'renameDevice'
  | 'getUserKeys'
  | 'putMasterKey'
  | 'putDeviceSigningKey'
  | 'getDsInfo'
  | 'uploadKeyPackages'
  | 'countKeyPackages'
  | 'listMlsGroups'
  | 'getMlsGroup'
  | 'getChannelMlsGroup'
  | 'getMlsGroupState'
  | 'createMlsGroup'
  | 'postCommit'
  | 'getHandshakes'
  | 'postJoinRequest'
  | 'getJoinRequest'
  | 'declineBatch'
  | 'getInbox'
  | 'ackInbox'
  | 'postInbox'
  | 'getBackups'
  | 'putIdentityBackup'
  | 'postHistoryBackup'
  | 'getBackup'
  | 'deleteBackups'
  | 'postHistoryBundle'
  | 'getHistoryBundles'
  | 'createLinkSession'
  | 'listLinkSessions'
  | 'postLinkMessage'
  | 'getLinkMessages'
  | 'deleteLinkSession'
  | 'ktTreeHead'
  | 'ktInclusion'
  | 'ktConsistency'
  | 'ktEntries'
  | 'getAdminActions'
>

export type DsCache = Pick<HachimanCache, 'user' | 'channels' | 'guilds' | 'roles' | 'members'>

/** Any rejection → the CryptoErrorShape that DsTransport promises. */
export function transportError(e: unknown): CryptoError {
  if (e instanceof RestError) return new CryptoError('Transport', e.message, e.code)
  return new CryptoError('Transport', e instanceof Error ? e.message : String(e))
}

const call = async <T>(p: () => Promise<T>): Promise<T> => {
  try {
    return await p()
  } catch (e) {
    throw transportError(e)
  }
}

/** The users who may read `channelId` (§2 VIEW_CHANNEL), from the cache. */
export function channelReaders(cache: DsCache, channelId: string): string[] {
  const channel = cache.channels.get(channelId)
  if (!channel) return []
  if (channel.guildId === null) {
    // A DM or group DM: its participants. `recipients` excludes the viewer.
    const ids = new Set((channel.recipients ?? []).map((u) => u.id))
    if (cache.user) ids.add(cache.user.id)
    return [...ids]
  }
  const guild = cache.guilds.get(channel.guildId)
  const members = cache.members.get(channel.guildId)
  if (!guild || !members) return []
  const roles = cache.roles.get(channel.guildId) ?? new Map()
  const readers: string[] = []
  for (const member of members.values()) {
    if (has(computeChannelPermissions(guild, member, roles, channel), Permissions.VIEW_CHANNEL))
      readers.push(member.user.id)
  }
  return readers
}

export function createDsTransport(rest: DsRest, cache: DsCache): DsTransport {
  return {
    registerDevice: (body) => call(() => rest.registerDevice(body)),
    putDeviceCertificate: (id, body) => call(() => rest.putDeviceCertificate(id, body)),
    listOwnDevices: () => call(() => rest.listDevices()),
    revokeDevice: (id, body) => call(() => rest.revokeDevice(id, body)),
    renameDevice: (id, name) => call(() => rest.renameDevice(id, name)),

    getUserKeys: (userId) => call(() => rest.getUserKeys(userId)),
    putMasterKey: (body) => call(() => rest.putMasterKey(body)),
    putDeviceSigningKey: (body) => call(() => rest.putDeviceSigningKey(body)),

    getDsInfo: () => call(() => rest.getDsInfo()),
    uploadKeyPackages: (body) => call(() => rest.uploadKeyPackages(body)),
    countKeyPackages: () => call(() => rest.countKeyPackages()),

    listGroups: () => call(() => rest.listMlsGroups()),
    getGroup: (groupId) => call(() => rest.getMlsGroup(groupId)),
    // RestClient resolves 404 UnknownGroup as null; every other error rejects.
    getGroupForChannel: (channelId) => call(() => rest.getChannelMlsGroup(channelId)),
    getGroupState: (groupId, epoch) => call(() => rest.getMlsGroupState(groupId, epoch)),
    createGroup: (body) => call(() => rest.createMlsGroup(body)),
    postCommit: (groupId, body) => call(() => rest.postCommit(groupId, body)),
    fetchHandshakes: (groupId, after, limit) =>
      call(() => rest.getHandshakes(groupId, { after, limit })),
    postJoinRequest: (groupId, body) => call(() => rest.postJoinRequest(groupId, body)),
    getJoinRequest: (id) => call(() => rest.getJoinRequest(id)),
    declineBatch: (batchId, reason) => call(() => rest.declineBatch(batchId, reason)),

    fetchInbox: (after, limit) => call(() => rest.getInbox({ after, limit })),
    ackInbox: (id) => call(() => rest.ackInbox(id)),
    postInbox: (deviceId, body) => call(() => rest.postInbox(deviceId, body)),

    getBackups: () => call(() => rest.getBackups()),
    putIdentityBackup: (body) => call(() => rest.putIdentityBackup(body)),
    postHistoryBackup: (body) => call(() => rest.postHistoryBackup(body)),
    getBackup: (id) => call(() => rest.getBackup(id)),
    deleteBackups: () => call(() => rest.deleteBackups()),
    postHistoryBundle: (groupId, body) => call(() => rest.postHistoryBundle(groupId, body)),
    getHistoryBundles: (groupId, epoch) => call(() => rest.getHistoryBundles(groupId, epoch)),

    createLinkSession: (body) => call(() => rest.createLinkSession(body)),
    listLinkSessions: () => call(() => rest.listLinkSessions()),
    postLinkMessage: (sessionId, body) => call(() => rest.postLinkMessage(sessionId, body)),
    fetchLinkMessages: (sessionId, after) => call(() => rest.getLinkMessages(sessionId, after)),
    deleteLinkSession: (sessionId) => call(() => rest.deleteLinkSession(sessionId)),

    ktTreeHead: () => call(() => rest.ktTreeHead()),
    ktInclusion: (index, treeSize) => call(() => rest.ktInclusion(index, treeSize)),
    ktConsistency: (from, to) => call(() => rest.ktConsistency(from, to)),
    ktEntries: (query) => call(() => rest.ktEntries({ userId: query.userId, after: query.after })),

    adminActions: (guildId, after) => call(() => rest.getAdminActions(guildId, after)),

    channelReaders: (channelId) => Promise.resolve(channelReaders(cache, channelId)),
    guildMembers: (guildId) => Promise.resolve([...(cache.members.get(guildId)?.keys() ?? [])])
  }
}
