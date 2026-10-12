import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Permissions,
  RestError,
  type Channel,
  type DocSnapshot,
  type Page,
  type PageHead
} from '@hachiman/client'
import type { CryptoEvents, DocDecryptResult, EncryptDocInput } from '@hachiman/crypto'
import {
  REWRAP_AGAIN_MS,
  REWRAP_DELAY_MS,
  createRewrapper,
  pagesChannelsOf,
  rewrapChannel,
  snapshotHeadless,
  type RewrapDeps
} from './rewrap'

const CHANNEL = 'c-1'
const utf8 = new TextEncoder()
const pointer = (uploadId: string): Uint8Array =>
  utf8.encode(JSON.stringify({ uploadId, fileKey: 'fk', sha256: 'sha', size: 1 }))
const bannerBytes = (pageId: string): Uint8Array =>
  utf8.encode(JSON.stringify({ uploadId: `banner-${pageId}`, mime: 'image/webp' }))

/** A fake Worker: an envelope is a handle on the plaintext, with the epoch of its send. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the fake is its own type
function fakeCrypto(epoch: { current: number }) {
  const sealed = new Map<string, { input: EncryptDocInput; epoch: number }>()
  const pending = new Set<string>()
  let n = 0
  const seal = (input: EncryptDocInput, at = epoch.current): string => {
    const envelope = `env-${++n}`
    sealed.set(envelope, { input, epoch: at })
    return envelope
  }
  return {
    sealed,
    pending,
    seal,
    encryptDoc: vi.fn(async (input: EncryptDocInput) => ({
      envelope: seal(input),
      groupId: 'g-1',
      epoch: epoch.current
    })),
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
    ensureChannelGroup: vi.fn(async () => ({ groupId: 'g-1', epoch: epoch.current }) as never)
  }
}

interface FakePage {
  page: Page
  latestSeq: number
  snapshot: DocSnapshot | null
}

/** A fake Takusen with the §4 Pages re-wrap and title compare-and-set rules. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the fake is its own type
function fakeServer(crypto: ReturnType<typeof fakeCrypto>, epoch: { current: number }) {
  const pages = new Map<string, FakePage>()
  let clock = 0
  const header = (envelope: string): { groupId: string; epoch: number } => ({
    groupId: 'g-1',
    epoch: crypto.sealed.get(envelope)?.epoch ?? 0
  })
  return {
    pages,
    add(
      id: string,
      opts: {
        titleEpoch: number
        /** A banner envelope of this epoch. */
        bannerEpoch?: number
        latestSeq?: number
        snapshot?: { baseSeq: number; epoch: number; uploadId?: string }
      }
    ): FakePage {
      const titleEnvelope = crypto.seal(
        { channelId: CHANNEL, pageId: id, kind: 'doc_title', bytes: utf8.encode(` ${id} `) },
        opts.titleEpoch
      )
      const bannerEnvelope =
        opts.bannerEpoch === undefined
          ? null
          : crypto.seal(
              { channelId: CHANNEL, pageId: id, kind: 'doc_banner', bytes: bannerBytes(id) },
              opts.bannerEpoch
            )
      const s = opts.snapshot
      const uploadId = s?.uploadId ?? `up-${id}`
      const p: FakePage = {
        page: {
          id,
          channelId: CHANNEL,
          parentId: null,
          position: 0,
          titleEnvelope,
          bannerEnvelope,
          createdBy: 'u-2',
          createdAt: 't0',
          updatedAt: `t${++clock}`
        },
        latestSeq: opts.latestSeq ?? s?.baseSeq ?? 0,
        snapshot: s
          ? {
              pageId: id,
              baseSeq: s.baseSeq,
              uploadId,
              key: `${uploadId}/blob`,
              size: 1,
              groupId: 'g-1',
              epoch: s.epoch,
              senderDevice: 'd-2',
              envelope: crypto.seal(
                { channelId: CHANNEL, pageId: id, kind: 'doc_snapshot', bytes: pointer(uploadId) },
                s.epoch
              ),
              mediaUploadIds: ['m-1'],
              createdAt: ''
            }
          : null
      }
      pages.set(id, p)
      return p
    },
    getPageHeads: vi.fn(async (): Promise<PageHead[]> =>
      [...pages.values()].map((p) => ({
        pageId: p.page.id,
        latestSeq: p.latestSeq,
        title: header(p.page.titleEnvelope),
        banner: p.page.bannerEnvelope === null ? null : header(p.page.bannerEnvelope),
        snapshot: p.snapshot
      }))
    ),
    getPages: vi.fn(async () => [...pages.values()].map((p) => p.page)),
    postPageSnapshot: vi.fn(
      async (
        pageId: string,
        body: { baseSeq: number; uploadId: string; envelope: string; mediaUploadIds: string[] }
      ) => {
        const p = pages.get(pageId)!
        const s = p.snapshot
        if (
          !s ||
          body.baseSeq !== s.baseSeq ||
          body.uploadId !== s.uploadId ||
          epoch.current <= s.epoch
        )
          throw new RestError(409, 'SnapshotConflict', undefined, { baseSeq: s?.baseSeq ?? 0 })
        p.snapshot = { ...s, epoch: epoch.current, senderDevice: 'd-1', envelope: body.envelope }
        return p.snapshot
      }
    ),
    updatePage: vi.fn(
      async (
        pageId: string,
        body: {
          titleEnvelope?: string | null
          banner?: { envelope: string; uploadIds?: string[] } | null
          ifUpdatedAt?: string | null
        }
      ) => {
        const p = pages.get(pageId)!
        if (body.ifUpdatedAt != null && body.ifUpdatedAt !== p.page.updatedAt)
          throw new RestError(409, 'PageConflict')
        p.page = {
          ...p.page,
          titleEnvelope: body.titleEnvelope ?? p.page.titleEnvelope,
          bannerEnvelope:
            body.banner === undefined ? p.page.bannerEnvelope : (body.banner?.envelope ?? null),
          updatedAt: `t${++clock}`
        }
        return p.page
      }
    )
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the harness is its own type
function harness() {
  const epoch = { current: 1 }
  const crypto = fakeCrypto(epoch)
  const server = fakeServer(crypto, epoch)
  const open = new Set<string>()
  const deps = {
    rest: server as unknown as RewrapDeps['rest'],
    crypto: () => crypto as unknown as ReturnType<RewrapDeps['crypto']>,
    channelsOf: vi.fn((groupId: string) => (groupId === 'g-1' ? [CHANNEL] : [])),
    resyncOpen: vi.fn((pageId: string) => open.has(pageId)),
    snapshotPage: vi.fn(async () => {}),
    random: () => 0
  } satisfies RewrapDeps
  return { epoch, crypto, server, open, deps }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('rewrapChannel', () => {
  it('re-wraps the pointer of a stale idle snapshot with the same baseSeq and uploadId', async () => {
    const h = harness()
    h.server.add('a', { titleEpoch: 1, snapshot: { baseSeq: 4, epoch: 1 } })
    h.server.add('b', { titleEpoch: 2, snapshot: { baseSeq: 2, epoch: 2 } })
    h.epoch.current = 2
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
    expect(h.server.postPageSnapshot).toHaveBeenCalledWith('a', {
      baseSeq: 4,
      uploadId: 'up-a',
      envelope: expect.any(String),
      mediaUploadIds: ['m-1']
    })
    const a = h.server.pages.get('a')!.snapshot!
    expect(a.epoch).toBe(2)
    expect(h.crypto.sealed.get(a.envelope)?.input.bytes).toEqual(pointer('up-a'))
    expect(h.deps.snapshotPage).not.toHaveBeenCalled()
  })

  it('re-wraps only a pointer that opens here and names the upload of the row', async () => {
    const h = harness()
    const locked = h.server.add('a', { titleEpoch: 2, snapshot: { baseSeq: 1, epoch: 1 } })
    h.crypto.pending.add(locked.snapshot!.envelope)
    const swapped = h.server.add('b', { titleEpoch: 2, snapshot: { baseSeq: 1, epoch: 1 } })
    swapped.snapshot = { ...swapped.snapshot!, uploadId: 'up-other' }
    h.epoch.current = 2
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.postPageSnapshot).not.toHaveBeenCalled()
    expect(h.crypto.encryptDoc).not.toHaveBeenCalled()
  })

  it('snapshots a page with updates after its snapshot, and leaves an open page to its provider', async () => {
    const h = harness()
    h.server.add('a', { titleEpoch: 2, latestSeq: 6, snapshot: { baseSeq: 4, epoch: 1 } })
    h.server.add('b', { titleEpoch: 2, latestSeq: 3 })
    h.server.add('c', { titleEpoch: 2, snapshot: { baseSeq: 1, epoch: 1 } })
    h.open.add('c')
    h.epoch.current = 2
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.deps.snapshotPage.mock.calls).toEqual([
      [CHANNEL, 'a'],
      [CHANNEL, 'b']
    ])
    expect(h.deps.resyncOpen).toHaveBeenCalledWith('c')
    expect(h.server.postPageSnapshot).not.toHaveBeenCalled()
  })

  it('loads a page with updates after a current snapshot only in a thorough pass', async () => {
    const h = harness()
    h.server.add('a', { titleEpoch: 2, latestSeq: 6, snapshot: { baseSeq: 4, epoch: 2 } })
    h.epoch.current = 2
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.deps.snapshotPage).not.toHaveBeenCalled()
    await rewrapChannel(h.deps, CHANNEL, true)
    expect(h.deps.snapshotPage.mock.calls).toEqual([[CHANNEL, 'a']])
  })

  it('reads the page list before the heads of the titles: a rename in the current epoch stays', async () => {
    const h = harness()
    const a = h.server.add('a', { titleEpoch: 1 })
    h.epoch.current = 2
    // A rename after the first heads read.
    h.server.getPages.mockImplementationOnce(async () => {
      a.page = {
        ...a.page,
        titleEnvelope: h.crypto.seal({
          channelId: CHANNEL,
          pageId: 'a',
          kind: 'doc_title',
          bytes: utf8.encode('renamed')
        }),
        updatedAt: 'renamed'
      }
      return [...h.server.pages.values()].map((p) => ({ ...p.page }))
    })
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    expect(h.server.updatePage).not.toHaveBeenCalled()
    // No stale title: one heads read and no page list.
    h.server.getPageHeads.mockClear()
    h.server.getPages.mockClear()
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(1)
    expect(h.server.getPages).not.toHaveBeenCalled()
  })

  it('re-wraps a stale title with the same bytes and ifUpdatedAt; a rename in between wins', async () => {
    const h = harness()
    const a = h.server.add('a', { titleEpoch: 1 })
    const b = h.server.add('b', { titleEpoch: 1 })
    h.server.add('c', { titleEpoch: 2 })
    h.epoch.current = 2
    const readAt = b.page.updatedAt
    // A rename of b after the pass read the page list.
    h.server.getPages.mockImplementationOnce(async () => {
      const pages = [...h.server.pages.values()].map((p) => ({ ...p.page }))
      b.page = { ...b.page, updatedAt: 'renamed' }
      return pages
    })
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.updatePage).toHaveBeenCalledTimes(2)
    expect(h.server.updatePage).toHaveBeenCalledWith('b', {
      titleEnvelope: expect.any(String),
      ifUpdatedAt: readAt
    })
    expect(h.crypto.sealed.get(a.page.titleEnvelope)).toMatchObject({
      epoch: 2,
      input: { bytes: utf8.encode(' a ') }
    })
    expect(b.page.updatedAt).toBe('renamed')
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('re-wraps a stale banner in one PATCH with the title, without uploadIds', async () => {
    const h = harness()
    const a = h.server.add('a', { titleEpoch: 1, bannerEpoch: 1 })
    h.epoch.current = 2
    const readAt = a.page.updatedAt
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.updatePage).toHaveBeenCalledTimes(1)
    // An exact body: a stray uploadIds would make Takusen claim ids for a non-uploader.
    expect(h.server.updatePage).toHaveBeenCalledWith('a', {
      titleEnvelope: expect.any(String),
      banner: { envelope: expect.any(String) },
      ifUpdatedAt: readAt
    })
    // The same bytes, not parsed, in the current epoch.
    expect(h.crypto.sealed.get(a.page.bannerEnvelope!)).toMatchObject({
      epoch: 2,
      input: { kind: 'doc_banner', bytes: bannerBytes('a') }
    })
  })

  it('re-wraps a page whose title is current and whose banner is stale', async () => {
    const h = harness()
    const a = h.server.add('a', { titleEpoch: 2, bannerEpoch: 1 })
    const titleEnvelope = a.page.titleEnvelope
    h.server.add('b', { titleEpoch: 2, bannerEpoch: 2 })
    h.epoch.current = 2
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.updatePage.mock.calls).toEqual([
      ['a', { banner: { envelope: expect.any(String) }, ifUpdatedAt: expect.any(String) }]
    ])
    expect(a.page.titleEnvelope).toBe(titleEnvelope)
    expect(h.crypto.sealed.get(a.page.bannerEnvelope!)?.epoch).toBe(2)
  })

  it('skips a banner that does not open here, and keeps the title re-wrap', async () => {
    const h = harness()
    const a = h.server.add('a', { titleEpoch: 1, bannerEpoch: 1 })
    h.crypto.pending.add(a.page.bannerEnvelope!)
    const b = h.server.add('b', { titleEpoch: 2, bannerEpoch: 1 })
    h.crypto.pending.add(b.page.bannerEnvelope!)
    h.epoch.current = 2
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.updatePage.mock.calls).toEqual([
      ['a', { titleEnvelope: expect.any(String), ifUpdatedAt: expect.any(String) }]
    ])
    expect(h.crypto.encryptDoc).toHaveBeenCalledTimes(1)
  })

  it('a re-wrap that another member made first ends quietly', async () => {
    const h = harness()
    const a = h.server.add('a', { titleEpoch: 2, snapshot: { baseSeq: 1, epoch: 1 } })
    h.epoch.current = 2
    h.server.getPageHeads.mockImplementationOnce(async () => {
      const heads = [{ pageId: 'a', latestSeq: 1, title: null, banner: null, snapshot: a.snapshot }]
      a.snapshot = { ...a.snapshot!, epoch: 2 }
      return heads
    })
    await rewrapChannel(h.deps, CHANNEL)
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a sign-out stops the channel before its next page and before the titles', async () => {
    const h = harness()
    h.server.add('a', { titleEpoch: 1, snapshot: { baseSeq: 1, epoch: 1 } })
    h.server.add('b', { titleEpoch: 1, snapshot: { baseSeq: 1, epoch: 1 } })
    h.epoch.current = 2
    let signedOut = false
    h.server.postPageSnapshot.mockImplementationOnce(async () => {
      signedOut = true
      throw new RestError(409, 'SnapshotConflict', undefined, { baseSeq: 1 })
    })
    await rewrapChannel(h.deps, CHANNEL, false, () => signedOut)
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
    expect(h.deps.resyncOpen).toHaveBeenCalledTimes(1)
    expect(h.server.getPages).not.toHaveBeenCalled()
    expect(h.server.updatePage).not.toHaveBeenCalled()
    // A sign-out during the title phase stops before the next title.
    signedOut = false
    h.server.updatePage.mockImplementationOnce(async () => {
      signedOut = true
      throw new RestError(409, 'PageConflict')
    })
    await rewrapChannel(h.deps, CHANNEL, false, () => signedOut)
    expect(h.server.updatePage).toHaveBeenCalledTimes(1)
  })

  it('a 403 stops the channel', async () => {
    const h = harness()
    h.server.add('a', { titleEpoch: 2, snapshot: { baseSeq: 1, epoch: 1 } })
    h.server.add('b', { titleEpoch: 2, snapshot: { baseSeq: 1, epoch: 1 } })
    h.epoch.current = 2
    h.server.postPageSnapshot.mockRejectedValueOnce(new RestError(403, 'MissingPermissions'))
    await expect(rewrapChannel(h.deps, CHANNEL)).rejects.toThrow()
    expect(h.server.postPageSnapshot).toHaveBeenCalledTimes(1)
  })
})

