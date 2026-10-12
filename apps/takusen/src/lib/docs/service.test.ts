/**
 * The pages delivery service (service.ts) on InMemoryDocsStore with a fake
 * acceptDocEnvelope: seq allocation, snapshot compare-and-set, quota, tree
 * moves, media claims, the page banner and the route permission matrix.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { beforeEach, describe, test } from 'node:test'

import { Permissions } from '@hachiman/client/permissions'

import type { DocPageRow } from '@/db/schema'
import { ApiError, MissingPermissionsError, NotFoundError, UnknownUploadError, UploadTooLargeError, ValidationError } from '@/lib/errors'
import type { DocEnvelopeInput } from '@/lib/mls/envelopes'

import { checkPageAccess, type PageMode } from './access'
import { docsLimits, type DocsLimits } from './config'
import { InMemoryDocsStore } from './repo.in-memory'
import { claimMedia, createPage, deletePage, getPageState, listPageHeads, postSnapshot, postUpdate, updatePage, type AcceptDocEnvelope } from './service'
import { createPageSchema, postSnapshotSchema, toPage, toPageHead, updatePageSchema, type UpdatePageBody } from './wire'

const GROUP = new Uint8Array(16).fill(7)
const env = () => new Uint8Array(randomBytes(12))

function apiCode(code: string) {
  return (err: unknown) => err instanceof ApiError && err.code === code
}

describe('pages service', () => {
  let store: InMemoryDocsStore
  let guildId: string
  let channelId: string
  let checks: DocEnvelopeInput[]
  let accept: AcceptDocEnvelope
  /** The group and epoch that the fake accept gives (the current ones of the channel). */
  let group: Uint8Array
  let epoch: number
  let limits: DocsLimits
  const userId = randomUUID()
  const deviceId = randomUUID()

  beforeEach(() => {
    store = new InMemoryDocsStore()
    guildId = store.addGuild()
    channelId = store.addChannel(guildId)
    checks = []
    group = GROUP
    epoch = 4
    accept = async (input) => {
      checks.push(input)
      return { groupId: group, epoch, senderDeviceId: input.deviceId, size: input.envelope.length }
    }
    limits = { maxSnapshotBytes: 1000, guildStorageBytes: 500 }
  })

  const newPage = (parentId: string | null = null): Promise<DocPageRow> =>
    store.transaction((r) => createPage(r, accept, { channelId, userId, deviceId, body: { id: randomUUID(), parentId, position: 0, titleEnvelope: env() } }))
  const post = (page: DocPageRow) => store.transaction((r) => postUpdate(r, accept, { page, userId, deviceId, envelope: env() }))
  const snapshot = (page: DocPageRow, baseSeq: number, uploadId: string, mediaUploadIds: string[] = []) =>
    store.transaction((r) => postSnapshot(r, accept, { page, guildId, userId, deviceId, limits, body: { baseSeq, uploadId, envelope: env(), mediaUploadIds } }))
  const snapshotUpload = (size = 100) => store.addUpload({ uploaderId: userId, purpose: 'page_snapshot', size }).id

  describe('pages', () => {
    test('create checks the title envelope against the chosen id', async () => {
      const page = await newPage()
      assert.equal(checks[0]?.kind, 'doc_title')
      assert.equal(checks[0]?.pageId, page.id)
      assert.equal(page.createdBy, userId)
    })

    test('create with a taken id is 409 PageExists', async () => {
      const page = await newPage()
      await assert.rejects(
        store.transaction((r) => createPage(r, accept, { channelId, userId, deviceId, body: { id: page.id, parentId: null, position: 0, titleEnvelope: env() } })),
        apiCode('PageExists'),
      )
    })

    test('a parent of another channel is 400 ValidationError', async () => {
      const otherChannel = store.addChannel(guildId)
      const foreign = await store.transaction((r) =>
        createPage(r, accept, { channelId: otherChannel, userId, deviceId, body: { id: randomUUID(), parentId: null, position: 0, titleEnvelope: env() } }),
      )
      await assert.rejects(newPage(foreign.id), ValidationError)
      const page = await newPage()
      await assert.rejects(
        store.transaction((r) => updatePage(r, accept, { guildId, limits, page, userId, deviceId, body: { parentId: foreign.id }, now: new Date() })),
        ValidationError,
      )
    })

    test('a move into the own subtree is 400 PageCycle', async () => {
      const a = await newPage()
      const b = await newPage(a.id)
      const c = await newPage(b.id)
      for (const target of [a.id, b.id, c.id]) {
        await assert.rejects(
          store.transaction((r) => updatePage(r, accept, { guildId, limits, page: a, userId, deviceId, body: { parentId: target }, now: new Date() })),
          apiCode('PageCycle'),
        )
      }
      const moved = await store.transaction((r) => updatePage(r, accept, { guildId, limits, page: c, userId, deviceId, body: { parentId: null, position: 2 }, now: new Date() }))
      assert.equal(moved.parentId, null)
      assert.equal(moved.position, 2)
    })

    test('a rename checks a doc_title envelope and sets updated_at', async () => {
      const page = await newPage()
      const now = new Date(Date.now() + 5000)
      const title = env()
      const row = await store.transaction((r) => updatePage(r, accept, { guildId, limits, page, userId, deviceId, body: { titleEnvelope: title }, now }))
      assert.equal(checks.at(-1)?.kind, 'doc_title')
      assert.deepEqual(row.titleEnvelope, title)
      assert.equal(row.updatedAt.getTime(), now.getTime())
    })

    test('ifUpdatedAt makes the PATCH a compare-and-set', async () => {
      const page = await newPage()
      const title = env()
      const patch = (ifUpdatedAt: string, now: Date) =>
        store.transaction((r) => updatePage(r, accept, { guildId, limits, page, userId, deviceId, body: { titleEnvelope: title, ifUpdatedAt }, now }))
      const renamed = await patch(page.updatedAt.toISOString(), new Date(page.updatedAt.getTime() + 1000))
      assert.deepEqual(renamed.titleEnvelope, title)
      // A second re-wrap that read the old row loses, and changes nothing.
      await assert.rejects(patch(page.updatedAt.toISOString(), new Date(page.updatedAt.getTime() + 2000)), apiCode('PageConflict'))
      assert.equal(store.state.pages.get(page.id)?.updatedAt.getTime(), renamed.updatedAt.getTime())
    })

    test('delete takes the subtree, its uploads and their bytes', async () => {
      const a = await newPage()
      const b = await newPage(a.id)
      const media = store.addUpload({ uploaderId: userId, size: 40 })
      await store.transaction((r) => claimMedia(r, { page: b, guildId, userId, uploadIds: [media.id], now: new Date(), limits }))
      await post(b)
      const snap = snapshotUpload(60)
      await snapshot({ ...b, latestSeq: 1 }, 1, snap)
      assert.equal(store.storage(guildId), 100)

      const { ids, keys } = await store.transaction((r) => deletePage(r, a))
      assert.deepEqual(ids.sort(), [a.id, b.id].sort())
      assert.deepEqual(keys.sort(), [media.key, `${snap}/blob`].sort())
      assert.equal(store.storage(guildId), 0)
      assert.equal(store.state.pages.size, 0)
      assert.equal(store.state.uploads.size, 0)
      assert.equal(store.state.updates.length, 0)
      assert.equal(store.state.snapshots.length, 0)
    })
  })

  describe('banner', () => {
    const KIND_BYTE = { doc_update: 1, doc_snapshot: 2, doc_title: 4, doc_banner: 5 } as const
    /** An envelope whose first byte is its kind, which the typed accept checks as the header kind. */
    const typed = (kind: keyof typeof KIND_BYTE) => new Uint8Array([KIND_BYTE[kind], ...randomBytes(11)])
    const other = { userId: randomUUID(), deviceId: randomUUID() }

    beforeEach(() => {
      const loose = accept
      accept = async (input) => {
        if (input.envelope[0] !== KIND_BYTE[input.kind]) throw new ApiError('InvalidEnvelope', 400, `the route takes a ${input.kind} envelope`)
        return loose(input)
      }
    })

    const root = () =>
      store.transaction((r) => createPage(r, accept, { channelId, userId, deviceId, body: { id: randomUUID(), parentId: null, position: 0, titleEnvelope: typed('doc_title') } }))
    const child = (parentId: string) =>
      store.transaction((r) => createPage(r, accept, { channelId, userId, deviceId, body: { id: randomUUID(), parentId, position: 0, titleEnvelope: typed('doc_title') } }))
    const patch = (page: DocPageRow, body: UpdatePageBody, now = new Date(), by = { userId, deviceId }) =>
      store.transaction((r) => updatePage(r, accept, { guildId, limits, page, ...by, body, now }))
    const media = (size = 100, uploaderId = userId) => store.addUpload({ uploaderId, size }).id
    const upload = (id: string) => store.state.uploads.get(id)
    const stored = (page: DocPageRow) => store.state.pages.get(page.id)!

    test('a banner on a top-level page claims its uploads, adds their bytes and checks a doc_banner envelope', async () => {
      const page = await root()
      const [image, thumb] = [media(100), media(50)]
      const envelope = typed('doc_banner')
      const now = new Date(Date.now() + 1000)
      const row = await patch(page, { banner: { envelope, uploadIds: [image, thumb] } }, now)
      assert.equal(checks.at(-1)?.kind, 'doc_banner')
      assert.equal(checks.at(-1)?.pageId, page.id)
      assert.deepEqual(row.bannerEnvelope, envelope)
      assert.deepEqual(row.bannerUploadIds, [image, thumb])
      assert.equal(row.updatedAt.getTime(), now.getTime())
      for (const id of [image, thumb]) {
        assert.equal(upload(id)?.purpose, 'page_media')
        assert.equal(upload(id)?.pageId, page.id)
      }
      assert.equal(store.storage(guildId), 150)
      const wire = toPage(row)
      assert.equal(wire.bannerEnvelope, Buffer.from(envelope).toString('base64url'))
      assert.ok(!('bannerUploadIds' in wire), 'the ids stay on the server')
      assert.equal(toPage(page).bannerEnvelope, null)
    })

    test('a banner on a sub-page, or with a move under a page, is 400 and stores nothing', async () => {
      const a = await root()
      const b = await child(a.id)
      const other = await root()
      const id = media()
      await assert.rejects(patch(b, { banner: { envelope: typed('doc_banner'), uploadIds: [id] } }), ValidationError)
      await assert.rejects(patch(a, { parentId: other.id, banner: { envelope: typed('doc_banner'), uploadIds: [id] } }), ValidationError)
      assert.equal(upload(id)?.purpose, null)
      assert.equal(stored(a).parentId, null)
      assert.equal(store.storage(guildId), 0)
      // A sub-page that moves to the top level can take a banner in the same PATCH.
      const moved = await patch(b, { parentId: null, banner: { envelope: typed('doc_banner'), uploadIds: [id] } })
      assert.equal(moved.parentId, null)
      assert.deepEqual(moved.bannerUploadIds, [id])
    })

    test('a title envelope sent as a banner is 400 InvalidEnvelope', async () => {
      const page = await root()
      const id = media()
      await assert.rejects(patch(page, { banner: { envelope: typed('doc_title'), uploadIds: [id] } }), apiCode('InvalidEnvelope'))
      assert.equal(stored(page).bannerEnvelope, null)
      assert.equal(upload(id)?.purpose, null)
    })

    test('a claim over the quota is 413 StorageQuotaExceeded and stores nothing', async () => {
      const page = await root()
      const [image, thumb] = [media(400), media(101)]
      const title = typed('doc_title')
      await assert.rejects(patch(page, { titleEnvelope: title, banner: { envelope: typed('doc_banner'), uploadIds: [image, thumb] } }), apiCode('StorageQuotaExceeded'))
      assert.equal(stored(page).bannerEnvelope, null)
      assert.notDeepEqual(stored(page).titleEnvelope, title)
      assert.equal(upload(image)?.purpose, null)
      assert.equal(store.storage(guildId), 0)
    })

    test('an upload of another user or of another page is 400 UnknownUpload', async () => {
      const page = await root()
      const elsewhere = await root()
      const ofElsewhere = media()
      await patch(elsewhere, { banner: { envelope: typed('doc_banner'), uploadIds: [ofElsewhere] } })
      for (const id of [media(100, randomUUID()), ofElsewhere, randomUUID()]) {
        await assert.rejects(patch(page, { banner: { envelope: typed('doc_banner'), uploadIds: [id] } }), UnknownUploadError)
      }
      assert.equal(stored(page).bannerEnvelope, null)
    })

    test('a re-wrap by another member (no uploadIds) keeps the stored ids and claims nothing', async () => {
      const page = await root()
      const [image, thumb] = [media(), media()]
      const set = await patch(page, { banner: { envelope: typed('doc_banner'), uploadIds: [image, thumb] } })
      const storage = store.storage(guildId)
      epoch = 5
      const envelope = typed('doc_banner')
      const rewrapped = await patch(page, { banner: { envelope }, ifUpdatedAt: set.updatedAt.toISOString() }, new Date(set.updatedAt.getTime() + 1000), other)
      assert.deepEqual(rewrapped.bannerEnvelope, envelope)
      assert.deepEqual(rewrapped.bannerUploadIds, [image, thumb])
      assert.equal(checks.at(-1)?.userId, other.userId)
      assert.equal(store.storage(guildId), storage)
      // A second re-wrap that read the old row loses.
      await assert.rejects(patch(page, { banner: { envelope: typed('doc_banner') }, ifUpdatedAt: set.updatedAt.toISOString() }, new Date(), other), apiCode('PageConflict'))
      assert.deepEqual(stored(page).bannerEnvelope, envelope)
    })

    test('a re-wrap without uploadIds on a page with no banner is 400 ValidationError', async () => {
      const page = await root()
      await assert.rejects(patch(page, { banner: { envelope: typed('doc_banner') } }), ValidationError)
      assert.equal(stored(page).bannerEnvelope, null)
    })

    test('a replacement claims only the new ids; it and a removal touch the dropped ids', async () => {
      const page = await root()
      const [m1, m2, m3] = [media(10), media(20), media(30)]
      const [t1, t2, t3] = [new Date(1_000_000), new Date(2_000_000), new Date(3_000_000)]
      await patch(page, { banner: { envelope: typed('doc_banner'), uploadIds: [m1, m2] } }, t1)
      assert.equal(store.storage(guildId), 30)

      const replaced = await patch(page, { banner: { envelope: typed('doc_banner'), uploadIds: [m2, m3] } }, t2)
      assert.deepEqual(replaced.bannerUploadIds, [m2, m3])
      assert.equal(store.storage(guildId), 60)
      assert.equal(upload(m1)?.lastReferencedAt?.getTime(), t2.getTime(), 'dropped')
      assert.equal(upload(m2)?.lastReferencedAt?.getTime(), t1.getTime(), 'kept, no new claim')
      assert.equal(upload(m3)?.lastReferencedAt?.getTime(), t2.getTime(), 'claimed')

      const removed = await patch(page, { banner: null }, t3)
      assert.equal(removed.bannerEnvelope, null)
      assert.deepEqual(removed.bannerUploadIds, [])
      for (const id of [m2, m3]) assert.equal(upload(id)?.lastReferencedAt?.getTime(), t3.getTime())
      assert.equal(upload(m1)?.lastReferencedAt?.getTime(), t2.getTime())
      // The uploads stay for the undo window of the sweep, and so do their bytes.
      assert.ok([m1, m2, m3].every((id) => upload(id)?.purpose === 'page_media'))
      assert.equal(store.storage(guildId), 60)
      // A removal on a page with no banner changes nothing but updated_at.
      assert.equal((await patch(page, { banner: null }, new Date(4_000_000))).bannerEnvelope, null)
    })

    test('a move under a page clears the banner and touches its ids', async () => {
      const a = await root()
      const b = await root()
      const id = media()
      await patch(a, { banner: { envelope: typed('doc_banner'), uploadIds: [id] } }, new Date(1_000_000))
      const at = new Date(2_000_000)
      const moved = await patch(a, { parentId: b.id }, at)
      assert.equal(moved.parentId, b.id)
      assert.equal(moved.bannerEnvelope, null)
      assert.deepEqual(moved.bannerUploadIds, [])
      assert.equal(upload(id)?.lastReferencedAt?.getTime(), at.getTime())
      assert.equal(toPage(moved).bannerEnvelope, null)
      // A move back to the top level does not bring the banner back.
      assert.equal((await patch(a, { parentId: null })).bannerEnvelope, null)
    })

    test('a reorder or a rename keeps the banner', async () => {
      const page = await root()
      const id = media()
      const set = await patch(page, { banner: { envelope: typed('doc_banner'), uploadIds: [id] } })
      const row = await patch(page, { position: 4, titleEnvelope: typed('doc_title') })
      assert.deepEqual(row.bannerEnvelope, set.bannerEnvelope)
      assert.deepEqual(row.bannerUploadIds, [id])
    })

    test('deleting a top-level page with a banner deletes the banner uploads and gives back their quota', async () => {
      const a = await root()
      await child(a.id)
      const [image, thumb] = [media(70), media(30)]
      await patch(a, { banner: { envelope: typed('doc_banner'), uploadIds: [image, thumb] } })
      assert.equal(store.storage(guildId), 100)
      const { keys } = await store.transaction((r) => deletePage(r, a))
      assert.deepEqual(keys.sort(), [`${image}/blob`, `${thumb}/blob`].sort())
      assert.equal(store.storage(guildId), 0)
      assert.equal(store.state.uploads.size, 0)
    })
  })

  describe('updates', () => {
    test('seq increases from 1 with no gaps under concurrent senders', async () => {
      const page = await newPage()
      const rows = await Promise.all(Array.from({ length: 25 }, () => post(page)))
      assert.deepEqual(rows.map((r) => r.seq).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1))
      assert.ok(checks.filter((c) => c.kind === 'doc_update').every((c) => c.pageId === page.id && c.channelId === channelId))
    })

    test('a rejected envelope takes no seq', async () => {
      const page = await newPage()
      const refuse: AcceptDocEnvelope = async () => {
        throw new ApiError('StaleEpoch', 409, undefined, { epoch: 5 })
      }
      await assert.rejects(store.transaction((r) => postUpdate(r, refuse, { page, userId, deviceId, envelope: env() })), apiCode('StaleEpoch'))
      assert.equal((await post(page)).seq, 1)
    })

    test('the row stores the header fields of the check', async () => {
      const page = await newPage()
      const row = await post(page)
      assert.deepEqual(row.groupId, GROUP)
      assert.equal(row.epoch, 4)
      assert.equal(row.senderDevice, deviceId)
    })
  })

  describe('snapshots', () => {
    async function pageWith(n: number): Promise<DocPageRow> {
      const page = await newPage()
      for (let i = 0; i < n; i++) await post(page)
      return (await store.transaction((r) => r.getPage(page.id)))!
    }

    test('compare-and-set: baseSeq above the current one and at most latest_seq', async () => {
      const page = await pageWith(5)
      await assert.rejects(snapshot(page, 6, snapshotUpload()), (err) => apiCode('SnapshotConflict')(err) && (err as ApiError).extra?.baseSeq === 0)
      await snapshot(page, 3, snapshotUpload())
      for (const baseSeq of [3, 2]) {
        const loser = snapshotUpload()
        await assert.rejects(snapshot(page, baseSeq, loser), (err) => apiCode('SnapshotConflict')(err) && (err as ApiError).extra?.baseSeq === 3)
        // The upload of the loser stays unclaimed.
        assert.equal(store.state.uploads.get(loser)?.pageId, null)
      }
    })

    test('keeps the previous snapshot, a third deletes the oldest and its upload', async () => {
      const page = await pageWith(9)
      const [u1, u2, u3] = [snapshotUpload(), snapshotUpload(), snapshotUpload()]
      assert.deepEqual((await snapshot(page, 3, u1!)).keys, [])
      const second = await snapshot(page, 6, u2!)
      assert.deepEqual(second.keys, [])
      // The previous snapshot (3) stays, and so do the updates after it.
      assert.deepEqual(store.state.updates.map((u) => u.seq).sort((a, b) => a - b), [4, 5, 6, 7, 8, 9])
      const third = await snapshot(page, 9, u3!, [randomUUID()])
      assert.deepEqual(third.keys, [`${u1}/blob`])
      assert.equal(store.state.uploads.has(u1!), false)
      assert.deepEqual(store.state.snapshots.map((s) => s.baseSeq).sort((a, b) => a - b), [6, 9])
      assert.deepEqual(store.state.updates.map((u) => u.seq), [7, 8, 9])
      assert.equal(store.storage(guildId), 200)
      assert.equal(third.snapshot.row.mediaUploadIds.length, 1)
      assert.equal(checks.filter((c) => c.kind === 'doc_snapshot').length, 3)

      const state = await getPageState(store.repo(), (await store.transaction((r) => r.getPage(page.id)))!)
      assert.equal(state.snapshot?.row.baseSeq, 9)
      assert.deepEqual(state.updates, [])
      assert.equal(state.latestSeq, 9)
    })

    test('the blob must be an unclaimed page_snapshot upload of the caller', async () => {
      const page = await pageWith(2)
      const blob = store.addUpload({ uploaderId: userId, purpose: null }).id
      const theirs = store.addUpload({ uploaderId: randomUUID(), purpose: 'page_snapshot' }).id
      for (const id of [blob, theirs]) await assert.rejects(snapshot(page, 1, id), UnknownUploadError)
      assert.equal(store.state.snapshots.length, 0)
    })

    test('a blob above TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES is 413 and stores nothing', async () => {
      const page = await pageWith(1)
      const big = snapshotUpload(1001)
      await assert.rejects(snapshot(page, 1, big), UploadTooLargeError)
      assert.equal(store.state.uploads.get(big)?.pageId, null)
      assert.equal(store.state.snapshots.length, 0)
    })

    test('a snapshot above the guild quota is 413 StorageQuotaExceeded', async () => {
      const page = await pageWith(1)
      const id = snapshotUpload(501)
      await assert.rejects(snapshot(page, 1, id), apiCode('StorageQuotaExceeded'))
      assert.equal(store.storage(guildId), 0)
      assert.equal(store.state.uploads.get(id)?.pageId, null)
    })
  })

  describe('snapshot re-wrap', () => {
    const other = { userId: randomUUID(), deviceId: randomUUID() }
    const rewrap = (page: DocPageRow, baseSeq: number, uploadId: string, by = other, envelope = env()) =>
      store.transaction((r) => postSnapshot(r, accept, { page, guildId, ...by, limits, body: { baseSeq, uploadId, envelope, mediaUploadIds: [] } }))

    /** A page with two snapshots (2 and 4) and an update after each. */
    async function pageWithSnapshots(): Promise<{ page: DocPageRow; first: string; newest: string; media: string }> {
      const page = await newPage()
      for (let i = 0; i < 5; i++) await post(page)
      const fresh = (await store.transaction((r) => r.getPage(page.id)))!
      const [first, newest, media] = [snapshotUpload(), snapshotUpload(), randomUUID()]
      await snapshot(fresh, 2, first)
      await snapshot(fresh, 4, newest, [media])
      return { page: fresh, first, newest, media }
    }

    test('the newest baseSeq and uploadId in a newer epoch replace the pointer envelope only', async () => {
      const { page, first, newest, media } = await pageWithSnapshots()
      const storage = store.storage(guildId)
      const updates = store.state.updates.map((u) => u.seq)
      epoch = 5
      const envelope = env()
      const out = await rewrap(page, 4, newest, other, envelope)
      assert.deepEqual(out.keys, [])
      assert.equal(out.snapshot.row.epoch, 5)
      assert.equal(out.snapshot.row.senderDevice, other.deviceId)
      assert.deepEqual(out.snapshot.row.envelope, envelope)
      assert.equal(out.snapshot.key, `${newest}/blob`)
      assert.equal(checks.at(-1)?.kind, 'doc_snapshot')
      // No claim, no quota change, no delete; the media references stay.
      assert.deepEqual(out.snapshot.row.mediaUploadIds, [media])
      assert.equal(store.storage(guildId), storage)
      assert.deepEqual(store.state.updates.map((u) => u.seq), updates)
      assert.ok(store.state.uploads.has(first) && store.state.uploads.has(newest))
      assert.deepEqual(store.state.snapshots.map((s) => s.baseSeq).sort((a, b) => a - b), [2, 4])
      assert.equal((await getPageState(store.repo(), page)).snapshot?.row.epoch, 5)
    })

    test('the same epoch, an older epoch or another uploadId is 409 SnapshotConflict', async () => {
      const { page, first, newest } = await pageWithSnapshots()
      const conflict = (err: unknown) => apiCode('SnapshotConflict')(err) && (err as ApiError).extra?.baseSeq === 4
      await assert.rejects(rewrap(page, 4, newest), conflict)
      epoch = 3
      await assert.rejects(rewrap(page, 4, newest), conflict)
      epoch = 5
      await assert.rejects(rewrap(page, 4, first), conflict)
      await assert.rejects(rewrap(page, 4, snapshotUpload()), conflict)
      assert.equal(store.state.snapshots.find((s) => s.baseSeq === 4)?.epoch, 4)
    })

    test('another group is a re-wrap at any epoch', async () => {
      const { page, newest } = await pageWithSnapshots()
      group = new Uint8Array(16).fill(9)
      epoch = 1
      const out = await rewrap(page, 4, newest)
      assert.deepEqual(out.snapshot.row.groupId, group)
      assert.equal(out.snapshot.row.epoch, 1)
    })

    test('of two concurrent re-wraps in one epoch, exactly one wins', async () => {
      const { page, newest } = await pageWithSnapshots()
      epoch = 6
      const results = await Promise.allSettled([rewrap(page, 4, newest), rewrap(page, 4, newest, { userId, deviceId })])
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
      const lost = results.find((r) => r.status === 'rejected')
      assert.ok(lost && apiCode('SnapshotConflict')(lost.reason))
    })

    test('a page without a snapshot has nothing to re-wrap', async () => {
      const page = await newPage()
      await post(page)
      const before = checks.length
      await assert.rejects(rewrap(page, 0, snapshotUpload()), apiCode('SnapshotConflict'))
      assert.equal(checks.length, before)
    })
  })

  describe('heads', () => {
    const parse = {
      parseDocEnvelopeHeader(envelope: Uint8Array) {
        if (envelope[0] === 0) throw new Error('malformed')
        return { kind: 'doc_title' as const, groupId: GROUP, channelId, pageId: '', epoch: envelope[0]!, senderLeaf: 0, senderDeviceId: deviceId, salt: new Uint8Array(32) }
      },
    }

    test('gives the title and banner epochs, latest_seq and the newest snapshot of each page', async () => {
      const a = await newPage()
      const b = await newPage()
      const c = await newPage()
      for (let i = 0; i < 3; i++) await post(a)
      const fresh = (await store.transaction((r) => r.getPage(a.id)))!
      await snapshot(fresh, 1, snapshotUpload())
      await snapshot(fresh, 2, snapshotUpload())
      await store.transaction((r) => r.updatePage(b.id, { titleEnvelope: new Uint8Array([3, 1]), updatedAt: new Date() }))
      await store.transaction((r) => r.updatePage(c.id, { titleEnvelope: new Uint8Array([0]), updatedAt: new Date() }))
      await store.transaction((r) => r.updatePage(a.id, { titleEnvelope: new Uint8Array([7]), bannerEnvelope: new Uint8Array([9]), updatedAt: new Date() }))
      await store.transaction((r) => r.updatePage(c.id, { bannerEnvelope: new Uint8Array([0]), updatedAt: new Date() }))
      store.addChannel(guildId)

      const heads = new Map((await listPageHeads(store.repo(), parse, channelId)).map(toPageHead).map((h) => [h.pageId, h]))
      assert.equal(heads.size, 3)
      assert.equal(heads.get(a.id)?.latestSeq, 3)
      assert.equal(heads.get(a.id)?.snapshot?.baseSeq, 2)
      assert.deepEqual(heads.get(a.id)?.title, { groupId: Buffer.from(GROUP).toString('base64url'), epoch: 7 })
      assert.deepEqual(heads.get(a.id)?.banner, { groupId: Buffer.from(GROUP).toString('base64url'), epoch: 9 })
      assert.equal(heads.get(b.id)?.snapshot, null)
      assert.equal(heads.get(b.id)?.title?.epoch, 3)
      assert.equal(heads.get(b.id)?.banner, null, 'no banner')
      assert.equal(heads.get(c.id)?.title, null)
      assert.equal(heads.get(c.id)?.banner, null, 'a banner header that does not decode')
    })
  })

  describe('media', () => {
    test('a new claim adds its bytes, a refresh adds none and sets last_referenced_at', async () => {
      const page = await newPage()
      const m = store.addUpload({ uploaderId: userId, size: 200 })
      const t1 = new Date(1_000_000)
      const t2 = new Date(2_000_000)
      await store.transaction((r) => claimMedia(r, { page, guildId, userId, uploadIds: [m.id], now: t1, limits }))
      assert.equal(store.storage(guildId), 200)
      assert.equal(store.state.uploads.get(m.id)?.purpose, 'page_media')
      await store.transaction((r) => claimMedia(r, { page, guildId, userId, uploadIds: [m.id], now: t2, limits }))
      assert.equal(store.storage(guildId), 200)
      assert.equal(store.state.uploads.get(m.id)?.lastReferencedAt?.getTime(), t2.getTime())
    })

    test('a claim over the quota is 413 and claims nothing', async () => {
      const page = await newPage()
      const a = store.addUpload({ uploaderId: userId, size: 300 })
      const b = store.addUpload({ uploaderId: userId, size: 300 })
      await assert.rejects(store.transaction((r) => claimMedia(r, { page, guildId, userId, uploadIds: [a.id, b.id], now: new Date(), limits })), apiCode('StorageQuotaExceeded'))
      assert.equal(store.storage(guildId), 0)
      assert.equal(store.state.uploads.get(a.id)?.purpose, null)
      await store.transaction((r) => claimMedia(r, { page, guildId, userId, uploadIds: [a.id], now: new Date(), limits: { ...limits, guildStorageBytes: 0 } }))
      assert.equal(store.storage(guildId), 300)
    })

    test('an upload of another user or of another page is 400 UnknownUpload', async () => {
      const a = await newPage()
      const b = await newPage()
      const theirs = store.addUpload({ uploaderId: randomUUID() })
      const ofB = store.addUpload({ uploaderId: userId })
      await store.transaction((r) => claimMedia(r, { page: b, guildId, userId, uploadIds: [ofB.id], now: new Date(), limits }))
      for (const id of [theirs.id, ofB.id]) {
        await assert.rejects(store.transaction((r) => claimMedia(r, { page: a, guildId, userId, uploadIds: [id], now: new Date(), limits })), UnknownUploadError)
      }
    })
  })
})

