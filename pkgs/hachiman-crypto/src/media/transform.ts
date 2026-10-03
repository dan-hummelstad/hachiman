/**
 * The frame transform logic of §12.10.2, as plain objects with no Worker or WebRTC types.
 * `transform-worker.ts` is the thin RTCRtpScriptTransform adapter around it.
 *
 * Sender: one CTR per KID per epoch key, from 0. The counter lives on the key entry, and an entry
 * is replaced only by a different secret, so (key, CTR) never repeats. Audio and video use
 * different media indexes, so they never share a key.
 * Receiver: the key by KID; the current epoch, newer installed epochs (peers that activate first)
 * and the previous epoch for SFRAME_OLD_EPOCH_RETENTION_MS after an activate. There is no
 * plaintext passthrough: every frame without a key is dropped.
 */
import type { FrameKeyMessage, FrameStatsMessage, FrameTransformOptions, UserId } from '../api'
import { SFRAME_EPOCH_BITS, SFRAME_OLD_EPOCH_RETENTION_MS, SFRAME_REPLAY_WINDOW, SFrameTrack } from '../constants'
import { equalBytes } from '../identity/bytes'
import { sframe } from './sframe'

const MAX_CTR = 0xffff_ffff_ffff_ffffn
const EPOCH_MASK = (1 << SFRAME_EPOCH_BITS) - 1
const WINDOW = BigInt(SFRAME_REPLAY_WINDOW)

/** Sliding replay window of SFRAME_REPLAY_WINDOW counters per KID. */
export class ReplayWindow {
  private max = -1n
  private readonly bits = new Uint32Array(SFRAME_REPLAY_WINDOW / 32)

  private bit(ctr: bigint): [number, number] {
    const i = Number(ctr % WINDOW)
    return [i >>> 5, 1 << (i & 31)]
  }

  /** True when ctr is a replay or older than the window. */
  seen(ctr: bigint): boolean {
    if (this.max < 0n || ctr > this.max) return false
    if (this.max - ctr >= WINDOW) return true
    const [w, m] = this.bit(ctr)
    return (this.bits[w]! & m) !== 0
  }

  /** Checks and records ctr in one step. False for a replay. */
  accept(ctr: bigint): boolean {
    if (this.seen(ctr)) return false
    if (ctr > this.max) {
      const d = ctr - this.max
      if (this.max < 0n || d >= WINDOW) this.bits.fill(0)
      else
        for (let c = this.max + 1n; c < ctr; c++) {
          const [w, m] = this.bit(c)
          this.bits[w]! &= ~m
        }
      this.max = ctr
      const [w, m] = this.bit(ctr)
      this.bits[w]! &= ~m
    }
    const [w, m] = this.bit(ctr)
    this.bits[w]! |= m
    return true
  }
}

interface EpochEntry {
  epoch: number
  secret: Uint8Array
  selfLeaf: number
  leaves: Map<number, UserId>
  keys: Map<bigint, Promise<{ key: CryptoKey; salt: Uint8Array }>>
  counters: Map<bigint, bigint>
  replay: Map<bigint, ReplayWindow>
}

export type DropReason = keyof FrameStatsMessage['dropped']

export type FrameResult = { frame: Uint8Array } | { drop: DropReason }

const trackBit = (t: FrameTransformOptions['track']): 0 | 1 => (t === 'audio' ? SFrameTrack.AUDIO : SFrameTrack.VIDEO)

/** The keys of one call as one MessagePort delivers them. Every transformer on that port shares it. */
export class FrameKeyRing {
  private readonly epochs = new Map<number, EpochEntry>()
  private active: number | null = null
  private previous: { epoch: number; until: number } | null = null
  private closed = false
  readonly stats: FrameStatsMessage = { type: 'stats', encrypted: 0, decrypted: 0, dropped: { unknownKey: 0, authFailed: 0, replay: 0, wrongSender: 0 } }

  get isClosed(): boolean {
    return this.closed
  }

  get activeEpoch(): number | null {
    return this.active
  }

