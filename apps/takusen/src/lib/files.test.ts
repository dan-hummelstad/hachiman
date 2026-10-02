/**
 * Unit tests for the pure upload / download helpers: limits parsing, safe
 * keys, Content-Length checks, Content-Disposition and Range parsing.
 *
 * Run with `tsx src/lib/files.test.ts` (part of `pnpm -F @hachiman/takusen test`).
 */
import assert from 'node:assert/strict'

import { DEFAULT_LIMITS } from '@hachiman/client/files'

import {
  BLOB_CONTENT_TYPE,
  contentDisposition,
  downloadHeaders,
  getLimits,
  normalizeContentType,
  parseContentLength,
  parseMaxUploadBytes,
  parseRange,
  parseUploadKind,
  safeName,
  toAttachment,
  uploadColumns,
  uploadKey,
} from './files'

let passed = 0
const failures: string[] = []
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}\n    ${(err as Error).message.replace(/\n/g, '\n    ')}`)
  }
}

test('limits: default, override, invalid', () => {
  assert.equal(parseMaxUploadBytes(undefined), DEFAULT_LIMITS.maxUploadBytes)
  assert.equal(parseMaxUploadBytes(''), 26214400)
  assert.equal(parseMaxUploadBytes('1048576'), 1048576)
  assert.throws(() => parseMaxUploadBytes('0'))
  assert.throws(() => parseMaxUploadBytes('-5'))
  assert.throws(() => parseMaxUploadBytes('10MB'))
  assert.throws(() => parseMaxUploadBytes('1.5'))
  assert.deepEqual(getLimits({ TAKUSEN_MAX_UPLOAD_BYTES: '100' }), { maxUploadBytes: 100, maxAttachmentsPerMessage: 10, maxEnvelopeBytes: 32768, maxPageSnapshotBytes: 104857600 })
  assert.equal(getLimits({ TAKUSEN_MAX_ENVELOPE_BYTES: '65536' }).maxEnvelopeBytes, 65536)
  assert.equal(getLimits({}).maxEnvelopeBytes, DEFAULT_LIMITS.maxEnvelopeBytes)
})

test('upload kind: kind=blob or filename=, never both', () => {
  assert.deepEqual(parseUploadKind(new URLSearchParams('kind=blob')), { kind: 'blob' })
  assert.deepEqual(parseUploadKind(new URLSearchParams('filename=%20me.png%20')), { kind: 'image', filename: 'me.png' })
  assert.equal(parseUploadKind(new URLSearchParams('kind=blob&filename=a.png')), null)
  assert.deepEqual(parseUploadKind(new URLSearchParams('kind=page_snapshot')), { kind: 'page_snapshot' })
  assert.equal(parseUploadKind(new URLSearchParams('kind=page_snapshot&filename=a.png')), null)
  assert.equal(parseUploadKind(new URLSearchParams('kind=file')), null)
  assert.equal(parseUploadKind(new URLSearchParams('')), null)
  assert.equal(parseUploadKind(new URLSearchParams('filename=')), null)
  assert.equal(parseUploadKind(new URLSearchParams({ filename: 'a'.repeat(256) })), null)
})

test('upload columns: a blob has no name, a fixed type and encrypted = true', () => {
  assert.deepEqual(uploadColumns('u1', { kind: 'blob' }, 'image/png'), {
    key: 'u1/blob',
    filename: null,
    contentType: BLOB_CONTENT_TYPE,
    encrypted: true,
  })
  assert.deepEqual(uploadColumns('u1', { kind: 'image', filename: 'my cat.PNG' }, 'Image/PNG; q=1'), {
    key: 'u1/my_cat.PNG',
    filename: 'my cat.PNG',
    contentType: 'image/png',
    encrypted: false,
  })
})

test('download headers: a blob is octet-stream with filename "blob"', () => {
  assert.deepEqual(downloadHeaders({ encrypted: true, contentType: 'image/png', filename: 'secret.png' }), {
    contentType: 'application/octet-stream',
    disposition: 'attachment; filename="blob"',
  })
  assert.deepEqual(downloadHeaders({ encrypted: false, contentType: 'image/png', filename: 'me.png' }), {
    contentType: 'image/png',
    disposition: 'inline',
  })
})

test('toAttachment: id, key and blob size only', () => {
  assert.deepEqual(toAttachment({ id: 'u1', key: 'u1/blob', size: 42 }), { id: 'u1', key: 'u1/blob', size: 42 })
})

test('safeName: replaces unsafe characters, caps length, never empty', () => {
  assert.equal(safeName('cat.png'), 'cat.png')
  assert.equal(safeName('my photo (1).JPG'), 'my_photo__1_.JPG')
  assert.equal(safeName('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(safeName('日本.txt'), '__.txt')
  assert.equal(safeName(''), 'file')
  assert.equal(safeName('a'.repeat(300)).length, 100)
  assert.equal(uploadKey('u1', 'a b.txt'), 'u1/a_b.txt')
})

test('normalizeContentType: base type only, octet-stream fallback', () => {
  assert.equal(normalizeContentType('image/PNG'), 'image/png')
  assert.equal(normalizeContentType('text/plain; charset=utf-8'), 'text/plain')
  assert.equal(normalizeContentType(null), 'application/octet-stream')
  assert.equal(normalizeContentType('garbage'), 'application/octet-stream')
  assert.equal(normalizeContentType('a/b\r\nX: y'), 'application/octet-stream')
})

test('parseContentLength: required, numeric, within the limit', () => {
  assert.equal(parseContentLength('0', 10), 0)
  assert.equal(parseContentLength('10', 10), 10)
  assert.equal(parseContentLength('11', 10), null)
  assert.equal(parseContentLength(null, 10), null)
  assert.equal(parseContentLength('', 10), null)
  assert.equal(parseContentLength('-1', 10), null)
  assert.equal(parseContentLength('1e3', 10_000), null)
  assert.equal(parseContentLength('99999999999999999999', Number.MAX_SAFE_INTEGER), null)
})

test('contentDisposition: inline only for embeddable types', () => {
  for (const t of ['image/png', 'image/avif', 'video/webm', 'audio/flac', 'audio/aac']) {
    assert.equal(contentDisposition(t, 'x'), 'inline', t)
  }
  for (const t of ['image/svg+xml', 'text/html', 'application/pdf', 'application/octet-stream']) {
    assert.match(contentDisposition(t, 'x'), /^attachment; /, t)
  }
})

test('contentDisposition: filename is header-safe and keeps UTF-8', () => {
  assert.equal(
    contentDisposition('text/plain', 'a "b".txt'),
    `attachment; filename="a _b_.txt"; filename*=UTF-8''a%20%22b%22.txt`,
  )
  assert.equal(
    contentDisposition('text/plain', 'naïve\r\n.txt'),
    `attachment; filename="na_ve__.txt"; filename*=UTF-8''na%C3%AFve%0D%0A.txt`,
  )
  assert.equal(
    contentDisposition('text/plain', "it's (1).txt"),
    `attachment; filename="it's (1).txt"; filename*=UTF-8''it%27s%20%281%29.txt`,
  )
})

test('parseRange: single ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=999-999', 1000), { start: 999, end: 999 })
})

test('parseRange: whole file for absent, malformed or multi ranges', () => {
  assert.equal(parseRange(null, 1000), null)
  assert.equal(parseRange('', 1000), null)
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null)
  assert.equal(parseRange('items=0-1', 1000), null)
  assert.equal(parseRange('bytes=-', 1000), null)
  assert.equal(parseRange('bytes=10-5', 1000), null)
})

test('parseRange: unsatisfiable', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable')
  assert.equal(parseRange('bytes=2000-3000', 1000), 'unsatisfiable')
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable')
  assert.equal(parseRange('bytes=0-', 0), 'unsatisfiable')
  assert.equal(parseRange('bytes=-10', 0), 'unsatisfiable')
})

// --- report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`files.test: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`files.test: ${passed} passed`)