describe('pagesChannelsOf', () => {
  it('keeps the pages channels of the group in which this user can view and write', () => {
    const V = Permissions.VIEW_CHANNEL
    const S = Permissions.SEND_MESSAGES
    const ch = (
      id: string,
      type: Channel['type'],
      mlsGroupId: string | null
    ): Pick<Channel, 'id' | 'type' | 'mlsGroupId'> => ({ id, type, mlsGroupId })
    const perms: Record<string, number> = { a: V | S, b: V | S, c: V | S, d: V, e: S, f: V | S }
    const channels = [
      ch('a', 'pages', 'g-1'),
      ch('b', 'text', 'g-1'),
      ch('c', 'pages', 'g-2'),
      ch('d', 'pages', 'g-1'),
      ch('e', 'pages', 'g-1'),
      ch('f', 'pages', null)
    ]
    expect(pagesChannelsOf(channels, 'g-1', (id) => perms[id] ?? 0)).toEqual(['a'])
    expect(pagesChannelsOf(channels, 'g-2', (id) => perms[id] ?? 0)).toEqual(['c'])
  })
})

describe('snapshotHeadless', () => {
  it('destroys the provider after the snapshot, also when the snapshot fails', async () => {
    const running = new Set<{ destroy(): void }>()
    let done = (): void => {}
    const ok = {
      snapshotIfNeeded: vi.fn(() => new Promise<void>((resolve) => (done = resolve))),
      destroy: vi.fn()
    }
    const run = snapshotHeadless(ok, running)
    await Promise.resolve()
    expect(ok.destroy).not.toHaveBeenCalled()
    // A sign-out meanwhile destroys the providers in the set.
    expect([...running]).toEqual([ok])
    done()
    await run
    expect(ok.destroy).toHaveBeenCalledTimes(1)
    expect(running.size).toBe(0)
    const bad = {
      snapshotIfNeeded: vi.fn(async () => {
        throw new Error('no blob')
      }),
      destroy: vi.fn()
    }
    await expect(snapshotHeadless(bad, running)).rejects.toThrow('no blob')
    expect(bad.destroy).toHaveBeenCalledTimes(1)
    expect(running.size).toBe(0)
  })
})

