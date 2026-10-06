import { describe, expect, it, vi } from 'vitest'
import { RestError, type DocSnapshot } from '@hachiman/client'
import type { DocDecryptResult } from '@hachiman/crypto'
import { isStale, openPointer, parsePointer, rewrapPointer } from './envelopes'

const CHANNEL = 'c-1'
const PAGE = 'p-1'
const utf8 = new TextEncoder()
const pointer = (uploadId: string): Uint8Array =>
  utf8.encode(JSON.stringify({ uploadId, fileKey: 'fk', sha256: 'sha', size: 1 }))

const snap = (over: Partial<DocSnapshot> = {}): DocSnapshot => ({
  pageId: PAGE,
  baseSeq: 3,
  uploadId: 'up-1',
  key: 'up-1/blob',
  size: 1,
  groupId: 'g-1',
  epoch: 1,
  senderDevice: 'd-2',
  envelope: 'env-1',
  mediaUploadIds: ['m-1'],
  createdAt: '2026-10-07T00:00:00.000Z',
  ...over
})

const sender = {
  userId: 'u-2',
  deviceId: 'd-2',
  leafIndex: 1,
  trust: 'tofu',
  membershipVerified: true
} as const

/** A Worker whose decryptDoc gives `result` (none for undefined). */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the fake is its own type
const cryptoGiving = (result?: DocDecryptResult) => ({
  decryptDoc: vi.fn(async () => (result ? [result] : [])),
  encryptDoc: vi.fn(async () => ({ envelope: 'env-2', groupId: 'g-1', epoch: 2 }))
})

const ok = (bytes: Uint8Array): DocDecryptResult => ({
  status: 'ok',
  id: 'snapshot',
  kind: 'doc_snapshot',
  bytes,
  sender
})

describe('isStale', () => {
  it('is true for another group or an older epoch', () => {
    const cur = { groupId: 'g-1', epoch: 2 }
    expect(isStale({ groupId: 'g-1', epoch: 1 }, cur)).toBe(true)
    expect(isStale({ groupId: 'g-0', epoch: 2 }, cur)).toBe(true)
    expect(isStale({ groupId: 'g-1', epoch: 2 }, cur)).toBe(false)
    expect(isStale({ groupId: 'g-1', epoch: 3 }, cur)).toBe(false)
  })
})

describe('parsePointer', () => {
  it('reads a pointer and refuses other bytes', () => {
    expect(parsePointer(pointer('up-1'))).toEqual({
      uploadId: 'up-1',
      fileKey: 'fk',
      sha256: 'sha',
      size: 1
    })
    expect(parsePointer(utf8.encode('{'))).toBeNull()
    expect(parsePointer(utf8.encode('null'))).toBeNull()
    expect(parsePointer(utf8.encode(JSON.stringify({ uploadId: 'up-1' })))).toBeNull()
    expect(parsePointer(new Uint8Array([0xff, 0xfe]))).toBeNull()
  })
})

describe('openPointer', () => {
  it('decrypts as a doc_snapshot of the page asked for, not of the row', async () => {
    const crypto = cryptoGiving(ok(pointer('up-1')))
    await openPointer(crypto, CHANNEL, PAGE, snap({ pageId: 'p-other' }))
    expect(crypto.decryptDoc).toHaveBeenCalledWith([
      {
        id: 'snapshot',
        channelId: CHANNEL,
        pageId: PAGE,
        kind: 'doc_snapshot',
        senderDevice: 'd-2',
        envelope: 'env-1'
      }
    ])
  })

  it('gives the pointer and its bytes', async () => {
    const bytes = pointer('up-1')
    const o = await openPointer(cryptoGiving(ok(bytes)), CHANNEL, PAGE, snap())
    expect(o).toEqual({ status: 'ok', pointer: parsePointer(bytes), bytes })
  })

  it('is pending with the reason of the Worker, and transport without a result', async () => {
    const pending: DocDecryptResult = { status: 'pending', id: 'snapshot', reason: 'epoch_ahead' }
    expect(await openPointer(cryptoGiving(pending), CHANNEL, PAGE, snap())).toEqual({
      status: 'pending',
      reason: 'epoch_ahead'
    })
    expect(await openPointer(cryptoGiving(), CHANNEL, PAGE, snap())).toEqual({
      status: 'pending',
      reason: 'transport'
    })
  })

  it('is bad with the failure, or with pointer for a bad pointer or another upload', async () => {
    const failed: DocDecryptResult = { status: 'failed', id: 'snapshot', reason: 'bad_signature' }
    expect(await openPointer(cryptoGiving(failed), CHANNEL, PAGE, snap())).toEqual({
      status: 'bad',
      reason: 'bad_signature'
    })
    const other = cryptoGiving(ok(pointer('up-2')))
    expect(await openPointer(other, CHANNEL, PAGE, snap())).toEqual({
      status: 'bad',
      reason: 'pointer'
    })
    const junk = cryptoGiving(ok(utf8.encode('not json')))
    expect(await openPointer(junk, CHANNEL, PAGE, snap())).toEqual({
      status: 'bad',
      reason: 'pointer'
    })
  })
})

describe('rewrapPointer', () => {
  it('posts the same bytes in the current epoch, with the baseSeq and uploads of the row', async () => {
    const bytes = pointer('up-1')
    const crypto = cryptoGiving(ok(bytes))
    const row = snap({ envelope: 'env-2', epoch: 2 })
    const rest = { postPageSnapshot: vi.fn(async () => row) }
    expect(await rewrapPointer(crypto, rest, CHANNEL, snap())).toBe(row)
    expect(crypto.encryptDoc).toHaveBeenCalledWith({
      channelId: CHANNEL,
      pageId: PAGE,
      kind: 'doc_snapshot',
      bytes
    })
    expect(rest.postPageSnapshot).toHaveBeenCalledWith(PAGE, {
      baseSeq: 3,
      uploadId: 'up-1',
      envelope: 'env-2',
      mediaUploadIds: ['m-1']
    })
  })

  it('posts nothing for a pointer that does not open or names another upload', async () => {
    for (const r of [
      ok(pointer('up-2')),
      { status: 'pending', id: 'snapshot', reason: 'no_history_key' } as const,
      { status: 'failed', id: 'snapshot', reason: 'aead' } as const
    ]) {
      const crypto = cryptoGiving(r)
      const rest = { postPageSnapshot: vi.fn() }
      expect(await rewrapPointer(crypto, rest, CHANNEL, snap())).toBeNull()
      expect(crypto.encryptDoc).not.toHaveBeenCalled()
      expect(rest.postPageSnapshot).not.toHaveBeenCalled()
    }
  })

  it('resolves null on 409 SnapshotConflict and throws other errors', async () => {
    const conflict = new RestError(409, 'SnapshotConflict', 'conflict')
    const rest = { postPageSnapshot: vi.fn().mockRejectedValueOnce(conflict) }
    expect(await rewrapPointer(cryptoGiving(ok(pointer('up-1'))), rest, CHANNEL, snap())).toBeNull()
    const denied = new RestError(403, 'MissingPermissions', 'denied')
    rest.postPageSnapshot.mockRejectedValueOnce(denied)
    await expect(
      rewrapPointer(cryptoGiving(ok(pointer('up-1'))), rest, CHANNEL, snap())
    ).rejects.toBe(denied)
  })
})
