/* eslint-disable @typescript-eslint/require-await -- a synchronous fake behind async interfaces */
/**
 * An in-memory delivery service for the GroupService specs. It adds the §12.7 MLS routes to the
 * identity FakeDs: compare-and-set on the epoch, the handshake stream with `seq`, DS proposals
 * that go into the stream before a batch uses them (§12.7.4), Welcome delivery through the device
 * inbox, join requests, and DsModule.checkCommit on every upload. It also stores invite records and
 * invite bundles (§12.11.4, §12.12), and applies the external commit rule of Takusen with its
 * InviteAuth check (§12.7.3). Not part of the package exports.
 */
import type {
  AdminPermissionModel,
  CommitInspection,
  CryptoGatewayEvent,
  DsSigner,
  DsTransport,
  EngineContext,
  GroupStatus,
  IdentityService,
  LeafEntry,
  MessageService,
  WireBatchAssign,
  WireHandshake,
  WireInboxItem,
  WireJoinRequest,
  WireMlsGroup,
} from '../api'
import { encode, fromB64url, toB64url } from '../codec'
import { INVITE_AUTH_WINDOW_MS, WIRE_VERSION, type CipherSuiteId, type GroupKindName, type HistoryVisibilityName } from '../constants'
import { randomBytes } from '../identity/bytes'
import { identity } from '../identity/index'
import { DsError, FakeDs, MemoryStore, testPermissions } from '../identity/test-helpers'
import { createIdentityService } from '../identity/service'
import { createMessageService } from '../envelope/service'
import { decodeInviteRecord, decodeSignedInviteRecord } from '../invites/codec'
import { createInviteService, type InviteServiceExt } from '../invites/service'
import { ds } from './ds'
import { mls } from './index'
import { createGroupService, type GroupServiceExt } from './service'
import { decodeGroupInfoMessage } from './wire'

interface Pending {
  id: string
  kind: 'add' | 'remove'
  leafIndex: number | null
  userId: string | null
  deviceId: string | null
  keyPackage: Uint8Array | null
  joinRequestId: string | null
  /** The signed DS proposal of the current epoch: Removes, and public_set Adds. */
  proposal: { epoch: number; bytes: Uint8Array; ref: Uint8Array } | null
}

interface Group {
  groupId: string
  kind: GroupKindName
  guildId: string | null
  channelId: string | null
  generation: number
  cipherSuite: CipherSuiteId
  status: GroupStatus
  historyVisibility: HistoryVisibilityName
  epoch: number | null
  states: Map<number, { groupInfo: Uint8Array; ratchetTree: Uint8Array }>
  roster: LeafEntry[]
  handshakes: WireHandshake[]
  pending: Pending[]
  bundles: { id: string; epoch: number; senderDevice: string; blob: string; createdAt: string }[]
  assignee: string | null
  commitLock: Promise<unknown>
  /** The retention sweep: `after` below this gives 410 HandshakesExpired. */
  expiredBefore: number
}

/** An invite with history (§4, §12.12): the record that the route stored, and its bundles. */
interface Invite {
  id: string
  code: string
  guildId: string
  keyId: string
  record: string
  expiresAtMs: number
  revoked: boolean
  bundles: { groupId: string; epoch: number; blob: string; senderDevice: string; senderUser: string }[]
  /** The users who joined the guild with the invite, and when (ms). */
  joined: Map<string, number>
}

export interface Client {
  userId: string
  deviceId: string
  identity: IdentityService
  groups: GroupServiceExt
  messages: MessageService
  /** Null unless the client was made with `invitePermissions`. */
  invites: InviteServiceExt | null
  ctx: EngineContext
  store: MemoryStore
  transport: DsTransport & { deviceId: string | null }
  events: { event: string; payload: unknown }[]
  of<T = unknown>(event: string): T[]
  /** When false, gateway events for this device are dropped (it is offline). */
  online: boolean
}

