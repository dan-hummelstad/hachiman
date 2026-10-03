/**
 * The pages delivery service (service.ts) on InMemoryDocsStore with a fake
 * acceptDocEnvelope: seq allocation, snapshot compare-and-set, quota, tree
 * moves, media claims and the route permission matrix.
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
import { claimMedia, createPage, deletePage, getPageState, postSnapshot, postUpdate, updatePage, type AcceptDocEnvelope } from './service'
import { createPageSchema, postSnapshotSchema } from './wire'

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
  let limits: DocsLimits
  const userId = randomUUID()
  const deviceId = randomUUID()

  beforeEach(() => {
    store = new InMemoryDocsStore()
    guildId = store.addGuild()
    channelId = store.addChannel(guildId)
    checks = []
    accept = async (input) => {
      checks.push(input)
      return { groupId: GROUP, epoch: 4, senderDeviceId: input.deviceId, size: input.envelope.length }
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
        store.transaction((r) => updatePage(r, accept, { page, userId, deviceId, body: { parentId: foreign.id }, now: new Date() })),
        ValidationError,
      )
    })

    test('a move into the own subtree is 400 PageCycle', async () => {
      const a = await newPage()
      const b = await newPage(a.id)
      const c = await newPage(b.id)
      for (const target of [a.id, b.id, c.id]) {
        await assert.rejects(
          store.transaction((r) => updatePage(r, accept, { page: a, userId, deviceId, body: { parentId: target }, now: new Date() })),
          apiCode('PageCycle'),
        )
      }
      const moved = await store.transaction((r) => updatePage(r, accept, { page: c, userId, deviceId, body: { parentId: null, position: 2 }, now: new Date() }))
      assert.equal(moved.parentId, null)
      assert.equal(moved.position, 2)
    })

    test('a rename checks a doc_title envelope and sets updated_at', async () => {
      const page = await newPage()
      const now = new Date(Date.now() + 5000)
      const title = env()
      const row = await store.transaction((r) => updatePage(r, accept, { page, userId, deviceId, body: { titleEnvelope: title }, now }))
      assert.equal(checks.at(-1)?.kind, 'doc_title')
      assert.deepEqual(row.titleEnvelope, title)
      assert.equal(row.updatedAt.getTime(), now.getTime())
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
