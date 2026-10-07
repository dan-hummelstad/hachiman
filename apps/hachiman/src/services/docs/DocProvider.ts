/**
 * The Yjs provider of one open page (contract §4 Pages, §6 op 5, §12.20). The server sees only
 * envelopes, so this provider does the work that y-websocket does on a server:
 *
 * - Load: the newest snapshot (the doc_snapshot pointer, then the §12.9 blob from /files), then the
 *   updates after its baseSeq. `applied` is the highest seq up to which every update is in the doc.
 * - Send: local updates merge for BATCH_MS (Y.mergeUpdates), then go out as one doc_update. An
 *   update that does not fit in an envelope goes into a snapshot instead (§12.20 "Send").
 * - Receive: DOC_UPDATE is ephemeral (not in the resume buffer). A seq gap reads the missing
 *   updates with GET /pages/:pageId/updates?after=. Yjs ignores an update that it already has.
 * - Snapshot: when more than SNAPSHOT_EVERY updates follow the newest snapshot, or when the
 *   snapshot or an update after it is of an older epoch (or group) than the current one, so that a
 *   member who joined later can read the page. A page with no update after its snapshot gets its
 *   pointer re-wrapped instead (envelopes.ts).
 * - Waiting (no key for the snapshot or for an update): a slow retry that loads the state again,
 *   until a member re-wraps the pointer or posts a snapshot that covers the update.
 * - Awareness: DocAwareness.ts.
 *
 * Plain dependencies, so the provider is testable without a Worker, a server or a gateway.
 */
import * as Y from 'yjs'
import {
  RestError,
  type DocAwarenessRequest,
  type DocSnapshot,
  type DocUpdate,
  type RestClient
} from '@hachiman/client'
import type { CryptoApi, DocDecryptResult, DocSnapshotPointer } from '@hachiman/crypto'
import type { DocPeer } from '@/stores/docsStore'
import { createDocAwareness, createMutedAwareness } from './DocAwareness'
import { isStale, openPointer, rewrapPointer } from './envelopes'
import type { DocProvider, DocStatus } from './types'

/** The transaction origin of remote updates. Local edits have any other origin. */
const REMOTE = 'remote'
export const BATCH_MS = 100
/** More updates than this after the newest snapshot give a new snapshot. */
export const SNAPSHOT_EVERY = 200
/** A random delay before a snapshot, so that the members online do not all post one at once. */
const SNAPSHOT_JITTER_MS = 2000
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000] as const
/** No key: the first retry after a random 10 to 30 s, then after twice the last wait, at most 5 min. */
const WAIT_RETRY_MS = [10_000, 30_000] as const
const WAIT_RETRY_MAX_MS = 300_000
const PAGE_LIMIT = 500
const DECRYPT_BATCH = 100

/** The bytes of an empty Yjs update: it gives a seq to a local update that only a snapshot holds. */
const EMPTY_UPDATE = Y.encodeStateAsUpdate(new Y.Doc())

type Item = Pick<DocUpdate, 'seq' | 'groupId' | 'epoch' | 'senderDevice' | 'envelope'>
type GroupEpoch = { groupId: string; epoch: number }

export interface DocProviderDeps {
  rest: Pick<
    RestClient,
    | 'getPageState'
    | 'getPageUpdates'
    | 'postPageUpdate'
    | 'postPageSnapshot'
    | 'uploadSnapshot'
    | 'fetchBlob'
  >
  /** The crypto Worker. Throws while it is not ready. */
  crypto(): Pick<
    CryptoApi,
    'encryptDoc' | 'decryptDoc' | 'encryptAttachment' | 'decryptAttachment' | 'ensureChannelGroup'
  >
  sendAwareness(d: DocAwarenessRequest): void
  /** This device: its own awareness frames come back and are ignored. */
  deviceId(): string | null
  /** The awareness `user` field of this client (y-prosemirror draws `name` and `color`). */
  me(): { userId: string; name: string; color: string } | null
  /** True when the gateway is 'ready'. */
  online(): boolean
  setPresence(pageId: string, peers: DocPeer[]): void
  /** The page_media upload ids that the doc references (POST snapshots `mediaUploadIds`). */
  collectMediaUploadIds(doc: Y.Doc): string[]
  /** Local edits of this page reached the server (the page activity post, N21). */
  onLocalEdit?(channelId: string, pageId: string): void
  random?(): number
}

