import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RestError, type DocSnapshot, type DocUpdate } from '@hachiman/client'
import type { DocDecryptResult, EncryptDocInput } from '@hachiman/crypto'
import { AWARENESS_MS, HEARTBEAT_MS, awarenessClientIds } from './DocAwareness'
import {
  BATCH_MS,
  SNAPSHOT_EVERY,
  createDocProvider,
  observeLabels,
  pageLabels,
  setPageLabels,
  type DocProviderDeps
} from './DocProvider'
import type { DocProvider } from './types'

const CHANNEL = 'c-1'
const PAGE = 'p-1'

/** A fake Worker: an envelope is a handle on the plaintext, with the group epoch of its send. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the fake is its own type
function fakeCrypto(epoch: { current: number }) {
  const sealed = new Map<string, { input: EncryptDocInput; epoch: number }>()
  let n = 0
  const pending = new Set<string>()
  const api = {
    sealed,
    pending,
    encryptDoc: vi.fn(async (input: EncryptDocInput) => {
      const envelope = `env-${++n}`
      sealed.set(envelope, { input, epoch: epoch.current })
      return { envelope, groupId: 'g-1', epoch: epoch.current }
    }),
    decryptDoc: vi.fn(async (items: { id: string; kind: string; envelope: string }[]) =>
      items.map((it): DocDecryptResult => {
        if (pending.has(it.envelope))
          return { status: 'pending', id: it.id, reason: 'no_history_key' }
        const s = sealed.get(it.envelope)
        if (!s || s.input.kind !== it.kind)
          return { status: 'failed', id: it.id, reason: 'malformed' }
        return {
          status: 'ok',
          id: it.id,
          kind: s.input.kind,
          bytes: s.input.bytes,
          sender: {
            userId: 'u-2',
            deviceId: 'd-2',
            leafIndex: 1,
            trust: 'tofu',
            membershipVerified: true
          }
        }
      })
    ),
    encryptAttachment: vi.fn(async (input: { file: Blob }) => ({
      blob: input.file,
      thumbnailBlob: null,
      draft: { key: 'fk', sha256: 'sha', size: input.file.size } as never
    })),
    decryptAttachment: vi.fn(async (_p: unknown, blob: Blob) => blob),
    ensureChannelGroup: vi.fn(async () => ({ groupId: 'g-1', epoch: epoch.current }) as never)
  }
  return api
}

/**
 * A fake Takusen: the update log, the newest snapshot and the uploaded blobs. Snapshots follow the
 * §4 Pages compare-and-set: a baseSeq above the newest one, or a re-wrap of the newest one.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the fake is its own type
function fakeServer(epoch: { current: number }) {
  const updates: DocUpdate[] = []
  const blobs = new Map<string, Blob>()
  let snapshot: DocSnapshot | null = null
  let uploads = 0
  const rest = {
    updates,
    get snapshot() {
      return snapshot
    },
    set snapshot(s: DocSnapshot | null) {
      snapshot = s
    },
    blobs,
    getPageState: vi.fn(async () => {
      const base = snapshot?.baseSeq ?? 0
      return {
        snapshot,
        updates: updates.filter((u) => u.seq > base).slice(0, 500),
        latestSeq: updates.length
      }
    }),
    getPageUpdates: vi.fn(async (_pageId: string, q: { after: number; limit?: number }) => ({
      updates: updates.filter((u) => u.seq > q.after).slice(0, q.limit ?? 200),
      latestSeq: updates.length
    })),
    postPageUpdate: vi.fn(async (_pageId: string, body: { envelope: string }) => {
      const seq = updates.length + 1
      updates.push(row(seq, body.envelope))
      return { seq }
    }),
    postPageSnapshot: vi.fn(
      async (
        _pageId: string,
        body: { baseSeq: number; uploadId: string; envelope: string; mediaUploadIds: string[] }
      ) => {
        const conflict = new RestError(409, 'SnapshotConflict', undefined, {
          baseSeq: snapshot?.baseSeq ?? 0
        })
        if (snapshot && body.baseSeq === snapshot.baseSeq) {
          if (body.uploadId !== snapshot.uploadId || epoch.current <= snapshot.epoch) throw conflict
          snapshot = {
            ...snapshot,
            epoch: epoch.current,
            senderDevice: 'd-1',
            envelope: body.envelope
          }
          return snapshot
        }
        if (body.baseSeq < (snapshot?.baseSeq ?? 1)) throw conflict
        snapshot = {
          pageId: PAGE,
          baseSeq: body.baseSeq,
          uploadId: body.uploadId,
          key: `${body.uploadId}/blob`,
          size: blobs.get(body.uploadId)?.size ?? 0,
          groupId: 'g-1',
          epoch: epoch.current,
          senderDevice: 'd-1',
          envelope: body.envelope,
          mediaUploadIds: body.mediaUploadIds,
          createdAt: ''
        }
        return snapshot
      }
    ),
    uploadSnapshot: vi.fn(async (blob: Blob) => {
      const id = `up-${++uploads}`
      blobs.set(id, blob)
      return { id, key: `${id}/blob`, size: blob.size }
    }),
    fetchBlob: vi.fn(async (key: string) => blobs.get(key.split('/')[0] as string) as Blob)
  }
  return rest
}

const row = (seq: number, envelope: string, epoch = 1): DocUpdate => ({
  pageId: PAGE,
  seq,
  groupId: 'g-1',
  epoch,
  senderDevice: 'd-2',
  envelope,
  createdAt: ''
})

interface Harness {
  crypto: ReturnType<typeof fakeCrypto>
  server: ReturnType<typeof fakeServer>
  epoch: { current: number }
  sent: { envelope: string }[]
  presence: unknown[][]
  open(): DocProvider
}

function harness(
  opts: Partial<DocProviderDeps> = {},
  providerOpts: { headless?: boolean } = {}
): Harness {
  const epoch = { current: 1 }
  const crypto = fakeCrypto(epoch)
  const server = fakeServer(epoch)
  const sent: { envelope: string }[] = []
  const presence: unknown[][] = []
  const deps: DocProviderDeps = {
    rest: server as unknown as DocProviderDeps['rest'],
    crypto: () => crypto as unknown as ReturnType<DocProviderDeps['crypto']>,
    sendAwareness: (d) => sent.push(d),
    deviceId: () => 'd-1',
    me: () => ({ userId: 'u-1', name: 'alice', color: '#112233' }),
    online: () => true,
    setPresence: (_p, peers) => presence.push(peers),
    collectMediaUploadIds: () => [],
    random: () => 0,
    ...opts
  }
  return {
    crypto,
    server,
    epoch,
    sent,
    presence,
    open: () => {
      const p = createDocProvider(CHANNEL, PAGE, deps, providerOpts)
      providers.push(p)
      return p
    }
  }
}

/** Seals a Yjs update the way another member's client does, and appends it to the log. */
async function remoteEdit(h: Harness, text: string, epoch = h.epoch.current): Promise<DocUpdate> {
  const d = new Y.Doc()
  d.getText('t').insert(0, text)
  const saved = h.epoch.current
  h.epoch.current = epoch
  const out = await h.crypto.encryptDoc({
    channelId: CHANNEL,
    pageId: PAGE,
    kind: 'doc_update',
    bytes: Y.encodeStateAsUpdate(d)
  })
  h.epoch.current = saved
  const u = row(h.server.updates.length + 1, out.envelope, epoch)
  h.server.updates.push(u)
  return u
}

