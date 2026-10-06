/**
 * One InviteHistoryStore test suite for both implementations
 * (invite-history.ts). invite-history.test.ts runs it on
 * InMemoryInviteHistoryStore, and invite-history.pg.test.ts on
 * drizzleInviteHistoryStore with a real Postgres.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { InviteRow } from '@/db/schema'

import type { InviteHistoryStore, NewInviteBundle } from './invite-history'

export interface InviteSeed {
  guildId: string
  createdBy: string
  /** A random record and key id. */
  history?: boolean
  expiresAt?: Date | null
  maxUses?: number | null
  uses?: number
  revoked?: boolean
  exhaustedAt?: Date | null
}

export interface InviteHistoryFixtures {
  addUser(): Promise<string>
  addGuild(ownerId: string): Promise<string>
  addInvite(seed: InviteSeed): Promise<InviteRow>
}

const HOUR_MS = 3_600_000

export function historySeed(): { record: Uint8Array; keyId: Uint8Array } {
  return { record: new Uint8Array(randomBytes(40)), keyId: new Uint8Array(randomBytes(32)) }
}

export interface StoreUnderTest {
  store: InviteHistoryStore
  fx: InviteHistoryFixtures
  close?: () => Promise<void>
}

export function describeInviteHistoryStore(name: string, open: () => Promise<StoreUnderTest>, opts: { skip?: string | false } = {}): void {
  describe(`InviteHistoryStore conformance: ${name}`, { skip: opts.skip }, () => {
    let ut: StoreUnderTest
    let store: InviteHistoryStore
    let fx: InviteHistoryFixtures
    let owner: string

    before(async () => {
      ut = await open()
      ;({ store, fx } = ut)
      owner = await fx.addUser()
    })
    after(async () => {
      await ut?.close?.()
    })

    const bundle = (inviteId: string, groupId: Uint8Array, epoch: number, size = 10): NewInviteBundle => ({
      inviteId,
      groupId,
      epoch,
      senderDevice: randomUUID(),
      senderUser: randomUUID(),
      blob: new Uint8Array(size),
      size,
    })
    const sizes = async (inviteId: string) => (await store.listBundles(inviteId)).map((b) => b.size)

    test('getInvite gives null for an unknown id', async () => {
      assert.equal(await store.getInvite(randomUUID()), null)
      assert.equal(await store.transaction((s) => s.getInvite(randomUUID(), true)), null)
    })

    test('joinWithInvite names the invite, counts the use and sets exhausted_at at the last use', async () => {
      const guild = await fx.addGuild(owner)
      const inv = await fx.addInvite({ guildId: guild, createdBy: owner, history: true, maxUses: 2 })
      const [a, b] = [await fx.addUser(), await fx.addUser()]
      const t1 = new Date(Date.now() - 2000)
      const t2 = new Date(Date.now() - 1000)

      await store.transaction(async (s) => s.joinWithInvite((await s.getInvite(inv.id, true))!, a, t1))
      let row = (await store.getInvite(inv.id))!
      assert.equal(row.uses, 1)
      assert.equal(row.exhaustedAt, null)
      assert.deepEqual(await store.memberJoin(guild, a), { inviteId: inv.id, joinedAt: t1 })

      await store.transaction(async (s) => s.joinWithInvite((await s.getInvite(inv.id, true))!, b, t2))
      row = (await store.getInvite(inv.id))!
      assert.equal(row.uses, 2)
      assert.equal(row.exhaustedAt?.getTime(), t2.getTime())
      assert.equal(await store.memberJoin(guild, await fx.addUser()), null)
    })

    test('activeRecords lists the active invites with a record, with the newest epoch per group', async () => {
      const guild = await fx.addGuild(owner)
      const other = await fx.addGuild(owner)
      const now = new Date()
      const past = new Date(now.getTime() - 60_000)
      const seed = { guildId: guild, createdBy: owner, history: true }
      const live = await fx.addInvite(seed)
      const later = await fx.addInvite({ ...seed, expiresAt: new Date(now.getTime() + HOUR_MS), maxUses: 2, uses: 1 })
      await fx.addInvite({ guildId: guild, createdBy: owner })
      await fx.addInvite({ ...seed, revoked: true })
      await fx.addInvite({ ...seed, expiresAt: past })
      await fx.addInvite({ ...seed, maxUses: 1, uses: 1, exhaustedAt: past })
      await fx.addInvite({ ...seed, maxUses: 1, uses: 1 })
      await fx.addInvite({ ...seed, guildId: other })
      const [ga, gb] = [new Uint8Array([1, 1]), new Uint8Array([2])]
      for (const [g, e] of [[gb, 1], [ga, 5], [ga, 3]] as const) await store.insertBundle(bundle(live.id, g, e))

      const records = await store.activeRecords(guild, now)
      assert.deepEqual(records.map((r) => r.inviteId).sort(), [live.id, later.id].sort())
      const r = records.find((x) => x.inviteId === live.id)!
      assert.deepEqual(r.keyId, live.keyId)
      assert.deepEqual(r.record, live.record)
      assert.equal(r.expiresAt, null)
      assert.deepEqual(r.bundled, [
        { groupId: ga, epoch: 5 },
        { groupId: gb, epoch: 1 },
      ])
      assert.deepEqual(records.find((x) => x.inviteId === later.id)!.bundled, [])
      assert.deepEqual(await store.activeRecords(randomUUID(), now), [])
    })

    test('trimBundles deletes the oldest bundles of the invite above the cap', async () => {
      const guild = await fx.addGuild(owner)
      const inv = await fx.addInvite({ guildId: guild, createdBy: owner, history: true })
      const keep = await fx.addInvite({ guildId: guild, createdBy: owner, history: true })
      const g = new Uint8Array([7])
      for (const [i, size] of [40, 30, 20, 10].entries()) await store.insertBundle(bundle(inv.id, g, i + 1, size))
      await store.insertBundle(bundle(keep.id, g, 1, 100))

      assert.equal(await store.trimBundles(inv.id, 100), 0)
      assert.equal(await store.trimBundles(inv.id, 60), 1)
      assert.deepEqual(await sizes(inv.id), [30, 20, 10])
      assert.deepEqual((await store.listBundles(inv.id)).map((b) => b.epoch), [2, 3, 4])
      assert.equal(await store.trimBundles(inv.id, 25), 2)
      assert.deepEqual(await sizes(inv.id), [10])
      assert.deepEqual(await sizes(keep.id), [100])
    })

    test('trimBundles with a sender user deletes only the oldest bundles of that user, over all its devices', async () => {
      const guild = await fx.addGuild(owner)
      const inv = await fx.addInvite({ guildId: guild, createdBy: owner, history: true })
      const g = new Uint8Array([8])
      const [a, b] = [randomUUID(), randomUUID()]
      const [a1, a2] = [randomUUID(), randomUUID()]
      const sent = [
        [b, randomUUID(), 50],
        [a, a1, 30],
        [b, randomUUID(), 5],
        [a, a2, 20],
        [a, a1, 10],
      ] as const
      for (const [user, device, size] of sent) {
        await store.insertBundle({ ...bundle(inv.id, g, 1, size), senderUser: user, senderDevice: device })
      }

      assert.equal(await store.trimBundles(inv.id, 60, a), 0)
      // Each device of `a` is below 55. Together they are above it.
      assert.equal(await store.trimBundles(inv.id, 55, a), 1)
      assert.deepEqual(await sizes(inv.id), [50, 5, 20, 10])
      assert.deepEqual((await store.listBundles(inv.id)).filter((x) => x.senderUser === a).map((x) => x.senderDevice), [a2, a1])
      assert.equal(await store.trimBundles(inv.id, 0, randomUUID()), 0)
      assert.equal(await store.trimBundles(inv.id, 10, b), 1)
      assert.deepEqual(await sizes(inv.id), [5, 20, 10])
    })

    test('revokeInvites revokes once and deletes the bundles', async () => {
      const guild = await fx.addGuild(owner)
      const a = await fx.addInvite({ guildId: guild, createdBy: owner, history: true })
      const b = await fx.addInvite({ guildId: guild, createdBy: owner, history: true, revoked: true })
      for (const inv of [a, b]) await store.insertBundle(bundle(inv.id, new Uint8Array([1]), 1))

      assert.deepEqual(await store.transaction((s) => s.revokeInvites([a.id, b.id])), [{ inviteId: a.id, code: a.code }])
      assert.equal((await store.getInvite(a.id))!.revoked, true)
      assert.deepEqual(await sizes(a.id), [])
      assert.deepEqual(await sizes(b.id), [])
      assert.deepEqual(await store.revokeInvites([a.id]), [])
      assert.deepEqual(await store.revokeInvites([]), [])
    })

    test('deleteStaleBundles deletes the bundles of revoked invites and of invites that ended before the cutoff', async () => {
      const guild = await fx.addGuild(owner)
      const cutoff = new Date(Date.now() - HOUR_MS)
      const early = new Date(cutoff.getTime() - 60_000)
      const late = new Date(cutoff.getTime() + 60_000)
      const seed = { guildId: guild, createdBy: owner, history: true }
      const live = await fx.addInvite(seed)
      const expiredLate = await fx.addInvite({ ...seed, expiresAt: late })
      const exhaustedLate = await fx.addInvite({ ...seed, maxUses: 1, uses: 1, exhaustedAt: late })
      const expiredEarly = await fx.addInvite({ ...seed, expiresAt: early })
      const exhaustedEarly = await fx.addInvite({ ...seed, maxUses: 1, uses: 1, exhaustedAt: early })
      const revoked = await fx.addInvite({ ...seed, revoked: true })
      const all = [live, expiredLate, exhaustedLate, expiredEarly, exhaustedEarly, revoked]
      for (const inv of all) await store.insertBundle(bundle(inv.id, new Uint8Array([3]), 1))

      assert.ok((await store.deleteStaleBundles(cutoff)) >= 3)
      const left = await Promise.all(all.map(async (inv) => (await store.listBundles(inv.id)).length))
      assert.deepEqual(left, [1, 1, 1, 0, 0, 0])
    })
  })
}
