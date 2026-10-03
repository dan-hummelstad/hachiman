/**
 * Key transparency in the gRPC process (docs/gateway-protocol.md §12.14):
 * appends get distinct indexes, the timer signs a head that covers the new
 * entries, and KT_TREE_HEAD goes to the owners. Real RFC 6962 math and
 * signatures from @hachiman/crypto; the in-memory MlsRepo.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'

import { fromB64 } from '../lib/mls/bytes'
import { KtEntryType } from '../lib/mls/crypto'
import type { Outbox } from '../lib/mls/events'
import { ed25519PublicKey } from '../lib/mls/keys'
import { appendKtEntry, consistencyProof, inclusionProof, listEntries, treeHead } from '../lib/mls/kt'
import { FakeDs } from '../lib/mls/testing'
import { InMemoryMlsRepo } from '../lib/mls/repo.in-memory'
import { KtHeadSigner } from './kt-heads'

const ds = new FakeDs()

describe('KT appends', () => {
  test('concurrent appends get distinct indexes without gaps', async () => {
    const repo = new InMemoryMlsRepo()
    const users = Array.from({ length: 20 }, () => crypto.randomUUID())
    const results = await Promise.all(
      users.map((userId) => repo.transaction((r) => appendKtEntry(r, ds, { type: KtEntryType.DEVICE_CERTIFICATE, userId, object: new Uint8Array(randomBytes(40)), now: new Date() }))),
    )
    assert.deepEqual(results.map((r) => r.idx).sort((a, b) => a - b), users.map((_, i) => i))
    assert.equal(await repo.ktSize(), 20)
  })
})

describe('KT tree heads', () => {
  test('the timer signs a head over the new entries and publishes KT_TREE_HEAD to their owners', async () => {
    const repo = new InMemoryMlsRepo()
    const seed = new Uint8Array(randomBytes(32))
    const published: Outbox[] = []
    let now = Date.UTC(2026, 9, 1)
    const signer = new KtHeadSigner({ repo, ds, seed, now: () => new Date(now), flush: async (out) => void published.push(out) })

    assert.equal(await signer.tick(), null, 'no entries, no head')
    const alice = crypto.randomUUID()
    const bob = crypto.randomUUID()
    for (const userId of [alice, bob, alice]) {
      await repo.transaction((r) => appendKtEntry(r, ds, { type: KtEntryType.MASTER_KEY, userId, object: new Uint8Array(randomBytes(30)), now: new Date(now) }))
    }
    const head = await signer.tick()
    assert.ok(head)
    assert.equal(head.treeSize, 3)
    const decoded = ds.kt.decodeTreeHead(head.signed)
    assert.ok(ds.kt.verifyTreeHead(ed25519PublicKey(seed), decoded), 'the head verifies under the KT public key')
    assert.deepEqual(decoded.rootHash, ds.kt.rootHash(await repo.ktLeafHashes(3)))
    const events = published.at(-1)!.events
    assert.deepEqual(events.map((e) => e.channel).sort(), [`user:${alice}`, `user:${bob}`].sort())
    assert.ok(events.every((e) => e.t === 'KT_TREE_HEAD' && (e.d as { treeSize: number }).treeSize === 3))
    assert.ok((await repo.latestKtHead())!.publishedAt)

    assert.equal(await signer.tick(), null, 'nothing new, no new head')

    // One more entry: the next head covers it, and only its owner hears about it.
    now += 10_000
    const carol = crypto.randomUUID()
    const { idx } = await repo.transaction((r) => appendKtEntry(r, ds, { type: KtEntryType.DEVICE_SIGNING_KEY, userId: carol, object: new Uint8Array(randomBytes(30)), now: new Date(now) }))
    const head2 = (await signer.tick())!
    assert.equal(head2.treeSize, 4)
    assert.deepEqual(published.at(-1)!.events.map((e) => e.channel), [`user:${carol}`])

    // The proof routes answer against the signed sizes.
    const wire = await treeHead(repo, ds)
    assert.equal(wire.treeSize, 4)
    const inc = await inclusionProof(repo, ds, new URLSearchParams({ index: String(idx), treeSize: '4' }))
    const leaf = (await repo.ktLeafHashes(4))[idx]!
    assert.ok(ds.kt.verifyInclusion(leaf, idx, 4, inc.auditPath.map((p) => fromB64(p)!), head2.rootHash))
    const cons = await consistencyProof(repo, ds, new URLSearchParams({ from: '3', to: '4' }))
    assert.ok(ds.kt.verifyConsistency(3, 4, head.rootHash, head2.rootHash, cons.proof.map((p) => fromB64(p)!)))
    await assert.rejects(inclusionProof(repo, ds, new URLSearchParams({ index: '0', treeSize: '5' })))
    const mine = await listEntries(repo, new URLSearchParams({ userId: alice }))
    assert.deepEqual(mine.map((e) => e.index), [0, 2])
    const range = await listEntries(repo, new URLSearchParams({ start: '1', end: '3' }))
    assert.deepEqual(range.map((e) => e.index), [1, 2])
  })
})
