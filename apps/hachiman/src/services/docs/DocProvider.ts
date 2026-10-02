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
 *   member who joined later can read the page.
 * - Awareness: y-protocols states as doc_awareness envelopes over op 5, at most one per
 *   AWARENESS_MS, and again every HEARTBEAT_MS. y-protocols drops a peer after 30 s. A frame
 *   from a new peer gets my state back, so a new viewer sees everyone at once.
 *
 * Plain dependencies, so the provider is testable without a Worker, a server or a gateway.
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { DocAwarenessRequest, DocUpdate, RestClient } from '@hachiman/client'
import type { CryptoApi, DocDecryptResult, DocSnapshotPointer } from '@hachiman/crypto'
import type { DocPeer } from '@/stores/docsStore'
import type { DocProvider, DocStatus } from './types'

/** The transaction origin of remote updates. Local edits have any other origin. */
export const REMOTE = 'remote'
export const BATCH_MS = 100
export const AWARENESS_MS = 100
export const HEARTBEAT_MS = 15_000
/** More updates than this after the newest snapshot give a new snapshot. */
export const SNAPSHOT_EVERY = 200
/** A random delay before a snapshot, so that the members online do not all post one at once. */
export const SNAPSHOT_JITTER_MS = 2000
export const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000] as const
const PAGE_LIMIT = 500
const DECRYPT_BATCH = 100

/** The bytes of an empty Yjs update: it advances seq for a re-encrypt snapshot of an idle page. */
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
  collectMediaUploadIds?(doc: Y.Doc): string[]
  random?(): number
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder('utf-8', { fatal: true })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code
const statusOf = (e: unknown): unknown => (e as { status?: unknown } | null)?.status
const isStale = (g: GroupEpoch, current: GroupEpoch): boolean =>
  g.groupId !== current.groupId || g.epoch < current.epoch

/** The client ids of a y-protocols awareness update (varUint count, then id, clock, state each). */
export function awarenessClientIds(update: Uint8Array): number[] {
  let pos = 0
  const varUint = (): number => {
    let n = 0
    let mult = 1
    for (;;) {
      const b = update[pos++]
      if (b === undefined) throw new Error('awareness update: truncated')
      n += (b & 0x7f) * mult
      if (b < 0x80) return n
      mult *= 128
      if (mult > 2 ** 53) throw new Error('awareness update: varUint too long')
    }
  }
  const ids: number[] = []
  for (let count = varUint(); count > 0; count--) {
    ids.push(varUint())
    varUint()
    pos += varUint()
    if (pos > update.length) throw new Error('awareness update: truncated')
  }
  return ids
}

function parsePointer(bytes: Uint8Array): DocSnapshotPointer | null {
  try {
    const p = JSON.parse(fromUtf8.decode(bytes)) as Partial<DocSnapshotPointer> | null
    return p &&
      typeof p.uploadId === 'string' &&
      typeof p.fileKey === 'string' &&
      typeof p.sha256 === 'string' &&
      typeof p.size === 'number'
      ? (p as DocSnapshotPointer)
      : null
  } catch {
    return null
  }
}

function peerOf(clientId: number, state: unknown, userId: string | undefined): DocPeer | null {
  const user = (state as { user?: { name?: unknown; color?: unknown } } | null)?.user
  if (!userId || !user) return null
  return {
    clientId,
    userId,
    name: typeof user.name === 'string' ? user.name.slice(0, 64) : '',
    color:
      typeof user.color === 'string' && /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#888888'
  }
}

