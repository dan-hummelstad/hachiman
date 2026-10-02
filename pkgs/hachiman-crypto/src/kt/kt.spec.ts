/* eslint-disable @typescript-eslint/require-await -- fakes implement async interfaces synchronously */
import { sha256 } from '@noble/hashes/sha2.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CryptoError, type CryptoEvents, type StoreSchema, type WireKtTreeHead } from '../api'
import { CodecError, toB64url } from '../codec'
import { generateEd25519 } from '../sign'
import { createKtClient } from './client'
import { kt } from './index'

const H = (...parts: Uint8Array[]) => sha256(Uint8Array.from(parts.flatMap((p) => [...p])))

/** RFC 6962 MTH, written as plainly as the RFC text. */
function naiveMth(d: Uint8Array[]): Uint8Array {
  if (d.length === 0) return sha256(new Uint8Array(0))
  if (d.length === 1) return d[0]!
  let k = 1
  while (k * 2 < d.length) k *= 2
  return H(new Uint8Array([1]), naiveMth(d.slice(0, k)), naiveMth(d.slice(k)))
}

const leaves = (n: number) => Array.from({ length: n }, (_, i) => kt.leafHash(new Uint8Array([i, i >> 8, 7])))

describe('Merkle math', () => {
  it('hashes leaves and nodes per RFC 6962', () => {
    const e = new Uint8Array([1, 2, 3])
    expect(kt.leafHash(e)).toEqual(H(new Uint8Array([0]), e))
    for (let n = 0; n <= 64; n++) expect(kt.rootHash(leaves(n))).toEqual(naiveMth(leaves(n)))
  })

  it('proves inclusion for every leaf of trees of size 1 to 64', () => {
    const all = leaves(64)
    for (let n = 1; n <= 64; n++) {
      const root = naiveMth(all.slice(0, n))
      for (let i = 0; i < n; i++) {
        const proof = kt.inclusionProof(all, i, n)
        expect(kt.verifyInclusion(all[i]!, i, n, proof, root)).toBe(true)
        expect(kt.verifyInclusion(all[(i + 1) % 64]!, i, n, proof, root)).toBe(false)
        if (proof.length > 0) {
          const bad = proof.map((p) => p.slice())
          bad[0]![0]! ^= 1
          expect(kt.verifyInclusion(all[i]!, i, n, bad, root)).toBe(false)
          expect(kt.verifyInclusion(all[i]!, i, n, proof.slice(1), root)).toBe(false)
        }
        expect(kt.verifyInclusion(all[i]!, i, n, [...proof, all[0]!], root)).toBe(false)
        if (n > 1) expect(kt.verifyInclusion(all[i]!, (i + 1) % n, n, proof, root)).toBe(false)
      }
      expect(kt.verifyInclusion(all[0]!, n, n, [], root)).toBe(false)
    }
  })

  it('proves consistency for every pair of sizes up to 64', () => {
    const all = leaves(64)
    for (let to = 1; to <= 64; to++) {
      const toRoot = naiveMth(all.slice(0, to))
      for (let from = 0; from <= to; from++) {
        const fromRoot = naiveMth(all.slice(0, from))
        const proof = kt.consistencyProof(all, from, to)
        expect(kt.verifyConsistency(from, to, fromRoot, toRoot, proof)).toBe(true)
        if (from > 0 && from < to) {
          const bad = proof.map((p) => p.slice())
          bad[bad.length - 1]![3]! ^= 1
          expect(kt.verifyConsistency(from, to, fromRoot, toRoot, bad)).toBe(false)
          expect(kt.verifyConsistency(from, to, toRoot, toRoot, proof)).toBe(false)
          const forked = naiveMth([...all.slice(0, from - 1), kt.leafHash(new Uint8Array([99])), ...all.slice(from, to)])
          expect(kt.verifyConsistency(from, to, fromRoot, forked, proof)).toBe(false)
        }
      }
    }
    expect(kt.verifyConsistency(5, 4, naiveMth(all.slice(0, 5)), naiveMth(all.slice(0, 4)), [])).toBe(false)
  })

  it('rejects bad sizes', () => {
    expect(() => kt.inclusionProof(leaves(3), 3, 3)).toThrow(RangeError)
    expect(() => kt.inclusionProof(leaves(3), 0, 4)).toThrow(RangeError)
    expect(() => kt.consistencyProof(leaves(3), 2, 1)).toThrow(RangeError)
  })
})

