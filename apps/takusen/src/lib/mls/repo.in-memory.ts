/**
 * In-memory MlsRepo for tests. It follows the Drizzle implementation
 * (repo.drizzle.ts) method by method: change both in the same commit.
 *
 * Transactions run one at a time (a mutex, like the row locks that serialize
 * Postgres writers on one group) and roll back by restoring a snapshot.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import type {
  BackupMeta,
  BackupRow,
  BatchRow,
  ChannelInfo,
  DevicePatch,
  DeviceRow,
  DskRow,
  GroupEpochRow,
  GroupKind,
  GroupPatch,
  GuildPermissionData,
  GroupRow,
  HandshakeRow,
  HistoryBundleRow,
  InboxRow,
  JoinRequestRow,
  KeyPackageRow,
  KtEntryRow,
  KtHeadRow,
  LinkMessageRow,
  LinkSessionRow,
  MasterKeyRow,
  MemberRow,
  MlsRepo,
  NewBackup,
  NewBatch,
  NewDevice,
  NewGroup,
  NewHandshake,
  NewInboxItem,
  NewJoinRequest,
  NewKeyPackage,
  NewKtEntry,
  NewMember,
  NewPending,
  OverwriteInfo,
  PendingPatch,
  PendingRow,
  PendingStatus,
  RevocationRow,
} from './repo'

type GuildPermissionDataShape = GuildPermissionData

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const bytesEq = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && hex(a) === hex(b)

interface State {
  users: Set<string>
  guilds: Map<string, { id: string; ownerId: string }>
  roles: Map<string, { id: string; guildId: string; permissions: number }>
  guildMembers: Map<string, Map<string, string[]>> // guildId → userId → roleIds
  channels: Map<string, ChannelInfo>
  overwrites: Map<string, OverwriteInfo[]>
  dmParticipants: Map<string, string[]>
  messageIds: Map<string, Set<string>> // channelId → client_msg_id hex
  devices: Map<string, DeviceRow>
  revocations: Map<string, RevocationRow>
  masterKeys: MasterKeyRow[]
  dsks: DskRow[]
  keyPackages: KeyPackageRow[]
  groups: Map<string, GroupRow>
  epochs: GroupEpochRow[]
  members: MemberRow[]
  handshakes: HandshakeRow[]
  pending: PendingRow[]
  batches: BatchRow[]
  joinRequests: JoinRequestRow[]
  inbox: InboxRow[]
  inboxSeq: number
  backups: BackupRow[]
  bundles: HistoryBundleRow[]
  linkSessions: LinkSessionRow[]
  linkMessages: LinkMessageRow[]
  kt: KtEntryRow[]
  ktHeads: KtHeadRow[]
}

function emptyState(): State {
  return {
    users: new Set(),
    guilds: new Map(),
    roles: new Map(),
    guildMembers: new Map(),
    channels: new Map(),
    overwrites: new Map(),
    dmParticipants: new Map(),
    messageIds: new Map(),
    devices: new Map(),
    revocations: new Map(),
    masterKeys: [],
    dsks: [],
    keyPackages: [],
    groups: new Map(),
    epochs: [],
    members: [],
    handshakes: [],
    pending: [],
    batches: [],
    joinRequests: [],
    inbox: [],
    inboxSeq: 0,
    backups: [],
    bundles: [],
    linkSessions: [],
    linkMessages: [],
    kt: [],
    ktHeads: [],
  }
}

const OPEN_JOIN: JoinRequestRow['status'][] = ['queued', 'waiting', 'external_commit']

export class InMemoryMlsRepo implements MlsRepo {
  s: State = emptyState()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly inTx = new AsyncLocalStorage<boolean>()
  /** Test clock for created_at columns. */
  clock: () => Date = () => new Date()

  // MARK: test seeding (the content tables are owned by other packages)

  addUser(id: string = randomUUID()): string {
    this.s.users.add(id)
    return id
  }
  addGuild(ownerId: string, id: string = randomUUID(), everyonePermissions = 0): string {
    this.s.guilds.set(id, { id, ownerId })
    this.s.roles.set(id, { id, guildId: id, permissions: everyonePermissions })
    this.s.guildMembers.set(id, new Map([[ownerId, []]]))
    return id
  }
  addRole(guildId: string, permissions: number, id: string = randomUUID()): string {
    this.s.roles.set(id, { id, guildId, permissions })
    return id
  }
  addGuildMember(guildId: string, userId: string, roleIds: string[] = []): void {
    this.s.guildMembers.get(guildId)!.set(userId, roleIds)
  }
  removeGuildMember(guildId: string, userId: string): void {
    this.s.guildMembers.get(guildId)!.delete(userId)
  }
  addChannel(c: Omit<ChannelInfo, 'id' | 'mlsGroupId'> & { id?: string }): string {
    const id = c.id ?? randomUUID()
    this.s.channels.set(id, { id, guildId: c.guildId, type: c.type, mlsGroupId: null })
    return id
  }
  setOverwrites(channelId: string, ows: OverwriteInfo[]): void {
    this.s.overwrites.set(channelId, ows)
  }
  addDm(participants: string[], type: 'dm' | 'group_dm' = 'dm'): string {
    const id = this.addChannel({ guildId: null, type })
    this.s.dmParticipants.set(id, participants)
    return id
  }
  addMessageClientMsgId(channelId: string, clientMsgId: Uint8Array): void {
    let set = this.s.messageIds.get(channelId)
    if (!set) this.s.messageIds.set(channelId, (set = new Set()))
    set.add(hex(clientMsgId))
  }
  /** The FK effects of a user delete: devices cascade, roster/pending rows set null. */
  deleteUser(userId: string): void {
    this.s.users.delete(userId)
    const deviceIds = new Set([...this.s.devices.values()].filter((d) => d.userId === userId).map((d) => d.id))
    for (const id of deviceIds) this.s.devices.delete(id)
    for (const m of this.s.members) {
      if (m.userId === userId) m.userId = null
      if (m.deviceId && deviceIds.has(m.deviceId)) m.deviceId = null
    }
    for (const p of this.s.pending) {
      if (p.userId === userId) p.userId = null
      if (p.deviceId && deviceIds.has(p.deviceId)) p.deviceId = null
    }
    this.s.joinRequests = this.s.joinRequests.filter((j) => j.userId !== userId)
    this.s.keyPackages = this.s.keyPackages.filter((k) => k.userId !== userId)
    for (const g of this.s.guildMembers.values()) g.delete(userId)
  }

  // MARK: transactions

  async transaction<T>(fn: (repo: MlsRepo) => Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return fn(this)
    const run = async (): Promise<T> => {
      const snapshot = structuredClone(this.s)
      try {
        return await this.inTx.run(true, () => fn(this))
      } catch (err) {
        this.s = snapshot
        throw err
      }
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  // MARK: guild, channel and DM data

  async getChannel(channelId: string): Promise<ChannelInfo | null> {
    const c = this.s.channels.get(channelId)
    return c ? { ...c } : null
  }
  async listGuildTextChannels(guildId: string): Promise<ChannelInfo[]> {
    return [...this.s.channels.values()].filter((c) => c.guildId === guildId && c.type === 'text').map((c) => ({ ...c }))
  }
  async getGuildPermissionData(guildId: string): Promise<GuildPermissionDataShape | null> {
    const guild = this.s.guilds.get(guildId)
    if (!guild) return null
    const roles = new Map<string, { id: string; permissions: number }>()
    for (const r of this.s.roles.values()) if (r.guildId === guildId) roles.set(r.id, { id: r.id, permissions: r.permissions })
    return { guild: { ...guild }, roles, members: new Map(this.s.guildMembers.get(guildId) ?? []) }
  }
  async getChannelOverwrites(channelId: string): Promise<OverwriteInfo[]> {
    return [...(this.s.overwrites.get(channelId) ?? [])]
  }
  async getDmParticipants(channelId: string): Promise<string[]> {
    return [...(this.s.dmParticipants.get(channelId) ?? [])]
  }
  async setChannelGroup(channelId: string, groupId: Uint8Array | null): Promise<void> {
    const c = this.s.channels.get(channelId)
    if (c) c.mlsGroupId = groupId
  }
  async guildIdsOfUser(userId: string): Promise<string[]> {
    return [...this.s.guildMembers.entries()].filter(([, m]) => m.has(userId)).map(([g]) => g)
  }
  async dmChannelIdsOfUser(userId: string): Promise<string[]> {
    return [...this.s.dmParticipants.entries()].filter(([, p]) => p.includes(userId)).map(([c]) => c)
  }
  async dmPartners(userId: string): Promise<string[]> {
    const out = new Set<string>()
    for (const p of this.s.dmParticipants.values()) if (p.includes(userId)) for (const u of p) if (u !== userId) out.add(u)
    return [...out]
  }
  async sharesGuildOrDm(a: string, b: string): Promise<boolean> {
    for (const m of this.s.guildMembers.values()) if (m.has(a) && m.has(b)) return true
    for (const p of this.s.dmParticipants.values()) if (p.includes(a) && p.includes(b)) return true
    return false
  }
  async userExists(userId: string): Promise<boolean> {
    return this.s.users.has(userId)
  }
  async messageClientMsgIdExists(channelId: string, clientMsgId: Uint8Array): Promise<boolean> {
    return this.s.messageIds.get(channelId)?.has(hex(clientMsgId)) ?? false
  }

  // MARK: devices

  async insertDevice(d: NewDevice): Promise<DeviceRow> {
    const row: DeviceRow = {
      id: randomUUID(),
      ...d,
      status: 'pending',
      certificate: null,
      mlsSignatureKey: null,
      hpkeKey: null,
      dskGeneration: null,
      createdAt: this.clock(),
      lastSeenAt: null,
      revokedAt: null,
    }
    this.s.devices.set(row.id, row)
    return { ...row }
  }
  async getDevice(id: string): Promise<DeviceRow | null> {
    const d = this.s.devices.get(id)
    return d ? { ...d } : null
  }
  async listDevices(userId: string): Promise<DeviceRow[]> {
    return [...this.s.devices.values()].filter((d) => d.userId === userId).sort((a, b) => +a.createdAt - +b.createdAt).map((d) => ({ ...d }))
  }
  async countLiveDevices(userId: string): Promise<number> {
    return [...this.s.devices.values()].filter((d) => d.userId === userId && d.status !== 'revoked').length
  }
  async updateDevice(id: string, patch: DevicePatch): Promise<DeviceRow> {
    const d = this.s.devices.get(id)
    if (!d) throw new Error(`no device ${id}`)
    Object.assign(d, patch)
    return { ...d }
  }
  async insertRevocation(r: Omit<RevocationRow, 'createdAt'>): Promise<void> {
    this.s.revocations.set(r.deviceId, { ...r, createdAt: this.clock() })
  }
  async listRevocations(userId: string): Promise<RevocationRow[]> {
    return [...this.s.revocations.values()].filter((r) => r.userId === userId)
  }

  // MARK: master keys and device-signing keys

  async listMasterKeys(userId: string): Promise<MasterKeyRow[]> {
    return this.s.masterKeys.filter((m) => m.userId === userId).sort((a, b) => b.generation - a.generation).map((m) => ({ ...m }))
  }
  async insertMasterKey(r: Omit<MasterKeyRow, 'createdAt' | 'supersededAt'>): Promise<void> {
    if (this.s.masterKeys.some((m) => m.userId === r.userId && m.generation === r.generation)) throw new Error('duplicate master generation')
    this.s.masterKeys.push({ ...r, createdAt: this.clock(), supersededAt: null })
  }
  async supersedeMasterKey(userId: string, at: Date): Promise<void> {
    for (const m of this.s.masterKeys) if (m.userId === userId && m.supersededAt === null) m.supersededAt = at
  }
  async restoreMasterKey(userId: string, generation: number): Promise<void> {
    for (const m of this.s.masterKeys) if (m.userId === userId && m.generation === generation) m.supersededAt = null
  }
  async listDsks(userId: string): Promise<DskRow[]> {
    return this.s.dsks.filter((m) => m.userId === userId).sort((a, b) => b.generation - a.generation).map((m) => ({ ...m }))
  }
  async insertDsk(r: Omit<DskRow, 'createdAt' | 'supersededAt'>): Promise<void> {
    if (this.s.dsks.some((m) => m.userId === r.userId && m.generation === r.generation)) throw new Error('duplicate dsk generation')
    this.s.dsks.push({ ...r, createdAt: this.clock(), supersededAt: null })
  }
  async supersedeDsk(userId: string, at: Date): Promise<void> {
    for (const m of this.s.dsks) if (m.userId === userId && m.supersededAt === null) m.supersededAt = at
  }

  // MARK: key packages

  async insertKeyPackages(rows: NewKeyPackage[]): Promise<number> {
    let n = 0
    for (const r of rows) {
      if (this.s.keyPackages.some((k) => bytesEq(k.ref, r.ref))) continue
      this.s.keyPackages.push({ ...r, id: randomUUID(), createdAt: new Date(this.clock().getTime() + n) })
      n++
    }
    return n
  }
  async putLastResortKeyPackage(row: NewKeyPackage): Promise<void> {
    this.s.keyPackages = this.s.keyPackages.filter(
      (k) => !(k.deviceId === row.deviceId && k.cipherSuite === row.cipherSuite && k.lastResort) && !bytesEq(k.ref, row.ref),
    )
    this.s.keyPackages.push({ ...row, lastResort: true, id: randomUUID(), createdAt: this.clock() })
  }
  async countKeyPackages(deviceId: string): Promise<{ cipherSuite: number; count: number; lastResort: boolean }[]> {
    const by = new Map<number, { cipherSuite: number; count: number; lastResort: boolean }>()
    for (const k of this.s.keyPackages) {
      if (k.deviceId !== deviceId) continue
      const e = by.get(k.cipherSuite) ?? { cipherSuite: k.cipherSuite, count: 0, lastResort: false }
      if (k.lastResort) e.lastResort = true
      else e.count++
      by.set(k.cipherSuite, e)
    }
    return [...by.values()].sort((a, b) => a.cipherSuite - b.cipherSuite)
  }
  async claimKeyPackage(deviceId: string, cipherSuite: number): Promise<{ data: Uint8Array; lastResort: boolean } | null> {
    const mine = this.s.keyPackages.filter((k) => k.deviceId === deviceId && k.cipherSuite === cipherSuite)
    const oneTime = mine.filter((k) => !k.lastResort).sort((a, b) => +a.createdAt - +b.createdAt)[0]
    if (oneTime) {
      this.s.keyPackages = this.s.keyPackages.filter((k) => k.id !== oneTime.id)
      return { data: oneTime.data, lastResort: false }
    }
    const lr = mine.find((k) => k.lastResort)
    return lr ? { data: lr.data, lastResort: true } : null
  }
  async listKeyPackagesOfUser(userId: string) {
    return this.s.keyPackages.filter((k) => k.userId === userId).map((k) => ({ id: k.id, deviceId: k.deviceId, cipherSuite: k.cipherSuite, data: k.data }))
  }
  async deleteKeyPackages(ids: string[]): Promise<void> {
    const set = new Set(ids)
    this.s.keyPackages = this.s.keyPackages.filter((k) => !set.has(k.id))
  }
  async deleteDeviceKeyPackages(deviceId: string): Promise<void> {
    this.s.keyPackages = this.s.keyPackages.filter((k) => k.deviceId !== deviceId)
  }
  async devicesWithKeyPackage(deviceIds: string[], cipherSuite: number): Promise<Set<string>> {
    const want = new Set(deviceIds)
    return new Set(this.s.keyPackages.filter((k) => want.has(k.deviceId) && k.cipherSuite === cipherSuite).map((k) => k.deviceId))
  }

  // MARK: groups

  async insertGroup(g: NewGroup): Promise<GroupRow> {
    if (this.s.groups.has(hex(g.groupId))) throw new Error('duplicate group')
    if ([...this.s.groups.values()].some((x) => x.kind === g.kind && x.scopeId === g.scopeId && x.generation === g.generation)) {
      throw new Error('duplicate (kind, scope, generation)')
    }
    const row: GroupRow = { ...g, latestSeq: 0, lastCommitRemoved: false, epochStartedAt: null, createdAt: this.clock() }
    this.s.groups.set(hex(g.groupId), row)
    return { ...row }
  }
  async getGroup(groupId: Uint8Array): Promise<GroupRow | null> {
    const g = this.s.groups.get(hex(groupId))
    return g ? { ...g } : null
  }
  async lockGroup(groupId: Uint8Array): Promise<GroupRow | null> {
    return this.getGroup(groupId)
  }
  async nextGroupGeneration(kind: GroupKind, scopeId: string): Promise<number> {
    let max = -1
    for (const g of this.s.groups.values()) if (g.kind === kind && g.scopeId === scopeId) max = Math.max(max, g.generation)
    return max + 1
  }
  async listGroupsByGuild(guildId: string): Promise<GroupRow[]> {
    return [...this.s.groups.values()].filter((g) => g.guildId === guildId).map((g) => ({ ...g }))
  }
  async listGroupsByChannel(channelId: string): Promise<GroupRow[]> {
    return [...this.s.groups.values()].filter((g) => g.channelId === channelId).map((g) => ({ ...g }))
  }
  async listGroupsNeedingWork(): Promise<GroupRow[]> {
    const withPending = new Set(this.s.pending.filter((p) => p.status !== 'rejected').map((p) => hex(p.groupId)))
    return [...this.s.groups.values()]
      .filter((g) => g.status === 'pending' || (g.status === 'active' && withPending.has(hex(g.groupId))))
      .map((g) => ({ ...g }))
  }
  async listActiveGroups(): Promise<GroupRow[]> {
    return [...this.s.groups.values()].filter((g) => g.status === 'active').map((g) => ({ ...g }))
  }
  async updateGroup(groupId: Uint8Array, patch: GroupPatch): Promise<void> {
    const g = this.s.groups.get(hex(groupId))
    if (g) Object.assign(g, patch)
  }
  async casGroupEpoch(groupId: Uint8Array, expectedEpoch: number, patch: GroupPatch): Promise<boolean> {
    const g = this.s.groups.get(hex(groupId))
    if (!g || g.epoch !== expectedEpoch) return false
    Object.assign(g, patch)
    return true
  }
  async deleteGroupWork(groupId: Uint8Array): Promise<void> {
    const k = hex(groupId)
    this.s.pending = this.s.pending.filter((p) => hex(p.groupId) !== k)
    this.s.batches = this.s.batches.filter((b) => hex(b.groupId) !== k)
    this.s.joinRequests = this.s.joinRequests.filter((j) => hex(j.groupId) !== k)
  }
  async insertGroupEpoch(r: Omit<GroupEpochRow, 'createdAt'>): Promise<void> {
    this.s.epochs = this.s.epochs.filter((e) => !(bytesEq(e.groupId, r.groupId) && e.epoch === r.epoch))
    this.s.epochs.push({ ...r, createdAt: this.clock() })
  }
  async getGroupEpoch(groupId: Uint8Array, epoch: number): Promise<GroupEpochRow | null> {
    return this.s.epochs.find((e) => bytesEq(e.groupId, groupId) && e.epoch === epoch) ?? null
  }
  async listGroupEpochs(groupId: Uint8Array): Promise<GroupEpochRow[]> {
    return this.s.epochs.filter((e) => bytesEq(e.groupId, groupId)).sort((a, b) => a.epoch - b.epoch)
  }
  async pruneGroupEpochs(groupId: Uint8Array, minEpoch: number): Promise<void> {
    this.s.epochs = this.s.epochs.filter((e) => !(bytesEq(e.groupId, groupId) && e.epoch < minEpoch))
  }
  async pruneAllGroupEpochs(keep: number): Promise<number> {
    const before = this.s.epochs.length
    const maxBy = new Map<string, number>()
    for (const e of this.s.epochs) maxBy.set(hex(e.groupId), Math.max(maxBy.get(hex(e.groupId)) ?? -1, e.epoch))
    this.s.epochs = this.s.epochs.filter((e) => e.epoch > maxBy.get(hex(e.groupId))! - keep)
    return before - this.s.epochs.length
  }

  // MARK: DS roster

  async listMembers(groupId: Uint8Array): Promise<MemberRow[]> {
    return this.s.members.filter((m) => bytesEq(m.groupId, groupId)).sort((a, b) => a.leafIndex - b.leafIndex).map((m) => ({ ...m }))
  }
  async replaceMembers(groupId: Uint8Array, rows: NewMember[]): Promise<void> {
    const devices = rows.map((r) => r.deviceId).filter((d): d is string => d !== null)
    if (new Set(devices).size !== devices.length) throw new Error('duplicate device in roster')
    this.s.members = this.s.members.filter((m) => !bytesEq(m.groupId, groupId))
    for (const r of rows) this.s.members.push({ ...r, groupId })
  }
  async memberByDevice(groupId: Uint8Array, deviceId: string): Promise<MemberRow | null> {
    return this.s.members.find((m) => bytesEq(m.groupId, groupId) && m.deviceId === deviceId) ?? null
  }
  async membershipsOfDevices(deviceIds: string[]): Promise<MemberRow[]> {
    const set = new Set(deviceIds)
    return this.s.members.filter((m) => m.deviceId !== null && set.has(m.deviceId)).map((m) => ({ ...m }))
  }
  async membershipsOfUser(userId: string): Promise<MemberRow[]> {
    return this.s.members.filter((m) => m.userId === userId).map((m) => ({ ...m }))
  }
  async groupIdsOfDevice(deviceId: string): Promise<Uint8Array[]> {
    return this.s.members.filter((m) => m.deviceId === deviceId).map((m) => m.groupId)
  }

  // MARK: handshakes

  async appendHandshake(h: NewHandshake): Promise<number> {
    const g = this.s.groups.get(hex(h.groupId))
    if (!g) throw new Error('no group')
    g.latestSeq += 1
    this.s.handshakes.push({ ...h, seq: g.latestSeq, createdAt: this.clock() })
    return g.latestSeq
  }
  async listHandshakes(groupId: Uint8Array, after: number, limit: number): Promise<HandshakeRow[]> {
    return this.s.handshakes
      .filter((h) => bytesEq(h.groupId, groupId) && h.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
  }
  async minHandshakeSeq(groupId: Uint8Array): Promise<number | null> {
    let min: number | null = null
    for (const h of this.s.handshakes) if (bytesEq(h.groupId, groupId)) min = min === null ? h.seq : Math.min(min, h.seq)
    return min
  }
  async deleteHandshakesBefore(at: Date): Promise<number> {
    const before = this.s.handshakes.length
    this.s.handshakes = this.s.handshakes.filter((h) => h.createdAt >= at)
    return before - this.s.handshakes.length
  }

  // MARK: pending

  async insertPending(p: NewPending): Promise<PendingRow | null> {
    if (
      p.op === 'remove' &&
      this.s.pending.some((x) => x.op === 'remove' && x.status !== 'rejected' && bytesEq(x.groupId, p.groupId) && x.leafIndex === p.leafIndex)
    ) {
      return null
    }
    const row: PendingRow = { ...p, id: randomUUID(), status: 'queued', proposal: null, proposalEpoch: null, proposalRef: null, createdAt: this.clock() }
    this.s.pending.push(row)
    return { ...row }
  }
  async listPending(groupId: Uint8Array, statuses: PendingStatus[]): Promise<PendingRow[]> {
    return this.s.pending
      .filter((p) => bytesEq(p.groupId, groupId) && statuses.includes(p.status))
      .sort((a, b) => +a.createdAt - +b.createdAt)
      .map((p) => ({ ...p }))
  }
  async getPendingByIds(ids: string[]): Promise<PendingRow[]> {
    const set = new Set(ids)
    return this.s.pending.filter((p) => set.has(p.id)).map((p) => ({ ...p }))
  }
  async updatePending(id: string, patch: PendingPatch): Promise<void> {
    const p = this.s.pending.find((x) => x.id === id)
    if (p) Object.assign(p, patch)
  }
  async deletePending(ids: string[]): Promise<void> {
    const set = new Set(ids)
    this.s.pending = this.s.pending.filter((p) => !set.has(p.id))
  }

  // MARK: batches

  async insertBatch(b: NewBatch): Promise<BatchRow> {
    const row: BatchRow = { ...b, id: randomUUID(), createdAt: this.clock() }
    this.s.batches.push(row)
    return { ...row }
  }
  async getBatch(id: string): Promise<BatchRow | null> {
    const b = this.s.batches.find((x) => x.id === id)
    return b ? { ...b } : null
  }
  async listBatchesOfGroup(groupId: Uint8Array): Promise<BatchRow[]> {
    return this.s.batches
      .filter((x) => bytesEq(x.groupId, groupId))
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .map((b) => ({ ...b }))
  }
  async expireBatch(id: string, at: Date): Promise<void> {
    const b = this.s.batches.find((x) => x.id === id)
    if (b) b.deadlineAt = at
  }
  async deleteBatch(id: string): Promise<void> {
    this.s.batches = this.s.batches.filter((b) => b.id !== id)
  }
  async deleteBatchesOfGroup(groupId: Uint8Array): Promise<void> {
    this.s.batches = this.s.batches.filter((b) => !bytesEq(b.groupId, groupId))
  }

  // MARK: join requests

  async insertJoinRequest(j: NewJoinRequest): Promise<JoinRequestRow> {
    const now = this.clock()
    const row: JoinRequestRow = { ...j, id: randomUUID(), createdAt: now, updatedAt: now }
    this.s.joinRequests.push(row)
    return { ...row }
  }
  async getJoinRequest(id: string): Promise<JoinRequestRow | null> {
    const j = this.s.joinRequests.find((x) => x.id === id)
    return j ? { ...j } : null
  }
  async updateJoinRequest(id: string, patch: Pick<JoinRequestRow, 'status' | 'reason'>, at: Date): Promise<void> {
    const j = this.s.joinRequests.find((x) => x.id === id)
    if (j) Object.assign(j, patch, { updatedAt: at })
  }
  async listOpenJoinRequests(groupId: Uint8Array): Promise<JoinRequestRow[]> {
    return this.s.joinRequests.filter((j) => bytesEq(j.groupId, groupId) && OPEN_JOIN.includes(j.status)).map((j) => ({ ...j }))
  }
  async deleteJoinRequestsBefore(at: Date): Promise<number> {
    const before = this.s.joinRequests.length
    const gone = new Set(this.s.joinRequests.filter((j) => j.createdAt < at).map((j) => j.id))
    this.s.joinRequests = this.s.joinRequests.filter((j) => !gone.has(j.id))
    this.s.pending = this.s.pending.filter((p) => !p.joinRequestId || !gone.has(p.joinRequestId))
    return before - this.s.joinRequests.length
  }

  // MARK: device inbox

  async insertInboxItem(i: NewInboxItem): Promise<InboxRow> {
    const row: InboxRow = { ...i, id: randomUUID(), seq: ++this.s.inboxSeq, createdAt: this.clock() }
    this.s.inbox.push(row)
    return { ...row }
  }
  async listInbox(deviceId: string, after: number, limit: number, now: Date): Promise<InboxRow[]> {
    return this.s.inbox
      .filter((i) => i.deviceId === deviceId && i.seq > after && i.expiresAt > now)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
  }
  async deleteInboxItem(deviceId: string, id: string): Promise<boolean> {
    const before = this.s.inbox.length
    this.s.inbox = this.s.inbox.filter((i) => !(i.deviceId === deviceId && i.id === id))
    return this.s.inbox.length !== before
  }
  async inboxBytes(deviceId: string, now: Date): Promise<number> {
    return this.s.inbox.filter((i) => i.deviceId === deviceId && i.expiresAt > now).reduce((n, i) => n + i.size, 0)
  }
  async deleteExpiredInbox(now: Date): Promise<number> {
    const before = this.s.inbox.length
    this.s.inbox = this.s.inbox.filter((i) => i.expiresAt > now)
    return before - this.s.inbox.length
  }

  // MARK: backups and history bundles

  async listBackups(userId: string): Promise<BackupMeta[]> {
    return this.s.backups
      .filter((b) => b.userId === userId)
      .sort((a, b) => +a.createdAt - +b.createdAt)
      .map((b) => {
        const meta: Partial<BackupRow> = { ...b }
        delete meta.blob
        return meta as BackupMeta
      })
  }
  async getBackup(userId: string, id: string): Promise<BackupRow | null> {
    return this.s.backups.find((b) => b.userId === userId && b.id === id) ?? null
  }
  async putIdentityBackup(b: NewBackup): Promise<void> {
    this.s.backups = this.s.backups.filter((x) => !(x.userId === b.userId && x.kind === 'identity'))
    this.s.backups.push({ ...b, id: randomUUID(), createdAt: this.clock() })
  }
  async insertBackup(b: NewBackup): Promise<string> {
    const id = randomUUID()
    this.s.backups.push({ ...b, id, createdAt: this.clock() })
    return id
  }
  async deleteBackups(userId: string): Promise<void> {
    this.s.backups = this.s.backups.filter((b) => b.userId !== userId)
  }
  async backupBytes(userId: string): Promise<number> {
    return this.s.backups.filter((b) => b.userId === userId).reduce((n, b) => n + b.size, 0)
  }
  async insertHistoryBundle(b: Omit<HistoryBundleRow, 'id' | 'createdAt'>): Promise<boolean> {
    if (this.s.bundles.some((x) => bytesEq(x.groupId, b.groupId) && x.epoch === b.epoch && x.senderDevice === b.senderDevice)) return false
    this.s.bundles.push({ ...b, id: randomUUID(), createdAt: this.clock() })
    return true
  }
  async listHistoryBundles(groupId: Uint8Array, epoch: number): Promise<HistoryBundleRow[]> {
    return this.s.bundles.filter((b) => bytesEq(b.groupId, groupId) && b.epoch === epoch)
  }
  async historyBundleEpochs(groupId: Uint8Array, epochs: number[]): Promise<Set<number>> {
    return new Set(this.s.bundles.filter((b) => bytesEq(b.groupId, groupId) && epochs.includes(b.epoch)).map((b) => b.epoch))
  }

  // MARK: device linking

  async insertLinkSession(s: Omit<LinkSessionRow, 'id' | 'createdAt'>): Promise<LinkSessionRow> {
    const row: LinkSessionRow = { ...s, id: randomUUID(), createdAt: this.clock() }
    this.s.linkSessions.push(row)
    return { ...row }
  }
  async getLinkSession(id: string): Promise<LinkSessionRow | null> {
    return this.s.linkSessions.find((s) => s.id === id) ?? null
  }
  async listLinkSessions(userId: string, now: Date): Promise<LinkSessionRow[]> {
    return this.s.linkSessions.filter((s) => s.userId === userId && s.expiresAt > now)
  }
  async openLinkSessionOfDevice(newDeviceId: string, now: Date): Promise<LinkSessionRow | null> {
    return this.s.linkSessions.filter((s) => s.newDeviceId === newDeviceId && s.expiresAt > now).sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null
  }
  async deleteLinkSession(id: string): Promise<void> {
    this.s.linkSessions = this.s.linkSessions.filter((s) => s.id !== id)
    this.s.linkMessages = this.s.linkMessages.filter((m) => m.sessionId !== id)
  }
  async deleteExpiredLinkSessions(now: Date): Promise<number> {
    const gone = this.s.linkSessions.filter((s) => s.expiresAt <= now).map((s) => s.id)
    for (const id of gone) await this.deleteLinkSession(id)
    return gone.length
  }
  async insertLinkMessage(m: Omit<LinkMessageRow, 'seq' | 'createdAt'>): Promise<number> {
    const seq = this.s.linkMessages.filter((x) => x.sessionId === m.sessionId).reduce((n, x) => Math.max(n, x.seq), 0) + 1
    this.s.linkMessages.push({ ...m, seq, createdAt: this.clock() })
    return seq
  }
  async listLinkMessages(sessionId: string, after: number): Promise<LinkMessageRow[]> {
    return this.s.linkMessages.filter((m) => m.sessionId === sessionId && m.seq > after).sort((a, b) => a.seq - b.seq)
  }

  // MARK: key transparency

  async appendKtEntry(e: NewKtEntry): Promise<number> {
    const idx = this.s.kt.length
    this.s.kt.push({ ...e, idx, createdAt: this.clock() })
    return idx
  }
  async ktSize(): Promise<number> {
    return this.s.kt.length
  }
  async ktLeafHashes(treeSize: number): Promise<Uint8Array[]> {
    return this.s.kt.slice(0, treeSize).map((e) => e.leafHash)
  }
  async listKtEntriesOfUser(userId: string, after: number, limit: number): Promise<KtEntryRow[]> {
    return this.s.kt.filter((e) => e.userId === userId && e.idx > after).slice(0, limit)
  }
  async listKtEntriesRange(start: number, end: number): Promise<KtEntryRow[]> {
    return this.s.kt.filter((e) => e.idx >= start && e.idx < end)
  }
  async latestKtHead(): Promise<KtHeadRow | null> {
    return [...this.s.ktHeads].sort((a, b) => b.treeSize - a.treeSize)[0] ?? null
  }
  async insertKtHead(h: Omit<KtHeadRow, 'createdAt' | 'publishedAt'>): Promise<void> {
    if (this.s.ktHeads.some((x) => x.treeSize === h.treeSize)) throw new Error('duplicate tree head')
    this.s.ktHeads.push({ ...h, createdAt: this.clock(), publishedAt: null })
  }
  async markKtHeadPublished(treeSize: number, at: Date): Promise<void> {
    const h = this.s.ktHeads.find((x) => x.treeSize === treeSize)
    if (h) h.publishedAt = at
  }
}