export function createDocProvider(
  channelId: string,
  pageId: string,
  deps: DocProviderDeps
): DocProvider {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const listeners = new Set<(status: DocStatus) => void>()
  const random = deps.random ?? Math.random
  let status: DocStatus = 'loading'
  let destroyed = false

  // Receive state.
  let loaded = false
  let applied = 0
  let known = 0
  const inbox = new Map<number, Item>()
  /** Seqs of updates that this provider posted: their content is in the doc already. */
  const own = new Set<number>()
  let tail: Promise<unknown> = Promise.resolve()
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  // Snapshot state: the newest snapshot and the group epochs of the updates after it.
  let snapBase = 0
  let snapEpoch: GroupEpoch | null = null
  let chain: (GroupEpoch & { seq: number })[] = []
  let current: GroupEpoch | null = null
  let snapshotting = false
  let forceSnapshot = false
  let canWrite = true

  // Send state.
  let queue: Uint8Array[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let sending = false
  let sendRetries = 0

  // Awareness state.
  let lastAwareness = -Infinity
  let awarenessTimer: ReturnType<typeof setTimeout> | null = null
  const peerUsers = new Map<number, string>()
  // Renewing the local state also keeps y-protocols from renewing it on its own clock.
  const heartbeat = setInterval(() => {
    if (loaded && !destroyed) awareness.setLocalState(awareness.getLocalState())
  }, HEARTBEAT_MS)

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
      if (statusOf(e) !== 403 && statusOf(e) !== 404) scheduleRetry()
    })
    return tail.then(() => undefined)
  }

  const scheduleRetry = (): void => {
    if (retryTimer || destroyed) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void resync()
    }, RETRY_MS[1])
  }

  const noteCurrent = (g: GroupEpoch): void => {
    if (!current || (g.groupId === current.groupId && g.epoch > current.epoch)) current = g
  }

  const ready = (): void => setStatus(deps.online() ? 'ready' : 'offline')

  /** Waiting for keys (§12.20 "Access by new members") or for a retry. */
  const onPending = (reason: Extract<DocDecryptResult, { status: 'pending' }>['reason']): void => {
    if (reason === 'no_history_key' || reason === 'group_unknown') {
      if (status === 'loading' || status === 'waiting' || !loaded) setStatus('waiting')
      return
    }
    scheduleRetry()
  }

  /** Applies the updates after `applied` in seq order, reading gaps from REST. False when it stopped. */
  async function drain(): Promise<boolean> {
    for (;;) {
      if (destroyed) return false
      while (own.has(applied + 1)) {
        own.delete(applied + 1)
        inbox.delete(applied + 1)
        applied++
      }
      const batch: Item[] = []
      for (let s = applied + 1; inbox.has(s) && !own.has(s) && batch.length < DECRYPT_BATCH; s++)
        batch.push(inbox.get(s) as Item)
      if (batch.length === 0) {
        if (applied >= known) return true
        if (!(await fetchTail())) return true
        continue
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

  async function load(): Promise<void> {
    const state = await deps.rest.getPageState(pageId)
    if (destroyed) return
    known = state.latestSeq
    const snap = state.snapshot
    if (snap) {
      const [r] = await deps.crypto().decryptDoc([
        {
          id: 'snapshot',
          channelId,
          pageId,
          kind: 'doc_snapshot',
          senderDevice: snap.senderDevice,
          envelope: snap.envelope
        }
      ])
      if (destroyed) return
      if (!r || r.status === 'pending') return onPending(r?.reason ?? 'transport')
      const pointer = r.status === 'ok' ? parsePointer(r.bytes) : null
      if (!pointer || pointer.uploadId !== snap.uploadId) {
        console.warn('[docs] snapshot dropped:', r.status === 'failed' ? r.reason : 'pointer')
        return setStatus('error')
      }
      const blob = await deps.rest.fetchBlob(snap.key)
      const plain = await deps.crypto().decryptAttachment(
        {
          key: pointer.fileKey,
          sha256: pointer.sha256,
          mime: 'application/octet-stream',
          size: pointer.size
        },
        blob
      )
      const bytes = new Uint8Array(await plain.arrayBuffer())
      if (destroyed) return
      Y.applyUpdate(doc, bytes, REMOTE)
      applied = Math.max(applied, snap.baseSeq)
      snapBase = snap.baseSeq
      snapEpoch = { groupId: snap.groupId, epoch: snap.epoch }
      noteCurrent(snapEpoch)
    }
    loaded = true
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
    sendAwareness()
    void maybeSnapshot()
  }

  function resync(): Promise<void> {
    return run(async () => {
      if (!loaded) return load()
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
    try {
      await sendParts(parts)
      sendRetries = 0
    } catch (e) {
      queue = [...parts, ...queue]
      if (statusOf(e) === 403) {
        canWrite = false
        console.warn('[docs] this page is read-only for me')
      } else {
        const ms = RETRY_MS[Math.min(sendRetries++, RETRY_MS.length - 1)]
        console.warn('[docs] send failed, retry in %d ms', ms, codeOf(e) ?? e)
        sending = false
        if (!destroyed) scheduleFlush(ms)
        return
      }
    } finally {
      sending = false
    }
    scheduleFlush(BATCH_MS)
  }

  async function sendParts(parts: Uint8Array[]): Promise<void> {
    const merged = parts.length === 1 ? (parts[0] as Uint8Array) : Y.mergeUpdates(parts)
    try {
      await postUpdate(merged)
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

  const needsSnapshot = (): boolean =>
    forceSnapshot ||
    applied - snapBase > SNAPSHOT_EVERY ||
    (current !== null &&
      (applied > 0 || snapEpoch !== null) &&
      ((snapEpoch !== null && isStale(snapEpoch, current)) ||
        chain.some((c) => c.seq > snapBase && isStale(c, current as GroupEpoch))))

  async function maybeSnapshot(): Promise<void> {
    if (snapshotting || !loaded || !canWrite || status !== 'ready' || !needsSnapshot()) return
    snapshotting = true
    try {
      await sleep(random() * SNAPSHOT_JITTER_MS)
      if (destroyed || status !== 'ready' || !needsSnapshot()) return
      // baseSeq must be above the newest snapshot: an idle page gets an empty update first.
      if (applied <= snapBase) {
        await postUpdate(EMPTY_UPDATE)
        await tail
        if (applied <= snapBase) return
      }
      const baseSeq = applied
      const state = Y.encodeStateAsUpdate(doc)
      const mediaUploadIds = deps.collectMediaUploadIds?.(doc) ?? []
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
        await deps.rest.postPageSnapshot(pageId, {
          baseSeq,
          uploadId: upload.id,
          envelope: out.envelope,
          mediaUploadIds
        })
        forceSnapshot = false
        snapBase = baseSeq
        snapEpoch = { groupId: out.groupId, epoch: out.epoch }
      } catch (e) {
        if (codeOf(e) !== 'SnapshotConflict') throw e
        // Another member was first. Its upload wins; mine stays unclaimed for the sweep.
        const theirs = (e as { details?: { baseSeq?: unknown } }).details?.baseSeq
        if (typeof theirs === 'number') snapBase = Math.max(snapBase, theirs)
        snapEpoch = current
      }
      chain = chain.filter((c) => c.seq > snapBase)
    } catch (e) {
      if (statusOf(e) === 403) canWrite = false
      console.warn('[docs] snapshot failed', codeOf(e) ?? e)
    } finally {
      snapshotting = false
    }
  }

  // MARK: - Awareness

  const me = deps.me()
  if (me) awareness.setLocalStateField('user', me)

  function sendAwareness(): void {
    if (awarenessTimer) return
    const wait = lastAwareness + AWARENESS_MS - Date.now()
    if (wait > 0) {
      awarenessTimer = setTimeout(() => {
        awarenessTimer = null
        sendAwarenessNow()
      }, wait)
      return
    }
    sendAwarenessNow()
  }

  function sendAwarenessNow(): void {
    // The null state on close goes out once more after `destroyed`.
    const leaving = awareness.getLocalState() === null
    if ((!loaded && !leaving) || !deps.online()) return
    lastAwareness = Date.now()
    const bytes = encodeAwarenessUpdate(awareness, [awareness.clientID])
    let crypto: ReturnType<DocProviderDeps['crypto']>
    try {
      crypto = deps.crypto()
    } catch {
      return
    }
    crypto
      .encryptDoc({ channelId, pageId, kind: 'doc_awareness', bytes })
      .then((out) => deps.sendAwareness({ channelId, pageId, envelope: out.envelope }))
      .catch((e: unknown) => console.warn('[docs] awareness not sent', codeOf(e) ?? e))
  }

  awareness.on(
    'update',
    ({ added }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === 'local') {
        if (awareness.getLocalState() === null) {
          if (awarenessTimer) clearTimeout(awarenessTimer)
          awarenessTimer = null
          sendAwarenessNow()
        } else if (!destroyed) sendAwareness()
      } else if (origin === REMOTE && added.length > 0 && !destroyed) sendAwareness()
    }
  )

  awareness.on('change', () => {
    if (destroyed) return
    const peers: DocPeer[] = []
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue
      const peer = peerOf(clientId, state, peerUsers.get(clientId))
      if (peer) peers.push(peer)
    }
    deps.setPresence(pageId, peers)
  })

  function receiveAwareness(d: { deviceId: string; envelope: string }): void {
    if (destroyed || d.deviceId === deps.deviceId()) return
    let crypto: ReturnType<DocProviderDeps['crypto']>
    try {
      crypto = deps.crypto()
    } catch {
      return
    }
    void crypto
      .decryptDoc([
        {
          id: 'awareness',
          channelId,
          pageId,
          kind: 'doc_awareness',
          senderDevice: d.deviceId,
          envelope: d.envelope
        }
      ])
      .then(([r]) => {
        if (destroyed || r?.status !== 'ok') return
        const ids = awarenessClientIds(r.bytes)
        if (ids.includes(awareness.clientID)) return
        // The name shows from the state, the user id only from the verified sender.
        for (const id of ids) peerUsers.set(id, r.sender.userId)
        applyAwarenessUpdate(awareness, r.bytes, REMOTE)
      })
      .catch((e: unknown) => console.warn('[docs] awareness dropped', codeOf(e) ?? e))
  }

  void run(load)

  return {
    channelId,
    pageId,
    doc,
    awareness,
    get status() {
      return status
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
    receiveAwareness,
    resync,
    markOffline() {
      if (status === 'ready') setStatus('offline')
    },
    destroy() {
      if (destroyed) return
      if (flushTimer) clearTimeout(flushTimer)
      if (retryTimer) clearTimeout(retryTimer)
      if (awarenessTimer) clearTimeout(awarenessTimer)
      flushTimer = retryTimer = awarenessTimer = null
      clearInterval(heartbeat)
      destroyed = true
      // The last edits still go out; the doc is gone after this.
      if (queue.length > 0 && canWrite && !sending && loaded) void flush()
      listeners.clear()
      doc.destroy() // destroys the awareness too, which sends the null state
      deps.setPresence(pageId, [])
    }
  }
}