describe('createRewrapper', () => {
  const event = (byMe: boolean, groupId = 'g-1'): CryptoEvents['usersAdded'] => ({
    groupId,
    kind: 'public_set',
    guildId: 'guild-1',
    channelId: null,
    epoch: 2,
    userIds: ['u-9'],
    byMe
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('the committer runs a pass at once and again after the epoch grace', async () => {
    const h = harness()
    const r = createRewrapper(h.deps)
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(REWRAP_AGAIN_MS - 1)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
  })

  it('another member waits 12 to 20 s, and a burst of commits gives few passes', async () => {
    const h = harness()
    let roll = 0.5
    const r = createRewrapper({ ...h.deps, random: () => roll })
    const wait = REWRAP_DELAY_MS[0] + 0.5 * (REWRAP_DELAY_MS[1] - REWRAP_DELAY_MS[0])
    r.onUsersAdded(event(false))
    await vi.advanceTimersByTimeAsync(wait - 1)
    expect(h.server.getPageHeads).not.toHaveBeenCalled()
    // A later commit inside the wait: the pass stays, and one more follows after its own wait.
    roll = 1
    r.onUsersAdded(event(false))
    r.onUsersAdded(event(false))
    await vi.advanceTimersByTimeAsync(1)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(REWRAP_DELAY_MS[1])
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    // A group without pages channels does nothing.
    r.onUsersAdded(event(true, 'g-other'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
  })

  it('only the pass at or after the committer second pass time is thorough', async () => {
    const h = harness()
    h.server.add('a', { titleEpoch: 2, latestSeq: 6, snapshot: { baseSeq: 4, epoch: 2 } })
    h.epoch.current = 2
    let roll = 0
    const r = createRewrapper({ ...h.deps, random: () => roll })
    r.onUsersAdded(event(false))
    await vi.advanceTimersByTimeAsync(REWRAP_DELAY_MS[0])
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(1)
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    expect(h.deps.snapshotPage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(REWRAP_AGAIN_MS)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(3)
    expect(h.deps.snapshotPage).toHaveBeenCalledTimes(1)
    // A later timer of another commit takes the second pass: it is thorough.
    roll = 1
    r.onUsersAdded(event(false))
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(REWRAP_DELAY_MS[1] - 1)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(4)
    expect(h.deps.snapshotPage).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(5)
    expect(h.deps.snapshotPage).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(5)
  })

  it('runs one pass per group at a time, and reset cancels the waits', async () => {
    const h = harness()
    let release = (): void => {}
    h.server.getPageHeads.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve([])))
    )
    const r = createRewrapper(h.deps)
    r.onUsersAdded(event(true))
    r.onUsersAdded(event(true))
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    // The requests during the pass give one more pass.
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    r.reset()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
  })

  it('a reset stops the pass that runs before its next page', async () => {
    const h = harness()
    h.server.add('a', { titleEpoch: 1, latestSeq: 3 })
    h.server.add('b', { titleEpoch: 1, latestSeq: 2 })
    h.epoch.current = 2
    let release = (): void => {}
    h.deps.snapshotPage.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve))
    )
    const r = createRewrapper(h.deps)
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deps.snapshotPage.mock.calls).toEqual([[CHANNEL, 'a']])
    r.reset()
    release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.deps.snapshotPage).toHaveBeenCalledTimes(1)
    expect(h.deps.resyncOpen).toHaveBeenCalledTimes(1)
    expect(h.server.getPages).not.toHaveBeenCalled()
    expect(h.server.updatePage).not.toHaveBeenCalled()
  })

  it('a pass from before a reset does not hold back or end a pass of the next session', async () => {
    const h = harness()
    const holds: (() => void)[] = []
    const hold = (): Promise<PageHead[]> => new Promise((resolve) => holds.push(() => resolve([])))
    h.server.getPageHeads.mockImplementationOnce(hold).mockImplementationOnce(hold)
    const r = createRewrapper(h.deps)
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(1)
    r.reset()
    // The committer of the next session: its pass starts at once.
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    // The old pass ends during the new one: the new one still runs one pass at a time.
    holds[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    r.onUsersAdded(event(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(2)
    // The request during the new pass gives one more pass after it.
    holds[1]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(3)
    // The second pass of the committer still runs.
    await vi.advanceTimersByTimeAsync(REWRAP_AGAIN_MS)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.server.getPageHeads).toHaveBeenCalledTimes(4)
  })
})
