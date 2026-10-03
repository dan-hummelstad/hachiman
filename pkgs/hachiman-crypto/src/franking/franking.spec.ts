import { describe, expect, it } from 'vitest'

import { CryptoError } from '../api'
import { bytes, fromHex, hex } from '../envelope/fixtures'
import { constantTimeEqual, franking } from './index'

const input = {
  frankingKey: Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i),
  channelId: '01234567-89ab-cdef-0123-456789abcdef',
  clientMsgId: Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i),
  content: new Uint8Array([1, 2, 3, 4]),
}

describe('franking', () => {
  it('matches the pinned vector (HMAC-SHA256 over label ‖ channel ‖ client_msg_id ‖ content)', async () => {
    // Computed with Node's crypto.createHmac, independent of @noble/hashes.
    expect(hex(await franking.tag(input))).toBe('0677d80c579872962221f7e5f81eb83cc73041d936aebb90e1f8a92489878108')
  })

  it('verifies the right opening and rejects every changed input', async () => {
    const tag = await franking.tag(input)
    expect(await franking.verify({ ...input, frankingTag: tag })).toBe(true)
    const flipped = tag.slice()
    flipped[0]! ^= 1
    expect(await franking.verify({ ...input, frankingTag: flipped })).toBe(false)
    expect(await franking.verify({ ...input, frankingTag: tag, content: new Uint8Array([1, 2, 3, 5]) })).toBe(false)
    expect(await franking.verify({ ...input, frankingTag: tag, channelId: '01234567-89ab-cdef-0123-456789abcdee' })).toBe(false)
    expect(await franking.verify({ ...input, frankingTag: tag, clientMsgId: bytes(16, 0) })).toBe(false)
    expect(await franking.verify({ ...input, frankingTag: tag, frankingKey: bytes(32, 0) })).toBe(false)
  })

  it('verify never throws on malformed input', async () => {
    const tag = await franking.tag(input)
    expect(await franking.verify({ ...input, frankingTag: tag.slice(0, 31) })).toBe(false)
    expect(await franking.verify({ ...input, frankingTag: tag, frankingKey: bytes(31, 0) })).toBe(false)
    expect(await franking.verify({ ...input, frankingTag: tag, channelId: 'nope' })).toBe(false)
    expect(await franking.verify({ ...input, frankingTag: tag, clientMsgId: bytes(3, 0) })).toBe(false)
  })

  it('tag rejects bad lengths with CryptoError', async () => {
    await expect(franking.tag({ ...input, frankingKey: bytes(16, 0) })).rejects.toBeInstanceOf(CryptoError)
  })

  it('generates 32-byte random keys', () => {
    const a = franking.generateKey()
    expect(a.length).toBe(32)
    expect(constantTimeEqual(a, franking.generateKey())).toBe(false)
  })

  it('constantTimeEqual', () => {
    expect(constantTimeEqual(fromHex('00ff'), fromHex('00ff'))).toBe(true)
    expect(constantTimeEqual(fromHex('00ff'), fromHex('00fe'))).toBe(false)
    expect(constantTimeEqual(fromHex('00'), fromHex('0000'))).toBe(false)
  })
})
