import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type Artifact, newestBuild } from './desktop-update'

const art = (sha: string, created_at: string, extra: Partial<Artifact> = {}): Artifact => ({
  name: 'hachiman-windows',
  expired: false,
  created_at,
  archive_download_url: `https://api.github.com/zip/${sha}`,
  digest: `sha256:${sha}00`,
  workflow_run: { head_sha: sha, head_branch: 'main' },
  ...extra,
})

test('picks the newest main-branch artifact', () => {
  const list = [art('old', '2026-10-01T00:00:00Z'), art('new', '2026-10-03T00:00:00Z')]
  assert.deepEqual(newestBuild(list, 'hachiman-windows'), {
    sha: 'new',
    sha256: 'new00',
    archiveUrl: 'https://api.github.com/zip/new',
  })
})

test('skips expired, other-branch and other-platform artifacts', () => {
  const list = [
    art('x', '2026-10-04T00:00:00Z', { expired: true }),
    art('y', '2026-10-04T00:00:00Z', { workflow_run: { head_sha: 'y', head_branch: 'dev' } }),
    art('z', '2026-10-04T00:00:00Z', { name: 'hachiman-macos' }),
  ]
  assert.equal(newestBuild(list, 'hachiman-windows'), null)
})

test('fails closed without a sha256 digest', () => {
  assert.equal(newestBuild([art('a', '2026-10-04T00:00:00Z', { digest: null })], 'hachiman-windows'), null)
})