const utf8 = new TextEncoder()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** The error code of a RestError or of a Worker error (EnvelopeTooLarge). */
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code
const statusOf = (e: unknown): number | null => (e instanceof RestError ? e.status : null)

export function createDocProvider(
  channelId: string,
  pageId: string,
  deps: DocProviderDeps,
  /**
   * headless: a provider that nobody views (the re-wrap pass): no awareness frames and no snapshot
   * jitter.
   */
  opts: { headless?: boolean } = {}
): DocProvider {
  const doc = new Y.Doc()
  const listeners = new Set<(status: DocStatus) => void>()
  const random = deps.random ?? Math.random
  let status: DocStatus = 'loading'
  let destroyed = false

  let loaded = false
  let applied = 0
  let known = 0
  const inbox = new Map<number, Item>()
  /** Seqs of updates that this provider posted: their content is in the doc already. */
  const own = new Set<number>()
  let tail: Promise<unknown> = Promise.resolve()
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** The last slow retry wait while a key is missing (0: none since the last catch-up). */
  let lastWait = 0
  /** The last drain stopped at an update without a key: resync loads the state again. */
  let blocked = false

  // Snapshot state: the newest snapshot and the group epochs of the updates after it.
  let snapBase = 0
  let snapEpoch: GroupEpoch | null = null
  /**
   * The newest snapshot row that this provider read or posted. When set, its baseSeq is snapBase.
   * null after a SnapshotConflict, whose row is not known here.
   */
  let snapRow: DocSnapshot | null = null
  let chain: (GroupEpoch & { seq: number })[] = []
  let current: GroupEpoch | null = null
  let snapshotRun: Promise<void> | null = null
  let forceSnapshot = false
  let canWrite = true

  let queue: Uint8Array[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let sending = false
  let sendRetries = 0

  const aware = opts.headless
    ? createMutedAwareness(doc)
    : createDocAwareness(doc, channelId, pageId, deps, () => loaded)

  const setStatus = (next: DocStatus): void => {
    if (status === next || destroyed) return
    status = next
    for (const cb of listeners) cb(next)
    if (next === 'ready') {
      scheduleFlush(0)
      void maybeSnapshot()
    }
  }

  /** Runs `task` after the earlier ones: load, drain and catch-up never overlap. */
  const run = (task: () => Promise<unknown>): Promise<void> => {
    const p = tail.then(() => (destroyed ? undefined : task()))
    tail = p.catch((e: unknown) => {
      console.warn('[docs] page sync failed', codeOf(e) ?? e)
      if (!destroyed && !loaded && status === 'loading') setStatus('error')
      // A deleted page or no access: the next resync (READY, new keys) tries again.
      if (statusOf(e) === 403 || statusOf(e) === 404) return
      // The reload of a page that waits for a key reads the snapshot blob again: it backs off.
      if (blocked) scheduleWait()
      else scheduleRetry()
    })
    return tail.then(() => undefined)
  }

  const scheduleRetry = (ms: number = RETRY_MS[1]): void => {
    if (retryTimer || destroyed) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void resync()
    }, ms)
  }

  const noteCurrent = (g: GroupEpoch): void => {
    if (!current || (g.groupId === current.groupId && g.epoch > current.epoch)) current = g
  }

  const ready = (): void => setStatus(deps.online() ? 'ready' : 'offline')

  /** A slow retry while a key is missing. A nudge while one is due changes nothing. */
  const scheduleWait = (): void => {
    if (retryTimer || destroyed) return
    const [min, max] = WAIT_RETRY_MS
    lastWait =
      lastWait === 0 ? min + random() * (max - min) : Math.min(WAIT_RETRY_MAX_MS, lastWait * 2)
    scheduleRetry(lastWait)
  }

  /**
   * Waiting for keys (§12.20 "Access by new members") or for a retry. A re-wrap or a snapshot by a
   * member sends no event to this page, so the page retries slowly (and on PAGE_UPDATE,
   * pageChanged). A page that shows its content stays 'ready' while it waits.
   */
  const onPending = (reason: Extract<DocDecryptResult, { status: 'pending' }>['reason']): void => {
    if (reason !== 'no_history_key' && reason !== 'group_unknown') return scheduleRetry()
    blocked = true
    if (!loaded || status === 'loading') setStatus('waiting')
    scheduleWait()
  }

  /** Applies the updates after `applied` in seq order, reading gaps from REST. False when it stopped. */
  async function drain(): Promise<boolean> {
    blocked = false
    for (;;) {
      if (destroyed) return false
      while (own.has(applied + 1)) {
        own.delete(applied + 1)
        inbox.delete(applied + 1)
        applied++
      }
      const batch: Item[] = []
      for (let s = applied + 1; batch.length < DECRYPT_BATCH && !own.has(s); s++) {
        const u = inbox.get(s)
        if (!u) break
        batch.push(u)
      }
      if (batch.length === 0) {
        if (applied < known && (await fetchTail())) continue
        lastWait = 0
        return true
      }
      const results = await deps.crypto().decryptDoc(
        batch.map((u) => ({
          id: String(u.seq),
          channelId,
          pageId,
          kind: 'doc_update' as const,
          senderDevice: u.senderDevice,
          envelope: u.envelope
        }))
      )
      if (destroyed) return false
      for (const [i, u] of batch.entries()) {
        const r = results[i]
        if (!r || r.status === 'pending') {
          onPending(r?.reason ?? 'transport')
          return false
        }
        if (r.status === 'ok') {
          try {
            Y.applyUpdate(doc, r.bytes, REMOTE)
          } catch (e) {
            console.warn('[docs] update %d does not apply', u.seq, e)
          }
        } else console.warn('[docs] update %d dropped: %s', u.seq, r.reason)
        inbox.delete(u.seq)
        applied = u.seq
        chain.push({ seq: u.seq, groupId: u.groupId, epoch: u.epoch })
        noteCurrent(u)
      }
    }
  }

  /** GET updates after `applied`. False when the server has none (latestSeq is the truth then). */
  async function fetchTail(): Promise<boolean> {
    const page = await deps.rest.getPageUpdates(pageId, { after: applied, limit: PAGE_LIMIT })
    known = page.latestSeq
    let added = false
    for (const u of page.updates) {
      if (u.seq <= applied) continue
      inbox.set(u.seq, u)
      added = true
    }
    return added
  }

  /** The first load, and the reload of a blocked page: a newer snapshot can cover its update. */
  async function load(): Promise<void> {
    const state = await deps.rest.getPageState(pageId)
    if (destroyed) return
    known = Math.max(known, state.latestSeq)
    const snap = state.snapshot
    // A reload applies only a snapshot that holds more than the doc.
    if (snap && (!loaded || snap.baseSeq > applied)) {
      const o = await openPointer(deps.crypto(), channelId, pageId, snap)
      if (destroyed) return
      if (o.status === 'pending') return onPending(o.reason)
      if (o.status === 'bad') {
        console.warn('[docs] snapshot dropped:', o.reason)
        if (!loaded) return setStatus('error')
        // A page that is loaded skips the bad snapshot and stays as it is: it waits for the next one.
        return scheduleWait()
      }
      const blob = await deps.rest.fetchBlob(snap.key)
      const plain = await deps.crypto().decryptAttachment(
        {
          key: o.pointer.fileKey,
          sha256: o.pointer.sha256,
          mime: 'application/octet-stream',
          size: o.pointer.size
        },
        blob
      )
      const bytes = new Uint8Array(await plain.arrayBuffer())
      if (destroyed) return
      Y.applyUpdate(doc, bytes, REMOTE)
      applied = Math.max(applied, snap.baseSeq)
      adoptSnapshot(snap)
    }
    loaded = true
    // The doc holds every update up to `applied` now: the drain goes on after it.
    for (const s of inbox.keys()) if (s <= applied) inbox.delete(s)
    for (const s of own) if (s <= applied) own.delete(s)
    for (const u of state.updates) if (u.seq > applied) inbox.set(u.seq, u)
    if (await drain()) await settle()
  }

  /** Caught up: the current epoch, then 'ready' (which flushes and checks the snapshot rules). */
  async function settle(): Promise<void> {
    try {
      const g = await deps.crypto().ensureChannelGroup(channelId)
      if (g.epoch !== null) current = { groupId: g.groupId, epoch: g.epoch }
    } catch (e) {
      console.warn('[docs] channel group unknown', codeOf(e) ?? e)
    }
    if (destroyed) return
    ready()
    aware.announce()
    void maybeSnapshot()
  }

  function resync(): Promise<void> {
    return run(async () => {
      if (!loaded || blocked) return load()
      await fetchTail()
      if (await drain()) await settle()
    })
  }

  // MARK: - Send

  const scheduleFlush = (ms: number): void => {
    if (flushTimer || destroyed || queue.length === 0) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, ms)
  }

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return
    queue.push(update)
    scheduleFlush(BATCH_MS)
  })

  async function flush(): Promise<void> {
    if (sending || queue.length === 0 || !canWrite) return
    if (status !== 'ready' && !destroyed) return // edits wait for the catch-up (setStatus flushes)
    sending = true
    const parts = queue
    queue = []
    let next: number = BATCH_MS
    try {
      await sendParts(parts)
      sendRetries = 0
      deps.onLocalEdit?.(channelId, pageId)
    } catch (e) {
      queue = [...parts, ...queue]
      if (statusOf(e) === 403) {
        canWrite = false
        console.warn('[docs] this page is read-only for me')
      } else {
        next = RETRY_MS[Math.min(sendRetries++, RETRY_MS.length - 1)]
        console.warn('[docs] send failed, retry in %d ms', next, codeOf(e) ?? e)
      }
    } finally {
      sending = false
    }
    scheduleFlush(next)
  }

  async function sendParts(parts: Uint8Array[]): Promise<void> {
    try {
      await postUpdate(Y.mergeUpdates(parts))
    } catch (e) {
      if (codeOf(e) !== 'TooLarge' && codeOf(e) !== 'EnvelopeTooLarge') throw e
      if (parts.length > 1) {
        for (const p of parts) await sendParts([p])
        return
      }
      // One update that does not fit an envelope: it goes into a snapshot (§12.20 "Send").
      forceSnapshot = true
      void maybeSnapshot()
    }
  }

  async function postUpdate(bytes: Uint8Array): Promise<void> {
    const out = await deps.crypto().encryptDoc({ channelId, pageId, kind: 'doc_update', bytes })
    noteCurrent(out)
    const { seq } = await deps.rest.postPageUpdate(pageId, { envelope: out.envelope })
    known = Math.max(known, seq)
    if (seq > applied) own.add(seq)
    chain.push({ seq, groupId: out.groupId, epoch: out.epoch })
    void run(async () => {
      if (await drain()) void maybeSnapshot()
    })
  }

  // MARK: - Snapshots

  const needsSnapshot = (): boolean => {
    if (forceSnapshot || applied - snapBase > SNAPSHOT_EVERY) return true
    const cur = current
    if (cur === null || (applied === 0 && snapEpoch === null)) return false
    return (
      (snapEpoch !== null && isStale(snapEpoch, cur)) ||
      chain.some((c) => c.seq > snapBase && isStale(c, cur))
    )
  }

  /** Resolves when the snapshot that runs (if any) is done. */
  function maybeSnapshot(): Promise<void> {
    if (snapshotRun) return snapshotRun
    if (!loaded || !canWrite || status !== 'ready' || !needsSnapshot()) return Promise.resolve()
    snapshotRun = snapshot().finally(() => {
      snapshotRun = null
    })
    return snapshotRun
  }

  /**
   * Takes `row` as the newest snapshot. A row older than the one held (a reply that a reload
   * overtook) changes nothing.
   */
  function adoptSnapshot(row: DocSnapshot): void {
    if (row.baseSeq < snapBase) return
    snapRow = row
    snapBase = row.baseSeq
    snapEpoch = { groupId: row.groupId, epoch: row.epoch }
    noteCurrent(snapEpoch)
    chain = chain.filter((c) => c.seq > snapBase)
  }

  /** An idle page: the pointer of the newest snapshot again, in the current epoch (§12.20). */
  async function rewrapIdle(): Promise<void> {
    const snap = snapRow ?? (await deps.rest.getPageState(pageId)).snapshot
    if (destroyed || snap?.baseSeq !== snapBase) return
    const row = await rewrapPointer(deps.crypto(), deps.rest, channelId, snap)
    // null: another member was first, or the pointer does not open here. Both end the attempt.
    if (row) adoptSnapshot(row)
    else snapEpoch = current
  }

  async function snapshot(): Promise<void> {
    try {
      if (!opts.headless) await sleep(random() * SNAPSHOT_JITTER_MS)
      if (destroyed || status !== 'ready' || !needsSnapshot()) return
      if (applied <= snapBase) {
        if (!forceSnapshot) return await rewrapIdle()
        // baseSeq must be above the newest snapshot. An update too large for an envelope gets a
        // seq from an empty update first.
        await postUpdate(EMPTY_UPDATE)
        await tail
        if (applied <= snapBase) return
      }
      const baseSeq = applied
      const state = Y.encodeStateAsUpdate(doc)
      const mediaUploadIds = deps.collectMediaUploadIds(doc)
      const crypto = deps.crypto()
      const enc = await crypto.encryptAttachment({
        file: new Blob([state as Uint8Array<ArrayBuffer>]),
        name: 'page',
        mime: 'application/octet-stream',
        width: null,
        height: null,
        durationMs: null,
        blurhash: null,
        thumbnail: null
      })
      const upload = await deps.rest.uploadSnapshot(enc.blob)
      const pointer: DocSnapshotPointer = {
        uploadId: upload.id,
        fileKey: enc.draft.key,
        sha256: enc.draft.sha256,
        size: enc.draft.size
      }
      const out = await crypto.encryptDoc({
        channelId,
        pageId,
        kind: 'doc_snapshot',
        bytes: utf8.encode(JSON.stringify(pointer))
      })
      noteCurrent(out)
      try {
        adoptSnapshot(
          await deps.rest.postPageSnapshot(pageId, {
            baseSeq,
            uploadId: upload.id,
            envelope: out.envelope,
            mediaUploadIds
          })
        )
        forceSnapshot = false
      } catch (e) {
        if (codeOf(e) !== 'SnapshotConflict') throw e
        // Another member was first. Its upload wins; mine stays unclaimed for the sweep. Its row is
        // not known here: rewrapIdle reads it again.
        const theirs = e instanceof RestError ? e.details.baseSeq : undefined
        if (typeof theirs === 'number') snapBase = Math.max(snapBase, theirs)
        snapRow = null
        snapEpoch = current
        chain = chain.filter((c) => c.seq > snapBase)
      }
    } catch (e) {
      if (statusOf(e) === 403) canWrite = false
      console.warn('[docs] snapshot failed', codeOf(e) ?? e)
    }
  }

  void run(load)

  return {
    channelId,
    pageId,
    doc,
    awareness: aware.awareness,
    get status() {
      return status
    },
    pageChanged() {
      if (blocked || status === 'waiting') void resync()
    },
    onStatus(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    receiveUpdate(u) {
      if (destroyed || u.seq <= applied) return
      inbox.set(u.seq, u)
      known = Math.max(known, u.seq)
      if (loaded) void run(drain)
    },
    receiveAwareness: aware.receive,
    resync,
    async snapshotIfNeeded() {
      // The load and any queued drain end first.
      await run(async () => {})
      await maybeSnapshot()
    },
    markOffline() {
      if (status === 'ready') setStatus('offline')
    },
    destroy() {
      if (destroyed) return
      if (flushTimer) clearTimeout(flushTimer)
      if (retryTimer) clearTimeout(retryTimer)
      flushTimer = retryTimer = null
      destroyed = true
      // The last edits still go out; the doc is gone after this.
      if (queue.length > 0 && canWrite && !sending && loaded) void flush()
      listeners.clear()
      aware.destroy()
      doc.destroy() // destroys the awareness too, which sends the null state
    }
  }
}
