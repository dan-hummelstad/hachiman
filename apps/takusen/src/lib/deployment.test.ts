/** Deployment name, tag and Hachiman links (deployment.ts). */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { deploymentInfo, hachimanLinks, inviteLinks } from './deployment'

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
})
