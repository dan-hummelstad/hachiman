import assert from 'node:assert/strict'
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { test } from 'node:test'

import { es256Jwt, isWebPushEndpoint, p256FromScalar } from './push'

test('es256Jwt signs a raw r‖s JWS that the public point verifies', () => {
  const { key, publicKey } = p256FromScalar(randomBytes(32))
  assert.equal(publicKey.length, 65)
  const jwt = es256Jwt({ alg: 'ES256' }, { aud: 'https://fcm.googleapis.com' }, key)
  const [h, c, s] = jwt.split('.')
  const sig = Buffer.from(s, 'base64url')
  assert.equal(sig.length, 64)
  const pub = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: publicKey.subarray(1, 33).toString('base64url'), y: publicKey.subarray(33).toString('base64url') },
  })
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, sig))
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { aud: 'https://fcm.googleapis.com' })
})

test('isWebPushEndpoint allows only the known push services over https', () => {
  assert.ok(isWebPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'))
  assert.ok(isWebPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'))
  assert.ok(isWebPushEndpoint('https://web.push.apple.com/abc'))
  assert.ok(isWebPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc'))
  assert.ok(!isWebPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'))
  assert.ok(!isWebPushEndpoint('https://fcm.googleapis.com:8443/x'))
  assert.ok(!isWebPushEndpoint('https://169.254.169.254/latest/meta-data'))
  assert.ok(!isWebPushEndpoint('https://evilpush.apple.com.example.org/x'))
  assert.ok(!isWebPushEndpoint('https://notify.windows.com.evil/x'))
  assert.ok(!isWebPushEndpoint('not a url'))
})
