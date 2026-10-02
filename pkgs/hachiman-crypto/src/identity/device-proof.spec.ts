import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'

import { fromB64url } from '../codec'
import { DEVICE_PROOF_NONCE_RE, deviceProofMessage, type DeviceProof, type DeviceProofInput } from '../device-proof'
import { identity } from './index'
import { FakeDs, makeDevice } from './test-helpers'

const ALICE = '0f8fad5b-d9cb-469f-a165-70867728950e'
const sha = (n: number) => new Uint8Array(32).fill(n)

const verify = (p: DeviceProof, input: DeviceProofInput, deviceId: string, key: Uint8Array) =>
  ed25519.verify(fromB64url(p.sig), deviceProofMessage(input, deviceId, p.ts, p.nonce), key)

describe('proveDevice (§12.12 device proof)', () => {
  it('signs POST /devices with the presented key, then every request with the device key', async () => {
    const ds = new FakeDs()
    const dev = await makeDevice(ds, ALICE, 'Desktop')
    const reg: DeviceProofInput = { kind: 'ds', method: 'POST', pathAndQuery: '/api/v1/devices', bodySha256: sha(1) }
    let registration: { proof: DeviceProof; key: Uint8Array } | null = null
    const inner = dev.transport.registerDevice
    dev.transport.registerDevice = async (body) => {
      registration = { proof: await dev.svc.proveDevice(reg), key: fromB64url(body.mlsSignatureKey) }
      return inner(body)
    }
    await expect(dev.svc.proveDevice(reg)).rejects.toMatchObject({ code: 'NoIdentity' })
    await dev.svc.setupFirstDevice()

    expect(registration).not.toBeNull()
    const r = registration!
    expect(verify(r.proof, reg, '', r.key)).toBe(true)
    expect(r.proof.nonce).toMatch(DEVICE_PROOF_NONCE_RE)

    const deviceId = dev.svc.status().deviceId!
    const cert = identity.decodeDeviceCertificate(fromB64url(ds.devices.get(deviceId)!.certificate!))
    expect(cert.mlsSignatureKey).toEqual(r.key)

    const get: DeviceProofInput = { kind: 'ds', method: 'get', pathAndQuery: '/api/v1/devices/@me/inbox?after=3', bodySha256: sha(2) }
    const p1 = await dev.svc.proveDevice(get)
    const p2 = await dev.svc.proveDevice(get)
    expect(verify(p1, get, deviceId, cert.mlsSignatureKey)).toBe(true)
    expect(p1.nonce).not.toBe(p2.nonce)
    // Another device id, path or body hash does not verify.
    expect(verify(p1, get, '', cert.mlsSignatureKey)).toBe(false)
    expect(verify(p1, { ...get, pathAndQuery: '/api/v1/devices/@me/inbox?after=4' }, deviceId, cert.mlsSignatureKey)).toBe(false)
    expect(verify(p1, { ...get, bodySha256: sha(3) }, deviceId, cert.mlsSignatureKey)).toBe(false)

    const idf: DeviceProofInput = { kind: 'identify', sessionId: null, tokenSha256: sha(4) }
    const p3 = await dev.svc.proveDevice(idf)
    expect(verify(p3, idf, deviceId, cert.mlsSignatureKey)).toBe(true)
    expect(verify(p3, { ...idf, sessionId: 's-1' }, deviceId, cert.mlsSignatureKey)).toBe(false)
  })

  it('pins the message format', () => {
    const msg = deviceProofMessage({ kind: 'identify', sessionId: 's', tokenSha256: new Uint8Array(32) }, 'd', 1700000000000, 'AAAAAAAAAAAAAAAAAAAAAA')
    expect(new TextDecoder().decode(msg)).toBe(
      'hachiman-device-proof/1\nidentify\nd\ns\n1700000000000\nAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    )
    expect(() => deviceProofMessage({ kind: 'ds', method: 'GET', pathAndQuery: '/a\nb', bodySha256: sha(0) }, 'd', 1, 'n')).toThrow()
  })
})
