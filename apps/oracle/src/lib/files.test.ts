/**
 * Unit tests for the pure upload / download helpers: limits parsing, safe
 * keys, Content-Length checks, Content-Disposition and Range parsing.
 *
 * Run with `tsx src/lib/files.test.ts` (part of `pnpm -F @hachiman/oracle test`).
 */
import assert from 'node:assert/strict'

import { DEFAULT_LIMITS } from '@hachiman/client/files'

import {
  contentDisposition,
  getLimits,
  normalizeContentType,
  parseContentLength,
  parseMaxUploadBytes,
  parseRange,
  safeName,
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
  assert.deepEqual(getLimits('100'), { maxUploadBytes: 100, maxAttachmentsPerMessage: 10 })
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
