/**
 * The client side of key transparency (docs/gateway-protocol.md §12.14): tree-head pinning and
 * consistency, inclusion proofs for fetched key objects, gossip. Used by IdentityService.
 */
import { CryptoError, type CryptoEvents, type DsTransport, type KtEntry, type SignedTreeHead, type StoreSchema, type UserId, type WireKtTreeHead } from '../api'
import { fromB64url } from '../codec'
import { KT_GOSSIP_MIN_INTERVAL_MS } from '../constants'
import { equalBytes } from '../identity/bytes'
import { kt } from './index'

/** How long one wait for the next KT_TREE_HEAD lasts before the client polls GET /kt/tree-head. */
export const KT_HEAD_WAIT_MS = 15_000
/** §12.14: a proof that still fails after this many new heads raises ktAlert bad_proof. */
const HEADS_BEFORE_ALERT = 2

export interface KtClientDeps {
  transport: Pick<DsTransport, 'ktTreeHead' | 'ktInclusion' | 'ktConsistency'>
  /** The pinned KT public key (GET /mls/ds), or null when unknown. */
  ktPublicKey(): Uint8Array | null
  loadState(): Promise<StoreSchema['kt'] | undefined>
  /** Read-modify-write of the kt row. The caller serializes it with other writers of the row. */
  patchState(patch: Partial<StoreSchema['kt']>): Promise<void>
  alert(a: CryptoEvents['ktAlert']): void
  now(): number
  /** Test seam. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
}

export interface KtClient {
  /** True once this client holds a verified tree head: KT proofs are then required. */
  active(): Promise<boolean>
  storedHead(): Promise<SignedTreeHead | null>
  /** A KT_TREE_HEAD event. */
  onTreeHead(wire: WireKtTreeHead): Promise<void>
  /** Gossip from an envelope. Never throws. */
  observeEncoded(encoded: Uint8Array, fromUserId: UserId): Promise<void>
  /**
   * Checks that `entryBytes` is in the log at `index` and holds `expect`. Waits for up to two new
   * heads when the newest head does not cover the index yet. Throws CryptoError('InvalidChain').
   */
  prove(index: number, entryBytes: Uint8Array, expect: Pick<KtEntry, 'type' | 'userId' | 'object'>): Promise<void>
  /** The stored head for EnvelopeContent.kt_tree_head, at most once per hour per group. */
  gossip(groupKey: string): Promise<Uint8Array | null>
}