export class FakeMlsDs {
  readonly id = new FakeDs()
  signer!: DsSigner
  groups = new Map<string, Group>()
  /** channelId → readers. DMs: the participants. */
  channels = new Map<string, { guildId: string | null; readers: Set<string> }>()
  guilds = new Map<string, Set<string>>()
  keyPackages = new Map<string, Uint8Array[]>()
  inbox = new Map<string, WireInboxItem[]>()
  joinRequests = new Map<string, WireJoinRequest & { userId: string }>()
  clients = new Map<string, Client>()
  invites = new Map<string, Invite>()
  /** Rewrites the `next` hashes of published handshakes (fork tests). */
  tamperNext: ((h: WireHandshake) => WireHandshake['next']) | null = null
  /** The wait between automatic resync attempts of every client (GroupServiceDeps.sleep). */
  sleep: (ms: number) => Promise<void> = () => Promise.resolve()
  /** Called before a commit is stored; throwing simulates a lost response. */
  onCommit: ((deviceId: string) => void) | null = null
  log: string[] = []
  private seq = 0
  private queue: { deviceId: string; event: CryptoGatewayEvent }[] = []

  async init(): Promise<this> {
    this.signer = await ds.loadSigner(randomBytes(32))
    return this
  }

  uuid(): string {
    return this.id.id()
  }

  // MARK: - clients

  /**
   * `adminPermissions`: the GroupService also replays signed admin actions (§12.16), as in the Worker.
   * `invitePermissions`: the client gets an InviteService with these §2 rules.
   */
  async client(userId: string, opts: { recoveryKey?: string; store?: MemoryStore; adminPermissions?: boolean; invitePermissions?: AdminPermissionModel } = {}): Promise<Client & { recoveryKey: string | null }> {
    const store = opts.store ?? new MemoryStore()
    const restart = opts.store !== undefined
    const transport = this.transport(userId)
    const events: Client['events'] = []
    const ctx: EngineContext = {
      store,
      transport,
      emit: (event, payload) => void events.push({ event, payload }),
      now: () => this.id.now,
      random: randomBytes,
      origin: 'https://takusen.test',
      platform: 'electron',
      clientVersion: '1.0.0',
    }
    const identity = createIdentityService(ctx, { mls, adminPermissions: testPermissions })
    const groups = createGroupService(ctx, identity, { sleep: (ms) => this.sleep(ms), ...(opts.adminPermissions === true ? { adminPermissions: testPermissions } : {}) })
    const messages = createMessageService(ctx, identity, groups)
    const invites = opts.invitePermissions === undefined ? null : createInviteService(ctx, identity, groups, opts.invitePermissions)
    const loaded = await identity.load({ userId, wrapKey: {} as CryptoKey, platform: 'electron', clientVersion: '1.0.0', deviceName: 'test', origin: ctx.origin })
    let recoveryKey: string | null = null
    if (restart) transport.deviceId = loaded!.deviceId
    else if (opts.recoveryKey === undefined) recoveryKey = (await identity.setupFirstDevice()).recoveryKey
    else await identity.restoreFromRecoveryKey(opts.recoveryKey)
    const deviceId = transport.deviceId!
    const c: Client & { recoveryKey: string | null } = {
      userId,
      deviceId,
      identity,
      groups,
      messages,
      invites,
      ctx,
      store,
      transport,
      events,
      of: <T>(e: string) => events.filter((x) => x.event === e).map((x) => x.payload as T),
      online: true,
      recoveryKey,
    }
    this.clients.set(deviceId, c)
    const route = async (e: CryptoGatewayEvent): Promise<void> => {
      if (!c.online) return
      if (e.t.startsWith('MLS_') || e.t === 'DEVICE_INBOX') await groups.onGatewayEvent(e)
      else if (e.t === 'INVITE_DELETE') await invites?.onGatewayEvent(e)
      else await identity.onGatewayEvent(e)
    }
    this.id.subscribe(deviceId, route)
    return c
  }

