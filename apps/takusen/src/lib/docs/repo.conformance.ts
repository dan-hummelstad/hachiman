/**
 * One DocsRepo test suite for both implementations (repo.ts).
 * repo.in-memory.test.ts runs it on InMemoryDocsStore. A Postgres run can
 * reuse it with drizzleDocsRepo inside db.transaction and real fixture rows.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { before, describe, test } from 'node:test'

import { UnknownUploadError } from '@/lib/errors'

import type { DocsRepo, NewDocPage } from './repo'

export interface DocsFixtures {
  addUser(): Promise<string>
  addGuild(): Promise<string>
  /** A pages channel of the guild. */
  addChannel(guildId: string): Promise<string>
  /** An MLS group id that doc rows can point at. */
  addGroup(): Promise<Uint8Array>
  /** An encrypted upload of `uploaderId`. Default size 100, purpose null. */
  addUpload(u: { uploaderId: string; size?: number; purpose?: 'page_snapshot' | null; encrypted?: boolean }): Promise<string>
  uploadExists(id: string): Promise<boolean>
  storage(guildId: string): Promise<number>
}

export interface DocsRepoUnderTest {
  transaction<T>(fn: (repo: DocsRepo) => Promise<T>): Promise<T>
  fx: DocsFixtures
}

export function describeDocsRepo(name: string, open: () => Promise<DocsRepoUnderTest>): void {
  describe(`DocsRepo conformance: ${name}`, () => {
    let t: DocsRepoUnderTest
    let tx: DocsRepoUnderTest['transaction']
    let user: string
    let guild: string
    let channel: string
    let group: Uint8Array

    const page = (over: Partial<NewDocPage> = {}): NewDocPage => ({
      id: randomUUID(),
      channelId: channel,
      parentId: null,
      position: 0,
      titleEnvelope: new Uint8Array(randomBytes(8)),
      createdBy: user,
      ...over,
    })
    const addPage = async (over: Partial<NewDocPage> = {}) => (await tx((r) => r.insertPage(page(over))))!
    const update = (pageId: string, seq: number) => ({ pageId, seq, groupId: group, epoch: 1, senderDevice: null, envelope: new Uint8Array([seq]) })

    before(async () => {
      t = await open()
      tx = t.transaction
      user = await t.fx.addUser()
      guild = await t.fx.addGuild()
      channel = await t.fx.addChannel(guild)
      group = await t.fx.addGroup()
    })

    test('insertPage stores the row, a taken id gives null', async () => {
      const values = page()
      const row = await tx((r) => r.insertPage(values))
      assert.equal(row?.id, values.id)
      assert.equal(row?.latestSeq, 0)
      assert.equal(await tx((r) => r.insertPage(values)), null)
      assert.ok((await tx((r) => r.listPages(channel))).some((p) => p.id === values.id))
    })

    test('updatePage applies the patch', async () => {
      const a = await addPage()
      const at = new Date(Date.now() + 60_000)
      const row = await tx((r) => r.updatePage(a.id, { position: 3, updatedAt: at }))
      assert.equal(row?.position, 3)
      assert.equal(row?.updatedAt.getTime(), at.getTime())
      assert.equal(await tx((r) => r.updatePage(randomUUID(), { updatedAt: at })), null)
    })

    test('subtreeIds and deletePage take the whole subtree', async () => {
      const a = await addPage()
      const b = await addPage({ parentId: a.id })
      const c = await addPage({ parentId: b.id })
      const other = await addPage()
      assert.deepEqual((await tx((r) => r.subtreeIds(a.id))).sort(), [a.id, b.id, c.id].sort())
      assert.deepEqual(await tx((r) => r.subtreeIds(randomUUID())), [])
      await tx((r) => r.deletePage(a.id))
      for (const id of [a.id, b.id, c.id]) assert.equal(await tx((r) => r.getPage(id)), null)
      assert.ok(await tx((r) => r.getPage(other.id)))
    })

    test('nextSeq has no gaps under concurrent senders', async () => {
      const a = await addPage()
      const seqs = await Promise.all(
        Array.from({ length: 10 }, () =>
          tx(async (r) => {
            const seq = (await r.nextSeq(a.id))!
            await r.insertUpdate(update(a.id, seq))
            return seq
          }),
        ),
      )
      assert.deepEqual([...seqs].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      assert.equal((await tx((r) => r.getPage(a.id)))?.latestSeq, 10)
      assert.equal(await tx((r) => r.nextSeq(randomUUID())), null)
    })

    test('a rolled-back transaction gives its seq back', async () => {
      const a = await addPage()
      await assert.rejects(
        tx(async (r) => {
          await r.nextSeq(a.id)
          throw new Error('rollback')
        }),
      )
      assert.equal(await tx((r) => r.nextSeq(a.id)), 1)
    })

    test('listUpdates pages by seq, deleteUpdatesThrough trims the head', async () => {
      const a = await addPage()
      await tx(async (r) => {
        for (let i = 1; i <= 5; i++) await r.insertUpdate(update(a.id, (await r.nextSeq(a.id))!))
      })
      assert.deepEqual((await tx((r) => r.listUpdates(a.id, 1, 2))).map((u) => u.seq), [2, 3])
      await tx((r) => r.deleteUpdatesThrough(a.id, 3))
      assert.deepEqual((await tx((r) => r.listUpdates(a.id, 0, 10))).map((u) => u.seq), [4, 5])
    })

    test('claimSnapshotUpload takes only an unclaimed page_snapshot blob of the caller', async () => {
      const a = await addPage()
      const other = await t.fx.addUser()
      const plain = await t.fx.addUpload({ uploaderId: user, purpose: null })
      const notMine = await t.fx.addUpload({ uploaderId: other, purpose: 'page_snapshot' })
      const ok = await t.fx.addUpload({ uploaderId: user, purpose: 'page_snapshot', size: 321 })
      for (const id of [plain, notMine, randomUUID()]) {
        await assert.rejects(tx((r) => r.claimSnapshotUpload(a.id, id, user)), UnknownUploadError)
      }
      const blob = await tx((r) => r.claimSnapshotUpload(a.id, ok, user))
      assert.equal(blob.size, 321)
      await assert.rejects(tx((r) => r.claimSnapshotUpload(a.id, ok, user)), UnknownUploadError)
    })

    test('listSnapshots is newest first; deletePageUploads drops the snapshot and frees its bytes', async () => {
      const a = await addPage()
      await tx(async (r) => {
        for (let i = 0; i < 3; i++) await r.nextSeq(a.id)
      })
      const ids: string[] = []
      for (const baseSeq of [1, 3]) {
        const id = await t.fx.addUpload({ uploaderId: user, purpose: 'page_snapshot', size: 50 })
        ids.push(id)
        await tx(async (r) => {
          await r.claimSnapshotUpload(a.id, id, user)
          assert.equal(await r.addPageStorage(guild, 50, 0), true)
          await r.insertSnapshot({ pageId: a.id, baseSeq, uploadId: id, groupId: group, epoch: 1, senderDevice: null, envelope: new Uint8Array([1]), mediaUploadIds: [] })
        })
      }
      const before = await t.fx.storage(guild)
      const snaps = await tx((r) => r.listSnapshots(a.id))
      assert.deepEqual(snaps.map((s) => s.row.baseSeq), [3, 1])
      assert.equal(snaps[0]!.size, 50)
      const deleted = await tx((r) => r.deletePageUploads({ uploadIds: [ids[0]!] }))
      assert.equal(deleted.length, 1)
      assert.equal(await t.fx.uploadExists(ids[0]!), false)
      assert.deepEqual((await tx((r) => r.listSnapshots(a.id))).map((s) => s.row.baseSeq), [3])
      assert.equal(await t.fx.storage(guild), before - 50)
    })

    test('claimMediaUploads counts only new claims and refuses foreign uploads', async () => {
      const a = await addPage()
      const b = await addPage()
      const other = await t.fx.addUser()
      const m1 = await t.fx.addUpload({ uploaderId: user, size: 10 })
      const m2 = await t.fx.addUpload({ uploaderId: user, size: 20 })
      const theirs = await t.fx.addUpload({ uploaderId: other })
      const plain = await t.fx.addUpload({ uploaderId: user, encrypted: false })
      const snap = await t.fx.addUpload({ uploaderId: user, purpose: 'page_snapshot' })
      const now = new Date()
      assert.equal(await tx((r) => r.claimMediaUploads(a.id, [m1, m2], user, now)), 30)
      assert.equal(await tx((r) => r.claimMediaUploads(a.id, [m1], user, now)), 0)
      for (const id of [theirs, plain, snap, randomUUID()]) {
        await assert.rejects(tx((r) => r.claimMediaUploads(a.id, [id], user, now)), UnknownUploadError)
      }
      await assert.rejects(tx((r) => r.claimMediaUploads(b.id, [m1], user, now)), UnknownUploadError)
    })

    test('deletePageUploads by page frees the bytes of the guild', async () => {
      const g = await t.fx.addGuild()
      const ch = await t.fx.addChannel(g)
      const a = await addPage({ channelId: ch })
      const m = await t.fx.addUpload({ uploaderId: user, size: 70 })
      await tx(async (r) => {
        await r.claimMediaUploads(a.id, [m], user, new Date())
        await r.addPageStorage(g, 70, 0)
      })
      assert.equal(await t.fx.storage(g), 70)
      const deleted = await tx((r) => r.deletePageUploads({ pageIds: [a.id] }))
      assert.deepEqual(deleted.map((d) => d.size), [70])
      assert.equal(await t.fx.storage(g), 0)
      assert.equal(await t.fx.uploadExists(m), false)
    })

    test('addPageStorage keeps the limit, 0 is no limit', async () => {
      const g = await t.fx.addGuild()
      assert.equal(await tx((r) => r.addPageStorage(g, 60, 100)), true)
      assert.equal(await tx((r) => r.addPageStorage(g, 41, 100)), false)
      assert.equal(await t.fx.storage(g), 60)
      assert.equal(await tx((r) => r.addPageStorage(g, 40, 100)), true)
      assert.equal(await tx((r) => r.addPageStorage(g, 1000, 0)), true)
      assert.equal(await tx((r) => r.addPageStorage(g, -5000, 100)), true)
      assert.equal(await t.fx.storage(g), 0)
    })
  })
}
