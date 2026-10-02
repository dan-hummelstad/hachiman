/**
 * Key transparency (docs/gateway-protocol.md §12.14): KtEntry and SignedTreeHead codecs, and the
 * RFC 6962 / RFC 9162 Merkle math. Node-safe (only @noble), so Takusen uses the same code.
 */
import { sha256 } from '@noble/hashes/sha2.js'

import type { KtEntry, KtModule, SignedTreeHead } from '../api'
import { CodecError, Reader, Writer, bytesToUuid, decode, encode, uuidToBytes } from '../codec'
import { SignLabel, WIRE_VERSION } from '../constants'
import { concatBytes, equalBytes } from '../identity/bytes'
import { signWithLabel, verifyWithLabel } from '../sign'

const HASH = 32

const leafHash = (entry: Uint8Array): Uint8Array => sha256(concatBytes(new Uint8Array([0]), entry))
const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array => sha256(concatBytes(new Uint8Array([1]), left, right))

/** The largest power of two strictly below n (n ≥ 2). */
function split(n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

function mth(leaves: readonly Uint8Array[], from: number, to: number): Uint8Array {
  const n = to - from
  if (n === 0) return sha256(new Uint8Array(0))
  if (n === 1) return leaves[from]!
  const k = split(n)
  return nodeHash(mth(leaves, from, from + k), mth(leaves, from + k, to))
}

function checkSize(leaves: readonly Uint8Array[], treeSize: number): void {
  if (!Number.isSafeInteger(treeSize) || treeSize < 0 || treeSize > leaves.length) throw new RangeError(`bad tree size ${treeSize}`)
}

/** RFC 6962 §2.1.1 PATH(m, D[from:to]). */
function path(leaves: readonly Uint8Array[], m: number, from: number, to: number): Uint8Array[] {
  const n = to - from
  if (n <= 1) return []
  const k = split(n)
  return m < k ? [...path(leaves, m, from, from + k), mth(leaves, from + k, to)] : [...path(leaves, m - k, from + k, to), mth(leaves, from, from + k)]
}

/** RFC 6962 §2.1.2 SUBPROOF(m, D[from:to], b). */
function subproof(leaves: readonly Uint8Array[], m: number, from: number, to: number, complete: boolean): Uint8Array[] {
  const n = to - from
  if (m === n) return complete ? [] : [mth(leaves, from, to)]
  const k = split(n)
  return m <= k
    ? [...subproof(leaves, m, from, from + k, complete), mth(leaves, from + k, to)]
    : [...subproof(leaves, m - k, from + k, to, false), mth(leaves, from, from + k)]
}

/** RFC 9162 §2.1.3.2. */
function verifyInclusion(leaf: Uint8Array, index: number, treeSize: number, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize) || index < 0 || index >= treeSize) return false
  if (leaf.length !== HASH || root.length !== HASH) return false
  let fn = index
  let sn = treeSize - 1
  let r = leaf
  for (const p of proof) {
    if (p.length !== HASH || sn === 0) return false
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r)
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2)
        sn = Math.floor(sn / 2)
      }
    } else {
      r = nodeHash(r, p)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  return sn === 0 && equalBytes(r, root)
}

/** RFC 9162 §2.1.4.2. */
function verifyConsistency(from: number, to: number, fromRoot: Uint8Array, toRoot: Uint8Array, proof: readonly Uint8Array[]): boolean {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to) return false
  if (fromRoot.length !== HASH || toRoot.length !== HASH || proof.some((p) => p.length !== HASH)) return false
  if (from === to) return proof.length === 0 && equalBytes(fromRoot, toRoot)
  // The empty tree is a prefix of every tree.
  if (from === 0) return proof.length === 0
  const path = (from & (from - 1)) === 0 ? [fromRoot, ...proof] : [...proof]
  if (path.length === 0) return false
  let fn = from - 1
  let sn = to - 1
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  let fr = path[0]!
  let sr = path[0]!
  for (const c of path.slice(1)) {
    if (sn === 0) return false
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr)
      sr = nodeHash(c, sr)
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2)
        sn = Math.floor(sn / 2)
      }
    } else {
      sr = nodeHash(sr, c)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  return equalBytes(fr, fromRoot) && equalBytes(sr, toRoot) && sn === 0
}

const isEntryType = (t: number): t is KtEntry['type'] => t >= 1 && t <= 4

function writeTreeHeadTbs(w: Writer, h: Omit<SignedTreeHead, 'signature'>): void {
  w.u8(WIRE_VERSION).u64(h.treeSize).u64(h.timestampMs).fixed(h.rootHash, HASH)
}
const encodeTreeHeadTbs = (h: Omit<SignedTreeHead, 'signature'>): Uint8Array =>
  encode((w) => {
    writeTreeHeadTbs(w, h)
  })

function readVersion(r: Reader): void {
  const v = r.u8()
  if (v !== WIRE_VERSION) throw new CodecError(`unsupported version ${v}`)
}

export const kt: KtModule = {
  encodeEntry: (e) =>
    encode((w) => {
      if (!isEntryType(e.type)) throw new CodecError(`bad KT entry type ${e.type as number}`)
      w.u8(WIRE_VERSION).u8(e.type).fixed(uuidToBytes(e.userId), 16).u64(e.timestampMs).opaque(e.object)
    }),
  decodeEntry: (b) =>
    decode(b, (r) => {
      readVersion(r)
      const type = r.u8()
      if (!isEntryType(type)) throw new CodecError(`bad KT entry type ${type}`)
      return { type, userId: bytesToUuid(r.fixed(16)), timestampMs: r.u64n(), object: r.opaque() }
    }),
  encodeTreeHead: (h) =>
    encode((w) => {
      writeTreeHeadTbs(w, h)
      w.opaque(h.signature)
    }),
  decodeTreeHead: (b) =>
    decode(b, (r) => {
      readVersion(r)
      return { treeSize: r.u64n(), timestampMs: r.u64n(), rootHash: r.fixed(HASH), signature: r.opaque(64) }
    }),

  leafHash,
  rootHash: (leaves) => mth(leaves, 0, leaves.length),

  inclusionProof(leaves, index, treeSize) {
    checkSize(leaves, treeSize)
    if (!Number.isSafeInteger(index) || index < 0 || index >= treeSize) throw new RangeError(`bad leaf index ${index}`)
    return path(leaves, index, 0, treeSize)
  },

  consistencyProof(leaves, from, to) {
    checkSize(leaves, to)
    if (!Number.isSafeInteger(from) || from < 0 || from > to) throw new RangeError(`bad consistency range ${from}..${to}`)
    if (from === 0 || from === to) return []
    return subproof(leaves, from, 0, to, true)
  },

  verifyInclusion,
  verifyConsistency,

  signTreeHead(ktPrivateKey, h) {
    return { ...h, signature: signWithLabel(ktPrivateKey, SignLabel.TREE_HEAD, encodeTreeHeadTbs(h)) }
  },

  verifyTreeHead(ktPublicKey, h) {
    try {
      return verifyWithLabel(ktPublicKey, SignLabel.TREE_HEAD, encodeTreeHeadTbs(h), h.signature)
    } catch {
      return false
    }
  },
}
