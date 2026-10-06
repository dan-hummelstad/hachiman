/**
 * The snapshot pointer of a page (contract §12.20): its staleness, its open (decrypt, parse and
 * the upload check, in one place for the reader and the re-wrapper) and its re-wrap in the current
 * epoch. DocProvider and the re-wrap pass (rewrap.ts) use it.
 *
 * Plain dependencies, so the rules are testable without a Worker or a server.
 */
import type { DocSnapshot, RestClient } from '@hachiman/client'
import type { CryptoApi, DocDecryptResult, DocSnapshotPointer } from '@hachiman/crypto'

type GroupEpoch = { groupId: string; epoch: number }
type PendingReason = Extract<DocDecryptResult, { status: 'pending' }>['reason']

const fromUtf8 = new TextDecoder('utf-8', { fatal: true })
/** The error code of a RestError or of a Worker error. */
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code

/** An envelope of another group, or of an older epoch, is closed to a member that joined later. */
export const isStale = (g: GroupEpoch, current: GroupEpoch): boolean =>
  g.groupId !== current.groupId || g.epoch < current.epoch

export function parsePointer(bytes: Uint8Array): DocSnapshotPointer | null {
  try {
    const p = JSON.parse(fromUtf8.decode(bytes)) as Partial<DocSnapshotPointer> | null
    return p &&
      typeof p.uploadId === 'string' &&
      typeof p.fileKey === 'string' &&
      typeof p.sha256 === 'string' &&
      typeof p.size === 'number'
      ? (p as DocSnapshotPointer)
      : null
  } catch {
    return null
  }
}

export type OpenedPointer =
  | { status: 'ok'; pointer: DocSnapshotPointer; bytes: Uint8Array }
  | { status: 'pending'; reason: PendingReason }
  | {
      status: 'bad'
      /** The decrypt failure, or 'pointer' for a bad pointer or a pointer of another upload. */
      reason: string
    }

/**
 * Decrypts the pointer of `snap` as a doc_snapshot of `pageId` and checks that it names the
 * upload of the row. `pageId` is the page that the caller asked for, so that the snapshot row of
 * another page does not open.
 */
export async function openPointer(
  crypto: Pick<CryptoApi, 'decryptDoc'>,
  channelId: string,
  pageId: string,
  snap: DocSnapshot
): Promise<OpenedPointer> {
  const [r] = await crypto.decryptDoc([
    {
      id: 'snapshot',
      channelId,
      pageId,
      kind: 'doc_snapshot',
      senderDevice: snap.senderDevice,
      envelope: snap.envelope
    }
  ])
  if (!r || r.status === 'pending') return { status: 'pending', reason: r?.reason ?? 'transport' }
  if (r.status === 'failed') return { status: 'bad', reason: r.reason }
  const pointer = parsePointer(r.bytes)
  if (!pointer || pointer.uploadId !== snap.uploadId) return { status: 'bad', reason: 'pointer' }
  return { status: 'ok', pointer, bytes: r.bytes }
}

/**
 * Posts the pointer of `snap` again, encrypted in the current epoch, with the same baseSeq and
 * uploadId. The re-wrapper signs the pointer as its own, so only a pointer that verifies and names
 * the upload of the row goes out. Resolves the new row, or null when this device cannot open the
 * pointer or another member was first (409 SnapshotConflict).
 */
export async function rewrapPointer(
  crypto: Pick<CryptoApi, 'encryptDoc' | 'decryptDoc'>,
  rest: Pick<RestClient, 'postPageSnapshot'>,
  channelId: string,
  snap: DocSnapshot
): Promise<DocSnapshot | null> {
  const { pageId } = snap
  const o = await openPointer(crypto, channelId, pageId, snap)
  if (o.status !== 'ok') return null
  const out = await crypto.encryptDoc({ channelId, pageId, kind: 'doc_snapshot', bytes: o.bytes })
  try {
    return await rest.postPageSnapshot(pageId, {
      baseSeq: snap.baseSeq,
      uploadId: snap.uploadId,
      envelope: out.envelope,
      mediaUploadIds: snap.mediaUploadIds
    })
  } catch (e) {
    if (codeOf(e) === 'SnapshotConflict') return null
    throw e
  }
}
