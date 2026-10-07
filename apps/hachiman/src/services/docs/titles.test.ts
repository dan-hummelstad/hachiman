import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@hachiman/client'
import type { DocDecryptResult, EncryptedDocItem } from '@hachiman/crypto'
import type { PageNode } from '@/stores/docsStore'
import { createPageTitles, keepTitle, mergeNode, titleNode, type PageTitlesDeps } from './titles'

const utf8 = new TextEncoder()

const page = (over: Partial<Page> = {}): Page => ({
  id: 'p-1',
  channelId: 'c-1',
  parentId: null,
  position: 1024,
  titleEnvelope: 'env',
  createdBy: 'u-1',
  createdAt: 't0',
  updatedAt: 't1',
  ...over
})

const ok = (title: string): DocDecryptResult => ({
  status: 'ok',
  id: 'p-1',
  kind: 'doc_title',
  bytes: utf8.encode(title),
  sender: { userId: 'u-1', deviceId: 'd-1', leafIndex: 0, trust: 'tofu', membershipVerified: true }
})

const pending = (reason: 'epoch_ahead' | 'no_history_key'): DocDecryptResult => ({
  status: 'pending',
  id: 'p-1',
  reason
})

const node = (over: Partial<Page> = {}, title = 'Notes'): PageNode =>
  titleNode(page(over), ok(title))

describe('titleNode', () => {
  it('maps a decrypt result to a node without the envelope', () => {
    const n = node()
    expect(n).toMatchObject({ id: 'p-1', title: 'Notes', titleState: 'ok', updatedAt: 't1' })
    expect(n).not.toHaveProperty('titleEnvelope')
    const bad: DocDecryptResult = { ...ok(''), bytes: new Uint8Array([0xff]) } as DocDecryptResult
    expect(titleNode(page(), bad).titleState).toBe('failed')
    expect(titleNode(page(), { status: 'failed', id: 'p-1', reason: 'malformed' }).titleState).toBe(
      'failed'
    )
    expect(titleNode(page(), pending('epoch_ahead'))).toMatchObject({
      title: '',
      titleState: 'pending'
    })
    expect(titleNode(page(), undefined).titleState).toBe('pending')
  })
})

describe('mergeNode', () => {
  it('skips a node that the store has: a title re-wrap changes only the envelope', () => {
    expect(mergeNode(node(), node({ updatedAt: 't2', titleEnvelope: 'env-2' }))).toBeNull()
    expect(mergeNode(undefined, node())).toEqual(node())
    expect(mergeNode(node(), node({}, 'Renamed'))?.title).toBe('Renamed')
    expect(mergeNode(node(), node({ position: 2048 }))?.position).toBe(2048)
  })

  it('keeps a decrypted title while a newer envelope of the page waits for its key', () => {
    const behind = titleNode(page({ updatedAt: 't2' }), pending('epoch_ahead'))
    // Only the title is new: nothing to store.
    expect(mergeNode(node(), behind)).toBeNull()
    // A move with it: the structure fields are new, the title stays.
    const moved = titleNode(
      page({ parentId: 'p-0', position: 512, updatedAt: 't3' }),
      pending('epoch_ahead')
    )
    expect(mergeNode(node(), moved)).toEqual({
      ...node(),
      parentId: 'p-0',
      position: 512,
      updatedAt: 't3'
    })
    // No decrypted title to keep: the placeholder shows.
    expect(mergeNode(undefined, behind)?.titleState).toBe('pending')
    expect(mergeNode(behind, behind)?.titleState).toBe('pending')
    // A title that fails replaces the stored one.
    const failed = titleNode(page(), { status: 'failed', id: 'p-1', reason: 'malformed' })
    expect(mergeNode(node(), failed)?.titleState).toBe('failed')
  })

  it('never stores an older row over a newer one', () => {
    const newer = node({ updatedAt: '2026-10-06T10:00:01.000Z' }, 'Renamed')
    const older = node({ updatedAt: '2026-10-06T10:00:00.000Z', position: 512 }, 'Notes')
    expect(mergeNode(newer, older)).toBeNull()
    expect(mergeNode(older, newer)).toEqual(newer)
    const behind = titleNode(
      page({ updatedAt: '2026-10-06T10:00:01.000Z' }),
      pending('epoch_ahead')
    )
    expect(mergeNode(behind, older)).toBeNull()
  })

  it('keepTitle applies to the page list of a reload, page by page', () => {
    const behind = titleNode(page({ updatedAt: 't2' }), pending('no_history_key'))
    expect(keepTitle(node(), behind)).toMatchObject({ title: 'Notes', titleState: 'ok' })
    expect(keepTitle(node({ id: 'p-2' }), behind).titleState).toBe('pending')
  })
})