  /** Delivers queued gateway events (both fakes) and waits for background work, until all is quiet. */
  async flush(): Promise<void> {
    let quiet = 0
    for (let i = 0; quiet < 2 && i < 10_000; i++) {
      await this.id.flush()
      let n = 0
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        n++
        const c = this.clients.get(next.deviceId)
        if (!c?.online) continue
        if (next.event.t === 'INVITE_DELETE') await c.invites?.onGatewayEvent(next.event)
        else await c.groups.onGatewayEvent(next.event)
      }
      for (const c of this.clients.values()) {
        await c.groups.idle()
        await c.invites?.idle()
      }
      quiet = n === 0 && this.queue.length === 0 ? quiet + 1 : 0
    }
  }

  private publish(deviceIds: Iterable<string>, event: CryptoGatewayEvent): void {
    for (const deviceId of deviceIds) this.queue.push({ deviceId, event })
  }

  private activeDevices(userIds: Iterable<string>): string[] {
    const users = new Set(userIds)
    return [...this.id.devices.values()].filter((d) => users.has(d.userId) && d.status === 'active').map((d) => d.id)
  }

  // MARK: - guilds, channels and groups (the parts of Takusen outside the DS)

  guild(members: string[]): string {
    const id = this.uuid()
    this.guilds.set(id, new Set(members))
    return id
  }

  channel(guildId: string | null, readers: string[]): string {
    const id = this.uuid()
    this.channels.set(id, { guildId, readers: new Set(readers) })
    return id
  }

  readersOf(g: Group): Set<string> {
    if (g.kind === 'public_set') return this.guilds.get(g.guildId!) ?? new Set()
    return this.channels.get(g.channelId!)?.readers ?? new Set()
  }

  /** Allocates a pending group and assigns the create to `assignee` (§12.7.7). */
  allocate(kind: Exclude<GroupKindName, 'voice'>, scope: { guildId: string | null; channelId: string | null }, assignee: string, historyVisibility: HistoryVisibilityName = kind === 'public_set' ? 'shared' : 'joined'): string {
    const generation = [...this.groups.values()].filter((g) => g.kind === kind && (g.channelId ?? g.guildId) === (scope.channelId ?? scope.guildId)).length
    const groupId = toB64url(mls.groupId({ kind, scope: kind === 'public_set' ? scope.guildId! : scope.channelId!, generation }))
    const g: Group = { groupId, kind, ...scope, generation, cipherSuite: 1, status: 'pending', historyVisibility, epoch: null, states: new Map(), roster: [], handshakes: [], pending: [], bundles: [], assignee, commitLock: Promise.resolve(), expiredBefore: 0 }
    this.groups.set(groupId, g)
    const batch: WireBatchAssign = {
      batchId: this.uuid(),
      groupId,
      epoch: 0,
      proposals: [],
      joins: [],
      create: { groupId, kind, guildId: scope.guildId, channelId: scope.channelId, cipherSuite: 1, historyVisibility },
      historyBundleEpochs: [],
      deadline: new Date(this.id.now + 5000).toISOString(),
    }
    this.publish([assignee], { t: 'MLS_BATCH_ASSIGN', d: batch })
    return groupId
  }

  wire(g: Group, deviceId: string | null): WireMlsGroup {
    return {
      groupId: g.groupId,
      kind: g.kind,
      guildId: g.guildId,
      channelId: g.kind === 'public_set' ? null : g.channelId,
      generation: g.generation,
      cipherSuite: g.cipherSuite,
      status: g.status,
      epoch: g.epoch,
      historyVisibility: g.historyVisibility,
      latestSeq: g.handshakes.at(-1)?.seq ?? 0,
      member: deviceId !== null && g.roster.some((r) => r.deviceId === deviceId),
    }
  }

  private claimKeyPackage(deviceId: string): Uint8Array | null {
    const list = this.keyPackages.get(deviceId) ?? []
    return list.shift() ?? null
  }

  private append(g: Group, h: Omit<WireHandshake, 'seq' | 'createdAt'>, also: readonly string[] = []): WireHandshake {
    const full: WireHandshake = { ...h, seq: (g.handshakes.at(-1)?.seq ?? 0) + 1, createdAt: new Date(this.id.now).toISOString() }
    if (this.tamperNext !== null && full.next !== null) full.next = this.tamperNext(full)
    g.handshakes.push(full)
    const d = { groupId: g.groupId, seq: full.seq, epoch: full.epoch, kind: full.kind, senderDevice: full.senderDevice, message: full.message, next: full.next }
    this.publish(new Set([...this.activeDevices(this.readersOf(g)), ...also]), { t: 'MLS_HANDSHAKE', d })
    return full
  }

  /** §12.7.4: one signed proposal per pending item and epoch, appended to the stream first. */
  private async signPending(g: Group): Promise<void> {
    if (g.epoch === null) return
    const state = g.states.get(g.epoch)!
    for (const p of g.pending) {
      if (p.proposal?.epoch === g.epoch) continue
      let bytes: Uint8Array | null = null
      if (p.kind === 'remove') bytes = await ds.proposeRemove(this.signer, state.groupInfo, p.leafIndex!)
      else if (g.kind === 'public_set') bytes = await ds.proposeAdd(this.signer, state.groupInfo, p.keyPackage!)
      if (bytes === null) continue
      p.proposal = { epoch: g.epoch, bytes, ref: await ds.proposalRef(bytes, g.cipherSuite) }
      this.append(g, { epoch: g.epoch, kind: 'proposal', senderDevice: null, message: toB64url(bytes), next: null })
    }
  }

  async queueRemove(groupId: string, deviceId: string): Promise<void> {
    const g = this.groups.get(groupId)!
    for (const r of g.roster.filter((x) => x.deviceId === deviceId)) {
      if (g.pending.some((p) => p.kind === 'remove' && p.leafIndex === r.leafIndex)) continue
      g.pending.push({ id: this.uuid(), kind: 'remove', leafIndex: r.leafIndex, userId: r.userId, deviceId, keyPackage: null, joinRequestId: null, proposal: null })
    }
    await this.signPending(g)
  }

  async queueAdd(groupId: string, deviceId: string, keyPackage: Uint8Array | null = null, joinRequestId: string | null = null, userIdOverride: string | null = null): Promise<boolean> {
    const g = this.groups.get(groupId)!
    const kp = keyPackage ?? this.claimKeyPackage(deviceId)
    if (kp === null) return false
    const userId = userIdOverride ?? this.id.devices.get(deviceId)!.userId
    g.pending.push({ id: this.uuid(), kind: 'add', leafIndex: null, userId, deviceId, keyPackage: kp, joinRequestId, proposal: null })
    await this.signPending(g)
    return true
  }

  /** The scheduler (§12.7.5): one batch for the group, sent to `committer`. */
  batch(groupId: string, committer: string, historyBundleEpochs: number[] = []): WireBatchAssign {
    const g = this.groups.get(groupId)!
    const d: WireBatchAssign = {
      batchId: this.uuid(),
      groupId,
      epoch: g.epoch!,
      proposals: g.pending.filter((p) => p.proposal?.epoch === g.epoch).map((p) => toB64url(p.proposal!.bytes)),
      joins: g.pending.filter((p) => p.kind === 'add' && g.kind !== 'public_set').map((p) => ({ pendingId: p.id, userId: p.userId!, deviceId: p.deviceId!, keyPackage: toB64url(p.keyPackage!) })),
      create: null,
      historyBundleEpochs,
      deadline: new Date(this.id.now + 5000).toISOString(),
    }
    this.publish([committer], { t: 'MLS_BATCH_ASSIGN', d })
    return d
  }

  private masterKeys(userId: string): Uint8Array | null {
    const row = this.id.users.get(userId)?.masters.find((m) => !m.superseded)
    // Takusen passes the raw 32-byte key (master_keys.public_key), not the record.
    return row === undefined ? null : identity.decodeMasterKeyRecord(row.record).publicKey
  }

  private async storeCommit(g: Group, caller: { id: string; userId: string }, body: Parameters<DsTransport['postCommit']>[1]): Promise<{ epoch: number; seq: number }> {
    const epoch = g.epoch!
    const previous = g.states.get(epoch)!
    const commit = fromB64url(body.commit)
    const groupInfo = fromB64url(body.groupInfo)
    const ratchetTree = fromB64url(body.ratchetTree)
    const published = g.pending.filter((p) => p.proposal?.epoch === epoch).map((p) => p.proposal!.bytes)
    const check = await ds.checkCommit({ groupId: fromB64url(g.groupId), epoch, commit, groupInfo, ratchetTree, previous, sender: { userId: caller.userId, deviceId: caller.id }, publishedProposals: published, masterKeys: (u) => this.masterKeys(u) })
    if (!check.ok) {
      this.log.push(`InvalidCommit: ${check.reason}`)
      throw new DsError('InvalidCommit')
    }
    const insp = check.inspection
    // Check 8/9 (simplified): every user in the next roster reads the group, unless a Remove is queued.
    const readers = this.readersOf(g)
    for (const r of insp.next.roster) {
      const queued = g.pending.some((p) => p.kind === 'remove' && p.leafIndex === r.leafIndex)
      const dev = this.id.devices.get(r.deviceId)
      if (!queued && (!readers.has(r.userId) || dev === undefined || dev.status === 'revoked')) {
        this.log.push(`IllegalMembership: ${r.userId}`)
        throw new DsError('IllegalMembership')
      }
    }
    // The external commit rule (§12.7.3): in channel and dm, a user without a leaf joins only with
    // a valid InviteAuth (channel).
    if (insp.sender.type === 'new_member_commit' && g.kind !== 'public_set' && !g.roster.some((r) => r.userId === caller.userId)) {
      const why = this.inviteJoinRefusal(g, caller, insp)
      if (why !== null) {
        this.log.push(`IllegalAdd: ${why}`)
        throw new DsError('IllegalAdd')
      }
    }
    this.onCommit?.(caller.id)
    const external = insp.sender.type === 'new_member_commit'
    const gi = decodeGroupInfoMessage(groupInfo)
    const before = new Set(g.roster.map((r) => r.deviceId))
    g.epoch = epoch + 1
    g.states.set(epoch + 1, { groupInfo, ratchetTree })
    g.roster = insp.next.roster
    const h = this.append(g, {
      epoch,
      kind: external ? 'external_commit' : 'commit',
      senderDevice: caller.id,
      message: body.commit,
      next: { treeHash: toB64url(gi.groupContext.treeHash), confirmedTranscriptHash: toB64url(gi.groupContext.confirmedTranscriptHash) },
    }, [...before])
    if (body.welcome !== null) {
      const item = encode((w) => w.u8(WIRE_VERSION).opaque(fromB64url(g.groupId)).u64(epoch + 1).opaque(fromB64url(body.welcome!)))
      for (const r of g.roster) if (!before.has(r.deviceId) && r.deviceId !== caller.id) this.deliver(r.deviceId, 'welcome', null, toB64url(item))
    }
    // Pending items that the commit applied.
    const inRoster = new Set(g.roster.map((r) => r.deviceId))
    g.pending = g.pending.filter((p) => {
      const done = p.kind === 'remove' ? insp.removedLeaves.includes(p.leafIndex!) : inRoster.has(p.deviceId!)
      if (done && p.joinRequestId !== null) this.joinRequests.get(p.joinRequestId)!.status = 'committed'
      return !done
    })
    for (const p of g.pending) if (p.kind === 'remove') p.leafIndex = g.roster.find((r) => r.deviceId === p.deviceId)?.leafIndex ?? p.leafIndex
    await this.signPending(g)
    return { epoch: epoch + 1, seq: h.seq }
  }

  /** Takusen's InviteAuth check of an external join (commits.ts, §12.11.4). Null when it allows the join. */
  private inviteJoinRefusal(g: Group, caller: { id: string; userId: string }, insp: CommitInspection): string | null {
    const leaf = insp.next.roster.find((r) => r.deviceId === caller.id)
    if (g.kind !== 'channel' || leaf === undefined || insp.authenticatedData.length === 0) return 'no leaf of the user'
    const v = ds.verifyInviteAuth({ authenticatedData: insp.authenticatedData, groupId: fromB64url(g.groupId), leafSignatureKey: leaf.signatureKey })
    if (v === null) return 'the InviteAuth does not verify'
    const inv = [...this.invites.values()].find((i) => i.keyId === toB64url(v.keyId))
    if (inv === undefined || inv.revoked || inv.guildId !== g.guildId || inv.record !== toB64url(v.signedRecord)) return 'unknown invite'
    if (inv.expiresAtMs !== 0 && inv.expiresAtMs <= this.id.now) return 'the invite expired'
    if (!v.record.channelIds.includes(g.channelId!)) return 'the channel is not in the scope'
    const joinedAt = inv.joined.get(caller.userId)
    if (joinedAt === undefined || this.id.now - joinedAt > INVITE_AUTH_WINDOW_MS) return 'not joined with the invite'
    return null
  }

  // MARK: - invites with history (the parts of Takusen outside the DS, §4)

  /** POST /guilds/:id/invites with a record. Like Takusen, it does not check the admin state. */
  createInvite(guildId: string, record: string): { inviteId: string; code: string } {
    const rec = decodeInviteRecord(decodeSignedInviteRecord(fromB64url(record)).record)
    const inv: Invite = { id: this.uuid(), code: this.uuid().slice(0, 8).toUpperCase(), guildId, keyId: toB64url(rec.signPublic), record, expiresAtMs: rec.expiresAtMs, revoked: false, bundles: [], joined: new Map() }
    this.invites.set(inv.id, inv)
    return { inviteId: inv.id, code: inv.code }
  }

  /** POST /invites/:code: the user joins the guild with the invite. */
  acceptInvite(code: string, userId: string): void {
    const inv = [...this.invites.values()].find((i) => i.code === code)!
    this.guilds.get(inv.guildId)!.add(userId)
    inv.joined.set(userId, this.id.now)
  }

  /** DELETE /invites/:code: revoke, delete the bundles, INVITE_DELETE to the guild. */
  revokeInvite(inviteId: string): void {
    const inv = this.invites.get(inviteId)!
    inv.revoked = true
    inv.bundles = []
    this.publish(this.activeDevices(this.guilds.get(inv.guildId) ?? []), { t: 'INVITE_DELETE', d: { guildId: inv.guildId, code: inv.code, inviteId } })
  }

  /** MLS_JOIN_UPDATE for a join request (the scheduler finds no online member, §12.7.5 step 7). */
  joinUpdate(requestId: string, status: WireJoinRequest['status']): void {
    const r = this.joinRequests.get(requestId)!
    r.status = status
    this.publish([r.deviceId], { t: 'MLS_JOIN_UPDATE', d: { requestId, groupId: r.groupId, status, reason: null } })
  }

  deliver(deviceId: string, kind: WireInboxItem['kind'], senderDevice: string | null, body: string): void {
    const list = this.inbox.get(deviceId) ?? []
    const item: WireInboxItem = { id: this.uuid(), seq: ++this.seq, kind, senderDevice, body, createdAt: new Date(this.id.now).toISOString() }
    list.push(item)
    this.inbox.set(deviceId, list)
    this.publish([deviceId], { t: 'DEVICE_INBOX', d: { id: item.id, seq: item.seq, kind } })
  }

  // MARK: - the transport

  transport(userId: string): DsTransport & { deviceId: string | null } {
    const base = this.id.transport(userId)
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the transport methods are plain functions
    const self = this
    const caller = (): { id: string; userId: string } => {
      const d = self.id.caller(base, userId, false)
      return { id: d.id, userId }
    }
    const group = (groupId: string): Group => {
      const g = self.groups.get(groupId)
      if (g === undefined) throw new DsError('UnknownGroup')
      return g
    }
    const t = base
    Object.assign(t, {
      async getDsInfo() {
        const info = await self.id.transport(userId).getDsInfo()
        return { ...info, externalSender: toB64url(self.signer.externalSender), limits: { ...info.limits, keyPackageTarget: 3 } }
      },
      async uploadKeyPackages(body: Parameters<DsTransport['uploadKeyPackages']>[0]) {
        const c = caller()
        const list = self.keyPackages.get(c.id) ?? []
        list.push(...body.keyPackages.map(fromB64url))
        self.keyPackages.set(c.id, list)
        return { stored: body.keyPackages.length, total: list.length }
      },
      async countKeyPackages() {
        const c = caller()
        return [{ cipherSuite: 1, count: (self.keyPackages.get(c.id) ?? []).length, lastResort: true }]
      },
      async listGroups() {
        const c = caller()
        return [...self.groups.values()].filter((g) => self.readersOf(g).has(userId)).map((g) => self.wire(g, c.id))
      },
      async getGroup(groupId: string) {
        return self.wire(group(groupId), caller().id)
      },
      async getGroupForChannel(channelId: string) {
        const c = caller()
        const ch = self.channels.get(channelId)
        if (ch === undefined) return null
        const own = [...self.groups.values()].filter((g) => g.channelId === channelId && g.status !== 'retired').at(-1)
        if (own !== undefined) return self.wire(own, c.id)
        const pub = [...self.groups.values()].find((g) => g.kind === 'public_set' && g.guildId === ch.guildId)
        return pub === undefined ? null : self.wire(pub, c.id)
      },
      async getGroupState(groupId: string, epoch?: number) {
        caller()
        const g = group(groupId)
        const e = epoch ?? g.epoch!
        const s = g.states.get(e)
        if (s === undefined) throw new DsError('EpochNotKept')
        return { groupId, epoch: e, groupInfo: toB64url(s.groupInfo), ratchetTree: toB64url(s.ratchetTree) }
      },
      async createGroup(body: Parameters<DsTransport['createGroup']>[0]) {
        const c = caller()
        const g = group(body.groupId)
        if (g.status !== 'pending') throw new DsError('GroupExists')
        if (g.assignee !== c.id) throw new DsError('IllegalAdd')
        const groupInfo = fromB64url(body.groupInfo)
        const ratchetTree = fromB64url(body.ratchetTree)
        const info = await ds.inspectGroupInfo(groupInfo, ratchetTree)
        if (!info.signatureValid || !info.treeHashValid || info.epoch !== 0 || info.roster.length !== 1 || info.roster[0]!.deviceId !== c.id) throw new DsError('InvalidCommit')
        if (info.extensions.types.join() !== '5,3,61857' || toB64url(info.extensions.externalSenders!) !== toB64url(self.signer.externalSender)) throw new DsError('InvalidCommit')
        if (info.descriptor?.kind !== g.kind || info.descriptor.createdByUserId !== c.userId) throw new DsError('InvalidCommit')
        g.status = 'active'
        g.epoch = 0
        g.states.set(0, { groupInfo, ratchetTree })
        g.roster = info.roster
        if (g.kind !== 'public_set') for (const d of self.activeDevices(self.readersOf(g))) if (d !== c.id) await self.queueAdd(g.groupId, d)
        self.publish(self.activeDevices(self.readersOf(g)), { t: 'MLS_GROUP_UPDATE', d: self.wire(g, null) })
        return self.wire(g, c.id)
      },
      async postCommit(groupId: string, body: Parameters<DsTransport['postCommit']>[1]) {
        const c = caller()
        const g = group(groupId)
        // One commit at a time per group: the compare-and-set of §12.7.3 check 10.
        const run = g.commitLock.then(async () => {
          if (g.epoch !== body.epoch) return { ok: false as const, code: 'EpochConflict' as const, epoch: g.epoch! }
          for (const x of body.rejected) {
            if ('proposalRef' in x) {
              // A DS proposal that the committer rejects: the pending row is rejected (mls_pending.proposal_ref).
              const i = g.pending.findIndex((p) => p.proposal !== null && toB64url(p.proposal.ref) === x.proposalRef)
              self.log.push(i >= 0 ? `rejected proposal ${x.reason}` : `rejected unknown proposal`)
              if (i >= 0) g.pending.splice(i, 1)
            } else self.log.push(`rejected ${x.reason}`)
          }
          const r = await self.storeCommit(g, c, body)
          return { ok: true as const, ...r }
        })
        g.commitLock = run.catch(() => undefined)
        return run
      },
      async fetchHandshakes(groupId: string, after: number, limit = 100) {
        caller()
        const g = group(groupId)
        if (after < g.expiredBefore) throw new DsError('HandshakesExpired')
        return { handshakes: g.handshakes.filter((h) => h.seq > after).slice(0, limit), latestSeq: g.handshakes.at(-1)?.seq ?? 0 }
      },
      async postJoinRequest(groupId: string, body: { keyPackage: string }) {
        const c = caller()
        const g = group(groupId)
        if (!self.readersOf(g).has(userId)) throw new DsError('UnknownGroup')
        const req: WireJoinRequest & { userId: string } = { id: self.uuid(), groupId, deviceId: c.id, status: 'queued', reason: null, createdAt: new Date(self.id.now).toISOString(), userId }
        self.joinRequests.set(req.id, req)
        if (g.kind !== 'public_set' && g.roster.some((r) => r.userId === userId)) req.status = 'external_commit'
        else await self.queueAdd(groupId, c.id, fromB64url(body.keyPackage), req.id)
        return { id: req.id, groupId: req.groupId, deviceId: req.deviceId, status: req.status, reason: req.reason, createdAt: req.createdAt }
      },
      async getJoinRequest(id: string) {
        const r = self.joinRequests.get(id)
        if (r === undefined) throw new DsError('NotFound')
        return { id: r.id, groupId: r.groupId, deviceId: r.deviceId, status: r.status, reason: r.reason, createdAt: r.createdAt }
      },
      async declineBatch(batchId: string, reason: string) {
        self.log.push(`decline ${batchId} ${reason}`)
      },
      async postHistoryBundle(groupId: string, body: { epoch: number; blob: string }) {
        const c = caller()
        group(groupId).bundles.push({ id: self.uuid(), epoch: body.epoch, senderDevice: c.id, blob: body.blob, createdAt: new Date(self.id.now).toISOString() })
      },
      async getHistoryBundles(groupId: string, epoch: number) {
        caller()
        return group(groupId).bundles.filter((b) => b.epoch === epoch).map((b) => ({ ...b, groupId }))
      },
      async inviteRecords(guildId: string) {
        caller()
        if (self.guilds.get(guildId)?.has(userId) !== true) throw new DsError('UnknownGuild')
        return [...self.invites.values()]
          .filter((i) => i.guildId === guildId && !i.revoked && (i.expiresAtMs === 0 || i.expiresAtMs > self.id.now))
          .map((i) => {
            const newest = new Map<string, number>()
            for (const b of i.bundles) newest.set(b.groupId, Math.max(newest.get(b.groupId) ?? -1, b.epoch))
            return { inviteId: i.id, keyId: i.keyId, record: i.record, expiresAt: i.expiresAtMs === 0 ? null : new Date(i.expiresAtMs).toISOString(), bundled: [...newest].map(([groupId, epoch]) => ({ groupId, epoch })) }
          })
      },
      async postInviteBundle(inviteId: string, body: { groupId: string; epoch: number; blob: string }) {
        const c = caller()
        const inv = self.invites.get(inviteId)
        if (inv === undefined || inv.revoked) throw new DsError('UnknownInvite')
        const g = group(body.groupId)
        if (!self.readersOf(g).has(userId) || g.guildId !== inv.guildId) throw new DsError('UnknownGroup')
        // The scope of the stored record (§12.12): public_set, or a channel that the record names.
        const scope = decodeInviteRecord(decodeSignedInviteRecord(fromB64url(inv.record)).record).channelIds
        if (g.kind !== 'public_set' && !(g.kind === 'channel' && scope.includes(g.channelId!))) throw new DsError('ValidationError')
        inv.bundles.push({ ...body, senderDevice: c.id, senderUser: userId })
      },
      async inviteBundles(code: string) {
        caller()
        const inv = [...self.invites.values()].find((i) => i.code === code)
        if (inv === undefined || inv.revoked || !inv.joined.has(userId)) throw new DsError('UnknownInvite')
        return { inviteId: inv.id, record: inv.record, bundles: inv.bundles.map(({ groupId, epoch, blob, senderDevice }) => ({ groupId, epoch, blob, senderDevice })) }
      },
      async channelReaders(channelId: string) {
        return [...(self.channels.get(channelId)?.readers ?? [])]
      },
      async guildMembers(guildId: string) {
        return [...(self.guilds.get(guildId) ?? [])]
      },
      async fetchInbox(after: number) {
        const c = self.id.caller(base, userId, false)
        return (self.inbox.get(c.id) ?? []).filter((i) => i.seq > after)
      },
      async ackInbox(id: string) {
        const c = self.id.caller(base, userId, false)
        self.inbox.set(c.id, (self.inbox.get(c.id) ?? []).filter((i) => i.id !== id))
      },
      async postInbox(deviceId: string, body: { kind: 'dsk_transfer' | 'history_keys'; body: string }) {
        const c = self.id.caller(base, userId, false)
        const target = self.id.devices.get(deviceId)
        if (target?.userId !== userId) throw new DsError('UnknownDevice')
        self.deliver(deviceId, body.kind, c.id, body.body)
      },
    } satisfies Partial<DsTransport>)
    return t
  }
}

/** The chain generation of a device's leaf in a group roster, as a member sees it. */
export function leafGeneration(roster: LeafEntry[], deviceId: string): number | null {
  return roster.find((r) => r.deviceId === deviceId)?.chain?.dsk.generation ?? null
}

