/**
 * The MLS scheduler of the gRPC process (docs/gateway-protocol.md §12.7.5,
 * §12.7.9): wakeups, the interval, the daily sweep and suite upgrades, on the
 * in-memory MlsRepo with the FakeDs of lib/mls/testing.ts.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Permissions } from '@hachiman/client/permissions'

import { setBusPublisher } from '../lib/events'
import { toB64 } from '../lib/mls/bytes'
import { Outbox } from '../lib/mls/events'
import { postJoinRequest } from '../lib/mls/joins'
import { uploadKeyPackages } from '../lib/mls/key-packages'
import { flushWithProposals, onMembershipChangeWith } from '../lib/mls/membership'
import { activate, activeDevice, fakeKeyPackage, newWorld } from '../lib/mls/testing'
import { InMemoryPageMediaSweepRepo } from '../lib/page-media-sweep'
import { MlsScheduler } from './mls-scheduler'

setBusPublisher(async () => undefined)

async function guildWithJoiner(env: Record<string, string> = {}) {
  const w = await newWorld(env)
  const owner = w.repo.addUser()
  const guildId = w.repo.addGuild(owner, undefined, Permissions.VIEW_CHANNEL)
  const channelId = w.repo.addChannel({ guildId, type: 'text' })
  const oDev = await activeDevice(w, owner)
  const joiner = w.repo.addUser()
  w.repo.addGuildMember(guildId, joiner)
  const jDev = await activeDevice(w, joiner)
  const out = new Outbox()
  await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'guild_created', guildId }, oDev.id))
  const group = await activate(w, out, (await w.repo.listGroupsByGuild(guildId))[0]!, oDev)
  return { w, guildId, channelId, owner, oDev, joiner, jDev, group }
}

describe('MlsScheduler', () => {
  test('a wakeup runs the group at once and the batch goes to the committer', async () => {
    const { w, group, joiner, jDev, oDev } = await guildWithJoiner()
    const flushed: Outbox[] = []
    let wake: ((groupId: string) => void) | null = null
    const scheduler = new MlsScheduler({
      repo: w.repo,
      deps: { ...w.deps, config: { ...w.deps.config, batchIntervalMs: 60_000 } },
      subscribe: async (onGroup) => {
        wake = onGroup
        return async () => {
          wake = null
        }
      },
      flush: async (o) => void flushed.push(o),
      logger: () => undefined,
    })
    await scheduler.start()
    try {
      const out = new Outbox()
      await postJoinRequest(w.repo, w.deps, out, { userId: joiner, device: jDev }, group.groupId, fakeKeyPackage(jDev))
      await flushWithProposals(w.repo, out, w.deps)
      const fire = wake as ((groupId: string) => void) | null
      assert.ok(fire, 'subscribed to takusen:mls_wakeup')
      for (const g of out.wake) fire(g)
      await scheduler.tick(new Set()) // waits for the queued wakeup pass
      const assign = flushed.flatMap((o) => o.events).find((e) => e.t === 'MLS_BATCH_ASSIGN')
      assert.ok(assign)
      assert.equal(assign.channel, `device:${oDev.id}`)
      assert.equal((assign.d as { groupId: string }).groupId, toB64(group.groupId))
    } finally {
      await scheduler.stop()
    }
    assert.equal(wake as unknown, null, 'stop unsubscribes')
  })

  test('the daily sweep deletes old handshakes, inbox items, link sessions, join requests and epochs', async () => {
    const { w, group, joiner, jDev } = await guildWithJoiner()
    const out = new Outbox()
    await postJoinRequest(w.repo, w.deps, out, { userId: joiner, device: jDev }, group.groupId, fakeKeyPackage(jDev))
    await flushWithProposals(w.repo, out, w.deps)
    await w.repo.insertInboxItem({ deviceId: jDev.id, kind: 'history_keys', senderDevice: null, body: new Uint8Array(4), size: 4, expiresAt: new Date(w.clock.now + 1000) })
    await w.repo.insertLinkSession({ userId: joiner, newDeviceId: jDev.id, offer: new Uint8Array(4), expiresAt: new Date(w.clock.now + 1000) })
    for (let e = 1; e <= 10; e++) {
      await w.repo.insertGroupEpoch({ groupId: group.groupId, epoch: e, groupInfo: new Uint8Array(1), ratchetTree: new Uint8Array(1), treeHash: new Uint8Array(1), confirmedTranscriptHash: new Uint8Array(1) })
    }
    const scheduler = new MlsScheduler({ repo: w.repo, deps: w.deps, flush: async () => undefined, logger: () => undefined })

    const none = await scheduler.sweep()
    assert.equal(none.handshakes + none.inbox + none.linkSessions + none.joinRequests, 0)
    assert.equal(none.epochs, 3, 'epochs 0-2 go, the newest 8 stay')
    assert.deepEqual((await w.repo.listGroupEpochs(group.groupId)).map((e) => e.epoch), [3, 4, 5, 6, 7, 8, 9, 10])

    w.clock.now += 31 * 24 * 60 * 60_000
    const swept = await scheduler.sweep()
    assert.equal(swept.handshakes, 1)
    assert.equal(swept.inbox, 1)
    assert.equal(swept.linkSessions, 1)
    assert.equal(swept.joinRequests, 1)
    assert.equal((await w.repo.listPending(group.groupId, ['queued'])).length, 0, 'the Add of a swept join request goes with it')
  })

  test('the daily sweep deletes page media that no recent snapshot or claim references, after 30 days', async () => {
    const w = await newWorld()
    const media = new InMemoryPageMediaSweepRepo()
    const created = new Date(w.clock.now)
    for (const id of ['current', 'previous', 'oldest', 'claimed', 'unlisted']) {
      media.uploads.set(id, { id, pageId: 'p', key: `key-${id}`, createdAt: created, lastReferencedAt: created })
    }
    media.snapshots.set('p', [['oldest'], ['previous'], ['current']])
    const deleted: string[] = []
    const scheduler = new MlsScheduler({
      repo: w.repo,
      deps: w.deps,
      flush: async () => undefined,
      logger: () => undefined,
      pageMedia: { repo: media, deleteObjects: async (keys) => void deleted.push(...keys) },
    })
    assert.equal((await scheduler.sweep()).pageMedia, 0, 'nothing is older than 30 days')

    w.clock.now += 31 * 24 * 60 * 60_000
    media.uploads.get('claimed')!.lastReferencedAt = new Date(w.clock.now - 60_000)
    assert.equal((await scheduler.sweep()).pageMedia, 2)
    assert.deepEqual(deleted.sort(), ['key-oldest', 'key-unlisted'])
    assert.deepEqual([...media.uploads.keys()].sort(), ['claimed', 'current', 'previous'])
  })

  test('the sweep starts a suite upgrade when suite 83 is enabled and every reader device has a key package', async () => {
    const { w, group, guildId, channelId, oDev, jDev } = await guildWithJoiner({ TAKUSEN_MLS_SUITES: '1,83' })
    const scheduler = new MlsScheduler({ repo: w.repo, deps: w.deps, flush: async () => undefined, logger: () => undefined })
    assert.equal((await scheduler.sweep()).upgrades, 0, 'no suite-83 key packages yet')
    for (const d of [oDev, jDev]) await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 83, keyPackages: [fakeKeyPackage(d, 83)], lastResort: null })
    assert.equal((await scheduler.sweep()).upgrades, 1)
    assert.equal((await w.repo.getGroup(group.groupId))!.status, 'retired')
    const next = (await w.repo.listGroupsByGuild(guildId)).find((g) => g.status === 'pending')!
    assert.equal(next.cipherSuite, 83)
    assert.equal(next.generation, 1)
    assert.deepEqual((await w.repo.getChannel(channelId))!.mlsGroupId, next.groupId, 'the public channel moves to the new generation')
  })
})
