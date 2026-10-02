/**
 * A fake media node for the voice specs: the §8 / §12.10.1 relay and ordering rules of
 * cmd/hachiman-media/e2ee.go (first commit per epoch wins, the committer by lowest leaf, "Bad
 * commits" eviction with revert), without sockets or timers. `failover()` stands in for the 5 s
 * committer timer. Not part of the package exports.
 */
import type { ChannelId, GuildId, VoiceE2eeClientOp, VoiceE2eeServerOp } from '../api'
import { Reader, fromB64url, toB64url } from '../codec'
import { equalBytes } from '../identity/bytes'
import { mls } from '../mls/index'
import { uuid } from '../mls/test-helpers'
import type { VoiceServiceExt } from './service'

export interface VoiceClient {
  name: string
  userId: string
  deviceId: string
  voice: VoiceServiceExt
  handle: string
}

interface Part {
  sid: string
  client: VoiceClient
  keyPackage: string
  seq: number
  leaf: number | null
  addedIn: number
  acked: number
  kpSentTo: string | null
  demoted: boolean
  expectTree: { epoch: number; t: Transition | null } | null
}

interface Departed {
  sid: string
  userId: string
  deviceId: string
  leaf: number | null
  addedIn: number
  removedIn: number
}

interface Transition {
  id: number
  epoch: number
  committer: Part
  commit: string
  welcome: string | null
  tree: string | null
  added: Part[]
  expected: Set<Part>
  invalid: Set<Part>
  prevLeaves: Map<Part, number | null>
}

export class FakeMedia {
  groupId = ''
  epoch: number | null = null
  parts = new Map<string, Part>()
  departed: Departed[] = []
  committer: Part | null = null
  transitions: Transition[] = []
  closes: { sid: string; code: number; reason: string }[] = []
  /** Every client op, in order. */
  log: { from: string; op: VoiceE2eeClientOp }[] = []
  /** Rewrites a client op before the media node reads it. Null drops the op. */
  interceptClient: ((from: Part, op: VoiceE2eeClientOp) => VoiceE2eeClientOp | null) | null = null
  /** Rewrites a server op before the client gets it. */
  interceptServer: ((to: Part, op: VoiceE2eeServerOp) => VoiceE2eeServerOp) | null = null
  private seq = 0
  private lastTransition = 0
  private dirty = false
  private queue: { to: Part; op: VoiceE2eeServerOp }[] = []

  constructor(
    readonly channelId: ChannelId,
    readonly guildId: GuildId,
  ) {
    this.newGroupId()
  }

  private newGroupId(): void {
    this.groupId = toB64url(mls.groupId({ kind: 'voice', scope: uuid(), generation: 0 }))
  }

  async join(name: string, userId: string, deviceId: string, voice: VoiceServiceExt, sid = uuid()): Promise<VoiceClient> {
    const start = await voice.voiceStart({ channelId: this.channelId, guildId: this.guildId })
    const client: VoiceClient = { name, userId, deviceId, voice, handle: start.handle }
    this.parts.set(sid, { sid, client, keyPackage: start.keyPackage, seq: ++this.seq, leaf: null, addedIn: 0, acked: 0, kpSentTo: null, demoted: false, expectTree: null })
    this.dirty = true
    this.settle()
    await this.flush()
    return client
  }

  sidOf(c: VoiceClient): string {
    for (const p of this.parts.values()) if (p.client === c) return p.sid
    throw new Error(`${c.name} is not in the room`)
  }

  async leave(c: VoiceClient): Promise<void> {
    const p = this.parts.get(this.sidOf(c))!
    this.leaveLocked(p)
    this.settle()
    await this.flush()
  }

