import { describe, expect, it } from 'vitest'

import { CryptoError } from '../api'
import { toB64url } from '../codec'
import { decodeInviteBundle, encodeInviteBundle } from './codec'
import { deriveInviteKeys, openInviteBundle, sealInviteBundle } from './keys'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const seed = (fill: number) => new Uint8Array(32).fill(fill)
const GROUP = new Uint8Array(22).fill(5)
const OTHER_GROUP = new Uint8Array(22).fill(6)
const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

const recordOf = (k: ReturnType<typeof deriveInviteKeys>) => ({ hpkePublic: k.hpke.publicKey, signPublic: k.sign.publicKey })

describe('invite keys', () => {
  it('derives both key pairs from the seed with HKDF (test vector of §12.11.4)', () => {
    const k = deriveInviteKeys(Uint8Array.from({ length: 32 }, (_, i) => i))
    expect(hex(k.hpke.publicKey)).toBe('f2e52868376523060a03d6ddcbaee000ddffe9f0fe3fec04a5d139a432c19873')
    expect(hex(k.sign.publicKey)).toBe('249ff29357de4ced21fd2e49eaca9944bb1957c2ef0b9b30e79220fef2c75d86')
    expect(toB64url(Uint8Array.from({ length: 32 }, (_, i) => i))).toHaveLength(43)
    expect(deriveInviteKeys(seed(1))).toEqual(deriveInviteKeys(seed(1)))
    expect(deriveInviteKeys(seed(1)).sign.publicKey).not.toEqual(deriveInviteKeys(seed(2)).sign.publicKey)
  })

  it('needs a 32-byte seed', () => {
    expect(() => deriveInviteKeys(new Uint8Array(31))).toThrow(CryptoError)
    expect(() => deriveInviteKeys(new Uint8Array(33))).toThrow(/32 bytes/)
  })
})

describe('invite bundle seal', () => {
  const k = deriveInviteKeys(seed(1))

  it('opens for the seed and the group', async () => {
    const blob = await sealInviteBundle(recordOf(k), GROUP, content)
    expect(decodeInviteBundle(blob).enc).toHaveLength(32)
    expect(await openInviteBundle(k, GROUP, blob)).toEqual(content)
  })

  it('does not open with another seed', async () => {
    const blob = await sealInviteBundle(recordOf(k), GROUP, content)
    await expect(openInviteBundle(deriveInviteKeys(seed(2)), GROUP, blob)).rejects.toThrow(/does not open/)
  })

  it('binds the group and the invite key id in the AAD', async () => {
    const blob = await sealInviteBundle(recordOf(k), GROUP, content)
    await expect(openInviteBundle(k, OTHER_GROUP, blob)).rejects.toThrow(/does not open/)
    // The right HPKE key, but the sign_public of another invite: a server cannot move a bundle between records.
    const other = deriveInviteKeys(seed(2))
    const moved = await sealInviteBundle({ hpkePublic: k.hpke.publicKey, signPublic: other.sign.publicKey }, GROUP, content)
    await expect(openInviteBundle(k, GROUP, moved)).rejects.toThrow(/does not open/)
  })

  it('rejects a relabelled or tampered bundle', async () => {
    const blob = await sealInviteBundle(recordOf(k), GROUP, content)
    const b = decodeInviteBundle(blob)
    const enc = b.enc.slice()
    enc[0]! ^= 1
    await expect(openInviteBundle(k, GROUP, encodeInviteBundle({ enc, ciphertext: b.ciphertext }))).rejects.toThrow(CryptoError)
    const ct = b.ciphertext.slice()
    ct[ct.length - 1]! ^= 1
    await expect(openInviteBundle(k, GROUP, encodeInviteBundle({ enc: b.enc, ciphertext: ct }))).rejects.toThrow(/does not open/)
    const v2 = blob.slice()
    v2[0] = 2
    await expect(openInviteBundle(k, GROUP, v2)).rejects.toThrow(/invite bundle: unsupported version/)
    await expect(openInviteBundle(k, GROUP, blob.subarray(0, 10))).rejects.toThrow(CryptoError)
  })

  it('fails closed on a bad record key', async () => {
    await expect(sealInviteBundle({ hpkePublic: k.hpke.publicKey, signPublic: new Uint8Array(31) }, GROUP, content)).rejects.toThrow(CryptoError)
    await expect(sealInviteBundle({ hpkePublic: new Uint8Array(5), signPublic: k.sign.publicKey }, GROUP, content)).rejects.toThrow(CryptoError)
  })
})