describe('createPageTitles', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the harness is its own type
  function harness() {
    /** channel → why its titles wait. A channel that is not here decrypts. */
    const waiting = new Map<string, 'epoch_ahead' | 'group_unknown'>()
    const stored = new Map<string, PageNode>()
    const worker = { ready: true }
    const crypto = {
      decryptDoc: vi.fn(async (items: EncryptedDocItem[]) =>
        items.map((it): DocDecryptResult => {
          const reason = waiting.get(it.channelId)
          return reason ? { status: 'pending', id: it.id, reason } : { ...ok('Notes'), id: it.id }
        })
      ),
      ensureChannelGroup: vi.fn<(channelId: string) => Promise<unknown>>(async () => ({}))
    }
    const titles = createPageTitles({
      crypto: () => {
        if (!worker.ready) throw new Error('not ready')
        return crypto as unknown as ReturnType<PageTitlesDeps['crypto']>
      },
      findPage: (id) => stored.get(id),
      upsertPage: (n) => {
        stored.set(n.id, n)
      }
    })
    return { waiting, stored, worker, crypto, titles }
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('catches a channel up once, then decrypts the titles again', async () => {
    const { waiting, stored, crypto, titles } = harness()
    waiting.set('c-1', 'epoch_ahead')
    const nodes = await titles.decrypt([
      page(),
      page({ id: 'p-2', channelId: 'c-2' }),
      page({ id: 'p-3' })
    ])
    expect(nodes.map((n) => n.titleState)).toEqual(['pending', 'ok', 'pending'])
    await flush()
    expect(crypto.ensureChannelGroup.mock.calls).toEqual([['c-1']])
    // The retry finds the titles still ahead: no second catch-up (no loop).
    expect(crypto.decryptDoc.mock.lastCall?.[0].map((it) => it.pageId)).toEqual(['p-1', 'p-3'])
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(2)
    // The titles of the channel decrypt with none ahead: they are stored.
    waiting.delete('c-1')
    titles.retry()
    await flush()
    expect(stored.get('p-1')).toMatchObject({ title: 'Notes', titleState: 'ok' })
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(3)
    // The next lag gets a catch-up again.
    waiting.set('c-1', 'epoch_ahead')
    await titles.decrypt([page({ updatedAt: 't2' })])
    await flush()
    expect(crypto.ensureChannelGroup).toHaveBeenCalledTimes(2)
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(5)
    // READY and RESUMED clear it too.
    titles.onReady()
    titles.retry()
    await flush()
    expect(crypto.ensureChannelGroup).toHaveBeenCalledTimes(3)
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(7)
    // The decrypted title stays while the newer one waits.
    expect(stored.get('p-1')).toMatchObject({ title: 'Notes', titleState: 'ok' })
  })

  it('a failed catch-up does not retry, and the next title that is ahead tries again', async () => {
    const { waiting, crypto, titles } = harness()
    waiting.set('c-1', 'epoch_ahead')
    crypto.ensureChannelGroup.mockRejectedValueOnce(new Error('not ready'))
    await titles.decrypt([page()])
    await flush()
    expect(crypto.ensureChannelGroup).toHaveBeenCalledTimes(1)
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(1)
    titles.retry()
    await flush()
    expect(crypto.ensureChannelGroup).toHaveBeenCalledTimes(2)
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(3)
  })

  it('a catch-up that ends after sign-out does not retry', async () => {
    const { waiting, crypto, titles } = harness()
    waiting.set('c-1', 'epoch_ahead')
    waiting.set('c-2', 'group_unknown')
    let done = (): void => {}
    crypto.ensureChannelGroup.mockImplementationOnce(
      () => new Promise((resolve) => (done = () => resolve({})))
    )
    await titles.decrypt([page()])
    await flush()
    titles.reset()
    // A title of the next session waits: the old catch-up does not decrypt it.
    await titles.decrypt([page({ id: 'p-2', channelId: 'c-2' })])
    done()
    await flush()
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(2)
  })

  it('a Worker that is not ready: the titles show pending until a retry', async () => {
    const { stored, worker, crypto, titles } = harness()
    worker.ready = false
    const nodes = await titles.decrypt([
      page(),
      page({ id: 'p-2' }),
      page({ id: 'p-3', channelId: 'c-2' })
    ])
    expect(nodes.map((n) => n.titleState)).toEqual(['pending', 'pending', 'pending'])
    worker.ready = true
    // A deleted page or channel waits no more.
    titles.forget(['p-2'])
    titles.forgetChannel('c-2')
    titles.retry()
    await flush()
    expect(crypto.decryptDoc.mock.calls.map(([items]) => items.map((it) => it.pageId))).toEqual([
      ['p-1']
    ])
    expect(stored.get('p-1')).toMatchObject({ title: 'Notes', titleState: 'ok' })
  })
})