  /** The 5 s committer timer fired. */
  async failover(): Promise<void> {
    const c = this.committer
    if (c !== null && this.hasWork() && !this.inFlight()) {
      if (this.epoch === null) c.seq = ++this.seq
      else c.demoted = true
      this.dirty = true
    }
    this.settle()
    await this.flush()
  }

  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const { to, op } = this.queue.shift()!
      if (this.parts.get(to.sid) !== to) continue
      const out = await to.client.voice.voiceHandle(to.client.handle, this.interceptServer === null ? op : this.interceptServer(to, op))
      for (const o of out) {
        if (this.parts.get(to.sid) !== to) break
        const x = this.interceptClient === null ? o : this.interceptClient(to, o)
        if (x === null) continue
        this.log.push({ from: to.client.name, op: x })
        this.onClient(to, x)
      }
      this.settle()
    }
  }

  private send(p: Part, op: VoiceE2eeServerOp): void {
    this.queue.push({ to: p, op })
  }

  private pending(p: Part): boolean {
    return p.leaf === null && p.addedIn === 0
  }

  private leaveLocked(p: Part): void {
    this.parts.delete(p.sid)
    if (!this.pending(p)) {
      this.departed.push({ sid: p.sid, userId: p.client.userId, deviceId: p.client.deviceId, leaf: p.leaf, addedIn: p.leaf === null ? p.addedIn : 0, removedIn: 0 })
    }
    for (const t of this.transitions) {
      t.expected.delete(p)
      t.invalid.delete(p)
    }
    this.dirty = true
  }

  private drop(p: Part, code: number, reason: string): void {
    this.closes.push({ sid: p.sid, code, reason })
    this.leaveLocked(p)
  }

  private inFlight(): boolean {
    return this.transitions.length > 0
  }

  private onClient(p: Part, op: VoiceE2eeClientOp): void {
    if (p.expectTree !== null && op.op !== 'e2ee_ratchet_tree') {
      this.drop(p, 4014, 'expected e2ee_ratchet_tree')
      return
    }
    switch (op.op) {
      case 'e2ee_commit':
        this.onCommit(p, op.d)
        return
      case 'e2ee_ratchet_tree': {
        const w = p.expectTree
        if (w?.epoch !== op.d.epoch) {
          this.drop(p, 4014, 'unexpected tree')
          return
        }
        p.expectTree = null
        const t = w.t
        if (t === null || !this.transitions.includes(t)) return
        t.tree = op.d.ratchetTree
        for (const q of t.added) {
          if (!t.expected.has(q)) continue
          this.send(q, { op: 'e2ee_welcome', d: { transitionId: t.id, epoch: t.epoch, welcome: t.welcome! } })
          this.send(q, { op: 'e2ee_ratchet_tree', d: { transitionId: t.id, epoch: t.epoch, ratchetTree: t.tree } })
        }
        return
      }
      case 'e2ee_ready': {
        if (op.d.transitionId === null) {
          if (this.epoch !== null || this.committer !== p || op.d.epoch !== 0 || op.d.leafIndex !== 0) {
            this.drop(p, 4014, 'bad create ready')
            return
          }
          this.epoch = 0
          p.leaf = 0
          this.dirty = true
          return
        }
        const t = this.transitions.find((x) => x.id === op.d.transitionId)
        if (!t?.expected.has(p)) return
        if (op.d.epoch !== t.epoch) {
          this.drop(p, 4014, 'ready epoch')
          return
        }
        p.acked = Math.max(p.acked, t.id)
        t.invalid.delete(p)
        if (p.leaf !== op.d.leafIndex) {
          p.leaf = op.d.leafIndex
          this.dirty = true
        }
        return
      }
      case 'e2ee_invalid': {
        const t = op.d.transitionId === null ? undefined : this.transitions.find((x) => x.id === op.d.transitionId)
        if (t === undefined || !t.expected.has(p) || t.committer === p) {
          this.drop(p, 4013, `e2ee_invalid: ${op.d.reason}`)
          return
        }
        t.invalid.add(p)
        return
      }
    }
  }

  private onCommit(p: Part, d: Extract<VoiceE2eeClientOp, { op: 'e2ee_commit' }>['d']): void {
    if (p.leaf === null) {
      this.drop(p, 4014, 'commit without leaf')
      return
    }
    let h: { groupId: Uint8Array; epoch: number; leaf: number }
    try {
      const r = new Reader(fromB64url(d.commit))
      if (r.u16() !== 1 || r.u16() !== 1) throw new Error('header')
      const groupId = r.opaque()
      const epoch = Number(r.u64())
      if (r.u8() !== 1) throw new Error('sender type')
      h = { groupId, epoch, leaf: r.u32() }
    } catch {
      this.drop(p, 4014, 'commit parse'); return;
    }
    if (!equalBytes(h.groupId, fromB64url(this.groupId)) || h.epoch !== d.epoch || h.leaf !== p.leaf) {
      this.drop(p, 4014, 'commit header')
      return
    }
    if ((d.welcome !== null) !== d.added.length > 0) {
      this.drop(p, 4014, 'welcome without adds')
      return
    }
    if (d.welcome !== null) p.expectTree = { epoch: d.epoch + 1, t: null }
    const reject = (): void => { this.send(p, { op: 'e2ee_commit_rejected', d: { epoch: d.epoch, currentEpoch: this.epoch ?? -1 } }); }
    if (this.epoch === null || d.epoch !== this.epoch || this.inFlight()) {
      reject()
      return
    }
    const added: Part[] = []
    for (const sid of d.added) {
      const q = this.parts.get(sid)
      if (q === undefined || !this.pending(q) || q === p) {
        reject()
        return
      }
      added.push(q)
    }
    const removed: Departed[] = []
    for (const sid of d.removed) {
      const deps = this.departed.filter((x) => x.sid === sid && x.removedIn === 0)
      if (deps.length === 0) {
        reject()
        return
      }
      removed.push(...deps)
    }
    const t: Transition = {
      id: ++this.lastTransition,
      epoch: d.epoch + 1,
      committer: p,
      commit: d.commit,
      welcome: d.welcome,
      tree: null,
      added,
      expected: new Set(),
      invalid: new Set(),
      prevLeaves: new Map(),
    }
    if (p.expectTree !== null) p.expectTree.t = t
    this.epoch = t.epoch
    for (const q of this.parts.values()) {
      t.prevLeaves.set(q, q.leaf)
      if (!this.pending(q)) t.expected.add(q)
    }
    for (const q of added) {
      q.addedIn = t.id
      t.expected.add(q)
    }
    for (const x of removed) x.removedIn = t.id
    this.transitions.push(t)
    this.dirty = true
    for (const q of t.expected) if (q.addedIn !== t.id) this.send(q, { op: 'e2ee_prepare_transition', d: { transitionId: t.id, epoch: t.epoch, commit: t.commit } })
  }

  /** Returns true when it dropped a participant. */
  private evaluate(t: Transition): boolean {
    let others = 0
    let invalid = 0
    let allDone = true
    for (const q of t.expected) {
      if (q !== t.committer) {
        others++
        if (t.invalid.has(q)) {
          invalid++
          continue
        }
      }
      if (q.acked < t.id) allDone = false
    }
    const thr = Math.min(2, others)
    if (thr > 0 && invalid >= thr) {
      this.evict(t)
      return true
    }
    if (invalid > 0 && allDone) {
      for (const q of [...t.invalid]) this.drop(q, 4013, 'e2ee_invalid')
      return true
    }
    if (allDone) {
      for (const q of t.expected) this.send(q, { op: 'e2ee_execute_transition', d: { transitionId: t.id, epoch: t.epoch } })
      this.resolve(t)
    }
    return false
  }

  private evict(t: Transition): void {
    if (this.transitions.at(-1) === t && this.epoch === t.epoch) {
      this.epoch = t.epoch - 1
      for (const [q, leaf] of t.prevLeaves) {
        q.leaf = leaf
        if (q.acked >= t.id) q.acked = t.id - 1
      }
      for (const q of t.added) {
        q.addedIn = 0
        q.kpSentTo = null
      }
      this.departed = this.departed.filter((x) => x.addedIn !== t.id)
      for (const x of this.departed) if (x.removedIn === t.id) x.removedIn = 0
      this.transitions = this.transitions.filter((x) => x !== t)
      this.dirty = true
    } else this.resolve(t)
    if (this.parts.get(t.committer.sid) === t.committer) this.drop(t.committer, 4014, 'commit rejected by members')
  }

  private resolve(t: Transition): void {
    this.departed = this.departed.filter((x) => x.removedIn !== t.id)
    this.transitions = this.transitions.filter((x) => x !== t)
  }

  private hasWork(): boolean {
    if (this.committer === null) return false
    if (this.epoch === null) return true
    return [...this.parts.values()].some((p) => this.pending(p)) || this.departed.some((x) => x.removedIn === 0)
  }

  private settle(): void {
    for (let again = true; again; ) {
      again = false
      for (const t of [...this.transitions]) {
        if (this.transitions.includes(t) && this.evaluate(t)) {
          again = true
          break
        }
      }
    }
    if (this.parts.size === 0) return
    if (this.epoch !== null && ![...this.parts.values()].some((p) => !this.pending(p))) {
      this.newGroupId()
      this.epoch = null
      this.departed = []
      this.committer = null
      this.transitions = []
      for (const p of this.parts.values()) Object.assign(p, { leaf: null, addedIn: 0, acked: 0, kpSentTo: null, demoted: false, expectTree: null })
      this.dirty = true
    }
    if (this.chooseCommitter()) this.dirty = true
    if (this.dirty) {
      this.dirty = false
      this.broadcastRoster()
    }
    const c = this.committer
    if (this.epoch === null || c?.leaf == null) return
    for (const p of [...this.parts.values()].sort((a, b) => a.seq - b.seq)) {
      if (!this.pending(p) || p === c || p.kpSentTo === c.sid) continue
      this.send(c, { op: 'e2ee_key_package', d: { sessionId: p.sid, userId: p.client.userId, deviceId: p.client.deviceId, keyPackage: p.keyPackage } })
      p.kpSentTo = c.sid
    }
  }

  private chooseCommitter(): boolean {
    let best: Part | null = null
    for (let round = 0; round < 2; round++) {
      for (const p of this.parts.values()) {
        if (this.epoch === null) {
          if (best === null || p.seq < best.seq) best = p
        } else if (p.leaf !== null && !p.demoted && (best === null || p.leaf < best.leaf!)) best = p
      }
      if (best !== null || this.epoch === null) break
      for (const p of this.parts.values()) p.demoted = false
    }
    const changed = best !== this.committer
    this.committer = best
    return changed
  }

  private broadcastRoster(): void {
    const parts = [...this.parts.values()].sort((a, b) => a.seq - b.seq)
    const members = parts
      .filter((p) => !this.pending(p))
      .map((p) => ({ sessionId: p.sid, userId: p.client.userId, deviceId: p.client.deviceId, leafIndex: p.leaf }))
      .sort((a, b) => (a.leafIndex ?? Infinity) - (b.leafIndex ?? Infinity))
    const pending = parts.filter((p) => this.pending(p)).map((p) => ({ sessionId: p.sid, userId: p.client.userId, deviceId: p.client.deviceId }))
    const departed = this.departed.filter((x) => x.removedIn === 0).map((x) => ({ sessionId: x.sid, userId: x.userId, deviceId: x.deviceId, leafIndex: x.leaf }))
    const d = { groupId: this.groupId, epoch: this.epoch, committer: this.committer?.sid ?? null, create: this.epoch === null && this.committer !== null, members, pending, departed }
    for (const p of parts) this.send(p, { op: 'e2ee_roster', d: structuredClone(d) })
  }
}
