/** Safety numbers, verify QR codes and epoch codes (docs/gateway-protocol.md §12.5). */
import { sha512 } from '@noble/hashes/sha2.js'

import { CryptoError, type SafetyNumber, type UserId } from '../api'
import { fromB64url, toB64url, uuidToBytes } from '../codec'
import {
  EPOCH_CODE_GROUPS,
  SAFETY_NUMBER_GROUPS_PER_USER,
  SAFETY_NUMBER_ITERATIONS,
  SAFETY_NUMBER_VERSION,
  VERIFY_QR_PREFIX,
} from '../constants'
import { compareBytes, concatBytes } from './bytes'
import { decodeVerifyQr, encodeVerifyQr } from './codec'

/** 5-digit groups from 5-byte big-endian chunks: uint40 mod 100000. */
function digitGroups(bytes: Uint8Array, groups: number): string[] {
  if (bytes.length < groups * 5) throw new CryptoError('Malformed', 'not enough bytes for the code')
  const out: string[] = []
  for (let j = 0; j < groups; j++) {
    let v = 0
    for (let i = 0; i < 5; i++) v = v * 256 + bytes[j * 5 + i]!
    out.push(String(v % 100000).padStart(5, '0'))
  }
  return out
}

function fingerprint(userId: UserId, masterKey: Uint8Array): string[] {
  const version = new Uint8Array([SAFETY_NUMBER_VERSION >>> 8, SAFETY_NUMBER_VERSION & 0xff])
  let h = concatBytes(version, masterKey, uuidToBytes(userId))
  for (let k = 0; k < SAFETY_NUMBER_ITERATIONS; k++) h = sha512(concatBytes(h, masterKey))
  return digitGroups(h.subarray(0, SAFETY_NUMBER_GROUPS_PER_USER * 5), SAFETY_NUMBER_GROUPS_PER_USER)
}

export function safetyNumber(self: { userId: UserId; masterKey: Uint8Array }, peer: { userId: UserId; masterKey: Uint8Array }): SafetyNumber {
  const selfFirst = compareBytes(uuidToBytes(self.userId), uuidToBytes(peer.userId)) < 0
  const [a, b] = selfFirst ? [self, peer] : [peer, self]
  const groups = [...fingerprint(a.userId, a.masterKey), ...fingerprint(b.userId, b.masterKey)]
  const qr = encodeVerifyQr({ userId: self.userId, masterKey: self.masterKey, peerUserId: peer.userId, peerMasterKey: peer.masterKey })
  return { digits: groups.join(''), groups, qrPayload: VERIFY_QR_PREFIX + toB64url(qr) }
}

export function parseVerifyQr(payload: string): { userId: UserId; masterKey: Uint8Array; peerUserId: UserId; peerMasterKey: Uint8Array } {
  const text = payload.trim()
  if (!text.startsWith(VERIFY_QR_PREFIX)) throw new CryptoError('Malformed', 'not a verify QR code')
  try {
    return decodeVerifyQr(fromB64url(text.slice(VERIFY_QR_PREFIX.length)))
  } catch (e) {
    throw new CryptoError('Malformed', `verify QR code: ${(e as Error).message}`)
  }
}

/** 30 digits from the first 30 bytes of the epoch authenticator. */
export function epochCode(epochAuthenticator: Uint8Array): string {
  return digitGroups(epochAuthenticator, EPOCH_CODE_GROUPS).join('')
}
