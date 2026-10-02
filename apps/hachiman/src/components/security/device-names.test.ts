import { describe, expect, it } from 'vitest'
import type { UserKeys } from '@hachiman/client'
import { encode, toB64url, uuidToBytes } from '@hachiman/crypto/codec'
import { contactDevices, readCertificateName } from './device-names'

const USER = '11111111-1111-4111-8111-111111111111'
const DEV_A = '22222222-2222-4222-8222-222222222222'
const DEV_B = '33333333-3333-4333-8333-333333333333'

/** encode(DeviceCertificate) per §12.4, with a dummy signature. */
const cert = (userId: string, deviceId: string, name: string, issuedAtMs: number): string =>
  toB64url(
    encode((w) => {
      w.u8(1).fixed(uuidToBytes(userId), 16).fixed(uuidToBytes(deviceId), 16)
      w.opaque(new Uint8Array(32).fill(7)).fixed(new Uint8Array(32).fill(8), 32)
      w.u32(1).u64(issuedAtMs).utf8(name).opaque(new Uint8Array(64))
    })
  )

const device = (
  id: string,
  certificate: string | null,
  status: 'active' | 'revoked' = 'active'
): UserKeys['devices'][number] => ({
  id,
  status,
  certificate,
  revocation: null,
  ktIndex: null,
  ktEntry: null,
  revocationKtIndex: null,
  revocationKtEntry: null
})

describe('device names from certificates', () => {
  it('reads display_name and the ids', () => {
    expect(readCertificateName(cert(USER, DEV_A, 'Work laptop', 1000))).toEqual({
      userId: USER,
      deviceId: DEV_A,
      name: 'Work laptop',
      issuedAtMs: 1000
    })
  })

  it('rejects trailing bytes and other versions', () => {
    expect(readCertificateName(cert(USER, DEV_A, 'x', 1) + 'AA')).toBeNull()
    expect(readCertificateName('AgAA')).toBeNull()
  })

  it('lists only active devices whose certificate names the same user and device', () => {
    const old = '66666666-6666-4666-8666-666666666666'
    const keys: UserKeys = {
      userId: USER,
      masterKey: null,
      deviceSigningKey: null,
      devices: [
        device(DEV_B, cert(USER, DEV_B, 'Phone', 2000)),
        device(DEV_A, cert(USER, DEV_A, 'Desk', 1000)),
        device('44444444-4444-4444-8444-444444444444', cert(USER, DEV_A, 'Copy', 3000)),
        device('55555555-5555-4555-8555-555555555555', null),
        device(old, cert(USER, old, 'Old', 1), 'revoked')
      ]
    }
    expect(contactDevices(keys).map((d) => d.name)).toEqual(['Desk', 'Phone'])
  })
})
