/**
 * MlsRepo: the storage seam of the delivery service (docs/gateway-protocol.md §12.18).
 *
 * Every DS behavior reaches Postgres through this interface, one method per
 * behavior. Production wires `drizzleMlsRepo` (repo.drizzle.ts). Tests wire
 * `InMemoryMlsRepo` (repo.in-memory.ts), so the same service code runs without
 * DATABASE_URL. When you add a method, change BOTH implementations in the same
 * commit (the `MediaNodesRepo` rule in CLAUDE.md).
 *
 * The row types are the Drizzle row types of src/db/schema.ts. Bytes are
 * Uint8Array, bigint columns are JS numbers (all values stay below 2^53).
 */
import type {
  deviceInbox,
  deviceLinkMessages,
  deviceLinkSessions,
  deviceRevocations,
  devices,
  deviceSigningKeys,
  historyBundles,
  invites,
  keyBackups,
  keyPackages,
  ktEntries,
  ktTreeHeads,
  masterKeys,
  mlsBatches,
  mlsGroupEpochs,
  mlsGroupMembers,
  mlsGroups,
  mlsHandshakes,
  mlsJoinRequests,
  mlsPending,
} from '@/db/schema'

export type DeviceRow = typeof devices.$inferSelect
export type RevocationRow = typeof deviceRevocations.$inferSelect
export type MasterKeyRow = typeof masterKeys.$inferSelect
export type DskRow = typeof deviceSigningKeys.$inferSelect
export type KeyPackageRow = typeof keyPackages.$inferSelect
export type GroupRow = typeof mlsGroups.$inferSelect
export type GroupEpochRow = typeof mlsGroupEpochs.$inferSelect
export type MemberRow = typeof mlsGroupMembers.$inferSelect
export type HandshakeRow = typeof mlsHandshakes.$inferSelect
export type PendingRow = typeof mlsPending.$inferSelect
export type BatchRow = typeof mlsBatches.$inferSelect
export type JoinRequestRow = typeof mlsJoinRequests.$inferSelect
export type InboxRow = typeof deviceInbox.$inferSelect
export type BackupRow = typeof keyBackups.$inferSelect
export type HistoryBundleRow = typeof historyBundles.$inferSelect
export type LinkSessionRow = typeof deviceLinkSessions.$inferSelect
export type LinkMessageRow = typeof deviceLinkMessages.$inferSelect
export type KtEntryRow = typeof ktEntries.$inferSelect
export type KtHeadRow = typeof ktTreeHeads.$inferSelect
/** The columns of an invite that the InviteAuth check of an external commit reads (§12.11.4). */
export type InviteKeyRow = Pick<typeof invites.$inferSelect, 'id' | 'guildId' | 'record' | 'revoked' | 'expiresAt'>

export type GroupKind = GroupRow['kind']
export type PendingStatus = PendingRow['status']
export type JoinStatus = JoinRequestRow['status']
export type RevokeReason = RevocationRow['reason']

/** A channel as the DS sees it. */
/**
 * A thread has no group of its own (§12.6): `mlsGroupId` is the group of its
 * parent, and `getChannelOverwrites` gives the overwrites of the parent.
 */
export interface ChannelInfo {
  id: string
  guildId: string | null
  type: 'text' | 'voice' | 'category' | 'dm' | 'group_dm' | 'pages' | 'thread'
  mlsGroupId: Uint8Array | null
  /** The parent channel of a thread or a channel in a category, else null. */
  parentId: string | null
}

export interface OverwriteInfo {
  id: string
  type: 'role' | 'member'
  allow: number
  deny: number
}

/** Everything §2 needs to compute permissions in one guild. */
export interface GuildPermissionData {
  guild: { id: string; ownerId: string }
  roles: Map<string, { id: string; permissions: number }>
  /** userId → role ids (without @everyone). */
  members: Map<string, string[]>
}

