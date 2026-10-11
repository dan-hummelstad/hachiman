import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Permissions,
  type Channel,
  type Page,
  type PageHead,
  type UpdatePageBody
} from '@hachiman/client'
import type {
  AttachmentPointer,
  CryptoEvents,
  DocDecryptResult,
  EncryptDocInput,
  EncryptedDocItem
} from '@hachiman/crypto'
import { useCryptoStore } from '@/stores/cryptoStore'
import { findPage } from '@/stores/docsStore'

const CHANNEL = 'c-1'
const T1 = '2026-10-06T10:00:00.000Z'
const T2 = '2026-10-06T10:00:01.000Z'
const utf8 = new TextEncoder()

/**
 * envelope → plaintext (a title, or the pointer JSON of a banner): an envelope that is not here
 * is of a group that this device has not joined.
 */
const titles = new Map<string, string>()
const decrypt = (items: EncryptedDocItem[]): DocDecryptResult[] =>
  items.map((it): DocDecryptResult => {
    const title = titles.get(it.envelope)
    if (title === undefined) return { status: 'pending', id: it.id, reason: 'group_unknown' }
    return {
      status: 'ok',
      id: it.id,
      kind: it.kind,
      bytes: utf8.encode(title),
      sender: {
        userId: 'u-2',
        deviceId: 'd-2',
        leafIndex: 1,
        trust: 'tofu',
        membershipVerified: true
      }
    }
  })

const crypto = {
  decryptDoc: vi.fn(async (items: EncryptedDocItem[]) => decrypt(items)),
  ensureChannelGroup: vi.fn(async () => ({ groupId: 'g-1', epoch: 2 })),
  /** The envelope is a handle on the plaintext, which `titles` then decrypts. */
  encryptDoc: vi.fn(async (input: EncryptDocInput) => {
    const envelope = `sealed-${input.kind}-${titles.size}`
    titles.set(envelope, new TextDecoder().decode(input.bytes))
    return { envelope, groupId: 'g-1', epoch: 2 }
  })
}
const rest = {
  getPages: vi.fn<(channelId: string) => Promise<Page[]>>(async () => []),
  getPageHeads: vi.fn<(channelId: string) => Promise<PageHead[]>>(async () => []),
  updatePage: vi.fn<(pageId: string, body: UpdatePageBody) => Promise<Page>>()
}
const channels = new Map<string, Pick<Channel, 'id' | 'type' | 'mlsGroupId'>>()
const CAN_WRITE = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES
vi.mock('@/services/client', () => ({
  hachiman: { rest, cache: { channels }, permissionsFor: () => CAN_WRITE }
}))
vi.mock('@/services/CryptoService', () => ({ cryptoService: { client: () => crypto } }))

const BANNER: AttachmentPointer = {
  uploadId: 'up-banner',
  key: 'k',
  sha256: 's',
  size: 1000,
  blobSize: 1100,
  mime: 'image/webp',
  name: 'banner.webp',
  width: 2048,
  height: 512,
  durationMs: null,
  blurhash: null,
  thumbnail: {
    uploadId: 'up-thumb',
    key: 'k',
    sha256: 's',
    size: 90,
    blobSize: 100,
    mime: 'image/webp',
    width: 320,
    height: 80
  }
}
const prepared = new File([new Uint8Array(10)], 'banner.webp', { type: 'image/webp' })
const upload = {
  prepareBannerImage: vi.fn<(file: File) => Promise<File>>(async () => prepared),
  uploadAttachment: vi.fn<(file: File, opts?: unknown) => Promise<AttachmentPointer>>(
    async () => BANNER
  )
}
vi.mock('@/lib/banner-image', () => ({ prepareBannerImage: upload.prepareBannerImage }))
vi.mock('@/services/UploadService', () => ({ uploadAttachment: upload.uploadAttachment }))

interface FakeProvider {
  pageId: string
  snapshotIfNeeded: () => Promise<void>
  destroy: () => void
  finish: () => void
}
const providers: FakeProvider[] = []
vi.mock('./DocProvider', () => ({
  createDocProvider: (
    _channelId: string,
    pageId: string,
    _deps: unknown,
    opts?: { headless?: boolean }
  ) => {
    if (!opts?.headless) throw new Error('only the re-wrap pass makes providers here')
    const p: FakeProvider = {
      pageId,
      finish: () => {},
      snapshotIfNeeded: vi.fn(() => new Promise<void>((resolve) => (p.finish = resolve))),
      destroy: vi.fn()
    }
    providers.push(p)
    return p
  }
}))

const { docsService } = await import('./DocsService')

const page = (id: string, over: Partial<Page> = {}): Page & { guildId: string } => ({
  id,
  channelId: CHANNEL,
  parentId: null,
  position: 1024,
  titleEnvelope: `env-${id}`,
  bannerEnvelope: null,
  createdBy: 'u-2',
  createdAt: T1,
  updatedAt: T1,
  guildId: 'guild-1',
  ...over
})