describe('page route permissions', () => {
  const VIEW = Permissions.VIEW_CHANNEL
  const SEND = Permissions.SEND_MESSAGES
  const cases: { perms: number; mode: PageMode; type: string; expect: 'ok' | typeof NotFoundError | typeof MissingPermissionsError | 'NotPagesChannel' }[] = [
    { perms: VIEW, mode: 'read', type: 'pages', expect: 'ok' },
    { perms: VIEW, mode: 'write', type: 'pages', expect: MissingPermissionsError },
    { perms: VIEW | SEND, mode: 'write', type: 'pages', expect: 'ok' },
    { perms: SEND, mode: 'read', type: 'pages', expect: NotFoundError },
    { perms: SEND, mode: 'write', type: 'pages', expect: NotFoundError },
    { perms: VIEW | SEND, mode: 'read', type: 'text', expect: 'NotPagesChannel' },
    { perms: VIEW | SEND, mode: 'write', type: 'voice', expect: 'NotPagesChannel' },
  ]
  for (const c of cases) {
    test(`${c.type} perms=${c.perms} ${c.mode}`, () => {
      const run = () => checkPageAccess(c.type, c.perms, c.mode)
      if (c.expect === 'ok') run()
      else if (c.expect === 'NotPagesChannel') assert.throws(run, apiCode('NotPagesChannel'))
      else assert.throws(run, c.expect)
    })
  }
})

