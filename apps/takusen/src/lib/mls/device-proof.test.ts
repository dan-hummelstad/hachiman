/**
 * Device proof of possession (device-proof.ts, §12.12): a request names its device and signs with
 * the device MLS key. A bearer token without the key cannot claim the device.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { describe, test } from 'node:test'

import { ApiError } from '@/lib/errors'

import { deviceProofMessage } from './crypto'
import { requireDeviceWith } from './device-auth'
import { InMemoryDeviceBindings } from './device-binding'
import { checkDeviceProof, InMemoryNonceStore, readRequestProof } from './device-proof'
import { registerDevice } from './identity'
import { InMemoryMlsRepo } from './repo.in-memory'

const proofInvalid = (err: unknown) => err instanceof ApiError && err.code === 'DeviceProofInvalid' && err.status === 401

function keyPair(): { pub: Uint8Array; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const x = publicKey.export({ format: 'jwk' }).x!
  return { pub: new Uint8Array(Buffer.from(x, 'base64url')), priv: privateKey }
}

/** A request as RestClient sends it, signed by `priv` for `deviceId`. */
async function signed(
  priv: KeyObject,
  deviceId: string,
  opts: { method?: string; path?: string; body?: string; ts?: number; nonce?: string; tamperBody?: string } = {},
): Promise<Request> {
  const method = opts.method ?? 'POST'
  const path = opts.path ?? '/api/v1/devices/@me/inbox?after=1'
  const body = opts.body ?? (method === 'GET' ? '' : '{"a":1}')
  const ts = opts.ts ?? Date.now()
  const nonce = opts.nonce ?? randomBytes(16).toString('base64url')
  const bodySha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
  const msg = deviceProofMessage({ kind: 'ds', method, pathAndQuery: path, bodySha256 }, deviceId, ts, nonce)
  const sig = sign(null, msg, priv).toString('base64url')
  const headers: Record<string, string> = { 'x-hachiman-device-ts': String(ts), 'x-hachiman-device-nonce': nonce, 'x-hachiman-device-sig': sig }
  if (deviceId) headers['x-hachiman-device'] = deviceId
  const sent = opts.tamperBody ?? body
  return new Request(`http://takusen.test${path}`, { method, headers, ...(method === 'GET' ? {} : { body: sent }) })
}

describe('device proof', () => {
  test('a registration proof verifies with the presented key, once', async () => {
    const k = keyPair()
    const nonces = new InMemoryNonceStore()
    const req = await signed(k.priv, '', { path: '/api/v1/devices' })
    const proof = await readRequestProof(req)
    await checkDeviceProof(proof, '', k.pub, nonces, new Date())
    // The handler can still read the body.
    assert.equal(await req.text(), '{"a":1}')
    await assert.rejects(checkDeviceProof(proof, '', k.pub, nonces, new Date()), proofInvalid)
  })

  test('rejects another key, another body, a stale ts and missing headers', async () => {
    const k = keyPair()
    const other = keyPair()
    const nonces = new InMemoryNonceStore()
    const check = async (req: Request, key: Uint8Array | null = k.pub, now = new Date()) => checkDeviceProof(await readRequestProof(req), '', key, nonces, now)
    await assert.rejects(check(await signed(k.priv, ''), other.pub), proofInvalid)
    await assert.rejects(check(await signed(k.priv, '', { tamperBody: '{"a":2}' })), proofInvalid)
    await assert.rejects(check(await signed(k.priv, '', { ts: Date.now() - 6 * 60_000 })), proofInvalid)
    await assert.rejects(check(await signed(k.priv, '', { ts: Date.now() + 6 * 60_000 })), proofInvalid)
    await assert.rejects(check(await signed(k.priv, '', { nonce: 'short' })), proofInvalid)
    await assert.rejects(check(new Request('http://takusen.test/api/v1/devices', { method: 'POST', body: '{}' })), proofInvalid)
    await assert.rejects(check(await signed(k.priv, ''), null), proofInvalid)
    // A forged request does not burn the nonce of the real one.
    const nonce = randomBytes(16).toString('base64url')
    await assert.rejects(check(await signed(other.priv, '', { nonce })), proofInvalid)
    await check(await signed(k.priv, '', { nonce }))
  })

  test('requireDevice: a stolen token without the device key claims no device and binds nothing', async () => {
    const repo = new InMemoryMlsRepo()
    const alice = repo.addUser()
    const laptop = keyPair()
    const wire = await registerDevice(repo, alice, { name: 'laptop', platform: 'electron', clientVersion: '1.0.0', mlsSignatureKey: laptop.pub })
    await repo.updateDevice(wire.id, { status: 'active' })
    const bindings = new InMemoryDeviceBindings()
    const nonces = new InMemoryNonceStore()
    const as = async (req: Request, grantId: string) =>
      requireDeviceWith(repo, req.headers.get('x-hachiman-device'), alice, {}, new Date(), { bindings, grantId }, { proof: await readRequestProof(req), nonces })

    const thief = keyPair()
    await assert.rejects(as(await signed(thief.priv, wire.id), 'g-thief'), proofInvalid)
    assert.equal(bindings.byGrant.size, 0)
    // The laptop key on a registration-style proof (device id "") does not pass for the device.
    const anon = await signed(laptop.priv, '')
    const named = new Request(anon, { headers: { ...Object.fromEntries(anon.headers), 'x-hachiman-device': wire.id } })
    await assert.rejects(as(named, 'g-thief'), proofInvalid)

    const ok = await signed(laptop.priv, wire.id, { method: 'GET', path: `/api/v1/devices/${wire.id}` })
    assert.equal((await as(ok, 'g-laptop')).id, wire.id)
    assert.equal(bindings.byGrant.get('g-laptop'), wire.id)
  })

  test('requireDevice: a device without a registered key fails the proof', async () => {
    const repo = new InMemoryMlsRepo()
    const alice = repo.addUser()
    const wire = await registerDevice(repo, alice, { name: 'old', platform: 'browser', clientVersion: '1.0.0' })
    const k = keyPair()
    const req = await signed(k.priv, wire.id)
    await assert.rejects(
      requireDeviceWith(repo, wire.id, alice, { allowPending: true }, new Date(), undefined, { proof: await readRequestProof(req), nonces: new InMemoryNonceStore() }),
      proofInvalid,
    )
  })
})