  /** Applies one FrameKeyMessage. Unknown or malformed messages are ignored. */
  handle(msg: FrameKeyMessage, nowMs: number): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- structured clone from another Worker
    if (this.closed || typeof msg !== 'object' || msg === null) return
    switch (msg.type) {
      case 'epoch':
        this.install(msg)
        break
      case 'activate':
        this.activate(msg.epoch, nowMs)
        break
      case 'retire':
        // Retiring the send epoch (a room reset: the next group starts at epoch 0 again) stops the
        // senders until the next activate.
        if (msg.epoch === this.active) this.active = null
        this.drop(msg.epoch)
        break
      case 'close':
        this.closed = true
        for (const e of [...this.epochs.keys()]) this.drop(e)
        this.active = null
        this.previous = null
        break
    }
  }

  private install(msg: Extract<FrameKeyMessage, { type: 'epoch' }>): void {
    if (!Number.isInteger(msg.epoch) || msg.epoch < 0 || !(msg.secret instanceof Uint8Array) || msg.secret.length !== 32) return
    if (!Number.isInteger(msg.selfLeaf) || msg.selfLeaf < 0) return
    if (this.active !== null && msg.epoch < this.active && this.previous?.epoch !== msg.epoch) return
    const leaves = new Map<number, UserId>()
    for (const l of msg.leaves) if (Number.isInteger(l.leafIndex) && l.leafIndex >= 0 && typeof l.userId === 'string') leaves.set(l.leafIndex, l.userId)
    const old = this.epochs.get(msg.epoch)
    if (old !== undefined && equalBytes(old.secret, msg.secret) && old.selfLeaf === msg.selfLeaf) {
      // The same key: keep the counters and the replay windows.
      old.leaves = leaves
      return
    }
    if (old !== undefined) this.drop(msg.epoch)
    this.epochs.set(msg.epoch, { epoch: msg.epoch, secret: new Uint8Array(msg.secret), selfLeaf: msg.selfLeaf, leaves, keys: new Map(), counters: new Map(), replay: new Map() })
  }

  private activate(epoch: number, nowMs: number): void {
    if (!this.epochs.has(epoch) || epoch === this.active) return
    if (this.active !== null && epoch < this.active) return
    const prev = this.active
    this.active = epoch
    if (this.previous !== null) this.drop(this.previous.epoch)
    this.previous = prev === null ? null : { epoch: prev, until: nowMs + SFRAME_OLD_EPOCH_RETENTION_MS }
    for (const e of [...this.epochs.keys()]) if (e < epoch && e !== prev) this.drop(e)
  }

  private drop(epoch: number): void {
    const e = this.epochs.get(epoch)
    if (e === undefined) return
    e.secret.fill(0)
    this.epochs.delete(epoch)
    if (this.previous?.epoch === epoch) this.previous = null
  }

  private accepted(e: EpochEntry, nowMs: number): boolean {
    if (this.active === null || e.epoch >= this.active) return true
    if (this.previous !== null && e.epoch === this.previous.epoch) {
      if (nowMs < this.previous.until) return true
      this.drop(e.epoch)
    }
    return false
  }

  private keyOf(e: EpochEntry, kid: bigint, mediaIndex: number): Promise<{ key: CryptoKey; salt: Uint8Array }> {
    let k = e.keys.get(kid)
    if (k === undefined) {
      k = sframe.deriveKey(e.secret, mediaIndex, kid)
      e.keys.set(kid, k)
    }
    return k
  }

  async encrypt(frame: Uint8Array, opts: Pick<FrameTransformOptions, 'track' | 'codec'>): Promise<FrameResult> {
    const e = this.active === null ? undefined : this.epochs.get(this.active)
    if (this.closed || e === undefined) return this.count({ drop: 'unknownKey' })
    const track = trackBit(opts.track)
    const kid = sframe.packKid(e.selfLeaf, track, e.epoch)
    const ctr = e.counters.get(kid) ?? 0n
    if (ctr > MAX_CTR) return this.count({ drop: 'unknownKey' })
    // Taken before the first await, so concurrent frames never share a CTR.
    e.counters.set(kid, ctr + 1n)
    const k = await this.keyOf(e, kid, e.selfLeaf * 2 + track)
    try {
      const out = await sframe.encryptFrame({ frame, codec: opts.codec, kid, ctr, key: k.key, salt: k.salt })
      this.stats.encrypted++
      return { frame: out }
    } catch {
      return this.count({ drop: 'authFailed' })
    }
  }

  async decrypt(frame: Uint8Array, opts: Pick<FrameTransformOptions, 'track' | 'codec' | 'userId'>, nowMs: number): Promise<FrameResult> {
    if (this.closed) return this.count({ drop: 'unknownKey' })
    let kid: bigint
    let ctr: bigint
    let id: { leafIndex: number; track: 0 | 1; epochBits: number }
    try {
      const h = sframe.decodeHeader(frame, sframe.clearPrefixLength(opts.codec, frame))
      kid = h.kid
      ctr = h.ctr
      id = sframe.unpackKid(kid)
    } catch {
      return this.count({ drop: 'authFailed' })
    }
    if (id.track !== trackBit(opts.track)) return this.count({ drop: 'wrongSender' })
    let e: EpochEntry | undefined
    for (const x of [...this.epochs.values()]) {
      if ((x.epoch & EPOCH_MASK) === id.epochBits && this.accepted(x, nowMs)) {
        e = x
        break
      }
    }
    if (e === undefined) return this.count({ drop: 'unknownKey' })
    // The KID leaf must be a leaf of the remote user of this receiver, never the own leaf.
    if (opts.userId === null || id.leafIndex === e.selfLeaf || e.leaves.get(id.leafIndex) !== opts.userId) return this.count({ drop: 'wrongSender' })
    let w = e.replay.get(kid)
    if (w?.seen(ctr)) return this.count({ drop: 'replay' })
    const entry = e
    const theKid = kid
    const mediaIndex = id.leafIndex * 2 + id.track
    const r = await sframe.decryptFrame({ frame, codec: opts.codec, keyFor: (k) => (k === theKid ? this.keyOf(entry, theKid, mediaIndex) : Promise.resolve(null)) })
    if ('failure' in r) return this.count({ drop: r.failure === 'unknown_key' ? 'unknownKey' : 'authFailed' })
    if (w === undefined) {
      w = new ReplayWindow()
      e.replay.set(kid, w)
    }
    if (!w.accept(ctr)) return this.count({ drop: 'replay' })
    this.stats.decrypted++
    return { frame: r.frame }
  }

  private count(r: { drop: DropReason }): FrameResult {
    this.stats.dropped[r.drop]++
    return r
  }

  /** A copy for postMessage. */
  snapshot(): FrameStatsMessage {
    return { type: 'stats', encrypted: this.stats.encrypted, decrypted: this.stats.decrypted, dropped: { ...this.stats.dropped } }
  }
}