/** A snapshot of the updates up to `baseSeq` that this device can read: blob, pointer and row. */
function readableSnapshot(h: Harness, baseSeq: number, uploadId: string): DocSnapshot {
  const parts = h.server.updates
    .filter((u) => u.seq <= baseSeq)
    .map((u) => h.crypto.sealed.get(u.envelope)?.input.bytes as Uint8Array)
  h.server.blobs.set(uploadId, new Blob([Y.mergeUpdates(parts) as Uint8Array<ArrayBuffer>]))
  const envelope = `env-${uploadId}`
  const pointer = { uploadId, fileKey: 'fk', sha256: 'sha', size: 1 }
  h.crypto.sealed.set(envelope, {
    input: {
      channelId: CHANNEL,
      pageId: PAGE,
      kind: 'doc_snapshot',
      bytes: new TextEncoder().encode(JSON.stringify(pointer))
    },
    epoch: h.epoch.current
  })
  return {
    pageId: PAGE,
    baseSeq,
    uploadId,
    key: `${uploadId}/blob`,
    size: 1,
    groupId: 'g-1',
    epoch: h.epoch.current,
    senderDevice: 'd-2',
    envelope,
    mediaUploadIds: [],
    createdAt: ''
  }
}

/** A readable snapshot of seq 1, and an update after it without a key (the old epoch, late). */
async function lateUpdate(h: Harness): Promise<void> {
  await remoteEdit(h, 'a')
  h.server.snapshot = readableSnapshot(h, 1, 'up-x')
  h.crypto.pending.add((await remoteEdit(h, 'b')).envelope)
}

