import assert from 'node:assert/strict'
import { test } from 'node:test'

import { safeNext } from './safe-next'

test('safeNext keeps same-origin paths only', () => {
  assert.equal(safeNext('/oidc/interaction/abc?x=1'), '/oidc/interaction/abc?x=1')
  for (const bad of ['//evil.com', '/\\evil.com', '/\t/evil.com', '/a\nb', 'https://evil.com', 'dashboard', '', null, 7]) {
    assert.equal(safeNext(bad), undefined, String(bad))
  }
})