describe('page bodies and limits', () => {
  test('createPage needs a uuid and a base64url title', () => {
    assert.equal(createPageSchema.safeParse({ id: 'x', parentId: null, titleEnvelope: 'AAAA' }).success, false)
    assert.equal(createPageSchema.safeParse({ id: randomUUID(), parentId: null, titleEnvelope: '!!' }).success, false)
    assert.equal(createPageSchema.safeParse({ id: randomUUID(), parentId: null, titleEnvelope: 'AAAA' }).success, true)
  })

  test('ifUpdatedAt is an ISO date', () => {
    assert.equal(updatePageSchema.safeParse({ ifUpdatedAt: '2026-10-06T10:00:00.123Z' }).success, true)
    assert.equal(updatePageSchema.safeParse({ ifUpdatedAt: 'yesterday' }).success, false)
  })

  test('banner is an envelope with 1 to 2 unique upload ids, an envelope alone, or null', () => {
    const [a, b] = [randomUUID(), randomUUID()]
    const ok = (banner: unknown) => updatePageSchema.safeParse({ banner }).success
    assert.equal(ok({ envelope: 'AAAA', uploadIds: [a] }), true)
    assert.equal(ok({ envelope: 'AAAA', uploadIds: [a, b] }), true)
    assert.equal(ok({ envelope: 'AAAA' }), true)
    assert.equal(ok(null), true)
    assert.equal(ok({ envelope: 'AAAA', uploadIds: [] }), false)
    assert.equal(ok({ envelope: 'AAAA', uploadIds: [a, b, randomUUID()] }), false)
    assert.equal(ok({ envelope: 'AAAA', uploadIds: [a, a] }), false)
    assert.equal(ok({ envelope: 'AAAA', uploadIds: ['x'] }), false)
    assert.equal(ok({ uploadIds: [a] }), false)
    assert.equal(ok({ envelope: 'AAAA', uploadIds: [a], focusY: 0.5 }), false, 'strict')
    assert.equal(updatePageSchema.safeParse({ bannerUploadIds: [a] }).success, false, 'strict')
  })

  test('a snapshot lists at most 1000 media ids, without duplicates', () => {
    const base = { baseSeq: 1, uploadId: randomUUID(), envelope: 'AAAA' }
    const id = randomUUID()
    assert.equal(postSnapshotSchema.safeParse({ ...base, mediaUploadIds: [id, id] }).success, false)
    assert.equal(postSnapshotSchema.safeParse({ ...base, mediaUploadIds: Array.from({ length: 1001 }, () => randomUUID()) }).success, false)
    assert.equal(postSnapshotSchema.safeParse({ ...base, mediaUploadIds: Array.from({ length: 1000 }, () => randomUUID()) }).success, true)
  })

  test('docsLimits reads the env, 0 is no guild limit', () => {
    assert.deepEqual(docsLimits({}), { maxSnapshotBytes: 104857600, guildStorageBytes: 10737418240 })
    assert.deepEqual(docsLimits({ TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES: '10', TAKUSEN_GUILD_PAGE_STORAGE_BYTES: '0' }), { maxSnapshotBytes: 10, guildStorageBytes: 0 })
    assert.throws(() => docsLimits({ TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES: '0' }))
  })
})
