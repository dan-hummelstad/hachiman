/**
 * Message franking (docs/gateway-protocol.md §12.16):
 * franking_tag = HMAC-SHA256(franking_key, "hachiman franking v1" ‖ channel_id(16) ‖ client_msg_id(16) ‖ encode(EnvelopeContent)).
 *
 * Pure @noble/hashes, so Takusen (`DsModule.verifyFrankingOpening`) can use it in Node.
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type { ChannelId, FrankingModule } from '../api'
import { CryptoError } from '../api'
import { uuidToBytes } from '../codec'
import { CLIENT_MSG_ID_LENGTH, FRANKING_KEY_LENGTH, FRANKING_TAG_LENGTH, HkdfInfo } from '../constants'

const LABEL = new TextEncoder().encode(HkdfInfo.FRANKING)

/** Constant time for equal lengths. Different lengths return false at once (lengths are public). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Synchronous core of `franking.tag`. Throws CryptoError('Malformed') on bad input lengths or ids. */
export function frankingTagSync(input: { frankingKey: Uint8Array; channelId: ChannelId; clientMsgId: Uint8Array; content: Uint8Array }): Uint8Array {
  if (input.frankingKey.length !== FRANKING_KEY_LENGTH) throw new CryptoError('Malformed', `franking key must be ${FRANKING_KEY_LENGTH} bytes`)
  if (input.clientMsgId.length !== CLIENT_MSG_ID_LENGTH) throw new CryptoError('Malformed', `client_msg_id must be ${CLIENT_MSG_ID_LENGTH} bytes`)
  let channel: Uint8Array
  try {
    channel = uuidToBytes(input.channelId)
  } catch {
    throw new CryptoError('Malformed', 'channel id is not a canonical UUID')
  }
  const mac = hmac.create(sha256, input.frankingKey)
  mac.update(LABEL)
  mac.update(channel)
  mac.update(input.clientMsgId)
  mac.update(input.content)
  return mac.digest()
}

/** Never throws: malformed input gives false. */
export function verifyFrankingSync(input: { frankingTag: Uint8Array; frankingKey: Uint8Array; channelId: ChannelId; clientMsgId: Uint8Array; content: Uint8Array }): boolean {
  if (input.frankingTag.length !== FRANKING_TAG_LENGTH) return false
  let expected: Uint8Array
  try {
    expected = frankingTagSync(input)
  } catch {
    return false
  }
  return constantTimeEqual(expected, input.frankingTag)
}

export const franking: FrankingModule = {
  generateKey(): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(FRANKING_KEY_LENGTH))
  },

  tag(input) {
    try {
      return Promise.resolve(frankingTagSync(input))
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)))
    }
  },

  verify(input) {
    return Promise.resolve(verifyFrankingSync(input))
  },
}
