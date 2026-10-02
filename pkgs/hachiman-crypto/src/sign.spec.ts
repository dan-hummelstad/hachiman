import { describe, expect, it } from 'vitest'

import { decode } from './codec'
import { generateEd25519, signContent, signWithLabel, verifyWithLabel } from './sign'

describe('SignWithLabel', () => {
  it('encodes the label with the Hachiman prefix', () => {
    const c = signContent('Envelope', new Uint8Array([1, 2]))
    const [label, content] = decode(c, (r) => [r.utf8(), r.opaque()] as const)
    expect(label).toBe('Hachiman 1.0 Envelope')
    expect(content).toEqual(new Uint8Array([1, 2]))
  })

  it('verifies only the same label, content and key', () => {
    const k = generateEd25519()
    const other = generateEd25519()
    const msg = new TextEncoder().encode('hello')
    const sig = signWithLabel(k.privateKey, 'MasterKey', msg)
    expect(verifyWithLabel(k.publicKey, 'MasterKey', msg, sig)).toBe(true)
    expect(verifyWithLabel(k.publicKey, 'DeviceCertificate', msg, sig)).toBe(false)
    expect(verifyWithLabel(k.publicKey, 'MasterKey', new TextEncoder().encode('hellO'), sig)).toBe(false)
    expect(verifyWithLabel(other.publicKey, 'MasterKey', msg, sig)).toBe(false)
    expect(verifyWithLabel(new Uint8Array(3), 'MasterKey', msg, sig)).toBe(false)
  })
})