/** `mlsSignatureKey`: the key that POST /devices presents (null when left out). */
export type NewDevice = Pick<DeviceRow, 'userId' | 'name' | 'platform' | 'clientVersion'> & { mlsSignatureKey?: Uint8Array | null }
export type DevicePatch = Partial<Pick<DeviceRow, 'status' | 'name' | 'certificate' | 'mlsSignatureKey' | 'hpkeKey' | 'dskGeneration' | 'lastSeenAt' | 'revokedAt'>>
export type NewKeyPackage = Omit<KeyPackageRow, 'id' | 'createdAt'>
export type NewGroup = Omit<GroupRow, 'createdAt' | 'latestSeq' | 'lastCommitRemoved' | 'epochStartedAt'>
export type GroupPatch = Partial<Pick<GroupRow, 'status' | 'epoch' | 'groupInfo' | 'ratchetTree' | 'historyVisibility' | 'epochStartedAt' | 'lastCommitRemoved'>>
export type NewMember = Omit<MemberRow, 'groupId'>
export type NewHandshake = Omit<HandshakeRow, 'seq' | 'createdAt'>
export type NewPending = Pick<PendingRow, 'groupId' | 'op' | 'userId' | 'deviceId' | 'leafIndex' | 'keyPackage' | 'joinRequestId' | 'reason'>
export type PendingPatch = Partial<Pick<PendingRow, 'status' | 'reason' | 'proposal' | 'proposalEpoch' | 'proposalRef' | 'keyPackage'>>
export type NewBatch = Omit<BatchRow, 'id' | 'createdAt'>
export type NewJoinRequest = Pick<JoinRequestRow, 'groupId' | 'deviceId' | 'userId' | 'keyPackage' | 'status' | 'reason'>
export type NewInboxItem = Omit<InboxRow, 'id' | 'seq' | 'createdAt'>
export type BackupMeta = Omit<BackupRow, 'blob'>
export type NewBackup = Omit<BackupRow, 'id' | 'createdAt'>
export type NewKtEntry = Omit<KtEntryRow, 'idx' | 'createdAt'>

export interface MlsRepo {
  /** Runs `fn` in one transaction. A throw rolls back every write. */
  transaction<T>(fn: (repo: MlsRepo) => Promise<T>): Promise<T>

  // MARK: guild, channel and DM data (read for channelReaders, §12.6)
  getChannel(channelId: string): Promise<ChannelInfo | null>
  listGuildTextChannels(guildId: string): Promise<ChannelInfo[]>
  getGuildPermissionData(guildId: string): Promise<GuildPermissionData | null>
  getChannelOverwrites(channelId: string): Promise<OverwriteInfo[]>
  getDmParticipants(channelId: string): Promise<string[]>
  setChannelGroup(channelId: string, groupId: Uint8Array | null): Promise<void>
  guildIdsOfUser(userId: string): Promise<string[]>
  dmChannelIdsOfUser(userId: string): Promise<string[]>
  /** Users who share a DM or group DM with `userId`. */
  dmPartners(userId: string): Promise<string[]>
  sharesGuildOrDm(a: string, b: string): Promise<boolean>
  userExists(userId: string): Promise<boolean>
  /** True when a message in the channel already has this client_msg_id (§12.8.4). */
  messageClientMsgIdExists(channelId: string, clientMsgId: Uint8Array): Promise<boolean>

  // MARK: devices
  insertDevice(d: NewDevice): Promise<DeviceRow>
  getDevice(id: string): Promise<DeviceRow | null>
  listDevices(userId: string): Promise<DeviceRow[]>
  countLiveDevices(userId: string): Promise<number>
  updateDevice(id: string, patch: DevicePatch): Promise<DeviceRow>
  insertRevocation(r: Omit<RevocationRow, 'createdAt'>): Promise<void>
  listRevocations(userId: string): Promise<RevocationRow[]>

  // MARK: master keys and device-signing keys
  /** Newest generation first. */
  listMasterKeys(userId: string): Promise<MasterKeyRow[]>
  insertMasterKey(r: Omit<MasterKeyRow, 'createdAt' | 'supersededAt'>): Promise<void>
  /** Sets superseded_at on the current (not superseded) master key, if any. */
  supersedeMasterKey(userId: string, at: Date): Promise<void>
  /** Clears superseded_at of one generation (restore after a reset). */
  restoreMasterKey(userId: string, generation: number): Promise<void>
  /** Newest generation first. */
  listDsks(userId: string): Promise<DskRow[]>
  insertDsk(r: Omit<DskRow, 'createdAt' | 'supersededAt'>): Promise<void>
  supersedeDsk(userId: string, at: Date): Promise<void>

