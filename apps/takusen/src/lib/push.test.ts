import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { test } from 'node:test'

import { apnsPayload, encryptWebPush, es256Jwt, isWebPushEndpoint, p256FromScalar } from './push'

test('encryptWebPush is RFC 8291 aes128gcm: the user agent side decrypts it', () => {
  const ua = createECDH('prime256v1')
  const uaPublic = ua.generateKeys()
  const auth = randomBytes(16)
  const msg = encryptWebPush(Buffer.from('{"c":"x","e":"abc"}'), uaPublic, auth)
  // The user agent side, with hkdfSync (RFC 5869) instead of the hand-made HMAC steps.
  const salt = msg.subarray(0, 16)
  assert.equal(msg.readUInt32BE(16), 4096)
  const idlen = msg[20]!
  const asPublic = msg.subarray(21, 21 + idlen)
  const body = msg.subarray(21 + idlen)
  const secret = ua.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(body.subarray(body.length - 16))
  const pt = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()])
  assert.equal(pt[pt.length - 1], 2)
  assert.equal(pt.subarray(0, -1).toString(), '{"c":"x","e":"abc"}')
})

test('apnsPayload wakes the service extension only for a sealed preview', () => {
  assert.deepEqual(apnsPayload('c', 'sealed'), {
    aps: { alert: { title: 'Hachiman', body: 'New message' }, sound: 'default', 'thread-id': 'c', 'mutable-content': 1 },
    c: 'c',
    e: 'sealed',
  })
  assert.equal('mutable-content' in (apnsPayload('c', undefined) as { aps: object }).aps, false)
})

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
