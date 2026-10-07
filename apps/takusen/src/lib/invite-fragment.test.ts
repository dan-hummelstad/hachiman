/**
 * The fragment decision of the invite page (`invite-fragment.ts`, contract §11 "Invite links"):
 * only a well-formed `#k=` goes on to the app, and every fragment leaves the address bar.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inviteFragment } from './invite-fragment'

/** The seed 0x00, 0x01, … 0x1f in base64url (§12.11.4 test vector). */
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

test('a page without a fragment forwards nothing and keeps its URL', () => {
  assert.deepEqual(inviteFragment(''), { forward: '', strip: false })
})

test('a well-formed key goes to both links and leaves the address bar', () => {
  assert.deepEqual(inviteFragment(`#k=${KEY}`), { forward: `#k=${KEY}`, strip: true })
})

test('an empty fragment forwards nothing', () => {
  assert.deepEqual(inviteFragment('#'), { forward: '', strip: true })
})

// The full malformed-key table is in @hachiman/client (src/invite-link.spec.ts).
test('a malformed, non-canonical or other fragment is not forwarded, and is stripped', () => {
  for (const hash of ['#k=', `#k=${KEY.slice(0, -1)}B`, '#section', `k=${KEY}`]) {
    assert.deepEqual(inviteFragment(hash), { forward: null, strip: true }, hash)
  }
})