describe('entries and tree heads', () => {
  it('round-trips KtEntry and rejects trailing bytes and bad versions', () => {
    fc.assert(
      fc.property(fc.constantFrom(1 as const, 2 as const, 3 as const, 4 as const), fc.uint8Array({ maxLength: 80 }), fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (type, object, timestampMs) => {
        const e = { type, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', timestampMs, object }
        const b = kt.encodeEntry(e)
        expect(kt.decodeEntry(b)).toEqual(e)
        expect(() => kt.decodeEntry(new Uint8Array([...b, 0]))).toThrow(CodecError)
        const bad = b.slice()
        bad[0] = 2
        expect(() => kt.decodeEntry(bad)).toThrow(CodecError)
      }),
    )
  })

  it('signs and verifies tree heads', () => {
    const key = generateEd25519()
    const h = kt.signTreeHead(key.privateKey, { treeSize: 5, timestampMs: 9, rootHash: new Uint8Array(32).fill(4) })
    expect(kt.decodeTreeHead(kt.encodeTreeHead(h))).toEqual(h)
    expect(kt.verifyTreeHead(key.publicKey, h)).toBe(true)
    expect(kt.verifyTreeHead(key.publicKey, { ...h, treeSize: 6 })).toBe(false)
    expect(kt.verifyTreeHead(generateEd25519().publicKey, h)).toBe(false)
    expect(() => kt.decodeTreeHead(new Uint8Array([...kt.encodeTreeHead(h), 1]))).toThrow(CodecError)
  })
})

describe('KT client', () => {
  /** `missingHeads`: the first GET /kt/tree-head calls answer 404 NotFound (no head signed yet). */
  function setup(missingHeads = 0) {
    const key = generateEd25519()
    const log: Uint8Array[] = []
    let row: StoreSchema['kt'] | undefined
    const alerts: CryptoEvents['ktAlert'][] = []
    let forkRoot: Uint8Array | null = null
    const head = (size = log.length): WireKtTreeHead => {
      const root = forkRoot ?? kt.rootHash(log.slice(0, size))
      const h = kt.signTreeHead(key.privateKey, { treeSize: size, timestampMs: 1, rootHash: root })
      return { treeSize: size, timestamp: new Date(1).toISOString(), rootHash: toB64url(root), signed: toB64url(kt.encodeTreeHead(h)) }
    }
    const append = (object: Uint8Array) => {
      const entry = kt.encodeEntry({ type: 3, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', timestampMs: log.length, object })
      log.push(kt.leafHash(entry))
      return { index: log.length - 1, entry }
    }
    let heads = 0
    const client = createKtClient({
      transport: {
        ktTreeHead: async () => {
          if (++heads <= missingHeads) throw new CryptoError('Transport', 'no tree head yet', 'NotFound')
          return head()
        },
        ktInclusion: async (index, treeSize) => ({ leafIndex: index, treeSize, auditPath: kt.inclusionProof(log, index, treeSize).map(toB64url) }),
        ktConsistency: async (from, to) => ({ from, to, proof: kt.consistencyProof(log, from, to).map(toB64url) }),
      },
      ktPublicKey: () => key.publicKey,
      loadState: async () => row,
      patchState: async (p) => {
        row = { ...(row ?? { treeHead: null, lastSelfCheckMs: 0, lastSelfIndex: -1 }), ...p }
      },
      alert: (a) => alerts.push(a),
      now: () => 0,
      sleep: async () => undefined,
    })
    return { client, append, head, alerts, log, setFork: (r: Uint8Array | null) => (forkRoot = r), heads: () => heads }
  }

  it('proves an entry that a head covers and stores the head', async () => {
    const t = setup()
    t.append(new Uint8Array([1]))
    const e = t.append(new Uint8Array([2]))
    await t.client.prove(e.index, e.entry, { type: 3, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', object: new Uint8Array([2]) })
    expect(await t.client.active()).toBe(true)
    expect((await t.client.storedHead())?.treeSize).toBe(2)
    expect(t.alerts).toEqual([])
  })

  it('rejects an entry with another object', async () => {
    const t = setup()
    const e = t.append(new Uint8Array([1]))
    await expect(t.client.prove(e.index, e.entry, { type: 3, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', object: new Uint8Array([9]) })).rejects.toMatchObject({ code: 'InvalidChain' })
    expect(t.alerts[0]?.kind).toBe('bad_proof')
  })

  it('waits for two heads, then raises bad_proof for an uncovered entry', async () => {
    const t = setup()
    t.append(new Uint8Array([1]))
    await t.client.onTreeHead(t.head())
    const uncovered = { index: 5, entry: kt.encodeEntry({ type: 3, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', timestampMs: 0, object: new Uint8Array([3]) }) }
    await expect(t.client.prove(uncovered.index, uncovered.entry, { type: 3, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', object: new Uint8Array([3]) })).rejects.toMatchObject({ code: 'InvalidChain' })
    expect(t.heads()).toBe(3)
    expect(t.alerts.map((a) => a.kind)).toEqual(['bad_proof'])
  })

  it('waits for the first head when the DS has signed none yet', async () => {
    const t = setup(1)
    const e = t.append(new Uint8Array([1]))
    await t.client.prove(e.index, e.entry, { type: 3, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', object: new Uint8Array([1]) })
    expect(t.heads()).toBe(2)
    expect((await t.client.storedHead())?.treeSize).toBe(1)
    expect(t.alerts).toEqual([])
  })

  it('raises split_view for two roots of one size and for an inconsistent head', async () => {
    const t = setup()
    t.append(new Uint8Array([1]))
    t.append(new Uint8Array([2]))
    await t.client.onTreeHead(t.head())
    t.setFork(new Uint8Array(32).fill(5))
    await t.client.onTreeHead(t.head())
    expect(t.alerts.map((a) => a.kind)).toEqual(['split_view'])
    t.append(new Uint8Array([3]))
    await t.client.onTreeHead(t.head())
    expect(t.alerts.map((a) => a.kind)).toEqual(['split_view', 'split_view'])
    expect((await t.client.storedHead())?.treeSize).toBe(2)
    t.setFork(null)
    await t.client.onTreeHead(t.head())
    expect((await t.client.storedHead())?.treeSize).toBe(3)
  })

  it('gossips at most once per hour per group and ignores bad gossip', async () => {
    const t = setup()
    expect(await t.client.gossip('g')).toBeNull()
    t.append(new Uint8Array([1]))
    await t.client.onTreeHead(t.head())
    expect(await t.client.gossip('g')).not.toBeNull()
    expect(await t.client.gossip('g')).toBeNull()
    expect(await t.client.gossip('h')).not.toBeNull()
    await t.client.observeEncoded(new Uint8Array([1, 2, 3]), 'x')
    expect(t.alerts).toEqual([])
  })
})
