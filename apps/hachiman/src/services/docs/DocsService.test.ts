import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Permissions, type Channel, type Page, type PageHead } from '@hachiman/client'
import type { CryptoEvents, DocDecryptResult, EncryptedDocItem } from '@hachiman/crypto'
import { useCryptoStore } from '@/stores/cryptoStore'
import { findPage } from '@/stores/docsStore'

const CHANNEL = 'c-1'
const T1 = '2026-10-06T10:00:00.000Z'
const T2 = '2026-10-06T10:00:01.000Z'
const utf8 = new TextEncoder()

/** envelope → title: an envelope that is not here is of a group that this device has not joined. */
const titles = new Map<string, string>()
const decrypt = (items: EncryptedDocItem[]): DocDecryptResult[] =>
  items.map((it): DocDecryptResult => {
    const title = titles.get(it.envelope)
    if (title === undefined) return { status: 'pending', id: it.id, reason: 'group_unknown' }
    return {
      status: 'ok',
      id: it.id,
      kind: 'doc_title',
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
  ensureChannelGroup: vi.fn(async () => ({ groupId: 'g-1', epoch: 2 }))
}
const rest = {
  getPages: vi.fn<(channelId: string) => Promise<Page[]>>(async () => []),
  getPageHeads: vi.fn<(channelId: string) => Promise<PageHead[]>>(async () => [])
}
const channels = new Map<string, Pick<Channel, 'id' | 'type' | 'mlsGroupId'>>()
const CAN_WRITE = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES
vi.mock('@/services/hachiman', () => ({
  hachiman: { rest, cache: { channels }, permissionsFor: () => CAN_WRITE }
}))
vi.mock('@/services/CryptoService', () => ({ cryptoService: { client: () => crypto } }))

interface FakeProvider {
  pageId: string
  snapshotIfNeeded: () => Promise<void>
  destroy: () => void
  finish: () => void
}
const providers: FakeProvider[] = []
vi.mock('./DocProvider', () => ({
  createDocProvider: (_channelId: string, pageId: string, deps: { headless?: boolean }) => {
    if (!deps.headless) throw new Error('only the re-wrap pass makes providers here')
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

/** The next decrypt waits for release(). */
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
      ['p-1', 'p-2'].map((pageId) => ({ pageId, latestSeq: 3, title: null, snapshot: null }))
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
