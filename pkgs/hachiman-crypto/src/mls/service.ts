/**
 * GroupService (docs/gateway-protocol.md §12.6, §12.7, §12.8.7, §12.11.1, §12.11.2): group sync,
 * the device inbox, batch commits, joins, resyncs, own commits across a crash (pendingCommits),
 * the fork alert, epoch secrets, the membership timeline and history bundles. onOwnCommit and
 * onJoin tell the InviteService about each own commit and each join (invite bundles, §12.11.4).
 * Through setInviteJoins, the InviteService makes and checks the InviteAuth of an external join
 * into a 'channel' group (§12.11.4 "Join authorization").
 *
 * Every group has a lock, so handshakes, commits and joins of one group run one at a time.
 */
import {
  CryptoError,
  type ChainContext,
  type CreateGroupService,
  type CryptoEvents,
  type CryptoGatewayEvent,
  type DeviceCertificate as DeviceCertificateT,
  type DeviceId,
  type EngineContext,
  type GroupDescriptor,
  type GroupServiceDeps,
  type BatchRejectReason,
  type BatchRejection,
  type GroupService,
  type GroupStatus,
  type HistoryKeyEntry,
  type IdentityService,
  type InviteJoins,
  type LeafEntry,
  type MembershipEvent,
  type MlsGroupHandle,
  type PendingCommit,
  type ProposalPolicy,
  type StoreSchema,
  type UserId,
  type WireBatchAssign,
  type WireHandshake,
  type WireInboxItem,
  type WireMlsGroup,
} from '../api'
import { CodecError, decode, fromB64url, toB64url } from '../codec'
import { COMMIT_REJECTED_RESYNC_DELAYS_MS, DSK_ROTATION_GRACE_MS, FORK_ALERT_FAILURES, FORK_ALERT_WINDOW_MS, FORK_RESYNC_MAX_INTERVAL_MS, FORK_RESYNC_MIN_INTERVAL_MS, GROUP_STATE_EPOCHS_KEPT, HISTORY_BUNDLE_MAX_EPOCHS, WIRE_VERSION, type CipherSuiteId } from '../constants'
import { equalBytes } from '../identity/bytes'
import { decodeHistoryKeysPayload, type HistoryKeysPayload } from '../identity/codec'
import { openDeviceMessage, sealHistoryKeys } from '../identity/device-message'
import { identity as identityModule } from '../identity/index'
import {
  checkAdd,
  checkStoredProposal,
  contextOf,
  dropStoredProposals,
  externalCommitAuth,
  handshakeUserIds,
  hasStoredProposal,
  keyPackageIdentity,
  messageSecret,
  mls as defaultMls,
  ownLeafEntry,
  proposalRefOf,
  treeHasSignatureKey,
  treeUserIds,
  welcomeKeyPackageRefs,
} from './index'
import { decodeBundleHeader } from './history'
import { normalizeExternalSender } from './wire'

/** §2 bits that the policy needs. `admin.spec.ts` keeps them equal to `@hachiman/client/permissions`. */
const Perm = { ADMINISTRATOR: 1 << 3, MANAGE_CHANNELS: 1 << 4, MANAGE_GUILD: 1 << 5, VIEW_CHANNEL: 1 << 10 } as const
const HANDSHAKE_PAGE = 100
const TIMELINE_MAX = 1000
const COMMIT_ATTEMPTS = 5
/** The §12.19 codes of a commit upload that the DS refused before it stored anything (§12.7.3). */
const COMMIT_REFUSALS = new Set(['InvalidCommit', 'IllegalAdd', 'IllegalMembership', 'IllegalRemove', 'GroupFull', 'GroupPending', 'GroupRetired', 'UnknownGroup', 'MissingPermissions', 'InboxFull'])

export type { GroupServiceDeps } from '../api'

export interface GroupServiceExt extends GroupService {
  /** Resolves when the background work (resyncs after a DSK rotation or a fork alert) is done. */
  idle(): Promise<void>
}

type GroupRow = StoreSchema['groups']
type EpochListener = (e: { groupId: Uint8Array; epoch: number }) => void

interface Ctx {
  gid: string
  row: GroupRow
  handle: MlsGroupHandle | null
}

function dsCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'dsCode' in e && typeof e.dsCode === 'string') return e.dsCode
  return undefined
}

function isTransient(e: unknown): boolean {
  return dsCode(e) !== undefined || (e instanceof CryptoError && e.code === 'Transport')
}

/** struct { uint8 version = 1; opaque group_id<V>; uint64 epoch; opaque welcome<V>; } WelcomeItem (§12.7.6). */
export function decodeWelcomeItem(b: Uint8Array): { groupId: Uint8Array; epoch: number; welcome: Uint8Array } {
  try {
    return decode(b, (r) => {
      if (r.u8() !== WIRE_VERSION) throw new CodecError('WelcomeItem version')
      return { groupId: r.opaque(64), epoch: r.u64n(), welcome: r.opaque() }
    })
  } catch (e) {
    throw new CryptoError('Malformed', `WelcomeItem: ${(e as Error).message}`)
  }
}

const descriptorOfWire = (g: WireMlsGroup): Omit<GroupDescriptor, 'createdByUserId'> => ({ kind: g.kind, guildId: g.guildId, channelId: g.channelId, historyVisibility: g.historyVisibility })

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const REJECT: Record<string, BatchRejectReason> = { not_reader: 'not_reader', not_admin_reader: 'not_reader', malformed: 'malformed', malformed_credential: 'malformed' }

/** A policy or chain verdict (checkAdd, processHandshake) as a batch rejection reason. */
function rejectReason(why: string): BatchRejectReason {
  if (why.includes('invalid_chain:revoked')) return 'revoked'
  if (why.includes('invalid_chain')) return 'invalid_chain'
  return REJECT[why] ?? 'policy'
}

function failingContext(nowMs: number): ChainContext {
  return { pinnedMaster: null, currentDsk: null, highestSeenDskGeneration: null, revokedDeviceIds: new Set(), leaf: null, entering: false, nowMs }
}

/** The users of `added` that had no leaf in `before`: a new device of a member is no new user. */
function newUserIds(before: readonly LeafEntry[], added: readonly LeafEntry[]): UserId[] {
  const known = new Set(before.map((x) => x.userId))
  return [...new Set(added.map((a) => a.userId).filter((u) => !known.has(u)))]
}

