/**
 * Key transparency (docs/gateway-protocol.md §12.14): appends, proofs and
 * tree heads. The Merkle math is `DsModule.kt` (RFC 6962), shared with the
 * clients. Appends run in the transaction of the key change under the KT
 * advisory lock (MlsRepo.appendKtEntry). Only the gRPC process signs heads.
 */
import { ApiError } from '@/lib/errors'

import { toB64 } from './bytes'
import { KtEntryType, type DsModule, type WireKtEntry, type WireKtTreeHead } from './crypto'
import type { Outbox } from './events'
import type { KtEntryRow, KtHeadRow, MlsRepo } from './repo'

export type KtType = (typeof KtEntryType)[keyof typeof KtEntryType]

export async function appendKtEntry(
  repo: MlsRepo,
  ds: Pick<DsModule, 'kt'>,
  e: { type: KtType; userId: string; object: Uint8Array; now: Date },
): Promise<{ idx: number; entry: Uint8Array }> {
  const entry = ds.kt.encodeEntry({ type: e.type, userId: e.userId, timestampMs: e.now.getTime(), object: e.object })
  const idx = await repo.appendKtEntry({ userId: e.userId, type: e.type, entry, leafHash: ds.kt.leafHash(entry) })
  return { idx, entry }
}

export function toWireKtEntry(row: KtEntryRow): WireKtEntry {
  return { index: row.idx, userId: row.userId, type: row.type as KtType, entry: toB64(row.entry), createdAt: row.createdAt.toISOString() }
}

export function toWireTreeHead(ds: Pick<DsModule, 'kt'>, head: KtHeadRow): WireKtTreeHead {
  const decoded = ds.kt.decodeTreeHead(head.signed)
  return { treeSize: head.treeSize, timestamp: new Date(decoded.timestampMs).toISOString(), rootHash: toB64(head.rootHash), signed: toB64(head.signed) }
}

/** The KT entries of one user, keyed by the encoded object, for UserKeys (§12.12). */
export async function ktIndexOfObjects(repo: MlsRepo, ds: Pick<DsModule, 'kt'>, userId: string): Promise<Map<string, { idx: number; entry: Uint8Array }>> {
  const out = new Map<string, { idx: number; entry: Uint8Array }>()
  let after = -1
  for (;;) {
    const page = await repo.listKtEntriesOfUser(userId, after, 1000)
    for (const row of page) {
      const e = ds.kt.decodeEntry(row.entry)
      out.set(`${e.type}:${toB64(e.object)}`, { idx: row.idx, entry: row.entry })
    }
    if (page.length < 1000) return out
    after = page[page.length - 1]!.idx
  }
}

export async function treeHead(repo: MlsRepo, ds: Pick<DsModule, 'kt'>): Promise<WireKtTreeHead> {
  const head = await repo.latestKtHead()
  if (!head) throw new ApiError('NotFound', 404, 'no tree head yet')
  return toWireTreeHead(ds, head)
}

function intParam(v: string | null, name: string): number {
  if (v === null || !/^\d+$/.test(v)) throw new ApiError('ValidationError', 400, `${name} must be a non-negative integer`)
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new ApiError('ValidationError', 400, `${name} is too large`)
  return n
}

/** Proofs are given only for a size that a signed head has. */
async function requireSignedSize(repo: MlsRepo, treeSize: number): Promise<void> {
  const head = await repo.latestKtHead()
  if (!head || treeSize > head.treeSize || treeSize < 1) throw new ApiError('ValidationError', 400, 'treeSize is not covered by a signed tree head')
}

export async function inclusionProof(repo: MlsRepo, ds: Pick<DsModule, 'kt'>, params: URLSearchParams) {
  const index = intParam(params.get('index'), 'index')
  const treeSize = intParam(params.get('treeSize'), 'treeSize')
  await requireSignedSize(repo, treeSize)
  if (index >= treeSize) throw new ApiError('ValidationError', 400, 'index must be below treeSize')
  const hashes = await repo.ktLeafHashes(treeSize)
  return { leafIndex: index, treeSize, auditPath: ds.kt.inclusionProof(hashes, index, treeSize).map(toB64) }
}

export async function consistencyProof(repo: MlsRepo, ds: Pick<DsModule, 'kt'>, params: URLSearchParams) {
  const from = intParam(params.get('from'), 'from')
  const to = intParam(params.get('to'), 'to')
  if (from < 1 || from > to) throw new ApiError('ValidationError', 400, 'need 1 <= from <= to')
  await requireSignedSize(repo, to)
  const hashes = await repo.ktLeafHashes(to)
  return { from, to, proof: ds.kt.consistencyProof(hashes, from, to).map(toB64) }
}

export const KT_ENTRIES_MAX = 1000

export async function listEntries(repo: MlsRepo, params: URLSearchParams): Promise<WireKtEntry[]> {
  const userId = params.get('userId')
  if (userId !== null) {
    const after = params.has('after') ? Number(params.get('after')) : -1
    if (!Number.isInteger(after) || after < -1) throw new ApiError('ValidationError', 400, 'after must be an integer')
    const limit = params.has('limit') ? intParam(params.get('limit'), 'limit') : KT_ENTRIES_MAX
    if (limit < 1 || limit > KT_ENTRIES_MAX) throw new ApiError('ValidationError', 400, `limit must be 1 to ${KT_ENTRIES_MAX}`)
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new ApiError('ValidationError', 400, 'bad userId')
    return (await repo.listKtEntriesOfUser(userId, after, limit)).map(toWireKtEntry)
  }
  const start = intParam(params.get('start'), 'start')
  const end = intParam(params.get('end'), 'end')
  if (end < start || end - start > KT_ENTRIES_MAX) throw new ApiError('ValidationError', 400, `need start <= end <= start + ${KT_ENTRIES_MAX}`)
  return (await repo.listKtEntriesRange(start, end)).map(toWireKtEntry)
}

/**
 * The gRPC timer step (§12.14): when entries exist past the newest head, sign
 * a head that covers all of them, store it, and emit KT_TREE_HEAD to the owner
 * of each new entry. Returns the new head, or null when nothing was new.
 */
export async function signNextHead(repo: MlsRepo, ds: Pick<DsModule, 'kt'>, ktSeed: Uint8Array, now: Date, out: Outbox): Promise<KtHeadRow | null> {
  return repo.transaction(async (r) => {
    const last = await r.latestKtHead()
    const size = await r.ktSize()
    const from = last?.treeSize ?? 0
    if (size <= from) return null
    const hashes = await r.ktLeafHashes(size)
    const rootHash = ds.kt.rootHash(hashes)
    const signed = ds.kt.signTreeHead(ktSeed, { treeSize: size, timestampMs: now.getTime(), rootHash })
    const row = { treeSize: size, rootHash, signed: ds.kt.encodeTreeHead(signed) }
    await r.insertKtHead(row)
    await r.markKtHeadPublished(size, now)
    const head: KtHeadRow = { ...row, createdAt: now, publishedAt: now }
    const wire = toWireTreeHead(ds, head)
    const owners = new Set((await r.listKtEntriesRange(from, size)).map((e) => e.userId))
    for (const userId of owners) out.toUser(userId, 'KT_TREE_HEAD', wire)
    return head
  })
}
