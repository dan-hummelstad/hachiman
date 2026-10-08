/** The member sample of the invite page (invite-landing.ts). */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pickMemberSample } from './invite-landing'

test('online members first, in member order, then the rest, at most n', () => {
  assert.deepEqual(pickMemberSample(['a', 'b', 'c', 'd', 'e'], new Set(['d', 'b']), 4), ['b', 'd', 'a', 'c'])
  assert.deepEqual(pickMemberSample(['a'], new Set(), 4), ['a'])
})