const providers: DocProvider[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const p of providers.splice(0)) p.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('DocProvider', () => {
  it('loads the log and becomes ready', async () => {
    const h = harness()
    await remoteEdit(h, 'a')
    await remoteEdit(h, 'b')
    const p = h.open()
    await settle()
    expect(p.status).toBe('ready')
    expect(p.doc.getText('t').toString()).toHaveLength(2)
  })

  it('batches local edits for 100 ms into one update', async () => {
    const h = harness()
    const p = h.open()
    await settle()
    const text = p.doc.getText('t')
    text.insert(0, 'a')
    await settle(30)
    text.insert(1, 'b')
    await settle(30)
    text.insert(2, 'c')
    expect(h.server.postPageUpdate).not.toHaveBeenCalled()
    await settle(BATCH_MS)
    expect(h.server.postPageUpdate).toHaveBeenCalledTimes(1)
    // The one envelope holds all three edits.
    const env = h.server.updates[0]?.envelope as string
    const other = new Y.Doc()
    Y.applyUpdate(other, h.crypto.sealed.get(env)?.input.bytes as Uint8Array)
    expect(other.getText('t').toString()).toBe('abc')

    text.insert(3, 'd')
    await settle(BATCH_MS)
    expect(h.server.postPageUpdate).toHaveBeenCalledTimes(2)
  })

  it('does not apply its own posted updates again, and remote ones with origin remote', async () => {
    const h = harness()
    const p = h.open()
    await settle()
    p.doc.getText('t').insert(0, 'x')
    await settle(BATCH_MS)
    h.crypto.decryptDoc.mockClear()
    const echo = h.server.updates[0] as DocUpdate
    p.receiveUpdate(echo)
    await settle()
    expect(h.crypto.decryptDoc).not.toHaveBeenCalled()

    const origins: unknown[] = []
    p.doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin))
    p.receiveUpdate(await remoteEdit(h, 'y'))
    await settle()
    expect(origins).toEqual(['remote'])
    // A remote update is not sent back.
    await settle(BATCH_MS)
    expect(h.server.postPageUpdate).toHaveBeenCalledTimes(1)
  })

  it('fills a seq gap from REST', async () => {
    const h = harness()
    await remoteEdit(h, 'a')
    const p = h.open()
    await settle()
    await remoteEdit(h, 'b')
    const third = await remoteEdit(h, 'c')
    h.server.getPageUpdates.mockClear()
    p.receiveUpdate(third)
    await settle()
    expect(h.server.getPageUpdates).toHaveBeenCalledWith(PAGE, { after: 1, limit: 500 })
    expect(p.doc.getText('t').toString()).toHaveLength(3)
  })

  it('reads the tail on resync', async () => {
    const h = harness()
    const p = h.open()
    await settle()
    await remoteEdit(h, 'missed')
    p.markOffline()
    expect(p.status).toBe('offline')
    await p.resync()
    await settle()
    expect(p.status).toBe('ready')
    expect(p.doc.getText('t').toString()).toBe('missed')
  })

  it('posts a snapshot after more than 200 updates, and loads from it', async () => {
    const h = harness()
    for (let i = 0; i <= SNAPSHOT_EVERY; i++) await remoteEdit(h, 'z')
    const p = h.open()
    await settle()
    expect(h.server.uploadSnapshot).toHaveBeenCalledTimes(1)
    expect(h.server.postPageSnapshot).toHaveBeenCalledWith(PAGE, {
      baseSeq: SNAPSHOT_EVERY + 1,
      uploadId: 'up-1',
      envelope: expect.any(String),
      mediaUploadIds: []
    })
    // A second client loads the snapshot and no update.
    const q = h.open()
    await settle()
    expect(q.status).toBe('ready')
    expect(q.doc.getText('t').toString()).toBe(p.doc.getText('t').toString())
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
  })

  it('posts a snapshot when the log is of an older epoch than the group', async () => {
    const h = harness()
    await remoteEdit(h, 'old', 1)
    h.epoch.current = 2
    h.open()
    await settle()
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
    expect(h.server.snapshot?.baseSeq).toBe(1)
  })

  it('re-wraps the pointer of an idle page: no update and no upload', async () => {
    const h = harness()
    await remoteEdit(h, 'old', 1)
    h.epoch.current = 2
    const p = h.open()
    await settle()
    // The snapshot is of epoch 2; epoch 3 makes it stale with no update after it.
    expect(h.server.snapshot?.epoch).toBe(2)
    h.server.postPageSnapshot.mockClear()
    h.epoch.current = 3
    const q = h.open()
    await settle()
    expect(q.status).toBe('ready')
    expect(h.server.updates).toHaveLength(1)
    expect(h.server.uploadSnapshot).toHaveBeenCalledTimes(1)
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
    expect(h.server.snapshot).toMatchObject({ baseSeq: 1, uploadId: 'up-1', epoch: 3 })
    // The same pointer bytes, in a new envelope of epoch 3.
    const env = h.server.snapshot?.envelope as string
    expect(h.crypto.sealed.get(env)?.epoch).toBe(3)
    const first = [...h.crypto.sealed.values()].find((x) => x.input.kind === 'doc_snapshot')
    expect(h.crypto.sealed.get(env)?.input.bytes).toEqual(first?.input.bytes)
    // The first provider learns the epoch from the gateway (resync): another member was first.
    await p.resync()
    await settle(2000)
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(2)
    expect(h.server.snapshot?.envelope).toBe(env)
  })

  it('waits when the snapshot has no key on this device', async () => {
    const h = harness()
    await remoteEdit(h, 'a')
    h.open()
    await settle()
    const env = h.server.snapshot?.envelope
    expect(env).toBeUndefined()
    // A snapshot that this device cannot read yet.
    h.server.snapshot = {
      pageId: PAGE,
      baseSeq: 1,
      uploadId: 'up-x',
      key: 'up-x/blob',
      size: 1,
      groupId: 'g-1',
      epoch: 1,
      senderDevice: 'd-2',
      envelope: 'env-locked',
      mediaUploadIds: [],
      createdAt: ''
    }
    h.crypto.pending.add('env-locked')
    const q = h.open()
    await settle()
    expect(q.status).toBe('waiting')
    // The keys arrive: resync loads again.
    h.crypto.pending.clear()
    h.crypto.sealed.set('env-locked', {
      input: {
        channelId: CHANNEL,
        pageId: PAGE,
        kind: 'doc_snapshot',
        bytes: new TextEncoder().encode(
          JSON.stringify({ uploadId: 'up-x', fileKey: 'fk', sha256: 'sha', size: 1 })
        )
      },
      epoch: 1
    })
    const state = new Y.Doc()
    state.getText('t').insert(0, 'S')
    h.server.blobs.set('up-x', new Blob([Y.encodeStateAsUpdate(state) as Uint8Array<ArrayBuffer>]))
    await q.resync()
    await settle()
    expect(q.status).toBe('ready')
    expect(q.doc.getText('t').toString()).toBe('S')
  })

  it('a waiting page retries on its own, with a growing wait', async () => {
    const h = harness()
    h.server.snapshot = {
      pageId: PAGE,
      baseSeq: 1,
      uploadId: 'up-x',
      key: 'up-x/blob',
      size: 1,
      groupId: 'g-1',
      epoch: 1,
      senderDevice: 'd-2',
      envelope: 'env-locked',
      mediaUploadIds: [],
      createdAt: ''
    }
    h.crypto.pending.add('env-locked')
    const q = h.open()
    await settle()
    expect(q.status).toBe('waiting')
    const reads = (): number => h.server.getPageState.mock.calls.length
    expect(reads()).toBe(1)
    await settle(10_000)
    expect(reads()).toBe(2)
    // The second wait is twice the first.
    await settle(10_000)
    expect(reads()).toBe(2)
    await settle(10_000)
    expect(reads()).toBe(3)
    // A member re-wrapped the pointer: the next retry opens the page.
    h.crypto.pending.clear()
    h.crypto.sealed.set('env-locked', {
      input: {
        channelId: CHANNEL,
        pageId: PAGE,
        kind: 'doc_snapshot',
        bytes: new TextEncoder().encode(
          JSON.stringify({ uploadId: 'up-x', fileKey: 'fk', sha256: 'sha', size: 1 })
        )
      },
      epoch: 1
    })
    h.server.blobs.set(
      'up-x',
      new Blob([Y.encodeStateAsUpdate(new Y.Doc()) as Uint8Array<ArrayBuffer>])
    )
    await settle(40_000)
    expect(q.status).toBe('ready')
  })

  it('a page that waits for an update after its snapshot opens when a newer snapshot covers it', async () => {
    const h = harness()
    await lateUpdate(h)
    const q = h.open()
    await settle()
    expect(q.status).toBe('waiting')
    const reads = (): number => h.server.getPageState.mock.calls.length
    expect(reads()).toBe(1)
    // Each retry loads the state again and arms the next one, twice the last wait.
    await settle(10_000)
    expect(reads()).toBe(2)
    expect(q.status).toBe('waiting')
    await settle(19_999)
    expect(reads()).toBe(2)
    await settle(1)
    expect(reads()).toBe(3)
    // The snapshot that the page has already is not read again.
    expect(h.server.fetchBlob).toHaveBeenCalledTimes(1)
    // A member posts a snapshot that covers the update: the next retry opens the page.
    h.server.snapshot = readableSnapshot(h, 2, 'up-y')
    await settle(40_000)
    expect(q.status).toBe('ready')
    expect(q.doc.getText('t').toString()).toHaveLength(2)
    // The drain goes on after the covered seq.
    q.receiveUpdate(await remoteEdit(h, 'c'))
    await settle()
    expect(q.doc.getText('t').toString()).toHaveLength(3)
  })

  it('a nudge while a retry is due does not make the next wait longer', async () => {
    const h = harness()
    await lateUpdate(h)
    const q = h.open()
    await settle()
    const reads = (): number => h.server.getPageState.mock.calls.length
    await settle(5_000)
    // PAGE_UPDATE, new epoch keys, RESUMED: each one loads the state again.
    await q.resync()
    await q.resync()
    await q.resync()
    expect(reads()).toBe(4)
    await settle(5_000)
    expect(reads()).toBe(5)
    // Twice the first wait.
    await settle(20_000)
    expect(reads()).toBe(6)
  })

  it('a ready page with an update without a key loads again when a snapshot covers it', async () => {
    const h = harness()
    await remoteEdit(h, 'a')
    const q = h.open()
    await settle()
    expect(q.status).toBe('ready')
    const late = await remoteEdit(h, 'b')
    h.crypto.pending.add(late.envelope)
    q.receiveUpdate(late)
    q.receiveUpdate(await remoteEdit(h, 'c'))
    await settle()
    // The page shows what it has, and the updates after the one without a key wait.
    expect(q.status).toBe('ready')
    expect(q.doc.getText('t').toString()).toBe('a')
    // PAGE_UPDATE loads it again. The retry that is due keeps its time.
    const reads = (): number => h.server.getPageState.mock.calls.length
    const before = reads()
    q.pageChanged()
    await settle()
    expect(reads()).toBe(before + 1)
    h.server.snapshot = readableSnapshot(h, 2, 'up-y')
    await settle(10_000)
    expect(q.status).toBe('ready')
    expect(q.doc.getText('t').toString()).toHaveLength(3)
    // Caught up: PAGE_UPDATE changes nothing.
    const after = reads()
    q.pageChanged()
    await settle()
    expect(reads()).toBe(after)
  })

  it('a loaded page skips a newer snapshot that does not open, and stays usable', async () => {
    const h = harness()
    await remoteEdit(h, 'a')
    const q = h.open()
    await settle()
    const late = await remoteEdit(h, 'b')
    h.crypto.pending.add(late.envelope)
    q.receiveUpdate(late)
    await settle()
    expect(q.status).toBe('ready')
    // A newer snapshot whose pointer names another upload than its row.
    h.server.snapshot = { ...readableSnapshot(h, 2, 'up-y'), uploadId: 'up-other' }
    const reads = (): number => h.server.getPageState.mock.calls.length
    await q.resync()
    expect(reads()).toBe(2)
    expect(q.status).toBe('ready')
    expect(h.server.fetchBlob).not.toHaveBeenCalled()
    // Local edits still go out.
    q.doc.getText('t').insert(0, 'x')
    await settle(BATCH_MS)
    expect(h.server.postPageUpdate).toHaveBeenCalledTimes(1)
    // No fast retry: the first slow retry is 10 s after the update without a key.
    await settle(9_000)
    expect(reads()).toBe(2)
    await settle(1_000)
    expect(reads()).toBe(3)
    expect(q.status).toBe('ready')
    // It still waits for the key: PAGE_UPDATE loads it again.
    q.pageChanged()
    await settle()
    expect(reads()).toBe(4)
  })

  it('a ready page that waits for no key ignores pageChanged', async () => {
    const h = harness()
    await remoteEdit(h, 'a')
    const q = h.open()
    await settle()
    expect(q.status).toBe('ready')
    const reads = h.server.getPageState.mock.calls.length
    q.pageChanged()
    await settle()
    expect(h.server.getPageState).toHaveBeenCalledTimes(reads)
    expect(h.server.getPageUpdates).not.toHaveBeenCalled()
  })

  it('the reload of a page that waits for a key backs off when the snapshot blob fails', async () => {
    const h = harness()
    await lateUpdate(h)
    const q = h.open()
    await settle()
    expect(q.status).toBe('waiting')
    h.server.snapshot = readableSnapshot(h, 2, 'up-y')
    h.server.fetchBlob.mockRejectedValue(new Error('network'))
    const reads = (): number => h.server.getPageState.mock.calls.length
    await settle(10_000)
    expect(reads()).toBe(2)
    expect(h.server.fetchBlob).toHaveBeenCalledTimes(2)
    // Twice the last wait, not the 2 s retry of a failed sync.
    await settle(19_999)
    expect(reads()).toBe(2)
    await settle(1)
    expect(reads()).toBe(3)
    expect(q.status).toBe('waiting')
  })

  it('a headless provider sends no awareness and snapshots without the jitter', async () => {
    const h = harness({ random: () => 1 }, { headless: true })
    await remoteEdit(h, 'old', 1)
    h.epoch.current = 2
    const p = h.open()
    let done = false
    void p.snapshotIfNeeded().then(() => (done = true))
    await settle()
    expect(done).toBe(true)
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
    p.destroy()
    await settle(HEARTBEAT_MS)
    expect(h.sent).toEqual([])
    const kinds = h.crypto.encryptDoc.mock.calls.map(([input]) => input.kind)
    expect(kinds).not.toContain('doc_awareness')
  })

  it('snapshotIfNeeded resolves after the snapshot that the rules call for', async () => {
    const h = harness()
    await remoteEdit(h, 'old', 1)
    h.epoch.current = 2
    const p = h.open()
    let done = false
    const run = p.snapshotIfNeeded().then(() => (done = true))
    await settle()
    await run
    expect(done).toBe(true)
    expect(h.server.snapshot).toMatchObject({ baseSeq: 1, epoch: 2 })
    // A current page needs none.
    h.server.postPageSnapshot.mockClear()
    const q = h.open()
    const again = q.snapshotIfNeeded()
    await settle()
    await again
    expect(h.server.postPageSnapshot).not.toHaveBeenCalled()
  })

  it('throttles awareness to one frame per 100 ms, and renews it every 15 s', async () => {
    const h = harness()
    const p = h.open()
    await settle()
    const opened = h.sent.length
    expect(opened).toBe(1) // the state on open
    await settle(AWARENESS_MS)
    for (let i = 0; i < 10; i++) {
      p.awareness.setLocalStateField('cursor', i)
      await settle(5)
    }
    await settle(AWARENESS_MS)
    // The leading frame and one trailing frame.
    expect(h.sent.length - opened).toBe(2)
    const before = h.sent.length
    await settle(16_000)
    expect(h.sent.length - before).toBe(1)
  })

  it('applies remote awareness with the verified user, and answers a new peer', async () => {
    const h = harness()
    const p = h.open()
    await settle(AWARENESS_MS)
    const peerDoc = new Y.Doc()
    const { Awareness, encodeAwarenessUpdate } = await import('y-protocols/awareness')
    const peer = new Awareness(peerDoc)
    peer.setLocalStateField('user', { userId: 'u-forged', name: 'bob', color: '#445566' })
    const bytes = encodeAwarenessUpdate(peer, [peer.clientID])
    expect(awarenessClientIds(bytes)).toEqual([peer.clientID])
    const out = await h.crypto.encryptDoc({
      channelId: CHANNEL,
      pageId: PAGE,
      kind: 'doc_awareness',
      bytes
    })
    const before = h.sent.length
    p.receiveAwareness({ deviceId: 'd-2', envelope: out.envelope })
    await settle(AWARENESS_MS)
    expect(h.presence.at(-1)).toEqual([
      { clientId: peer.clientID, userId: 'u-2', name: 'bob', color: '#445566' }
    ])
    expect(h.sent.length - before).toBe(1)
    // My own frames are ignored.
    h.crypto.decryptDoc.mockClear()
    p.receiveAwareness({ deviceId: 'd-1', envelope: out.envelope })
    expect(h.crypto.decryptDoc).not.toHaveBeenCalled()
    peer.destroy()
  })
})

describe('page labels', () => {
  it('stores normalized labels in the meta map and syncs them as doc content', () => {
    const a = new Y.Doc()
    const seen: string[][] = []
    const stop = observeLabels(a, (l) => seen.push(l))
    expect(pageLabels(a)).toEqual([])
    setPageLabels(a, [' RFC ', 'rfc', '', 'Draft', 'x'.repeat(30), 'a', 'b', 'c'])
    expect(pageLabels(a)).toEqual(['RFC', 'Draft', 'x'.repeat(24), 'a', 'b'])
    expect(seen).toHaveLength(1)
    stop()
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(pageLabels(b)).toEqual(['RFC', 'Draft', 'x'.repeat(24), 'a', 'b'])
  })
  it('ignores a malformed remote value', () => {
    const d = new Y.Doc()
    d.getMap('meta').set('labels', 'RFC')
    expect(pageLabels(d)).toEqual([])
    d.getMap('meta').set('labels', [1, 'Draft', null])
    expect(pageLabels(d)).toEqual(['Draft'])
  })
})
