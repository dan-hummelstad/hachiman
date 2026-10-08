import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_EMOJI_BYTES } from '@hachiman/client/files'

import { createEmojiSchema, emojiClaimError } from './emojis'
import { InvalidImageError, UnknownUploadError } from './errors'

const ME = '00000000-0000-4000-8000-000000000001'
const row = (over: Partial<Parameters<typeof emojiClaimError>[0] & object> = {}) => ({
  uploaderId: ME,
  purpose: null,
  encrypted: false,
  contentType: 'image/png',
  size: 1000,
  ...over,
})

test('an unclaimed plaintext PNG, GIF or WebP of the caller is claimable', () => {
  for (const contentType of ['image/png', 'image/gif', 'image/webp']) {
    assert.equal(emojiClaimError(row({ contentType }), ME), null)
  }
  assert.equal(emojiClaimError(row({ size: MAX_EMOJI_BYTES }), ME), null)
})

test('the emoji claim refuses other uploads', () => {
  assert.ok(emojiClaimError(null, ME) instanceof UnknownUploadError)
  assert.ok(emojiClaimError(row({ uploaderId: '00000000-0000-4000-8000-000000000002' }), ME) instanceof UnknownUploadError)
  assert.ok(emojiClaimError(row({ purpose: 'image' }), ME) instanceof UnknownUploadError)
  assert.ok(emojiClaimError(row({ encrypted: true }), ME) instanceof UnknownUploadError)
  assert.ok(emojiClaimError(row({ contentType: 'image/jpeg' }), ME) instanceof InvalidImageError)
  assert.ok(emojiClaimError(row({ size: MAX_EMOJI_BYTES + 1 }), ME) instanceof InvalidImageError)
})

test('emoji names are 2 to 32 characters of a-z, 0-9 and _', () => {
  const ok = (name: string) => createEmojiSchema.safeParse({ name, uploadId: ME }).success
  assert.ok(ok('ab'))
  assert.ok(ok('party_parrot_2'))
  assert.ok(ok('a'.repeat(32)))
  assert.ok(!ok('a'))
  assert.ok(!ok('a'.repeat(33)))
  assert.ok(!ok('Party'))
  assert.ok(!ok('par-ty'))
  assert.ok(!ok('párty'))
})
