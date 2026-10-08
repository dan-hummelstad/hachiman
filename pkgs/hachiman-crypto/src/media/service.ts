/**
 * VoiceService (docs/gateway-protocol.md §8, §12.10.1): the client side of a voice room group.
 *
 * Member-commit model: the media node orders commits and signs nothing. The committer (named in
 * e2ee_roster) creates the group, adds pending joiners and removes departed leaves. Every member
 * checks every commit (chains, the roster policy) before it sends e2ee_ready. A prepared epoch
 * becomes the send epoch only on e2ee_execute_transition. A roster with a lower room epoch
 * reverts a prepared transition (the media node evicted its committer).
 */
import {
  CryptoError,
  type ChainContext,
  type ChannelId,
  type CreateVoiceService,
  type DeviceId,
  type EngineContext,
  type FrameKeyMessage,
  type GuildId,
  type IdentityService,
  type MlsGroupHandle,
  type PendingCommit,
  type ProposalPolicy,
  type UserId,
  type VoiceE2eeClientOp,
  type VoiceE2eeServerOp,
  type VoiceRosterEntry,
  type VoiceService,
} from '../api'
import { Reader, fromB64url, toB64url } from '../codec'
import { DEFAULT_CIPHER_SUITE, EXPORTER_LENGTH, ExporterLabel } from '../constants'
import { equalBytes } from '../identity/bytes'
import { identity as identityModule } from '../identity/index'
import { checkAdd, contextOf, handshakeUserIds, keyPackageIdentity, mls, treeUserIds } from '../mls/index'

type RosterData = Extract<VoiceE2eeServerOp, { op: 'e2ee_roster' }>['d']

/** Consecutive rejected commits after which the committer waits for new work. */
const MAX_COMMIT_RETRIES = 3

interface Transition {
  id: number
  epoch: number
  /** The state before the commit. Null for a Welcome join. */
  prev: MlsGroupHandle | null
  next: MlsGroupHandle
}

interface OwnCommit {
  epoch: number
  commit: string
  pc: PendingCommit
}

interface Call {
  channelId: ChannelId
  guildId: GuildId | null
  keyPackage: { publicPackage: Uint8Array; privatePackage: Uint8Array }
  /** True once a Welcome join used keyPackage. RFC 9420 §16.8: one KeyPackage, one use. */
  keyPackageUsed: boolean
  groupId: Uint8Array | null
  /** The newest local state: the prepared one while a transition waits for execute. */
  group: MlsGroupHandle | null
  /** The state whose epoch the senders use (the last executed one). */
  active: MlsGroupHandle | null
  transition: Transition | null
  welcome: { transitionId: number; epoch: number; welcome: Uint8Array } | null
  roster: RosterData | null
  prevRoster: RosterData | null
  ownSessionId: string | null
  keyPackages: Map<string, { userId: UserId; deviceId: DeviceId; keyPackage: Uint8Array }>
  ownCommit: OwnCommit | null
  rejections: number
  /** Port id → port. The id goes back to the caller of voiceAttachTransform. */
  ports: Map<string, MessagePort>
  /** Epochs whose keys the transform Workers hold. */
  installed: Set<number>
  lock: Promise<unknown>
}


function failingContext(nowMs: number): ChainContext {
  return { pinnedMaster: null, currentDsk: null, highestSeenDskGeneration: null, revokedDeviceIds: new Set(), leaf: null, entering: false, nowMs }
}

/** The media commit parse of §12.10.1: the sender leaf of a PublicMessage commit, or null. */
export function commitSenderLeaf(commit: Uint8Array): number | null {
  try {
    const r = new Reader(commit)
    if (r.u16() !== 1 || r.u16() !== 1) return null
    r.opaque()
    r.u64()
    if (r.u8() !== 1) return null
    return r.u32()
  } catch {
    return null
  }
}

function invalid(transitionId: number | null, reason: string, committerLeaf: number | null): VoiceE2eeClientOp {
  return { op: 'e2ee_invalid', d: { transitionId, reason, committerLeaf } }
}

