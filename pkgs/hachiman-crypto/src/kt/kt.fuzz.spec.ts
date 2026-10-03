/**
 * Fuzz and property tests of the KT codecs and proof verifiers (§12.14).
 * Invariants: the verifiers never throw, accept every honest proof and reject every changed one;
 * the decoders throw only CodecError and accept only canonical bytes.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { CodecError } from '../codec'
import { edits, flip, flipped, mutate, only, runs } from '../fuzz-helpers'
import { generateEd25519 } from '../sign'
import { kt } from './index'

const hash = fc.uint8Array({ minLength: 32, maxLength: 32 })
const anyBytes = fc.oneof(hash, fc.uint8Array({ maxLength: 40 }))
const anyInt = fc.oneof(fc.integer({ min: -3, max: 80 }), fc.constantFrom(Number.NaN, Infinity, -0, 2 ** 53, 0.5, Number.MAX_SAFE_INTEGER))
const tree = fc.integer({ min: 1, max: 48 }).map((n) => Array.from({ length: n }, (_, i) => kt.leafHash(new Uint8Array([i, i >> 8, 0x4b]))))

describe('KT verifiers (fuzz)', () => {
  it('verifyInclusion and verifyConsistency never throw on arbitrary input', () => {
    fc.assert(
      fc.property(anyBytes, anyInt, anyInt, fc.array(anyBytes, { maxLength: 8 }), anyBytes, (leaf, a, b, proof, root) => {
        expect(typeof kt.verifyInclusion(leaf, a, b, proof, root)).toBe('boolean')
        expect(typeof kt.verifyConsistency(a, b, leaf, root, proof)).toBe('boolean')
      }),
      runs(3000),
    )
  })

  it('random proofs never verify against a real root', () => {
    fc.assert(
      fc.property(tree, fc.nat(), fc.array(hash, { maxLength: 7 }), (leaves, i, proof) => {
        const n = leaves.length
        const root = kt.rootHash(leaves)
        const index = i % n
        // A one-leaf tree has the empty proof; every other proof is random and must fail.
        if (n === 1 && proof.length === 0) return
        expect(kt.verifyInclusion(leaves[index]!, index, n, proof, root)).toBe(false)
      }),
      runs(1000),
    )
  })

  it('inclusion: the honest proof verifies; any bit flip in leaf, proof or root does not', () => {
    fc.assert(
      fc.property(tree, fc.nat(), fc.constantFrom('leaf' as const, 'proof' as const, 'root' as const), flip, fc.nat(), (leaves, i, where, f, which) => {
        const n = leaves.length
        const index = i % n
        const root = kt.rootHash(leaves)
        const proof = kt.inclusionProof(leaves, index, n)
        expect(kt.verifyInclusion(leaves[index]!, index, n, proof, root)).toBe(true)
        if (where === 'proof' && proof.length === 0) return
        const leaf = where === 'leaf' ? flipped(leaves[index]!, f) : leaves[index]!
        const r = where === 'root' ? flipped(root, f) : root
        const p = where === 'proof' ? proof.map((x, k) => (k === which % proof.length ? flipped(x, f) : x)) : proof
        expect(kt.verifyInclusion(leaf, index, n, p, r)).toBe(false)
      }),
      runs(1000),
    )
  })

  // The proof binds the index. It does not bind the tree size by itself (RFC 9162 §2.1.3.2): a
  // size-5 proof of leaf 0 also passes with treeSize 6 against the size-5 root. Callers must take
  // treeSize and root from one verified SignedTreeHead (kt/client.ts does).
  it('inclusion: the proof binds the leaf index', () => {
    fc.assert(
      fc.property(tree, fc.nat(), fc.nat(), (leaves, i, j) => {
        const n = leaves.length
        const index = i % n
        const other = j % n
        const proof = kt.inclusionProof(leaves, index, n)
        if (other !== index) expect(kt.verifyInclusion(leaves[index]!, other, n, proof, kt.rootHash(leaves))).toBe(false)
      }),
      runs(1000),
    )
  })

  it('inclusion: a root of another tree size never verifies', () => {
    fc.assert(
      fc.property(tree, fc.nat(), fc.integer({ min: 1, max: 3 }), (leaves, i, dn) => {
        const n = leaves.length
        const index = i % n
        const longer = [...leaves, ...Array.from({ length: dn }, (_, k) => kt.leafHash(new Uint8Array([0xee, k])))]
        expect(kt.verifyInclusion(leaves[index]!, index, n + dn, kt.inclusionProof(leaves, index, n), kt.rootHash(longer))).toBe(false)
      }),
      runs(500),
    )
  })

  it('consistency: every honest prefix proof verifies; a flip or a fork does not', () => {
    fc.assert(
      fc.property(tree, fc.nat(), flip, fc.nat(), (leaves, m, f, which) => {
        const to = leaves.length
        const from = m % (to + 1)
        const fromRoot = kt.rootHash(leaves.slice(0, from))
        const toRoot = kt.rootHash(leaves)
        const proof = kt.consistencyProof(leaves, from, to)
        expect(kt.verifyConsistency(from, to, fromRoot, toRoot, proof)).toBe(true)
        if (from === 0 || from === to) return
        expect(kt.verifyConsistency(from, to, flipped(fromRoot, f), toRoot, proof)).toBe(false)
        expect(kt.verifyConsistency(from, to, fromRoot, flipped(toRoot, f), proof)).toBe(false)
        expect(kt.verifyConsistency(from, to, fromRoot, toRoot, proof.map((x, k) => (k === which % proof.length ? flipped(x, f) : x)))).toBe(false)
        // A log that rewrote a leaf before `from` cannot prove consistency with the old head.
        const forked = leaves.slice()
        forked[which % from] = flipped(forked[which % from]!, f)
        expect(kt.verifyConsistency(from, to, fromRoot, kt.rootHash(forked), kt.consistencyProof(forked, from, to))).toBe(false)
      }),
      runs(1000),
    )
  })
})

describe('KT codecs (fuzz)', () => {
  it('decodeEntry and decodeTreeHead throw only CodecError and accept only canonical bytes', () => {
    const entry = kt.encodeEntry({ type: 3, userId: '0f8fad5b-d9cb-469f-a165-70867728950e', timestampMs: 7, object: new Uint8Array([1, 2, 3]) })
    const key = generateEd25519()
    const head = kt.encodeTreeHead(kt.signTreeHead(key.privateKey, { treeSize: 9, timestampMs: 3, rootHash: new Uint8Array(32).fill(2) }))
    fc.assert(
      fc.property(fc.oneof(fc.constant(entry), fc.constant(head), fc.uint8Array({ maxLength: 160 })), edits(), fc.option(fc.nat()), fc.uint8Array({ maxLength: 3 }), (base, e, cut, tail) => {
        const b = mutate(base, e, cut, tail)
        const de = only(() => kt.decodeEntry(b), CodecError)
        if (de !== undefined) expect(kt.encodeEntry(de)).toEqual(b)
        const dh = only(() => kt.decodeTreeHead(b), CodecError)
        if (dh !== undefined) expect(kt.encodeTreeHead(dh)).toEqual(b)
      }),
      runs(3000),
    )
  })

  it('verifyTreeHead: the signature covers every field and never throws', () => {
    const key = generateEd25519()
    const signed = kt.encodeTreeHead(kt.signTreeHead(key.privateKey, { treeSize: 9, timestampMs: 3, rootHash: new Uint8Array(32).fill(2) }))
    fc.assert(
      fc.property(flip, anyBytes, (f, junkKey) => {
        const h = only(() => kt.decodeTreeHead(flipped(signed, f)), CodecError)
        if (h !== undefined) expect(kt.verifyTreeHead(key.publicKey, h)).toBe(false)
        expect(kt.verifyTreeHead(junkKey, kt.decodeTreeHead(signed))).toBe(false)
      }),
      runs(1000),
    )
  })
})