export const createGroupService = ((ctx: EngineContext, identity: IdentityService, deps: GroupServiceDeps = {}): GroupServiceExt => {
  const { store, transport } = ctx
  const mls = deps.mls ?? defaultMls
  const sleep = deps.sleep ?? defaultSleep
  const handles = new Map<string, MlsGroupHandle>()
  /** Counts the saveRow calls per group: load caches a restored handle only when none came between. */
  const saves = new Map<string, number>()
  /** Handles of recent epochs: history bundles need K_hist of their epoch (§12.11.2). */
  const recent = new Map<string, Map<number, MlsGroupHandle>>()
  const locks = new Map<string, Promise<unknown>>()
  const stuck = new Map<string, string>()
  const joinRequested = new Set<string>()
  /** Groups where the DS refused the invite join of this device (403 IllegalAdd): no new try in this session. */
  const inviteJoinRefused = new Set<string>()
  /** Groups with an automatic resync scheduled after a rejected commit. */
  const recovering = new Set<string>()
  const background = new Set<Promise<unknown>>()
  const ownCommitListeners = new Set<EpochListener>()
  const joinListeners = new Set<EpochListener>()
  let inviteJoins: InviteJoins | null = null
  let inboxLock: Promise<unknown> = Promise.resolve()

  identity.onDskRotated(() => {
    spawn(resyncAll('dsk_rotated'))
  })

  // MARK: - plumbing

  function spawn(p: Promise<unknown>): void {
    const q = p.catch(report).finally(() => background.delete(q))
    background.add(q)
  }

  function report(e: unknown): void {
    const code = e instanceof CryptoError ? e.code : 'Transport'
    ctx.emit('error', { code, message: e instanceof Error ? e.message : String(e), dsCode: dsCode(e) })
  }

  /**
   * After an own commit that the DS accepted (the new epoch and its secret are stored), or after a
   * join. The listeners run later, outside the group lock: sendState holds the lock on the encrypt
   * path, and a listener that waits for the group would wait for itself.
   */
  function notify(listeners: Set<EpochListener>, h: MlsGroupHandle): void {
    const e = { groupId: h.groupId, epoch: h.epoch }
    for (const cb of listeners) {
      spawn(
        Promise.resolve().then(() => {
          cb(e)
        }),
      )
    }
  }

  function withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prev = locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }

  async function load(gid: string): Promise<Ctx | null> {
    const seen = saves.get(gid) ?? 0
    const row = await store.get('groups', gid)
    if (row === undefined) return null
    let handle = handles.get(gid) ?? null
    if (handle === null && row.state.length > 0) {
      handle = await mls.restore(row.state)
      // A caller outside the lock (descriptor, currentEpoch) restored a row that a locked caller
      // replaced or removed meanwhile: read it again, and never cache the old handle.
      if ((saves.get(gid) ?? 0) !== seen) return load(gid)
      handles.set(gid, handle)
    }
    return { gid, row, handle }
  }

  function withGroup<R>(gid: string, fn: (g: Ctx | null) => Promise<R>): Promise<R> {
    return withLock(`g:${gid}`, async () => fn(await load(gid)))
  }

  function remember(gid: string, h: MlsGroupHandle): void {
    handles.set(gid, h)
    let m = recent.get(gid)
    if (!m) {
      m = new Map<number, MlsGroupHandle>()
      recent.set(gid, m)
    }
    m.set(h.epoch, h)
    for (const e of [...m.keys()].sort((a, b) => a - b).slice(0, Math.max(0, m.size - GROUP_STATE_EPOCHS_KEPT))) m.delete(e)
  }

  async function dsExternalSenderKey(): Promise<Uint8Array> {
    const row = await store.get('identity', 'self')
    const bytes = row?.dsExternalSender ?? fromB64url((await transport.getDsInfo()).externalSender)
    return normalizeExternalSender(bytes).signatureKey
  }

  async function readersOf(d: Pick<GroupDescriptor, 'kind' | 'guildId' | 'channelId'>): Promise<Set<UserId> | null> {
    try {
      if (d.kind === 'public_set' && d.guildId !== null) return new Set(await transport.guildMembers(d.guildId))
      if ((d.kind === 'channel' || d.kind === 'dm') && d.channelId !== null) return new Set(await transport.channelReaders(d.channelId))
    } catch {
      return null
    }
    return null
  }

  /**
   * The ProposalPolicy with prefetched chain contexts for `userIds` (the ts-mls callback is synchronous).
   * `ownCommit`: the policy is for an own batch commit. Then a 'channel' group of a guild without a
   * verified genesis action fails closed (adminChainMissing, §12.16): the DS can return an empty
   * admin chain to a device without a cached admin state.
   */
  async function buildPolicy(d: Pick<GroupDescriptor, 'kind' | 'guildId' | 'channelId'>, userIds: Iterable<UserId>, ownCommit = false): Promise<ProposalPolicy> {
    const users = new Set(userIds)
    users.add(identity.self().userId)
    const contexts = new Map<UserId, ChainContext>()
    for (const u of users) contexts.set(u, await identity.chainContextFor(u, false))
    const readers = await readersOf(d)
    let adminReaders: Set<UserId> | null = null
    let adminChainMissing = false
    const canChange = new Set<UserId>()
    const perms = deps.adminPermissions
    if (perms !== undefined && d.guildId !== null && (d.kind === 'channel' || d.kind === 'public_set')) {
      const state = await identity.adminState(d.guildId)
      if (state !== null) {
        const members = await transport.guildMembers(d.guildId)
        for (const u of users) {
          if (d.kind === 'channel' && d.channelId !== null) {
            const p = perms.channelPermissions(state, d.channelId, u, members)
            if (p & (Perm.MANAGE_CHANNELS | Perm.ADMINISTRATOR)) canChange.add(u)
            if (p & (Perm.VIEW_CHANNEL | Perm.ADMINISTRATOR)) (adminReaders ??= new Set()).add(u)
          } else if (perms.guildPermissions(state, u) & (Perm.MANAGE_GUILD | Perm.ADMINISTRATOR)) {
            canChange.add(u)
          }
        }
        if (d.kind === 'channel') adminReaders ??= new Set()
      } else if (ownCommit && d.kind === 'channel') {
        adminChainMissing = true
      }
    }
    const nowMs = ctx.now()
    return {
      kind: d.kind,
      dsExternalSenderKey: d.kind === 'voice' ? null : await dsExternalSenderKey(),
      readers,
      adminReaders,
      adminChainMissing,
      chainContextFor: (u) => contexts.get(u) ?? failingContext(nowMs),
      canChangeDescriptor: (u) => canChange.has(u),
      voice: null,
    }
  }

  function descriptorOf(g: Ctx): GroupDescriptor {
    const d = g.handle === null ? null : contextOf(g.handle).descriptor
    if (d === null) throw new CryptoError('StoreCorrupt', 'group without a descriptor')
    return d
  }

  async function freshKeyPackage(cipherSuite: CipherSuiteId, keep: boolean): Promise<{ publicPackage: Uint8Array; privatePackage: Uint8Array }> {
    const self = identity.self()
    const [kp] = await mls.generateKeyPackages({ chain: self.chain, signatureKey: self.mlsSignatureKey, cipherSuite, count: 1, lastResort: false })
    if (kp === undefined) throw new CryptoError('Malformed', 'no key package')
    if (keep) await store.put('keyPackages', toB64url(kp.ref), { ref: kp.ref, cipherSuite, publicPackage: kp.publicPackage, privatePackage: kp.privatePackage, lastResort: false, createdAtMs: ctx.now() })
    return kp
  }

  // MARK: - state transitions: epoch secrets, membership, timeline

  async function appendTimeline(gid: string, events: MembershipEvent[]): Promise<void> {
    if (events.length === 0) return
    const row = await store.get('timeline', gid)
    const all = [...(row?.events ?? []), ...events].slice(-TIMELINE_MAX)
    await store.put('timeline', gid, { events: all })
    for (const e of events) ctx.emit('membership', e)
  }

  /** Opens and closes membership intervals for the leaves that changed (§12.8.5 step 9). */
  async function recordMembership(gid: string, epoch: number, added: readonly LeafEntry[], removed: readonly LeafEntry[]): Promise<void> {
    for (const r of removed) {
      const key = `${gid}:${r.deviceId}`
      const row = (await store.get('membership', key)) ?? { intervals: [] }
      const open = row.intervals.find((i) => i.toEpoch === null && i.leafIndex === r.leafIndex)
      if (open) open.toEpoch = epoch - 1
      row.removedAtEpoch = epoch
      await store.put('membership', key, row)
    }
    for (const a of added) {
      const key = `${gid}:${a.deviceId}`
      const row = (await store.get('membership', key)) ?? { intervals: [] }
      for (const i of row.intervals) i.toEpoch ??= epoch - 1
      row.intervals.push({ leafIndex: a.leafIndex, fromEpoch: epoch, toEpoch: null })
      row.removedAtEpoch = null
      await store.put('membership', key, row)
    }
  }

  /**
   * The secret of an epoch that this device holds the state of. It comes from MLS, so it replaces
   * an imported secret that differs: any member can sign an invite bundle (§12.11.4).
   */
  async function storeEpochSecret(gid: string, h: MlsGroupHandle): Promise<void> {
    const key = `${gid}:${h.epoch}`
    const secret = await messageSecret(h)
    const replaced = await store.transaction(['epochSecrets'], async (tx) => {
      const old = await tx.get('epochSecrets', key)
      if (old !== undefined && equalBytes(old.secret, secret)) return false
      await tx.put('epochSecrets', key, { groupId: h.groupId, epoch: h.epoch, secret, backedUp: false })
      return old !== undefined
    })
    if (replaced) ctx.emit('epochKeysAvailable', { groupId: gid, epochs: [h.epoch] })
  }

  async function saveRow(g: Ctx, h: MlsGroupHandle | null, lastSeq: number, status?: GroupStatus): Promise<void> {
    saves.set(g.gid, (saves.get(g.gid) ?? 0) + 1)
    g.row = { ...g.row, state: h === null ? new Uint8Array(0) : h.state, lastSeq, status: status ?? g.row.status }
    g.handle = h
    await store.put('groups', g.gid, g.row)
    if (h === null) handles.delete(g.gid)
    else remember(g.gid, h)
  }

  /** After a new epoch: secret, membership, timeline, then buffered envelopes (§12.7.9). */
  async function enterEpoch(g: Ctx, h: MlsGroupHandle, lastSeq: number, change: { kind: MembershipEvent['kind']; actor: UserId | null; added: LeafEntry[]; removed: LeafEntry[] }): Promise<void> {
    await saveRow(g, h, lastSeq)
    await storeEpochSecret(g.gid, h)
    await recordMembership(g.gid, h.epoch, change.added, change.removed)
    const channelId = g.row.channelId
    const events: MembershipEvent[] = []
    const subjects = (xs: LeafEntry[]) => xs.map((x) => ({ userId: x.userId, deviceId: x.deviceId }))
    if (change.kind === 'resynced' || change.kind === 'joined_external' || change.kind === 'created') {
      events.push({ groupId: g.gid, channelId, epoch: h.epoch, actorUserId: change.actor, kind: change.kind, subjects: subjects(change.added) })
    } else {
      if (change.added.length > 0) events.push({ groupId: g.gid, channelId, epoch: h.epoch, actorUserId: change.actor, kind: 'added', subjects: subjects(change.added) })
      if (change.removed.length > 0) events.push({ groupId: g.gid, channelId, epoch: h.epoch, actorUserId: change.actor, kind: 'removed', subjects: subjects(change.removed) })
    }
    await appendTimeline(g.gid, events)
    await drainBuffered(g)
  }

  async function drainBuffered(g: Ctx): Promise<void> {
    if (g.handle === null) return
    const current = g.handle.epoch
    const ready = await store.transaction(['buffered'], async (tx) => {
      const row = await tx.get('buffered', g.gid)
      if (!row || row.messages.length === 0) return []
      const now = row.messages.filter((m) => m.epoch <= current)
      if (now.length === 0) return []
      const rest = row.messages.filter((m) => m.epoch > current)
      if (rest.length === 0) await tx.delete('buffered', g.gid)
      else await tx.put('buffered', g.gid, { messages: rest })
      return now
    })
    if (ready.length > 0) ctx.emit('epochKeysAvailable', { groupId: g.gid, epochs: [...new Set(ready.map((m) => m.epoch))].sort((a, b) => a - b) })
  }

  function forkCheck(h: MlsGroupHandle, next: WireHandshake['next']): boolean {
    if (next === null) return true
    const c = contextOf(h)
    return equalBytes(c.treeHash, fromB64url(next.treeHash)) && equalBytes(c.confirmedTranscriptHash, fromB64url(next.confirmedTranscriptHash))
  }

  function forkAlert(g: Ctx, reason: CryptoEvents['forkAlert']['reason']): void {
    ctx.emit('forkAlert', { groupId: g.gid, channelId: g.row.channelId, epoch: g.handle?.epoch ?? null, reason })
  }

  /**
   * §12.7.9, §12.8.7: this device rejected a commit that the DS accepted, so its state stops. It
   * resyncs its own leaf by external commit after each wait of COMMIT_REJECTED_RESYNC_DELAYS_MS
   * (5 attempts). The resync enters the DS epoch, drains the buffered envelopes and asks the own
   * devices for the skipped epoch keys. When every attempt fails, the group stays stopped (fail
   * closed) until the next sync() schedules the attempts again. Voice groups never come here
   * (the media service owns them, and §12.10 has no external commit).
   */
  function scheduleRecovery(gid: string): void {
    if (recovering.has(gid)) return
    recovering.add(gid)
    const run = async (): Promise<void> => {
      let last: unknown = null
      for (const delay of COMMIT_REJECTED_RESYNC_DELAYS_MS) {
        await sleep(delay)
        try {
          await withGroup(gid, async (g) => {
            if (g?.handle == null || g.row.kind === 'voice' || g.row.status === 'retired' || !stuck.has(gid)) return
            const before = g.handle.epoch
            await resyncLocked(g, 'fork')
            const now = g.handle as MlsGroupHandle | null
            if (now !== null && now.epoch - before > 1) spawn(requestHistoryKeys(now.groupId, before + 1, now.epoch - 1))
          })
          return
        } catch (e) {
          last = e
        }
      }
      const why = last instanceof Error ? last.message : String(last)
      throw new CryptoError('InvalidChain', `group ${gid} stays stopped after ${COMMIT_REJECTED_RESYNC_DELAYS_MS.length} resync attempts: ${why}`)
    }
    spawn(
      run().finally(() => {
        recovering.delete(gid)
      }),
    )
  }

  // MARK: - handshakes

  /** Applies one handshake of the stream. Returns false when processing of the group must stop. */
  async function applyHandshake(g: Ctx, h: { seq: number; epoch: number; kind: WireHandshake['kind']; senderDevice: DeviceId | null; message: Uint8Array; next: WireHandshake['next'] }): Promise<boolean> {
    const handle = g.handle
    if (handle === null) return false
    if (h.seq <= g.row.lastSeq) return true
    if (h.epoch < handle.epoch) {
      await saveRow(g, handle, h.seq)
      return true
    }
    if (h.epoch > handle.epoch) {
      // The stream skipped a commit that this state never saw: the state is lost.
      spawnResync(g.gid, 'state_lost')
      return false
    }
    const self = identity.self()
    if (h.kind !== 'proposal' && h.senderDevice === self.deviceId) {
      // ts-mls cannot process its own commit: adopt the stored state (§12.7.9).
      const pending = await store.get('pendingCommits', g.gid)
      await store.delete('pendingCommits', g.gid)
      if (pending?.epoch !== h.epoch) {
        spawnResync(g.gid, 'state_lost')
        return false
      }
      const next = await mls.restore(pending.state)
      if (!forkCheck(next, h.next)) {
        forkAlert(g, 'group_info_mismatch')
        spawnResync(g.gid, 'fork')
        return false
      }
      const before = mls.roster(handle)
      const change = diff(before, mls.roster(next))
      await enterEpoch(g, next, h.seq, { kind: h.kind === 'external_commit' ? 'resynced' : 'added', actor: self.userId, ...change })
      emitUsersAdded(g, before, change.added, true)
      notify(ownCommitListeners, next)
      return true
    }

    const desc = descriptorOf(g)
    const policy = await buildPolicy(desc, handshakeUserIds(handle, h.message))
    const invite = h.kind === 'external_commit' && desc.kind === 'channel' ? await inviteJoinKey(handle.groupId, desc, h.message) : null
    if (invite !== null) policy.inviteJoinKey = invite.key
    const r = await mls.processHandshake(handle, h.message, policy)
    if (r.result === 'rejected') {
      if (h.kind === 'proposal') {
        report(new CryptoError('InvalidChain', `group ${g.gid}: proposal ${h.seq} rejected: ${r.reason}`))
        await saveRow(g, handle, h.seq)
        return true
      }
      // The DS accepted a commit that this client rejects: stop (fail closed), raise the fork
      // alert and resync the own leaf by external commit (§12.7.9).
      stuck.set(g.gid, r.reason)
      const why = invite?.why == null ? '' : ` (invite_auth: ${invite.why})`
      report(new CryptoError('InvalidChain', `group ${g.gid}: commit ${h.seq} rejected: ${r.reason}${why}`))
      forkAlert(g, 'commit_rejected')
      scheduleRecovery(g.gid)
      return false
    }
    if (r.result === 'proposal_stored') {
      await saveRow(g, r.handle, h.seq)
      return true
    }
    // A commit by another device for this epoch: an own pending commit lost.
    const pending = await store.get('pendingCommits', g.gid)
    if (pending !== undefined && pending.epoch <= h.epoch) await store.delete('pendingCommits', g.gid)
    if (r.selfRemoved) {
      await saveRow(g, null, h.seq)
      await recordMembership(g.gid, handle.epoch + 1, [], r.removed)
      const actor = r.committerLeaf === null ? null : (mls.roster(handle).find((x) => x.leafIndex === r.committerLeaf)?.userId ?? null)
      await appendTimeline(g.gid, [{ groupId: g.gid, channelId: g.row.channelId, epoch: handle.epoch + 1, actorUserId: actor, kind: 'removed', subjects: r.removed.map((x) => ({ userId: x.userId, deviceId: x.deviceId })) }])
      return false
    }
    if (!forkCheck(r.handle, h.next)) {
      forkAlert(g, 'group_info_mismatch')
      spawnResync(g.gid, 'fork')
      return false
    }
    const external = h.kind === 'external_commit'
    const committer = r.committerLeaf === null ? null : external ? mls.roster(r.handle).find((x) => x.leafIndex === r.committerLeaf) : mls.roster(handle).find((x) => x.leafIndex === r.committerLeaf)
    let kind: MembershipEvent['kind'] = 'added'
    if (external) kind = r.removed.length > 0 || r.added.length === 0 ? 'resynced' : 'joined_external'
    await enterEpoch(g, r.handle, h.seq, { kind, actor: external ? null : (committer?.userId ?? null), added: r.added, removed: r.removed })
    emitUsersAdded(g, mls.roster(handle), r.added, false)
    return true
  }

  /**
   * §12.11.4 "Join authorization": the InviteAuth of an external commit into a 'channel' group, as
   * the InviteService checks it. `key` is the new leaf key when it authorizes the join. Null when
   * the commit carries no `authenticated_data`. A failed fetch (keys, members, admin chain) or a
   * store error is not a verdict: it rejects, and the handshake runs again on the next catch-up, as
   * when buildPolicy fails.
   */
  async function inviteJoinKey(groupId: Uint8Array, d: GroupDescriptor, message: Uint8Array): Promise<{ key: Uint8Array | null; why: string | null } | null> {
    const auth = externalCommitAuth(message)
    if (auth === null) return null
    if (inviteJoins === null) return { key: null, why: 'no invite service' }
    try {
      const why = await inviteJoins.checkJoin({ groupId, descriptor: d, ...auth })
      return { key: why === null ? auth.leafSignatureKey : null, why }
    } catch (e) {
      if (isTransient(e) || !(e instanceof CryptoError)) throw e
      return { key: null, why: e.message }
    }
  }

  function diff(before: LeafEntry[], after: LeafEntry[]): { added: LeafEntry[]; removed: LeafEntry[] } {
    const key = (e: LeafEntry) => `${e.leafIndex}:${e.userId}:${e.deviceId}:${toB64url(e.signatureKey)}`
    const a = new Set(before.map(key))
    const b = new Set(after.map(key))
    return { added: after.filter((e) => !a.has(key(e))), removed: before.filter((e) => !b.has(key(e))) }
  }

  /** Fetches and applies every handshake after lastSeq. 410 HandshakesExpired gives a resync (§12.7.9). */
  async function catchUp(g: Ctx): Promise<void> {
    if (g.handle === null) return
    const why = stuck.get(g.gid)
    if (why !== undefined) throw new CryptoError('InvalidChain', `group ${g.gid} is stopped: ${why}`)
    for (;;) {
      let page
      try {
        page = await transport.fetchHandshakes(g.gid, g.row.lastSeq, HANDSHAKE_PAGE)
      } catch (e) {
        if (dsCode(e) === 'HandshakesExpired') {
          const before = g.handle.epoch
          await resyncLocked(g, 'state_lost')
          // The epochs in between: ask the own devices for their keys (§12.7.9).
          const now = g.handle as MlsGroupHandle | null
          if (now !== null && now.epoch - before > 1) spawn(requestHistoryKeys(now.groupId, before + 1, now.epoch - 1))
          return
        }
        throw e
      }
      for (const h of page.handshakes) {
        const ok = await applyHandshake(g, { ...h, message: fromB64url(h.message) })
        if (!ok) {
          const reason = stuck.get(g.gid)
          if (reason !== undefined) throw new CryptoError('InvalidChain', `group ${g.gid} is stopped: ${reason}`)
          return
        }
      }
      if (page.handshakes.length < HANDSHAKE_PAGE || g.row.lastSeq >= page.latestSeq) break
    }
    await drainBuffered(g)
  }

  // MARK: - own commits

  /** Writes pendingCommits before the POST (§12.7.9). 'conflict' on 409 EpochConflict. */
  async function postOwnCommit(g: Ctx, pc: PendingCommit, batch: { batchId: string | null; rejected: BatchRejection[] }, kind: MembershipEvent['kind']): Promise<'ok' | 'conflict'> {
    await store.put('pendingCommits', g.gid, { epoch: pc.epoch, state: pc.next.state, createdAtMs: ctx.now() })
    const res = await transport.postCommit(g.gid, { ...pc.request, batchId: batch.batchId, rejected: batch.rejected })
    if (!res.ok) {
      await store.delete('pendingCommits', g.gid)
      return 'conflict'
    }
    await enterEpoch(g, pc.next, Math.max(g.row.lastSeq, res.seq), { kind, actor: identity.self().userId, added: pc.added, removed: pc.removed })
    await store.delete('pendingCommits', g.gid)
    notify(ownCommitListeners, pc.next)
    return 'ok'
  }

  async function sendBundle(g: Ctx, h: MlsGroupHandle): Promise<void> {
    const self = identity.self()
    const entries = (await store.list('epochSecrets', `${g.gid}:`)).map((x) => x.value).filter((v) => v.epoch < h.epoch)
    if (entries.length === 0) return
    const blob = await mls.sealHistoryBundle(h, self.mlsSignatureKey.privateKey, self.deviceId, entries.map(({ groupId, epoch, secret }) => ({ groupId, epoch, secret })))
    await transport.postHistoryBundle(g.gid, { epoch: h.epoch, blob: toB64url(blob) })
  }

  /** §12.11.2: a commit that added a device of a new user in a 'shared' group sends a bundle. */
  async function maybeSendBundle(g: Ctx, before: LeafEntry[], added: LeafEntry[]): Promise<void> {
    if (g.handle === null || descriptorOf(g).historyVisibility !== 'shared') return
    if (newUserIds(before, added).length === 0) return
    try {
      await sendBundle(g, g.handle)
    } catch (e) {
      report(e)
    }
  }

  /**
   * §12.20 "Access by new members": after a commit (in the new epoch) that added a leaf of a new
   * user to a text group. The callers are the commits of others, the own batch commits and the
   * crash adoption, never an own join, Welcome or create (`added` is the whole roster there).
   */
  function emitUsersAdded(g: Ctx, before: LeafEntry[], added: LeafEntry[], byMe: boolean): void {
    const kind = g.row.kind
    const d = g.handle === null ? null : contextOf(g.handle).descriptor
    if (g.handle === null || d === null || (kind !== 'public_set' && kind !== 'channel')) return
    const userIds = newUserIds(before, added)
    if (userIds.length === 0) return
    ctx.emit('usersAdded', { groupId: g.gid, kind, guildId: d.guildId, channelId: d.channelId, epoch: g.handle.epoch, userIds, byMe })
  }

  /** The leaves of revoked devices other than the own leaf, and their users (§12.4 rule 7). */
  async function revokedLeaves(h: MlsGroupHandle): Promise<{ leaves: number[]; users: UserId[] }> {
    const roster = mls.roster(h)
    const users = [...new Set(roster.map((e) => e.userId))]
    const revokedOf = new Map(await Promise.all(users.map(async (u) => [u, (await identity.chainContextFor(u, false)).revokedDeviceIds] as const)))
    const hit = roster.filter((e) => e.leafIndex !== h.ownLeaf && revokedOf.get(e.userId)?.has(e.deviceId) === true)
    return { leaves: hit.map((e) => e.leafIndex), users: [...new Set(hit.map((e) => e.userId))] }
  }

  // MARK: - joins and resyncs

  function spawnResync(gid: string, reason: 'dsk_rotated' | 'fork' | 'state_lost'): void {
    // Runs after the current lock holder: the lock is taken again inside.
    spawn(Promise.resolve().then(() => withGroup(gid, async (g) => (g === null ? undefined : resyncLocked(g, reason)))))
  }

  /**
   * External commit with a fresh key package: a resync when the tree has the own key, else a join.
   * `inviteAuth`: an InviteAuth for a join into a 'channel' group (§12.11.4). It signs the group and
   * the own MLS key, so every attempt can use it. A resync does not carry it.
   */
  async function externalCommit(gid: string, g: Ctx | null, inviteAuth: Uint8Array | null = null): Promise<void> {
    const self = identity.self()
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      const group = await transport.getGroup(gid)
      if (group.status !== 'active') throw new CryptoError('GroupPending', `group ${gid} is ${group.status}`)
      const st = await transport.getGroupState(gid)
      const tree = fromB64url(st.ratchetTree)
      const resync = treeHasSignatureKey(tree, self.mlsSignatureKey.publicKey)
      const kp = await freshKeyPackage(group.cipherSuite, false)
      const policy = await buildPolicy(descriptorOfWire(group), treeUserIds(tree))
      const authenticatedData = resync || inviteAuth === null ? new Uint8Array(0) : inviteAuth
      const pc = await mls.joinExternal({ groupInfo: fromB64url(st.groupInfo), ratchetTree: tree, keyPackage: kp, resync, policy, authenticatedData })
      const desc = contextOf(pc.next).descriptor
      const row: GroupRow = g?.row ?? { groupId: fromB64url(gid), state: new Uint8Array(0), channelId: desc?.channelId ?? null, kind: group.kind, lastSeq: 0, status: group.status }
      const target: Ctx = g ?? { gid, row, handle: null }
      target.row = { ...row, channelId: desc?.channelId ?? null, kind: group.kind, status: group.status }
      await store.put('pendingCommits', gid, { epoch: pc.epoch, state: pc.next.state, createdAtMs: ctx.now() })
      let res
      try {
        res = await transport.postCommit(gid, { ...pc.request, batchId: null, rejected: [] })
      } catch (e) {
        // A §12.7.3 refusal: the DS did not store the commit, so no adoption waits for the row. A
        // network error or a 5xx can hide an accepted commit: the row stays (§12.7.9).
        if (COMMIT_REFUSALS.has(dsCode(e) ?? '')) await store.delete('pendingCommits', gid)
        throw e
      }
      if (!res.ok) {
        await store.delete('pendingCommits', gid)
        continue
      }
      stuck.delete(gid)
      const roster = mls.roster(pc.next)
      // A resync keeps the own leaf; a join adds it. The timeline shows the leaves this device now sees.
      const added = resync ? pc.added : roster
      await enterEpoch(target, pc.next, res.seq, { kind: resync ? 'resynced' : 'joined_external', actor: null, added, removed: resync ? pc.removed : [] })
      await store.delete('pendingCommits', gid)
      notify(ownCommitListeners, pc.next)
      if (!resync) {
        notify(joinListeners, pc.next)
        await joinerCheck(target, roster)
      }
      return
    }
    throw new CryptoError('EpochConflict', `external commit to ${gid} lost ${COMMIT_ATTEMPTS} times`)
  }

  /** The reason is for the caller's log only: every resync is the same external commit. */
  async function resyncLocked(g: Ctx, reason: 'dsk_rotated' | 'fork' | 'state_lost'): Promise<void> {
    void reason
    await externalCommit(g.gid, g)
  }

  /** Decision 4: a joiner compares the tree with its own channelReaders and shows each extra user. */
  async function joinerCheck(g: Ctx, roster: LeafEntry[]): Promise<void> {
    const readers = await readersOf(descriptorOf(g))
    if (readers === null || g.handle === null) return
    const extra = new Map<UserId, { userId: UserId; deviceId: DeviceId }[]>()
    for (const e of roster) {
      if (readers.has(e.userId)) continue
      const list = extra.get(e.userId) ?? []
      list.push({ userId: e.userId, deviceId: e.deviceId })
      extra.set(e.userId, list)
    }
    await appendTimeline(
      g.gid,
      [...extra.values()].map((subjects) => ({ groupId: g.gid, channelId: g.row.channelId, epoch: g.handle!.epoch, actorUserId: null, kind: 'added' as const, subjects })),
    )
  }

  /**
   * The DS lists this device as a member, but it holds no state: the Welcome of the Add can still
   * be in the device inbox. Drain it first, so an Add does not turn into a resync external commit.
   * The drain runs outside the group lock (handleWelcome takes it).
   */
  async function joinAsMember(gid: string): Promise<void> {
    try {
      await drainInbox()
    } catch (e) {
      report(e)
    }
    await withGroup(gid, async (g) => {
      if (g?.handle != null) return
      await externalCommit(gid, g)
    })
  }

  async function requestJoin(group: WireMlsGroup): Promise<void> {
    if (joinRequested.has(group.groupId)) return
    joinRequested.add(group.groupId)
    try {
      const kp = await freshKeyPackage(group.cipherSuite, true)
      const req = await transport.postJoinRequest(group.groupId, { keyPackage: toB64url(kp.publicPackage) })
      if (req.status === 'external_commit') await withGroup(group.groupId, (g) => externalCommit(group.groupId, g))
    } catch (e) {
      joinRequested.delete(group.groupId)
      throw e
    }
  }

  /**
   * A group that the DS does not list this device in, without state: a 'channel' group of the scope
   * of a redeemed invite joins at once by external commit with an InviteAuth (§12.11.4). A DS that
   * refuses it gives a join request, as any other group. After a refusal (403 IllegalAdd: for
   * example a revoke that this device missed, or a guild join with another invite), the device does
   * not try the InviteAuth for that group again in this session.
   */
  async function joinOrRequest(group: WireMlsGroup): Promise<void> {
    if (group.kind === 'channel' && group.guildId !== null && group.channelId !== null && inviteJoins !== null && !inviteJoinRefused.has(group.groupId)) {
      try {
        const auth = await inviteJoins.authFor({ groupId: fromB64url(group.groupId), guildId: group.guildId, channelId: group.channelId })
        if (auth !== null) {
          await withGroup(group.groupId, async (g) => (g?.handle != null ? undefined : externalCommit(group.groupId, g, auth)))
          return
        }
      } catch (e) {
        if (dsCode(e) === 'IllegalAdd') inviteJoinRefused.add(group.groupId)
        report(e)
      }
    }
    await requestJoin(group)
  }

  /** The first handshake seq to fetch for a state at `epoch`: after the last handshake of an older epoch. */
  async function startSeq(gid: string, epoch: number, latestSeq: number): Promise<number> {
    let lo = 0
    let hi = latestSeq
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      let first: WireHandshake | undefined
      try {
        first = (await transport.fetchHandshakes(gid, mid, 1)).handshakes[0]
      } catch (e) {
        if (dsCode(e) !== 'HandshakesExpired') throw e
        lo = mid + 1
        continue
      }
      if (first === undefined || first.epoch >= epoch) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  async function handleWelcome(item: WireInboxItem): Promise<void> {
    const w = decodeWelcomeItem(fromB64url(item.body))
    const gid = toB64url(w.groupId)
    await withGroup(gid, async (existing) => {
      if (existing?.handle && existing.handle.epoch >= w.epoch) return
      const group = await transport.getGroup(gid)
      const st = await transport.getGroupState(gid, w.epoch)
      let kp: StoreSchema['keyPackages'] | undefined
      let kpKey = ''
      for (const ref of welcomeKeyPackageRefs(w.welcome)) {
        kpKey = toB64url(ref)
        kp = await store.get('keyPackages', kpKey)
        if (kp !== undefined) break
      }
      if (kp === undefined) throw new CryptoError('Malformed', 'the Welcome is for no key package of this device')
      const tree = fromB64url(st.ratchetTree)
      const policy = await buildPolicy(descriptorOfWire(group), treeUserIds(tree))
      const handle = await mls.joinFromWelcome({ welcome: w.welcome, ratchetTree: tree, keyPackage: kp, policy })
      if (handle.epoch !== w.epoch) throw new CryptoError('Malformed', 'the Welcome epoch differs from the item')
      const desc = contextOf(handle).descriptor!
      if (desc.kind !== group.kind || desc.channelId !== group.channelId || desc.guildId !== group.guildId) throw new CryptoError('Malformed', 'the group descriptor differs from the DS group')
      if (!kp.lastResort) await store.delete('keyPackages', kpKey)
      const lastSeq = await startSeq(gid, w.epoch, group.latestSeq)
      const g: Ctx = existing ?? { gid, row: { groupId: w.groupId, state: new Uint8Array(0), channelId: desc.channelId, kind: desc.kind, lastSeq, status: group.status }, handle: null }
      g.row = { ...g.row, channelId: desc.channelId, kind: desc.kind, status: group.status }
      stuck.delete(gid)
      joinRequested.delete(gid)
      const roster = mls.roster(handle)
      await enterEpoch(g, handle, lastSeq, { kind: 'added', actor: null, added: roster, removed: [] })
      notify(joinListeners, handle)
      await joinerCheck(g, roster)
      if (desc.historyVisibility === 'shared') await fetchBundles(g, handle)
      await catchUp(g)
    })
  }

  async function fetchBundles(g: Ctx, h: MlsGroupHandle): Promise<void> {
    let bundles
    try {
      bundles = await transport.getHistoryBundles(g.gid, h.epoch)
    } catch (e) {
      report(e)
      return
    }
    for (const b of bundles) {
      try {
        const blob = fromB64url(b.blob)
        const sender = mls.roster(h).find((x) => x.leafIndex === decodeBundleHeader(blob).header.senderLeaf)
        const policy = await buildPolicy(descriptorOf(g), sender === undefined ? [] : [sender.userId])
        const entries = await mls.openHistoryBundle(h, blob, policy)
        await importHistoryKeys(entries, 'bundle')
      } catch (e) {
        report(e)
      }
    }
  }

  // MARK: - batches

  async function createAssigned(d: WireBatchAssign): Promise<void> {
    const c = d.create!
    await withGroup(c.groupId, async (existing) => {
      if (existing?.handle) return
      const self = identity.self()
      const descriptor: GroupDescriptor = { kind: c.kind, guildId: c.guildId, channelId: c.channelId, historyVisibility: c.historyVisibility, createdByUserId: self.userId }
      const idRow = await store.get('identity', 'self')
      const dsSender = idRow?.dsExternalSender ?? fromB64url((await transport.getDsInfo()).externalSender)
      const kp = await freshKeyPackage(c.cipherSuite, false)
      const created = await mls.createGroup({ groupId: fromB64url(c.groupId), descriptor, dsExternalSender: normalizeExternalSender(dsSender).encoded, cipherSuite: c.cipherSuite, keyPackage: kp })
      const group = await transport.createGroup({ groupId: c.groupId, kind: c.kind, guildId: c.guildId, channelId: c.channelId, cipherSuite: c.cipherSuite, groupInfo: toB64url(created.groupInfo), ratchetTree: toB64url(created.ratchetTree), assignmentId: d.batchId })
      const g: Ctx = { gid: c.groupId, row: { groupId: fromB64url(c.groupId), state: new Uint8Array(0), channelId: c.channelId, kind: c.kind, lastSeq: group.latestSeq, status: group.status }, handle: null }
      await enterEpoch(g, created.handle, group.latestSeq, { kind: 'created', actor: self.userId, added: mls.roster(created.handle), removed: [] })
    })
  }

  async function handleBatch(d: WireBatchAssign): Promise<void> {
    if (d.create !== null) {
      await createAssigned(d)
      return
    }
    const decline = async (reason: 'not_synced' | 'busy'): Promise<void> => {
      try {
        await transport.declineBatch(d.batchId, reason)
      } catch (e) {
        if (!isTransient(e)) throw e
      }
    }
    await withGroup(d.groupId, async (g) => {
      if (g?.handle == null) return decline('not_synced')
      try {
        await catchUp(g)
      } catch (e) {
        await decline('not_synced')
        throw e
      }
      const h = g.handle as MlsGroupHandle | null
      if (h?.epoch !== d.epoch) return decline('not_synced')
      const desc = descriptorOf(g)
      // Bundles for earlier epochs that the previous committer did not send (§12.11.2). Only in a
      // group whose MLS-authenticated descriptor says 'shared', now and at that epoch: the DS list
      // alone never makes a 'joined' group share its history.
      if (desc.historyVisibility === 'shared') {
        for (const e of d.historyBundleEpochs) {
          const he = recent.get(g.gid)?.get(e)
          if (he !== undefined && contextOf(he).descriptor?.historyVisibility === 'shared') await sendBundle(g, he).catch(report)
        }
      }
      // The DS proposals are in the stream already; process any that this state misses. A DS
      // proposal that this device rejects is reported by its ProposalRef, so Takusen can mark the
      // pending row rejected instead of waiting for the batch deadline.
      const rejected: BatchRejection[] = []
      const dsProposals: { ref: Uint8Array; users: UserId[] }[] = []
      let dirty = false
      for (const p of d.proposals) {
        let bytes: Uint8Array
        let ref: Uint8Array
        try {
          bytes = fromB64url(p)
          ref = await proposalRefOf(bytes, g.handle.cipherSuite)
        } catch {
          // Not a proposal: nothing to reference it by. checkCommit rejects any ref to it anyway.
          continue
        }
        const users = handshakeUserIds(g.handle, bytes)
        if (!hasStoredProposal(g.handle, ref)) {
          const r = await mls.processHandshake(g.handle, bytes, await buildPolicy(desc, users))
          if (r.result === 'rejected') {
            rejected.push({ proposalRef: toB64url(ref), reason: rejectReason(r.reason) })
            continue
          }
          if (r.result === 'proposal_stored') {
            // Stored once after the loop: one state encoding per batch, not one per proposal.
            g.handle = r.handle
            dirty = true
          }
        }
        dsProposals.push({ ref, users })
      }
      if (dirty) await saveRow(g, g.handle, g.row.lastSeq)
      const joinUsers = d.joins.flatMap((j) => {
        try {
          return [keyPackageIdentity(fromB64url(j.keyPackage)).userId]
        } catch {
          return []
        }
      })
      const policy = await buildPolicy(desc, [...joinUsers, ...dsProposals.flatMap((x) => x.users)], true)
      // A stored DS Add that no longer passes (a chain revoked or a reader gone since it was stored).
      const drop: Uint8Array[] = []
      for (const { ref } of dsProposals) {
        const why = checkStoredProposal(g.handle, ref, policy)
        if (why === null) continue
        drop.push(ref)
        rejected.push({ proposalRef: toB64url(ref), reason: rejectReason(why) })
      }
      if (drop.length > 0) await saveRow(g, dropStoredProposals(g.handle, drop), g.row.lastSeq)
      const adds: Uint8Array[] = []
      const inTree = new Set(mls.roster(g.handle).map((x) => x.deviceId))
      for (const j of d.joins) {
        const bytes = fromB64url(j.keyPackage)
        let id
        try {
          id = keyPackageIdentity(bytes)
        } catch {
          rejected.push({ pendingId: j.pendingId, reason: 'malformed' })
          continue
        }
        if (id.userId !== j.userId || id.deviceId !== j.deviceId || inTree.has(id.deviceId)) {
          rejected.push({ pendingId: j.pendingId, reason: 'malformed' })
          continue
        }
        const why = checkAdd(bytes, policy)
        if (why === null) {
          adds.push(bytes)
          inTree.add(id.deviceId)
        } else rejected.push({ pendingId: j.pendingId, reason: rejectReason(why) })
      }
      if (policy.adminChainMissing === true && rejected.length > 0) report(new CryptoError('InvalidChain', `admin_chain_missing: guild ${desc.guildId} has no verified genesis action; Adds to ${g.gid} rejected`))
      const before = mls.roster(g.handle)
      const pc = await mls.commit(g.handle, { adds, removes: [], descriptor: null, policy })
      const res = await postOwnCommit(g, pc, { batchId: d.batchId, rejected }, 'added')
      if (res === 'conflict') {
        await catchUp(g).catch(report)
        return decline('not_synced')
      }
      emitUsersAdded(g, before, pc.added, true)
      await maybeSendBundle(g, before, pc.added)
    })
  }

  // MARK: - the device inbox (§12.7.6)

  function drainInbox(): Promise<void> {
    const run = inboxLock.then(async () => {
      const cursor = (await store.get('inbox', 'self'))?.lastSeq ?? 0
      let after = cursor
      for (;;) {
        const items = await transport.fetchInbox(after, 100)
        if (items.length === 0) break
        for (const item of items) {
          if (item.seq <= after) continue
          try {
            if (item.kind === 'welcome') await handleWelcome(item)
            else if (item.kind === 'history_keys') await handleHistoryKeys(item)
            else await identity.handleInboxItem(item)
          } catch (e) {
            // A transport failure keeps the item for the next drain. Anything else is dropped.
            if (isTransient(e)) throw e
            report(e)
          }
          await transport.ackInbox(item.id)
          after = item.seq
          await store.put('inbox', 'self', { lastSeq: after })
        }
        if (items.length < 100) break
      }
    })
    inboxLock = run.catch(() => undefined)
    return run
  }

  async function handleHistoryKeys(item: WireInboxItem): Promise<void> {
    const self = identity.self()
    const opened = await openDeviceMessage({
      recipientHpkePrivateKey: self.hpkeKey.privateKey,
      recipientDeviceId: self.deviceId,
      sealed: fromB64url(item.body),
      senderSignatureKey: async (sender, kind) => {
        if (kind !== 'history_keys' || sender === self.deviceId || (item.senderDevice !== null && item.senderDevice !== sender)) return null
        return (await ownDeviceCertificate(sender))?.mlsSignatureKey ?? null
      },
    })
    const p = decodeHistoryKeysPayload(opened.payload)
    if (p.type === 'response') {
      await importHistoryKeys(
        p.keys.filter((k) => k.epoch >= p.epochFrom && k.epoch <= p.epochTo).map((k) => ({ groupId: p.groupId, epoch: k.epoch, secret: k.secret })),
        'own_device',
      )
      return
    }
    const gid = toB64url(p.groupId)
    const keys = (await store.list('epochSecrets', `${gid}:`))
      .map((x) => x.value)
      .filter((v) => v.epoch >= p.epochFrom && v.epoch <= p.epochTo)
      .sort((a, b) => a.epoch - b.epoch)
      .slice(-HISTORY_BUNDLE_MAX_EPOCHS)
    if (keys.length === 0) return
    await sendHistoryKeys(opened.senderDeviceId, { type: 'response', groupId: p.groupId, epochFrom: p.epochFrom, epochTo: p.epochTo, keys: keys.map((k) => ({ epoch: k.epoch, secret: k.secret })) })
  }

  /** The certificate of another own device that is not revoked, or null. */
  async function ownDeviceCertificate(deviceId: DeviceId): Promise<DeviceCertificateT | null> {
    const self = identity.self()
    if (deviceId === self.deviceId) return null
    const ctxSelf = await identity.chainContextFor(self.userId, false)
    if (ctxSelf.revokedDeviceIds.has(deviceId)) return null
    const cert = await identity.deviceCertificate(self.userId, deviceId)
    return cert?.userId === self.userId ? cert : null
  }

  async function sendHistoryKeys(deviceId: DeviceId, payload: HistoryKeysPayload): Promise<void> {
    const cert = await ownDeviceCertificate(deviceId)
    if (cert === null) return
    const self = identity.self()
    const sealed = await sealHistoryKeys({ deviceId: self.deviceId, signatureKey: self.mlsSignatureKey.privateKey }, { deviceId, hpkeKey: cert.hpkeKey }, payload)
    await transport.postInbox(deviceId, { kind: 'history_keys', body: toB64url(sealed) })
  }

  /** Asks every other active own device for the keys of epochs this device missed (§12.7.9). */
  async function requestHistoryKeys(groupId: Uint8Array, epochFrom: number, epochTo: number): Promise<void> {
    for (const d of await identity.listDevices()) {
      if (d.current || d.status !== 'active') continue
      try {
        await sendHistoryKeys(d.id, { type: 'request', groupId, epochFrom, epochTo, keys: [] })
      } catch (e) {
        report(e)
      }
    }
  }

  // MARK: - the public surface

  /** Never replaces a stored secret. One transaction, so storeEpochSecret cannot run between the read and the write. */
  async function importHistoryKeys(entries: HistoryKeyEntry[], source: 'own_device' | 'backup' | 'bundle'): Promise<void> {
    if (entries.length === 0) return
    const byGroup = new Map<string, number[]>()
    await store.transaction(['epochSecrets'], async (tx) => {
      for (const e of entries) {
        const gid = toB64url(e.groupId)
        const key = `${gid}:${e.epoch}`
        if ((await tx.get('epochSecrets', key)) !== undefined) continue
        await tx.put('epochSecrets', key, { groupId: e.groupId, epoch: e.epoch, secret: e.secret, backedUp: source === 'backup' })
        const list = byGroup.get(gid) ?? []
        list.push(e.epoch)
        byGroup.set(gid, list)
      }
    })
    for (const [groupId, epochs] of byGroup) ctx.emit('epochKeysAvailable', { groupId, epochs: epochs.sort((a, b) => a - b) })
  }

  async function resyncAll(reason: 'dsk_rotated' | 'fork' | 'state_lost'): Promise<void> {
    for (const { key } of await store.list('groups')) {
      try {
        await withGroup(key, async (g) => {
          if (g?.handle == null || g.row.status === 'retired') return
          if (reason === 'dsk_rotated') {
            // Only leaves whose chain is older than the own current chain.
            const own = ownLeafEntry(g.handle)
            if (own?.chain && own.chain.dsk.generation >= identity.self().chain.dsk.generation) return
          }
          await resyncLocked(g, reason)
        })
      } catch (e) {
        report(e)
      }
    }
  }

  async function groupForChannel(channelId: string): Promise<WireMlsGroup> {
    const group = await transport.getGroupForChannel(channelId)
    if (group === null) throw new CryptoError('UnknownGroup', `channel ${channelId} has no group`)
    if (group.status === 'pending') throw new CryptoError('GroupPending', `the group of channel ${channelId} is pending`)
    return group
  }

  const service: GroupServiceExt = {
    async sync() {
      try {
        await drainInbox()
      } catch (e) {
        report(e)
      }
      // READY and RESUMED: a failed replenish elsewhere must not leave the device without key
      // packages (KEY_PACKAGES_LOW comes only after a claim).
      try {
        await identity.replenishKeyPackages()
      } catch (e) {
        report(e)
      }
      const self = identity.self()
      for (const group of await transport.listGroups()) {
        try {
          const local = await store.get('groups', group.groupId)
          const hasState = local !== undefined && local.state.length > 0
          if (local !== undefined && local.status !== group.status) await store.put('groups', group.groupId, { ...local, status: group.status })
          if (group.status !== 'active') continue
          if (!hasState) {
            if (group.member) await joinAsMember(group.groupId)
            else if (group.kind !== 'public_set') await joinOrRequest(group)
            continue
          }
          await withGroup(group.groupId, async (g) => {
            if (g === null) return
            if (stuck.has(g.gid)) {
              scheduleRecovery(g.gid)
              return
            }
            await catchUp(g)
            // A leaf with an older chain than the own one: resync within DSK_ROTATION_GRACE_MS (§12.4).
            const own = g.handle === null ? null : ownLeafEntry(g.handle)
            if (own?.chain && own.chain.dsk.generation < self.chain.dsk.generation && ctx.now() - self.chain.dsk.issuedAtMs < DSK_ROTATION_GRACE_MS) await resyncLocked(g, 'dsk_rotated')
          })
        } catch (e) {
          report(e)
        }
      }
    },

    async onGatewayEvent(event: CryptoGatewayEvent) {
      try {
        switch (event.t) {
          case 'MLS_HANDSHAKE': {
            const d = event.d
            await withGroup(d.groupId, async (g) => {
              if (g?.handle == null) return
              if (d.seq <= g.row.lastSeq) return
              if (d.seq === g.row.lastSeq + 1 && d.message !== null && !stuck.has(g.gid)) {
                const ok = await applyHandshake(g, { seq: d.seq, epoch: d.epoch, kind: d.kind, senderDevice: d.senderDevice, message: fromB64url(d.message), next: d.next })
                if (ok) await drainBuffered(g)
                return
              }
              await catchUp(g)
            })
            return
          }
          case 'MLS_BATCH_ASSIGN':
            await handleBatch(event.d)
            return
          case 'MLS_JOIN_UPDATE': {
            const d = event.d
            if (d.status === 'external_commit') await withGroup(d.groupId, (g) => externalCommit(d.groupId, g))
            else if (d.status === 'rejected') {
              joinRequested.delete(d.groupId)
              ctx.emit('error', { code: 'NotMember', message: `join request for ${d.groupId} rejected: ${d.reason ?? 'no reason'}` })
            }
            return
          }
          case 'MLS_GROUP_UPDATE': {
            const d = event.d
            await withGroup(d.groupId, async (g) => {
              if (g !== null && g.row.status !== d.status) await store.put('groups', g.gid, { ...g.row, status: d.status })
            })
            return
          }
          case 'DEVICE_INBOX':
            await drainInbox()
            return
          default:
            return
        }
      } catch (e) {
        report(e)
      }
    },

    async ensureChannelGroup(channelId) {
      const group = await groupForChannel(channelId)
      const local = await store.get('groups', group.groupId)
      if (local !== undefined && local.state.length > 0) {
        await withGroup(group.groupId, async (g) => {
          if (g !== null) await catchUp(g)
        })
        return group
      }
      if (group.status !== 'active') return group
      if (group.member) await joinAsMember(group.groupId)
      else await joinOrRequest(group)
      return group
    },

    async membershipTimeline(channelId, limit) {
      const events: MembershipEvent[] = []
      const gids = new Set<string>()
      for (const { key, value } of await store.list('groups')) if (value.channelId === channelId) gids.add(key)
      try {
        const g = await transport.getGroupForChannel(channelId)
        if (g !== null) gids.add(g.groupId)
      } catch {
        // Offline: the local groups only.
      }
      for (const gid of gids) {
        for (const e of (await store.get('timeline', gid))?.events ?? []) if (e.channelId === channelId || e.channelId === null) events.push({ ...e, channelId })
      }
      return events.slice(-Math.max(0, limit))
    },

    async getEpochCode(groupId) {
      const g = await load(groupId)
      if (g?.handle == null) throw new CryptoError('NotMember', 'not a member of this group')
      return identityModule.epochCode(mls.epochAuthenticator(g.handle))
    },

    resyncAll,

    async sendState(channelId) {
      const group = await groupForChannel(channelId)
      if (group.status === 'retired') throw new CryptoError('GroupPending', `the group of channel ${channelId} is retired`)
      return withGroup(group.groupId, async (g) => {
        if (g?.handle == null) throw new CryptoError('NotMember', `this device has no leaf in the group of ${channelId}`)
        for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
          await catchUp(g)
          const h = g.handle as MlsGroupHandle | null
          if (h === null) throw new CryptoError('NotMember', 'removed from the group')
          const revoked = await revokedLeaves(h)
          if (!mls.hasPendingRemoves(h) && revoked.leaves.length === 0) {
            // From the MLS state, never from a stored row: an imported secret cannot steer a send.
            return { groupId: h.groupId, epoch: h.epoch, ownLeaf: h.ownLeaf, epochSecret: await messageSecret(h) }
          }
          // §12.7.4: commit the pending Removes before the device encrypts. A revoked leaf goes by
          // value too (§12.4 rule 7): a DS that withholds its Remove does not keep it in the tree.
          const policy = await buildPolicy(descriptorOf(g), revoked.users)
          const pc = await mls.commit(h, { adds: [], removes: revoked.leaves, descriptor: null, policy })
          await postOwnCommit(g, pc, { batchId: null, rejected: [] }, 'removed')
        }
        throw new CryptoError('PendingRemoves', 'pending Removes are not committed yet')
      })
    },

    async epochSecret(groupId, epoch) {
      const gid = toB64url(groupId)
      const row = await store.get('epochSecrets', `${gid}:${epoch}`)
      if (row !== undefined) return row.secret
      const h = handles.get(gid) ?? recent.get(gid)?.get(epoch) ?? null
      if (h !== null && h.epoch === epoch) {
        await storeEpochSecret(gid, h)
        return messageSecret(h)
      }
      return null
    },

    async leafAt(groupId, deviceId, epoch) {
      const row = await store.get('membership', `${toB64url(groupId)}:${deviceId}`)
      const i = row?.intervals.find((x) => x.fromEpoch <= epoch && (x.toEpoch === null || epoch <= x.toEpoch))
      return i?.leafIndex ?? null
    },

    async removedAt(groupId, deviceId) {
      return (await store.get('membership', `${toB64url(groupId)}:${deviceId}`))?.removedAtEpoch ?? null
    },

    /**
     * §12.8.7. The header (and thus `senderDevice`) is not authenticated before decryption, so a
     * server can insert rows that fail. The trigger is therefore a count over time only, and the
     * automatic resync is rate-limited per group with exponential backoff. A failure while the
     * resync waits for its backoff raises no alert.
     */
    async reportAeadFailure(groupId, _epoch, senderDevice) {
      const gid = toB64url(groupId)
      const now = ctx.now()
      const fire = await store.transaction(['aeadFailures'], async (tx) => {
        const row = await tx.get('aeadFailures', gid)
        const list = (row?.failures ?? []).filter((f) => now - f.atMs < FORK_ALERT_WINDOW_MS)
        list.push({ atMs: now, senderDevice })
        const last = row?.lastResyncMs
        const streak = last === undefined || now - last >= FORK_RESYNC_MAX_INTERVAL_MS ? 0 : (row?.resyncStreak ?? 0)
        const wait = Math.min(FORK_RESYNC_MIN_INTERVAL_MS * 2 ** Math.max(0, streak - 1), FORK_RESYNC_MAX_INTERVAL_MS)
        const allowed = streak === 0 || now - last! >= wait
        if (list.length >= FORK_ALERT_FAILURES && allowed) {
          await tx.put('aeadFailures', gid, { failures: [], lastResyncMs: now, resyncStreak: streak + 1 })
          return true
        }
        await tx.put('aeadFailures', gid, { ...row, failures: list })
        return false
      })
      if (fire) {
        const g = await load(gid)
        ctx.emit('forkAlert', { groupId: gid, channelId: g?.row.channelId ?? null, epoch: g?.handle?.epoch ?? null, reason: 'aead_failures' })
        spawnResync(gid, 'fork')
      }
    },

    async currentEpoch(groupId) {
      const g = await load(toB64url(groupId))
      return g?.handle?.epoch ?? null
    },

    async exportHistoryKeys(groupIds, maxEpochsPerGroup) {
      const wanted = groupIds === 'all' ? null : new Set(groupIds.map(toB64url))
      const byGroup = new Map<string, HistoryKeyEntry[]>()
      for (const { value } of await store.list('epochSecrets')) {
        const gid = toB64url(value.groupId)
        if (wanted !== null && !wanted.has(gid)) continue
        const list = byGroup.get(gid) ?? []
        list.push({ groupId: value.groupId, epoch: value.epoch, secret: value.secret })
        byGroup.set(gid, list)
      }
      return [...byGroup.values()].flatMap((list) => list.sort((a, b) => a.epoch - b.epoch).slice(-Math.max(0, maxEpochsPerGroup)))
    },

    importHistoryKeys,

    async descriptor(groupId) {
      const g = await load(toB64url(groupId))
      return g?.handle == null ? null : contextOf(g.handle).descriptor
    },

    onOwnCommit(cb) {
      ownCommitListeners.add(cb)
      return () => {
        ownCommitListeners.delete(cb)
      }
    },

    onJoin(cb) {
      joinListeners.add(cb)
      return () => {
        joinListeners.delete(cb)
      }
    },

    appendTimeline(groupId, events) {
      return withLock(`g:${groupId}`, () => appendTimeline(groupId, events))
    },

    setInviteJoins(joins) {
      inviteJoins = joins
    },

    async idle() {
      while (background.size > 0) await Promise.allSettled([...background])
    },
  }
  return service
}) satisfies CreateGroupService