const membership = (
  kind: CryptoEvents['membership']['kind'],
  deviceIds: string[]
): CryptoEvents['membership'] => ({
  groupId: 'g-1',
  channelId: null,
  epoch: 2,
  actorUserId: null,
  kind,
  subjects: deviceIds.map((deviceId) => ({ userId: `u-${deviceId}`, deviceId }))
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function holdNextDecrypt(): { release: () => void } {
  const hold = { release: () => {} }
  crypto.decryptDoc.mockImplementationOnce(
    (items) => new Promise((resolve) => (hold.release = () => resolve(decrypt(items))))
  )
  return hold
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  useCryptoStore.setState({
    status: {
      state: 'ready',
      userId: 'u-1',
      deviceId: 'd-me',
      primary: true,
      recoveryConfigured: false,
      hostTrust: 'strong'
    }
  })
})

afterEach(() => {
  docsService.reset()
  titles.clear()
  channels.clear()
  providers.length = 0
  crypto.decryptDoc.mockReset()
  rest.getPages.mockReset()
  rest.getPageHeads.mockReset()
  rest.updatePage.mockReset()
  upload.prepareBannerImage.mockClear()
  upload.uploadAttachment.mockClear()
  vi.restoreAllMocks()
})

describe('pending titles', () => {
  it('decrypt again when this device joins a group, not when another device does', async () => {
    rest.getPages.mockResolvedValueOnce([page('p-1')])
    await docsService.loadPages(CHANNEL)
    expect(findPage('p-1')?.titleState).toBe('pending')
    titles.set('env-p-1', 'Notes')
    docsService.onMembership(membership('added', ['d-2']))
    docsService.onMembership(membership('removed', ['d-me']))
    await flush()
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(1)
    // A Welcome: the event lists the whole roster.
    docsService.onMembership(membership('added', ['d-2', 'd-me']))
    await flush()
    expect(crypto.decryptDoc).toHaveBeenCalledTimes(2)
    expect(findPage('p-1')).toMatchObject({ title: 'Notes', titleState: 'ok' })
  })

  it('a retry that a newer PAGE_UPDATE overtook does not store the older row', async () => {
    rest.getPages.mockResolvedValueOnce([page('p-1')])
    await docsService.loadPages(CHANNEL)
    const hold = holdNextDecrypt()
    titles.set('env-p-1', 'Old')
    docsService.retry()
    await flush()
    titles.set('env-new', 'New')
    docsService.onPageEvent(
      page('p-1', { titleEnvelope: 'env-new', position: 2048, updatedAt: T2 })
    )
    await flush()
    expect(findPage('p-1')).toMatchObject({ title: 'New', position: 2048, updatedAt: T2 })
    hold.release()
    await flush()
    expect(findPage('p-1')).toMatchObject({ title: 'New', position: 2048, updatedAt: T2 })
  })

  it('a retry of an older row keeps the newer pending row for the next retry', async () => {
    rest.getPages.mockResolvedValueOnce([page('p-1')])
    await docsService.loadPages(CHANNEL)
    const hold = holdNextDecrypt()
    docsService.retry()
    await flush()
    // A rename in a group that this device has not joined yet.
    docsService.onPageEvent(page('p-1', { titleEnvelope: 'env-new', updatedAt: T2 }))
    await flush()
    titles.set('env-p-1', 'Old')
    hold.release()
    await flush()
    expect(findPage('p-1')).toMatchObject({ titleState: 'pending', updatedAt: T2 })
    titles.set('env-new', 'New')
    docsService.retry()
    await flush()
    expect(crypto.decryptDoc.mock.lastCall?.[0].map((it) => it.envelope)).toEqual(['env-new'])
    expect(findPage('p-1')).toMatchObject({ title: 'New', titleState: 'ok', updatedAt: T2 })
  })
})

describe('re-wrap pass', () => {
  it('a sign-out destroys its headless providers and stops it before the next page', async () => {
    channels.set(CHANNEL, { id: CHANNEL, type: 'pages', mlsGroupId: 'g-1' })
    rest.getPageHeads.mockResolvedValueOnce(
      ['p-1', 'p-2'].map((pageId) => ({
        pageId,
        latestSeq: 3,
        title: null,
        banner: null,
        snapshot: null
      }))
    )
    docsService.onUsersAdded({
      groupId: 'g-1',
      kind: 'channel',
      guildId: 'guild-1',
      channelId: CHANNEL,
      epoch: 2,
      userIds: ['u-9'],
      byMe: true
    })
    await flush()
    expect(providers.map((p) => p.pageId)).toEqual(['p-1'])
    docsService.reset()
    expect(providers[0]?.destroy).toHaveBeenCalledTimes(1)
    providers[0]?.finish()
    await flush()
    expect(providers.map((p) => p.pageId)).toEqual(['p-1'])
  })
})

describe('renamePage', () => {
  it('sends a clamped title, and nothing when the title does not change', async () => {
    titles.set('env-p-1', 'Notes')
    const row = page('p-1')
    rest.getPages.mockResolvedValueOnce([row])
    await docsService.loadPages(CHANNEL)
    rest.updatePage.mockImplementation(async (_id, body) => ({
      ...row,
      titleEnvelope: body.titleEnvelope ?? row.titleEnvelope,
      updatedAt: T2
    }))
    await docsService.renamePage('p-1', '  Notes ')
    expect(rest.updatePage).not.toHaveBeenCalled()
    await docsService.renamePage('p-1', 'é'.repeat(150))
    const sent = crypto.encryptDoc.mock.lastCall?.[0]
    expect(sent).toMatchObject({ pageId: 'p-1', kind: 'doc_title' })
    expect(sent?.bytes.length).toBe(200)
    expect(findPage('p-1')).toMatchObject({ title: 'é'.repeat(100), titleState: 'ok' })
    await docsService.renamePage('p-1', '   ')
    expect(new TextDecoder().decode(crypto.encryptDoc.mock.lastCall?.[0].bytes)).toBe('Untitled')
  })
})

describe('banners', () => {
  /** The fake Takusen: the PATCH gives the row with the banner envelope of the body. */
  function serve(row: Page): void {
    rest.updatePage.mockImplementation(async (_id, body) => {
      row = {
        ...row,
        bannerEnvelope:
          body.banner === undefined ? row.bannerEnvelope : (body.banner?.envelope ?? null),
        updatedAt: row.updatedAt === T1 ? T2 : '2026-10-06T10:00:02.000Z'
      }
      return row
    })
  }

  it('the page list decrypts the banners into the store', async () => {
    titles.set('env-p-1', 'Root')
    titles.set('benv', JSON.stringify(BANNER))
    rest.getPages.mockResolvedValueOnce([page('p-1', { bannerEnvelope: 'benv' })])
    await docsService.loadPages(CHANNEL)
    expect(findPage('p-1')).toMatchObject({ title: 'Root', bannerPending: false, banner: BANNER })
    expect(findPage('p-1')).not.toHaveProperty('bannerEnvelope')
  })

  it('setBanner uploads the prepared image and PATCHes the envelope with its upload ids', async () => {
    titles.set('env-p-1', 'Root')
    const root = page('p-1')
    rest.getPages.mockResolvedValueOnce([root])
    await docsService.loadPages(CHANNEL)
    serve(root)
    const original = new File([new Uint8Array(5)], 'IMG_0001.HEIC.jpg', { type: 'image/jpeg' })
    await docsService.setBanner('p-1', original)
    expect(upload.prepareBannerImage).toHaveBeenCalledWith(original)
    expect(upload.uploadAttachment.mock.calls[0]?.[0]).toBe(prepared)
    expect(crypto.encryptDoc).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL, pageId: 'p-1', kind: 'doc_banner' })
    )
    expect(rest.updatePage).toHaveBeenCalledWith('p-1', {
      banner: { envelope: expect.any(String), uploadIds: ['up-banner', 'up-thumb'] }
    })
    expect(findPage('p-1')).toMatchObject({ banner: BANNER, bannerPending: false })

    await docsService.removeBanner('p-1')
    expect(rest.updatePage).toHaveBeenLastCalledWith('p-1', { banner: null })
    expect(findPage('p-1')).toMatchObject({ banner: null, bannerPending: false })
  })

  it('setBanner rejects a sub-page or an orphan before any upload', async () => {
    rest.getPages.mockResolvedValueOnce([
      page('p-1'),
      page('p-2', { parentId: 'p-1' }),
      page('p-3', { parentId: 'gone' })
    ])
    await docsService.loadPages(CHANNEL)
    for (const id of ['p-2', 'p-3', 'p-9'])
      await expect(docsService.setBanner(id, prepared)).rejects.toThrow()
    expect(upload.prepareBannerImage).not.toHaveBeenCalled()
    expect(upload.uploadAttachment).not.toHaveBeenCalled()
    expect(rest.updatePage).not.toHaveBeenCalled()
  })

  it('setBanner sends no pointer that the members would drop', async () => {
    titles.set('env-p-1', 'Root')
    rest.getPages.mockResolvedValueOnce([page('p-1')])
    await docsService.loadPages(CHANNEL)
    upload.uploadAttachment.mockResolvedValueOnce({ ...BANNER, width: null, height: null })
    await expect(docsService.setBanner('p-1', prepared)).rejects.toThrow('cannot be used')
    expect(rest.updatePage).not.toHaveBeenCalled()
  })
})