  // MARK: key packages (§12.7.2)
  /** Inserts one-time packages. A duplicate ref is skipped. Returns the number stored. */
  insertKeyPackages(rows: NewKeyPackage[]): Promise<number>
  /** Replaces the last-resort package of (device, suite). */
  putLastResortKeyPackage(row: NewKeyPackage): Promise<void>
  countKeyPackages(deviceId: string): Promise<{ cipherSuite: number; count: number; lastResort: boolean }[]>
  /** Atomic pop of the oldest one-time package, else the last-resort package (not deleted). */
  claimKeyPackage(deviceId: string, cipherSuite: number): Promise<{ data: Uint8Array; lastResort: boolean } | null>
  listKeyPackagesOfUser(userId: string): Promise<Pick<KeyPackageRow, 'id' | 'deviceId' | 'cipherSuite' | 'data'>[]>
  deleteKeyPackages(ids: string[]): Promise<void>
  deleteDeviceKeyPackages(deviceId: string): Promise<void>
  /** Devices of `deviceIds` that have a key package (one-time or last resort) in `cipherSuite`. */
  devicesWithKeyPackage(deviceIds: string[], cipherSuite: number): Promise<Set<string>>

  // MARK: groups
  insertGroup(g: NewGroup): Promise<GroupRow>
  getGroup(groupId: Uint8Array): Promise<GroupRow | null>
  /** SELECT … FOR UPDATE. Every writer of a group's epoch or proposals takes it first. */
  lockGroup(groupId: Uint8Array): Promise<GroupRow | null>
  nextGroupGeneration(kind: GroupKind, scopeId: string): Promise<number>
  listGroupsByGuild(guildId: string): Promise<GroupRow[]>
  listGroupsByChannel(channelId: string): Promise<GroupRow[]>
  /** Groups with status 'pending', or with queued or assigned pending items. */
  listGroupsNeedingWork(): Promise<GroupRow[]>
  /** Active groups with status 'active' (for the suite-upgrade sweep). */
  listActiveGroups(): Promise<GroupRow[]>
  updateGroup(groupId: Uint8Array, patch: GroupPatch): Promise<void>
  /** Compare-and-set on the epoch (§12.7.3 check 10). False when the epoch moved. */
  casGroupEpoch(groupId: Uint8Array, expectedEpoch: number, patch: GroupPatch): Promise<boolean>
  /** Deletes the pending items, batches and join requests of a group (retire). */
  deleteGroupWork(groupId: Uint8Array): Promise<void>
  insertGroupEpoch(r: Omit<GroupEpochRow, 'createdAt'>): Promise<void>
  getGroupEpoch(groupId: Uint8Array, epoch: number): Promise<GroupEpochRow | null>
  listGroupEpochs(groupId: Uint8Array): Promise<GroupEpochRow[]>
  /** Deletes epoch rows below `minEpoch`. */
  pruneGroupEpochs(groupId: Uint8Array, minEpoch: number): Promise<void>
  /** Daily sweep: keep the newest `keep` epoch rows of every group. */
  pruneAllGroupEpochs(keep: number): Promise<number>

  // MARK: DS roster
  listMembers(groupId: Uint8Array): Promise<MemberRow[]>
  replaceMembers(groupId: Uint8Array, rows: NewMember[]): Promise<void>
  memberByDevice(groupId: Uint8Array, deviceId: string): Promise<MemberRow | null>
  membershipsOfDevices(deviceIds: string[]): Promise<MemberRow[]>
  membershipsOfUser(userId: string): Promise<MemberRow[]>
  /** Group ids where the device has a leaf. */
  groupIdsOfDevice(deviceId: string): Promise<Uint8Array[]>

  // MARK: handshakes (§12.7.3, §12.7.9)
  /** Appends at latest_seq + 1 and moves latest_seq. Returns the seq. */
  appendHandshake(h: NewHandshake): Promise<number>
  listHandshakes(groupId: Uint8Array, after: number, limit: number): Promise<HandshakeRow[]>
  minHandshakeSeq(groupId: Uint8Array): Promise<number | null>
  deleteHandshakesBefore(at: Date): Promise<number>

  // MARK: pending proposals (§12.7.4)
  /** A second open Remove of one leaf is skipped (unique index): returns null. */
  insertPending(p: NewPending): Promise<PendingRow | null>
  listPending(groupId: Uint8Array, statuses: PendingStatus[]): Promise<PendingRow[]>
  getPendingByIds(ids: string[]): Promise<PendingRow[]>
  updatePending(id: string, patch: PendingPatch): Promise<void>
  deletePending(ids: string[]): Promise<void>

