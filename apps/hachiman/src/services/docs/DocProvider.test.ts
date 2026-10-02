import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { DocSnapshot, DocUpdate } from '@hachiman/client'
import type { DocDecryptResult, EncryptDocInput } from '@hachiman/crypto'
import {
  AWARENESS_MS,
  BATCH_MS,
  SNAPSHOT_EVERY,
  awarenessClientIds,
  createDocProvider,
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

/** A fake Takusen: the update log, the newest snapshot and the uploaded blobs. */
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

function harness(): Harness {
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
    random: () => 0
  }
  return {
    crypto,
    server,
    epoch,
    sent,
    presence,
    open: () => {
      const p = createDocProvider(CHANNEL, PAGE, deps)
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

  it('re-encrypts an idle page with an empty update first', async () => {
    const h = harness()
    await remoteEdit(h, 'old', 1)
    h.epoch.current = 2
    h.open()
    await settle()
    h.server.postPageSnapshot.mockClear()
    // The snapshot is of epoch 2; epoch 3 makes it stale with no update after it.
    expect(h.server.snapshot?.epoch).toBe(2)
    h.epoch.current = 3
    const q = h.open()
    await settle()
    expect(q.status).toBe('ready')
    expect(h.server.updates).toHaveLength(2)
    expect(h.server.snapshot?.baseSeq).toBe(2)
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
