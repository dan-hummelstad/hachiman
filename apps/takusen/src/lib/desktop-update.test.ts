import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type Release, releaseBuild } from './desktop-update'

const SHA = 'a'.repeat(40)
const release = (extra: Partial<Release> = {}): Release => ({
  body: `Unsigned builds.\nCommit: ${SHA}`,
  assets: [
    { name: 'hachiman-macos.zip', url: 'https://api.github.com/assets/1', digest: 'sha256:mac' },
    { name: 'hachiman-windows.zip', url: 'https://api.github.com/assets/2', digest: 'sha256:win' },
  ],
  ...extra,
})

test('picks the platform asset and the commit from the notes', () => {
  assert.deepEqual(releaseBuild(release(), 'hachiman-windows.zip'), {
    sha: SHA,
    sha256: 'win',
    assetUrl: 'https://api.github.com/assets/2',
  })
})

test('no build without the platform asset or a commit line', () => {
  assert.equal(releaseBuild(release({ assets: [] }), 'hachiman-windows.zip'), null)
  assert.equal(releaseBuild(release({ body: 'no commit' }), 'hachiman-windows.zip'), null)
})

test('fails closed without a sha256 digest', () => {
  const assets = [{ name: 'hachiman-windows.zip', url: 'u', digest: null }]
  assert.equal(releaseBuild(release({ assets }), 'hachiman-windows.zip'), null)
})
