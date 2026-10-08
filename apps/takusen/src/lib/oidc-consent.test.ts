/** The consent page request view and the redirect URI kinds (oidc-consent.ts). */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { consentRequest, redirectUriKind } from './oidc-consent'

describe('consentRequest', () => {
  test('reads the client, scopes, redirect and PKCE from the interaction', () => {
    assert.deepEqual(
      consentRequest({
        prompt: { name: 'consent' },
        params: {
          client_id: 'hachiman-client',
          scope: 'openid profile  email openid',
          redirect_uri: 'app.hachiman://oauth-callback',
          code_challenge: 'abc',
          code_challenge_method: 'S256',
        },
      }),
      {
        prompt: 'consent',
        clientId: 'hachiman-client',
        scopes: ['openid', 'profile', 'email'],
        redirectUri: 'app.hachiman://oauth-callback',
        pkce: true,
      },
    )
  })

  test('missing params', () => {
    assert.deepEqual(consentRequest({ prompt: { name: 'login' }, params: {} }), {
      prompt: 'login',
      clientId: '',
      scopes: [],
      redirectUri: null,
      pkce: false,
    })
  })
})

describe('redirectUriKind', () => {
  test('desktop scheme, desktop bridge, web and junk', () => {
    assert.equal(redirectUriKind('app.hachiman://oauth-callback'), 'desktop')
    assert.equal(redirectUriKind('http://localhost:3000/oauth/electron-bridge'), 'desktop_bridge')
    assert.equal(redirectUriKind('http://localhost:5173/oauth/callback'), 'web')
    assert.equal(redirectUriKind('not a url'), 'other')
  })
})