  // MARK: batches (§12.7.5)
  insertBatch(b: NewBatch): Promise<BatchRow>
  getBatch(id: string): Promise<BatchRow | null>
  /**
   * Every batch row of a group, newest first. Rows past their deadline stay
   * for 60 s: their devices are in the timeout cooldown (§12.7.5 step 3).
   */
  listBatchesOfGroup(groupId: Uint8Array): Promise<BatchRow[]>
  /** Sets the deadline (a decline sets it to now). */
  expireBatch(id: string, at: Date): Promise<void>
  deleteBatch(id: string): Promise<void>
  deleteBatchesOfGroup(groupId: Uint8Array): Promise<void>

  // MARK: join requests (§12.7.8)
  insertJoinRequest(j: NewJoinRequest): Promise<JoinRequestRow>
  getJoinRequest(id: string): Promise<JoinRequestRow | null>
  updateJoinRequest(id: string, patch: Pick<JoinRequestRow, 'status' | 'reason'>, at: Date): Promise<void>
  /** Join requests in status queued, waiting or external_commit. */
  listOpenJoinRequests(groupId: Uint8Array): Promise<JoinRequestRow[]>
  deleteJoinRequestsBefore(at: Date): Promise<number>

  // MARK: device inbox (§12.7.6)
  insertInboxItem(i: NewInboxItem): Promise<InboxRow>
  listInbox(deviceId: string, after: number, limit: number, now: Date): Promise<InboxRow[]>
  deleteInboxItem(deviceId: string, id: string): Promise<boolean>
  inboxBytes(deviceId: string, now: Date): Promise<number>
  deleteExpiredInbox(now: Date): Promise<number>

  // MARK: backups and history bundles (§12.11)
  listBackups(userId: string): Promise<BackupMeta[]>
  getBackup(userId: string, id: string): Promise<BackupRow | null>
  /** Replaces the identity backup of the user. */
  putIdentityBackup(b: NewBackup): Promise<void>
  insertBackup(b: NewBackup): Promise<string>
  deleteBackups(userId: string): Promise<void>
  backupBytes(userId: string): Promise<number>
  /** False when (group, epoch, sender) already has a bundle. */
  insertHistoryBundle(b: Omit<HistoryBundleRow, 'id' | 'createdAt'>): Promise<boolean>
  listHistoryBundles(groupId: Uint8Array, epoch: number): Promise<HistoryBundleRow[]>
  historyBundleEpochs(groupId: Uint8Array, epochs: number[]): Promise<Set<number>>

  // MARK: device linking (§12.5)
  insertLinkSession(s: Omit<LinkSessionRow, 'id' | 'createdAt'>): Promise<LinkSessionRow>
  getLinkSession(id: string): Promise<LinkSessionRow | null>
  listLinkSessions(userId: string, now: Date): Promise<LinkSessionRow[]>
  openLinkSessionOfDevice(newDeviceId: string, now: Date): Promise<LinkSessionRow | null>
  deleteLinkSession(id: string): Promise<void>
  deleteExpiredLinkSessions(now: Date): Promise<number>
  /** Appends at max(seq) + 1. */
  insertLinkMessage(m: Omit<LinkMessageRow, 'seq' | 'createdAt'>): Promise<number>
  listLinkMessages(sessionId: string, after: number): Promise<LinkMessageRow[]>

  // MARK: key transparency (§12.14)
  /** Takes the KT advisory lock and appends at max(idx) + 1. Returns the index. */
  appendKtEntry(e: NewKtEntry): Promise<number>
  ktSize(): Promise<number>
  /** Leaf hashes of indexes 0 … treeSize - 1, in order. */
  ktLeafHashes(treeSize: number): Promise<Uint8Array[]>
  listKtEntriesOfUser(userId: string, after: number, limit: number): Promise<KtEntryRow[]>
  /** Indexes start … end - 1. */
  listKtEntriesRange(start: number, end: number): Promise<KtEntryRow[]>
  latestKtHead(): Promise<KtHeadRow | null>
  insertKtHead(h: Omit<KtHeadRow, 'createdAt' | 'publishedAt'>): Promise<void>
  markKtHeadPublished(treeSize: number, at: Date): Promise<void>

  // MARK: invites with history (§12.11.4 "Join authorization")
  /** The invite whose key id (`invites.key_id`, the record sign_public) is `keyId`, or null. */
  getInviteByKeyId(keyId: Uint8Array): Promise<InviteKeyRow | null>
  /** When `userId` joined the guild of the invite with it (`guild_members.invite_id`), or null. */
  inviteJoinedBy(inviteId: string, userId: string): Promise<Date | null>
}
