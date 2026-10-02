/**
 * Small seams of the DS: CORS headers, ApiError mapping, the seed files,
 * strict base64url, and the framings that the DS parses itself.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { CORS_ALLOW_HEADERS, applyCors, preflight } from '@/lib/cors'
import { ApiError } from '@/lib/errors'

import { fromB64, toB64 } from './bytes'
import { ed25519PublicKey, loadOrCreateSeed } from './keys'
import { encodeForTests, parseGroupInfoContext, parseLinkOffer, parsePublicMessagePrefix } from './wire-format'
import { encodeGroupId } from './groups'

describe('CORS (§4, §12.12)', () => {
  test('allows the device and signed-action headers and exposes Retry-After', () => {
    const res = new Response(null)
    applyCors(res, 'http://localhost:5173')
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173')
    const allow = res.headers.get('Access-Control-Allow-Headers')!.split(',').map((h) => h.trim())
    for (const h of ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Hachiman-Device', 'X-Hachiman-Device-Ts', 'X-Hachiman-Device-Nonce', 'X-Hachiman-Device-Sig', 'X-Hachiman-Signed-Action']) assert.ok(allow.includes(h), h)
    assert.equal(res.headers.get('Access-Control-Expose-Headers'), 'Retry-After')
    assert.equal(CORS_ALLOW_HEADERS, 'Authorization, Content-Type, X-Requested-With, X-Hachiman-Device, X-Hachiman-Device-Ts, X-Hachiman-Device-Nonce, X-Hachiman-Device-Sig, X-Hachiman-Signed-Action')
    const pre = preflight('http://localhost:5173')
    assert.equal(pre.status, 204)
    assert.ok(pre.headers.get('Access-Control-Allow-Headers')!.includes('X-Hachiman-Device'))
  })

  test('a disallowed origin gets no CORS headers', () => {
    const res = new Response(null)
    applyCors(res, 'https://evil.example')
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
    assert.equal(res.headers.get('Access-Control-Expose-Headers'), null)
  })
})

describe('ApiError (§12.18)', () => {
  test('errorResponse maps code, message, extra and Retry-After', async () => {
    const { errorResponse } = await import('@/lib/api-helpers')
    const res = errorResponse(new ApiError('EpochConflict', 409, 'another commit won', { epoch: 7 }))
    assert.equal(res.status, 409)
    assert.deepEqual(await res.json(), { error: 'EpochConflict', message: 'another commit won', epoch: 7 })
    const limited = errorResponse(new ApiError('RateLimited', 429, undefined, undefined, 12.2))
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('Retry-After'), '13')
    assert.deepEqual(await limited.json(), { error: 'RateLimited' })
    // `extra` cannot replace the code.
    const sneaky = errorResponse(new ApiError('IllegalMembership', 403, undefined, { error: 'Fine', userIds: ['u'] }))
    assert.deepEqual(await sneaky.json(), { error: 'IllegalMembership', userIds: ['u'] })
  })
})

describe('seed files (§12.7.1)', () => {
  test('two loaders that race for a missing file use one key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takusen-seed-'))
    const path = join(dir, 'keys', 'takusen-ds.ed25519')
    let inner: Uint8Array | null = null
    // Loader A makes its seed; while it is between create and link, loader B runs to completion.
    const a = loadOrCreateSeed(path, () => {
      inner = loadOrCreateSeed(path)
      return new Uint8Array(randomBytes(32))
    })
    assert.ok(inner)
    assert.deepEqual(a, inner, 'the loser reads the winner key')
    assert.deepEqual(new Uint8Array(readFileSync(path)), a)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(loadOrCreateSeed(path), a, 'a later load reads the same key')
  })

  test('a damaged seed file is fatal, never replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takusen-seed-'))
    const path = join(dir, 'bad.ed25519')
    writeFileSync(path, new Uint8Array(5))
    assert.throws(() => loadOrCreateSeed(path), /32-byte/)
    assert.equal(readFileSync(path).length, 5)
  })

  test('the Ed25519 public key of a seed (RFC 8032 test 1)', () => {
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex')
    assert.equal(Buffer.from(ed25519PublicKey(seed)).toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
  })
})

describe('encodings (§12.2)', () => {
  test('base64url is strict: no padding, no other alphabet, no non-zero trailing bits', () => {
    const b = new Uint8Array([0xff, 0xee, 0x01])
    assert.equal(toB64(b), '_-4B')
    assert.deepEqual(fromB64('_-4B'), b)
    assert.equal(fromB64('_-4B='), null)
    assert.equal(fromB64('/+4B'), null)
    assert.deepEqual(fromB64('AA'), new Uint8Array([0]))
    assert.equal(fromB64('AB'), null, 'non-zero trailing bits')
    assert.equal(fromB64('A'), null)
  })

  test('group ids are 22 bytes: version, kind, scope, generation', () => {
    const id = encodeGroupId('channel', '00000000-0000-0000-0000-000000000001', 3)
    assert.equal(id.length, 22)
    assert.equal(toB64(id).length, 30)
    assert.deepEqual([...id.subarray(0, 2)], [1, 2])
    assert.deepEqual([...id.subarray(18)], [0, 0, 0, 3])
  })

  test('PublicMessage prefix and GroupInfo context parse', () => {
    const groupId = new Uint8Array(22).fill(7)
    const commit = encodeForTests.publicMessagePrefix({ groupId, epoch: 2 ** 40, senderLeaf: 5, contentType: 3 }, new Uint8Array([9, 9]))
    const p = parsePublicMessagePrefix(commit)
    assert.deepEqual(p.groupId, groupId)
    assert.equal(p.epoch, 2 ** 40)
    assert.deepEqual(p.sender, { type: 'member', leafIndex: 5 })
    assert.equal(p.contentType, 'commit')
    const ext = parsePublicMessagePrefix(encodeForTests.publicMessagePrefix({ groupId, epoch: 1, senderLeaf: null, contentType: 3 }))
    assert.deepEqual(ext.sender, { type: 'new_member_commit' })
    const gi = encodeForTests.groupInfo({ cipherSuite: 1, groupId, epoch: 3, treeHash: new Uint8Array(32).fill(1), confirmedTranscriptHash: new Uint8Array(32).fill(2) })
    const c = parseGroupInfoContext(gi)
    assert.equal(c.epoch, 3)
    assert.deepEqual(c.treeHash, new Uint8Array(32).fill(1))
    assert.throws(() => parseGroupInfoContext(commit))
    assert.throws(() => parsePublicMessagePrefix(gi))
  })

  test('LinkOffer parse', () => {
    const userId = new Uint8Array(16).fill(1)
    const deviceId = new Uint8Array(16).fill(2)
    const o = parseLinkOffer(encodeForTests.linkOffer({ userId, deviceId, mlsSignatureKey: new Uint8Array(32).fill(3), hpkeKey: new Uint8Array(32).fill(4) }))
    assert.equal(o.userId, '01010101-0101-0101-0101-010101010101')
    assert.equal(o.mode, 'qr')
    assert.deepEqual(o.hpkeKey, new Uint8Array(32).fill(4))
  })
})
