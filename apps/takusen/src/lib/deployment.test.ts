/** Deployment name, tag and Hachiman links (deployment.ts). */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { deploymentInfo, desktopDownloadFor, hachimanLinks, inviteLinks } from './deployment'

describe('deploymentInfo', () => {
  test('the env name wins, then the NEXTAUTH_URL host, then "takusen"', () => {
    assert.deepEqual(
      deploymentInfo({ TAKUSEN_DEPLOYMENT_NAME: ' takusen-preview ', TAKUSEN_DEPLOYMENT_TAG: 'preview' }),
      {
        name: 'takusen-preview',
        tag: 'preview',
      },
    )
    assert.deepEqual(deploymentInfo({ NEXTAUTH_URL: 'https://id.example.com/' }), { name: 'id.example.com', tag: null })
    assert.deepEqual(deploymentInfo({ NEXTAUTH_URL: 'nope', TAKUSEN_DEPLOYMENT_TAG: '' }), {
      name: 'takusen',
      tag: null,
    })
  })
})

describe('links', () => {
  test('web URL without a trailing slash, invite links encoded', () => {
    assert.equal(hachimanLinks({ HACHIMAN_WEB_URL: 'https://app.example.com/' }).web, 'https://app.example.com')
    assert.deepEqual(inviteLinks('AB CD', { HACHIMAN_WEB_URL: 'https://app.example.com' }), {
      web: 'https://app.example.com/invite/AB%20CD',
      app: 'takusen://invite/AB%20CD',
    })
  })

  test('the desktop download follows the User-Agent', () => {
    const links = hachimanLinks({})
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    assert.equal(desktopDownloadFor(win, links), links.download.windows)
    assert.equal(desktopDownloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)', links), links.download.macos)
    assert.equal(desktopDownloadFor(null, links), links.download.macos)
  })
})
