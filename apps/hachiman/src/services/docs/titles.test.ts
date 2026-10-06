import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from '@hachiman/client'
import type { DocDecryptResult } from '@hachiman/crypto'
import type { PageNode } from '@/stores/docsStore'
import { createTitleCatchUp, keepTitle, mergeNode, titleNode } from './titles'

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

describe('createTitleCatchUp', () => {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the harness is its own type
  function harness() {
    const deps = {
      ensureChannelGroup: vi.fn<(channelId: string) => Promise<unknown>>(async () => ({})),
      retry: vi.fn()
    }
    return { deps, catchUp: createTitleCatchUp(deps) }
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('catches a channel up once, then decrypts the titles again', async () => {
    const { deps, catchUp } = harness()
    catchUp.noteResults(['c-1', 'c-2', 'c-1'], new Set(['c-1']))
    await flush()
    expect(deps.ensureChannelGroup.mock.calls).toEqual([['c-1']])
    expect(deps.retry).toHaveBeenCalledTimes(1)
    // The retry finds the title still ahead: no second catch-up (no loop).
    catchUp.noteResults(['c-1'], new Set(['c-1']))
    await flush()
    expect(deps.ensureChannelGroup).toHaveBeenCalledTimes(1)
    expect(deps.retry).toHaveBeenCalledTimes(1)
    // The titles of the channel decrypt with none ahead: the next lag gets a catch-up again.
    catchUp.noteResults(['c-1'], new Set())
    catchUp.noteResults(['c-1'], new Set(['c-1']))
    await flush()
    expect(deps.ensureChannelGroup).toHaveBeenCalledTimes(2)
    // READY and RESUMED clear it too.
    catchUp.clear()
    catchUp.noteResults(['c-1'], new Set(['c-1']))
    await flush()
    expect(deps.ensureChannelGroup).toHaveBeenCalledTimes(3)
    expect(deps.retry).toHaveBeenCalledTimes(3)
  })

  it('a failed catch-up does not retry, and the next title that is ahead tries again', async () => {
    const { deps, catchUp } = harness()
    deps.ensureChannelGroup.mockRejectedValueOnce(new Error('not ready'))
    catchUp.noteResults(['c-1'], new Set(['c-1']))
    await flush()
    expect(deps.retry).not.toHaveBeenCalled()
    catchUp.noteResults(['c-1'], new Set(['c-1']))
    await flush()
    expect(deps.ensureChannelGroup).toHaveBeenCalledTimes(2)
    expect(deps.retry).toHaveBeenCalledTimes(1)
  })

  it('a catch-up that ends after sign-out does not retry', async () => {
    const { deps, catchUp } = harness()
    let done = (): void => {}
    deps.ensureChannelGroup.mockImplementationOnce(
      () => new Promise((resolve) => (done = () => resolve({})))
    )
    catchUp.noteResults(['c-1'], new Set(['c-1']))
    await flush()
    catchUp.reset()
    done()
    await flush()
    expect(deps.retry).not.toHaveBeenCalled()
  })
})