function reasonOf(e: unknown): string {
  if (e instanceof CryptoError) return `${e.code}: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

export const createVoiceService = ((ctx: EngineContext, identity: IdentityService): VoiceService => {
  const calls = new Map<string, Call>()

  function callOf(handle: string): Call {
    const c = calls.get(handle)
    if (c === undefined) throw new CryptoError('Malformed', 'unknown voice handle')
    return c
  }

  /** One op at a time per call. */
  function serial<R>(c: Call, fn: () => Promise<R>): Promise<R> {
    const run = c.lock.then(fn, fn)
    c.lock = run.catch(() => undefined)
    return run
  }

  async function policyFor(users: Iterable<UserId>, pending: ReadonlySet<string>, departed: ReadonlySet<DeviceId>): Promise<ProposalPolicy> {
    const contexts = new Map<UserId, ChainContext>()
    const all = new Set(users)
    all.add(identity.self().userId)
    for (const u of all) contexts.set(u, await identity.chainContextFor(u, false))
    const nowMs = ctx.now()
    return {
      kind: 'voice',
      dsExternalSenderKey: null,
      readers: null,
      adminReaders: null,
      chainContextFor: (u) => contexts.get(u) ?? failingContext(nowMs),
      canChangeDescriptor: () => false,
      voice: { pending, departedDeviceIds: departed },
    }
  }

  /** Pending identities and departed devices of the last two rosters (a commit may race a roster). */
  function rosterSets(c: Call): { pending: Set<string>; departed: Set<DeviceId> } {
    const pending = new Set<string>()
    const departed = new Set<DeviceId>()
    for (const r of [c.roster, c.prevRoster]) {
      if (r === null || c.groupId === null || r.groupId !== toB64url(c.groupId)) continue
      for (const p of r.pending) pending.add(`${p.userId}:${p.deviceId}`)
      for (const d of r.departed) departed.add(d.deviceId)
    }
    return { pending, departed }
  }

  // MARK: - frame keys

  function post(c: Call, msg: FrameKeyMessage): void {
    for (const [id, p] of c.ports) {
      try {
        p.postMessage(msg)
      } catch {
        forgetPort(c, id)
      }
    }
  }

  /** Port id → handle of its call, for voiceDetachTransform. */
  const portCalls = new Map<string, string>()

  function forgetPort(c: Call, id: string): void {
    c.ports.delete(id)
    portCalls.delete(id)
  }

  /** sframe_epoch_secret = MLS-Exporter("SFrame 1.0 Base Key", "", 32), with the leaf → user map. */
  async function keyMessage(h: MlsGroupHandle): Promise<FrameKeyMessage> {
    const secret = await mls.exporter(h, ExporterLabel.SFRAME, new Uint8Array(0), EXPORTER_LENGTH)
    const leaves = mls.roster(h).map((e) => ({ leafIndex: e.leafIndex, userId: e.userId }))
    return { type: 'epoch', epoch: h.epoch, secret, selfLeaf: h.ownLeaf, leaves }
  }

  async function installKeys(c: Call, h: MlsGroupHandle): Promise<void> {
    const m = await keyMessage(h)
    post(c, m)
    if (m.type === 'epoch') m.secret.fill(0)
    c.installed.add(h.epoch)
  }

  function activate(c: Call, h: MlsGroupHandle, handle: string): void {
    c.active = h
    post(c, { type: 'activate', epoch: h.epoch })
    ctx.emit('voiceRoster', { handle, roster: rosterOf(c, h), epoch: h.epoch })
  }

  function rosterOf(c: Call, h: MlsGroupHandle): VoiceRosterEntry[] {
    const sessions = [...(c.roster?.members ?? [])]
    return mls.roster(h).map((e) => ({
      sessionId: sessions.find((s) => s.leafIndex === e.leafIndex && s.deviceId === e.deviceId)?.sessionId ?? (e.leafIndex === h.ownLeaf ? (c.ownSessionId ?? '') : ''),
      userId: e.userId,
      deviceId: e.deviceId,
      leafIndex: e.leafIndex,
    }))
  }

  // MARK: - state changes

  /** Forgets the room group (a new group id: the media node reset the room). */
  function resetGroup(c: Call, groupId: Uint8Array): void {
    for (const e of c.installed) post(c, { type: 'retire', epoch: e })
    c.installed.clear()
    c.groupId = groupId
    c.group = null
    c.active = null
    c.transition = null
    c.welcome = null
    c.ownCommit = null
    c.keyPackages.clear()
    c.rejections = 0
  }

  /**
   * The media node evicted the committer of the prepared transition: back to the previous epoch.
   * Returns true when the transition was this device's Welcome join: its key package is used, and
   * the media node would relay the same one to the next committer.
   */
  function revert(c: Call): boolean {
    const t = c.transition
    if (t === null) return false
    post(c, { type: 'retire', epoch: t.epoch })
    c.installed.delete(t.epoch)
    c.group = t.prev
    c.transition = null
    c.ownCommit = null
    return t.prev === null
  }

  /** The descriptor scope (§12.10.1): the guild of a guild call, the channel of a DM call. */
  function voiceScope(c: Call): { guildId: GuildId | null; channelId: ChannelId | null } {
    return c.guildId !== null ? { guildId: c.guildId, channelId: null } : { guildId: null, channelId: c.channelId }
  }

  function ownSession(c: Call, d: RosterData): string | null {
    const self = identity.self().deviceId
    const live = [...d.members, ...d.pending].filter((e) => e.deviceId === self)
    if (c.ownSessionId !== null && live.some((e) => e.sessionId === c.ownSessionId)) return c.ownSessionId
    return live.length === 1 ? live[0]!.sessionId : null
  }

  async function onRoster(c: Call, d: RosterData, handle: string): Promise<VoiceE2eeClientOp[]> {
    let gid: Uint8Array
    try {
      gid = fromB64url(d.groupId)
      const parts = mls.parseGroupId(gid)
      if (parts.kind !== 'voice' || parts.generation !== 0) throw new CryptoError('Malformed', 'not a voice group id')
    } catch (e) {
      return [invalid(null, `roster: ${reasonOf(e)}`, null)]
    }
    if (c.groupId === null || !equalBytes(c.groupId, gid)) resetGroup(c, gid)
    c.prevRoster = c.roster
    c.roster = d
    c.ownSessionId = ownSession(c, d)
    const pendingSessions = new Set(d.pending.map((p) => p.sessionId))
    for (const sid of [...c.keyPackages.keys()]) if (!pendingSessions.has(sid)) c.keyPackages.delete(sid)
    if (c.transition !== null && (d.epoch === null || d.epoch < c.transition.epoch) && revert(c)) {
      // A resync (4013): the rejoin calls voiceStart, which makes a new key package.
      return [invalid(null, 'welcome join reverted: the key package is used', null)]
    }
    if (c.welcome !== null && (d.epoch === null || d.epoch < c.welcome.epoch)) c.welcome = null

    if (d.create && d.epoch === null && c.group === null && c.ownSessionId !== null && d.committer === c.ownSessionId) return create(c, gid, handle)
    return maybeCommit(c)
  }

  async function create(c: Call, gid: Uint8Array, handle: string): Promise<VoiceE2eeClientOp[]> {
    const self = identity.self()
    const r = await mls.createGroup({
      groupId: gid,
      descriptor: { kind: 'voice', ...voiceScope(c), historyVisibility: 'joined', createdByUserId: self.userId },
      dsExternalSender: null,
      cipherSuite: DEFAULT_CIPHER_SUITE,
      keyPackage: c.keyPackage,
    })
    c.group = r.handle
    await installKeys(c, r.handle)
    activate(c, r.handle, handle)
    return [{ op: 'e2ee_ready', d: { transitionId: null, epoch: r.handle.epoch, leafIndex: r.handle.ownLeaf } }]
  }

  /** The committer commits Adds for pending joiners and Removes for departed leaves. */
  async function maybeCommit(c: Call): Promise<VoiceE2eeClientOp[]> {
    const d = c.roster
    const g = c.group
    if (d === null || g === null || c.ownSessionId === null || d.committer !== c.ownSessionId) return []
    if (c.transition !== null || c.ownCommit !== null || d.epoch !== g.epoch) return []
    const leaves = mls.roster(g)
    const self = identity.self()

    // Adds: a relayed key package whose credential equals the roster entry of a pending session.
    const adds: { sessionId: string; bytes: Uint8Array; userId: UserId; text: string }[] = []
    for (const p of d.pending) {
      if (p.sessionId === c.ownSessionId) continue
      const kp = c.keyPackages.get(p.sessionId)
      if (kp === undefined) continue
      if (kp.userId !== p.userId || kp.deviceId !== p.deviceId) continue
      let id
      try {
        id = keyPackageIdentity(kp.keyPackage)
      } catch {
        c.keyPackages.delete(p.sessionId)
        continue
      }
      const text = `${p.userId}:${p.deviceId}`
      if (id.credentialIdentity !== text) {
        c.keyPackages.delete(p.sessionId)
        continue
      }
      adds.push({ sessionId: p.sessionId, bytes: kp.keyPackage, userId: p.userId, text })
    }
    if (adds.length === 0 && d.departed.length === 0) return []

    // Removes: the departed leaf at its reported index. Else every leaf of the departed device that
    // no member session claims, once no live session of that device lacks a leaf index.
    const live: { deviceId: DeviceId; leafIndex: number | null }[] = [...d.members, ...d.pending.map((p) => ({ ...p, leafIndex: null }))]
    const claimed = new Set(d.members.flatMap((m) => (m.leafIndex === null ? [] : [m.leafIndex])))
    const removable = (l: { leafIndex: number; deviceId: DeviceId }, deviceId: DeviceId): boolean => l.deviceId === deviceId && l.leafIndex !== g.ownLeaf && !claimed.has(l.leafIndex)
    const removes = new Set<number>()
    const removedSessions: string[] = []
    const departedDevices = new Set<DeviceId>()
    for (const dep of d.departed) {
      const at = dep.leafIndex === null ? undefined : leaves.find((l) => l.leafIndex === dep.leafIndex)
      let targets: number[]
      if (at !== undefined && removable(at, dep.deviceId)) targets = [at.leafIndex]
      else {
        if (live.some((s) => s.deviceId === dep.deviceId && s.leafIndex === null)) continue
        targets = leaves.filter((l) => removable(l, dep.deviceId)).map((l) => l.leafIndex)
      }
      removedSessions.push(dep.sessionId)
      for (const t of targets) removes.add(t)
      if (targets.length > 0) departedDevices.add(dep.deviceId)
    }

    const removedUsers = leaves.filter((l) => removes.has(l.leafIndex)).map((l) => l.userId)
    const policy = await policyFor([...adds.map((a) => a.userId), ...removedUsers, self.userId], new Set(adds.map((a) => a.text)), departedDevices)
    // Chain check of each Add on its own, so one bad key package does not block the others.
    const accepted = adds.filter((a) => {
      const why = checkAdd(a.bytes, policy)
      if (why !== null) c.keyPackages.delete(a.sessionId)
      return why === null
    })
    if (accepted.length === 0 && removedSessions.length === 0) return []

    let pc: PendingCommit
    try {
      pc = await mls.commit(g, { adds: accepted.map((a) => a.bytes), removes: [...removes], descriptor: null, policy })
    } catch {
      return []
    }
    c.ownCommit = { epoch: g.epoch, commit: pc.request.commit, pc }
    const out: VoiceE2eeClientOp[] = [
      { op: 'e2ee_commit', d: { epoch: g.epoch, commit: pc.request.commit, welcome: pc.request.welcome, added: accepted.map((a) => a.sessionId), removed: removedSessions } },
    ]
    if (pc.request.welcome !== null) out.push({ op: 'e2ee_ratchet_tree', d: { epoch: g.epoch + 1, ratchetTree: pc.request.ratchetTree } })
    return out
  }

  async function onPrepare(c: Call, d: Extract<VoiceE2eeServerOp, { op: 'e2ee_prepare_transition' }>['d']): Promise<VoiceE2eeClientOp[]> {
    const g = c.group
    let bytes: Uint8Array
    try {
      bytes = fromB64url(d.commit)
    } catch {
      return [invalid(d.transitionId, 'commit: not base64url', null)]
    }
    const committerLeaf = commitSenderLeaf(bytes)
    if (g === null) return [invalid(d.transitionId, 'not a member', committerLeaf)]
    if (c.transition !== null) return [invalid(d.transitionId, 'a transition is already prepared', committerLeaf)]
    if (d.epoch !== g.epoch + 1) return [invalid(d.transitionId, `epoch ${d.epoch} does not follow ${g.epoch}`, committerLeaf)]

    let next: MlsGroupHandle
    const own = c.ownCommit
    c.ownCommit = null
    if (own !== null && own.epoch === g.epoch && own.commit === d.commit) {
      next = own.pc.next
    } else {
      const sets = rosterSets(c)
      let r
      try {
        const policy = await policyFor(handshakeUserIds(g, bytes), sets.pending, sets.departed)
        r = await mls.processHandshake(g, bytes, policy)
      } catch (e) {
        return [invalid(d.transitionId, reasonOf(e), committerLeaf)]
      }
      if (r.result !== 'applied') return [invalid(d.transitionId, r.result === 'rejected' ? r.reason : 'not a commit', committerLeaf)]
      if (r.selfRemoved) return [invalid(d.transitionId, 'the commit removes this device', committerLeaf)]
      if (r.committerLeaf !== committerLeaf) return [invalid(d.transitionId, 'committer leaf', committerLeaf)]
      next = r.handle
    }
    if (next.epoch !== d.epoch) return [invalid(d.transitionId, 'epoch after the commit', committerLeaf)]
    c.transition = { id: d.transitionId, epoch: d.epoch, prev: g, next }
    c.group = next
    c.rejections = 0
    await installKeys(c, next)
    return [{ op: 'e2ee_ready', d: { transitionId: d.transitionId, epoch: d.epoch, leafIndex: next.ownLeaf } }]
  }

  async function onTree(c: Call, d: Extract<VoiceE2eeServerOp, { op: 'e2ee_ratchet_tree' }>['d']): Promise<VoiceE2eeClientOp[]> {
    const w = c.welcome
    if (w?.transitionId !== d.transitionId || w.epoch !== d.epoch || c.group !== null || c.groupId === null) return []
    c.welcome = null
    if (c.keyPackageUsed) return [invalid(d.transitionId, 'welcome: the key package is used', null)]
    c.keyPackageUsed = true
    let h: MlsGroupHandle
    try {
      const tree = fromB64url(d.ratchetTree)
      const policy = await policyFor(treeUserIds(tree), new Set(), new Set())
      h = await mls.joinFromWelcome({ welcome: w.welcome, ratchetTree: tree, keyPackage: c.keyPackage, policy })
    } catch (e) {
      return [invalid(d.transitionId, `welcome: ${reasonOf(e)}`, null)]
    }
    const desc = contextOf(h).descriptor
    if (!equalBytes(h.groupId, c.groupId)) return [invalid(d.transitionId, 'welcome: another group', null)]
    if (h.epoch !== d.epoch) return [invalid(d.transitionId, 'welcome: epoch', null)]
    if (desc?.kind !== 'voice' || desc.historyVisibility !== 'joined') return [invalid(d.transitionId, 'welcome: descriptor', null)]
    const want = voiceScope(c)
    if (desc.guildId !== want.guildId || desc.channelId !== want.channelId) return [invalid(d.transitionId, 'welcome: another call', null)]
    c.transition = { id: d.transitionId, epoch: d.epoch, prev: null, next: h }
    c.group = h
    await installKeys(c, h)
    return [{ op: 'e2ee_ready', d: { transitionId: d.transitionId, epoch: d.epoch, leafIndex: h.ownLeaf } }]
  }

  async function onExecute(c: Call, d: Extract<VoiceE2eeServerOp, { op: 'e2ee_execute_transition' }>['d'], handle: string): Promise<VoiceE2eeClientOp[]> {
    const t = c.transition
    if (t?.id !== d.transitionId || t.epoch !== d.epoch) return []
    c.transition = null
    activate(c, t.next, handle)
    return maybeCommit(c)
  }

  async function dispatch(c: Call, op: VoiceE2eeServerOp, handle: string): Promise<VoiceE2eeClientOp[]> {
    switch (op.op) {
      case 'e2ee_roster':
        return onRoster(c, op.d, handle)
      case 'e2ee_key_package': {
        let kp: Uint8Array
        try {
          kp = fromB64url(op.d.keyPackage)
        } catch {
          return []
        }
        c.keyPackages.set(op.d.sessionId, { userId: op.d.userId, deviceId: op.d.deviceId, keyPackage: kp })
        return maybeCommit(c)
      }
      case 'e2ee_commit_rejected': {
        const own = c.ownCommit
        if (own?.epoch !== op.d.epoch) return []
        c.ownCommit = null
        c.rejections++
        // Another commit won: its prepare follows. Else the roster moved: retry with the newest one.
        if (c.group !== null && op.d.currentEpoch === c.group.epoch && c.rejections <= MAX_COMMIT_RETRIES) return maybeCommit(c)
        return []
      }
      case 'e2ee_prepare_transition':
        return onPrepare(c, op.d)
      case 'e2ee_welcome': {
        if (c.group !== null) return []
        let w: Uint8Array
        try {
          w = fromB64url(op.d.welcome)
        } catch {
          return [invalid(op.d.transitionId, 'welcome: not base64url', null)]
        }
        c.welcome = { transitionId: op.d.transitionId, epoch: op.d.epoch, welcome: w }
        return []
      }
      case 'e2ee_ratchet_tree':
        return onTree(c, op.d)
      case 'e2ee_execute_transition':
        return onExecute(c, op.d, handle)
      default:
        return []
    }
  }

  const service = {
    async voiceStart(opts: Parameters<VoiceService['voiceStart']>[0]) {
      const self = identity.self()
      const [kp] = await mls.generateKeyPackages({ chain: self.chain, signatureKey: self.mlsSignatureKey, cipherSuite: DEFAULT_CIPHER_SUITE, count: 1, lastResort: false })
      if (kp === undefined) throw new CryptoError('Malformed', 'no key package')
      const handle = toB64url(ctx.random(16))
      calls.set(handle, {
        channelId: opts.channelId,
        guildId: opts.guildId,
        keyPackage: { publicPackage: kp.publicPackage, privatePackage: kp.privatePackage },
        keyPackageUsed: false,
        groupId: null,
        group: null,
        active: null,
        transition: null,
        welcome: null,
        roster: null,
        prevRoster: null,
        ownSessionId: null,
        keyPackages: new Map(),
        ownCommit: null,
        rejections: 0,
        ports: new Map(),
        installed: new Set(),
        lock: Promise.resolve(),
      })
      return { handle, keyPackage: toB64url(kp.publicPackage) }
    },

    async voiceHandle(handle: string, op: VoiceE2eeServerOp) {
      const c = callOf(handle)
      return serial(c, () => dispatch(c, op, handle))
    },

    async voiceAttachTransform(handle: string, port: MessagePort) {
      const c = callOf(handle)
      return serial(c, async () => {
        const id = toB64url(ctx.random(16))
        c.ports.set(id, port)
        portCalls.set(id, handle)
        const send = async (h: MlsGroupHandle): Promise<void> => {
          const m = await keyMessage(h)
          port.postMessage(m)
          if (m.type === 'epoch') m.secret.fill(0)
        }
        if (c.active !== null) {
          await send(c.active)
          port.postMessage({ type: 'activate', epoch: c.active.epoch } satisfies FrameKeyMessage)
        }
        if (c.group !== null && c.group !== c.active) await send(c.group)
        return id
      })
    },

    async voiceDetachTransform(portId: string) {
      const handle = portCalls.get(portId)
      const c = handle === undefined ? undefined : calls.get(handle)
      if (c === undefined) {
        portCalls.delete(portId)
        return Promise.resolve()
      }
      return serial(c, () => {
        const port = c.ports.get(portId)
        forgetPort(c, portId)
        if (port !== undefined) {
          // The transform Worker closes its ring and its end of the port on `close`.
          try {
            port.postMessage({ type: 'close' } satisfies FrameKeyMessage)
          } catch {
            // The other end is gone.
          }
          port.close()
        }
        return Promise.resolve()
      })
    },

    async voiceRoster(handle: string) {
      const c = callOf(handle)
      return serial(c, () => Promise.resolve(c.group === null ? [] : rosterOf(c, c.group)))
    },

    async voiceEpochCode(handle: string) {
      const c = callOf(handle)
      return serial(c, () => {
        const h = c.active ?? c.group
        return Promise.resolve(h === null ? null : identityModule.epochCode(mls.epochAuthenticator(h)))
      })
    },

    async voiceStop(handle: string) {
      const c = calls.get(handle)
      if (c === undefined) return Promise.resolve()
      calls.delete(handle)
      return serial(c, () => {
        post(c, { type: 'close' })
        for (const [id, p] of c.ports) {
          p.close()
          portCalls.delete(id)
        }
        c.ports.clear()
        c.installed.clear()
        c.group = null
        c.active = null
        c.transition = null
        return Promise.resolve()
      })
    },
  } satisfies VoiceService

  return service
}) satisfies CreateVoiceService