export function createKtClient(deps: KtClientDeps): KtClient {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const proven = new Map<number, Uint8Array>()
  const lastGossip = new Map<string, number>()
  let waiters: (() => void)[] = []

  async function state(): Promise<StoreSchema['kt']> {
    return (await deps.loadState()) ?? { treeHead: null, lastSelfCheckMs: 0, lastSelfIndex: -1 }
  }

  async function storedHead(): Promise<SignedTreeHead | null> {
    const s = await state()
    return s.treeHead === null ? null : kt.decodeTreeHead(s.treeHead)
  }

  function verifySignature(h: SignedTreeHead): boolean {
    const key = deps.ktPublicKey()
    return key !== null && kt.verifyTreeHead(key, h)
  }

  /** Stores `h` when it is newer and consistent. Returns false (and alerts) on a split view. */
  async function observe(h: SignedTreeHead): Promise<boolean> {
    if (!verifySignature(h)) return false
    const s = await state()
    const cur = s.treeHead === null ? null : kt.decodeTreeHead(s.treeHead)
    if (cur !== null) {
      if (h.treeSize === cur.treeSize) {
        if (!equalBytes(h.rootHash, cur.rootHash)) {
          deps.alert({ kind: 'split_view', detail: `two roots for tree size ${h.treeSize}` })
          return false
        }
        return true
      }
      const [older, newer] = h.treeSize < cur.treeSize ? [h, cur] : [cur, h]
      if (older.treeSize > 0) {
        const p = await deps.transport.ktConsistency(older.treeSize, newer.treeSize)
        const proof = p.proof.map(fromB64url)
        if (p.from !== older.treeSize || p.to !== newer.treeSize || !kt.verifyConsistency(older.treeSize, newer.treeSize, older.rootHash, newer.rootHash, proof)) {
          deps.alert({ kind: 'split_view', detail: `no consistency from ${older.treeSize} to ${newer.treeSize}` })
          return false
        }
      }
      if (h.treeSize < cur.treeSize) return true
    }
    await deps.patchState({ treeHead: kt.encodeTreeHead(h) })
    const w = waiters
    waiters = []
    for (const resolve of w) resolve()
    return true
  }

  async function fetchHead(): Promise<SignedTreeHead | null> {
    const wire = await deps.transport.ktTreeHead()
    const h = decodeWire(wire)
    return (await observe(h)) ? h : null
  }

  function decodeWire(wire: WireKtTreeHead): SignedTreeHead {
    const h = kt.decodeTreeHead(fromB64url(wire.signed))
    if (h.treeSize !== wire.treeSize || !equalBytes(h.rootHash, fromB64url(wire.rootHash))) throw new CryptoError('Malformed', 'KT_TREE_HEAD fields differ from the signed head')
    return h
  }

  function nextHead(): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      waiters.push(finish)
      void sleep(KT_HEAD_WAIT_MS).then(finish)
    })
  }

  async function covering(index: number): Promise<SignedTreeHead> {
    let head = await storedHead()
    if (head === null || index >= head.treeSize) head = (await fetchHead()) ?? (await storedHead())
    for (let attempt = 0; (head === null || index >= head.treeSize) && attempt < HEADS_BEFORE_ALERT; attempt++) {
      await nextHead()
      head = await storedHead()
      if (head === null || index >= head.treeSize) head = (await fetchHead()) ?? (await storedHead())
    }
    if (head === null || index >= head.treeSize) {
      deps.alert({ kind: 'bad_proof', detail: `KT entry ${index} is in no signed tree head` })
      throw new CryptoError('InvalidChain', `KT entry ${index} is not covered by a tree head`)
    }
    return head
  }

  return {
    async active() {
      return (await state()).treeHead !== null
    },
    storedHead,

    async onTreeHead(wire) {
      await observe(decodeWire(wire))
    },

    async observeEncoded(encoded) {
      try {
        await observe(kt.decodeTreeHead(encoded))
      } catch {
        // Gossip is best effort. A split view already raised its alert.
      }
    },

    async prove(index, entryBytes, expect) {
      const leaf = kt.leafHash(entryBytes)
      const known = proven.get(index)
      if (known !== undefined) {
        if (equalBytes(known, leaf)) return
        deps.alert({ kind: 'bad_proof', detail: `two entries for KT index ${index}` })
        throw new CryptoError('InvalidChain', `two entries for KT index ${index}`)
      }
      let entry: KtEntry
      try {
        entry = kt.decodeEntry(entryBytes)
      } catch {
        deps.alert({ kind: 'bad_proof', detail: `KT entry ${index} does not decode` })
        throw new CryptoError('InvalidChain', `KT entry ${index} does not decode`)
      }
      if (entry.type !== expect.type || entry.userId !== expect.userId || !equalBytes(entry.object, expect.object)) {
        deps.alert({ kind: 'bad_proof', detail: `KT entry ${index} holds another object` })
        throw new CryptoError('InvalidChain', `KT entry ${index} holds another object`)
      }
      let head = await covering(index)
      for (let attempt = 0; ; attempt++) {
        const p = await deps.transport.ktInclusion(index, head.treeSize)
        if (p.leafIndex === index && p.treeSize === head.treeSize && kt.verifyInclusion(leaf, index, head.treeSize, p.auditPath.map(fromB64url), head.rootHash)) break
        if (attempt + 1 >= HEADS_BEFORE_ALERT) {
          deps.alert({ kind: 'bad_proof', detail: `no inclusion proof for KT entry ${index}` })
          throw new CryptoError('InvalidChain', `bad inclusion proof for KT entry ${index}`)
        }
        await nextHead()
        head = await covering(index)
      }
      proven.set(index, leaf)
    },

    async gossip(groupKey) {
      const now = deps.now()
      const last = lastGossip.get(groupKey)
      if (last !== undefined && now - last < KT_GOSSIP_MIN_INTERVAL_MS) return null
      const s = await state()
      if (s.treeHead === null) return null
      lastGossip.set(groupKey, now)
      return s.treeHead
    },
  }
}
