/**
 * Device linking: the pure protocol steps (docs/gateway-protocol.md §12.5).
 * IdentityService moves the messages over the DS link session.
 */
import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { CryptoError, type LinkOffer, type LinkProtocol, type LinkSecrets, type LinkTransfer, type SasEmoji } from '../api'
import { fromB64url, toB64url } from '../codec'
import { HkdfInfo, LINK_QR_PREFIX, SAS_EMOJI_COUNT } from '../constants'
import { concatBytes, equalBytes, randomBytes, utf8 } from './bytes'
import { decodeLinkMessage, decodeLinkOffer, decodeLinkQr, decodeLinkTransfer, encodeLinkMessage, encodeLinkOffer, encodeLinkQr, encodeLinkTransfer } from './codec'

/** The Matrix client-server API SAS emoji table ("SAS method: emoji"), index 0 to 63. */
export const SAS_EMOJI: readonly (readonly [string, string])[] = [
  ['🐶', 'Dog'], ['🐱', 'Cat'], ['🦁', 'Lion'], ['🐎', 'Horse'], ['🦄', 'Unicorn'], ['🐷', 'Pig'], ['🐘', 'Elephant'], ['🐰', 'Rabbit'],
  ['🐼', 'Panda'], ['🐓', 'Rooster'], ['🐧', 'Penguin'], ['🐢', 'Turtle'], ['🐟', 'Fish'], ['🐙', 'Octopus'], ['🦋', 'Butterfly'], ['🌷', 'Flower'],
  ['🌳', 'Tree'], ['🌵', 'Cactus'], ['🍄', 'Mushroom'], ['🌏', 'Globe'], ['🌙', 'Moon'], ['☁️', 'Cloud'], ['🔥', 'Fire'], ['🍌', 'Banana'],
  ['🍎', 'Apple'], ['🍓', 'Strawberry'], ['🌽', 'Corn'], ['🍕', 'Pizza'], ['🎂', 'Cake'], ['❤️', 'Heart'], ['😀', 'Smiley'], ['🤖', 'Robot'],
  ['🎩', 'Hat'], ['👓', 'Glasses'], ['🔧', 'Spanner'], ['🎅', 'Santa'], ['👍', 'Thumbs Up'], ['☂️', 'Umbrella'], ['⌛', 'Hourglass'], ['⏰', 'Clock'],
  ['🎁', 'Gift'], ['💡', 'Light Bulb'], ['📕', 'Book'], ['✏️', 'Pencil'], ['📎', 'Paperclip'], ['✂️', 'Scissors'], ['🔒', 'Lock'], ['🔑', 'Key'],
  ['🔨', 'Hammer'], ['☎️', 'Telephone'], ['🏁', 'Flag'], ['🚂', 'Train'], ['🚲', 'Bicycle'], ['✈️', 'Aeroplane'], ['🚀', 'Rocket'], ['🏆', 'Trophy'],
  ['⚽', 'Ball'], ['🎸', 'Guitar'], ['🎺', 'Trumpet'], ['🔔', 'Bell'], ['⚓', 'Anchor'], ['🎧', 'Headphones'], ['📁', 'Folder'], ['📌', 'Pin'],
]

const LINK_SECRET_BYTES = 16

/** Emoji i is bits 6i … 6i+5 of the SAS bytes, most significant bit first. */
export function sasEmoji(sas: Uint8Array): SasEmoji[] {
  const out: SasEmoji[] = []
  for (let i = 0; i < SAS_EMOJI_COUNT; i++) {
    const bit = i * 6
    const byte = bit >>> 3
    const word = (sas[byte]! << 8) | (sas[byte + 1] ?? 0)
    const index = (word >>> (10 - (bit & 7))) & 63
    const [emoji, name] = SAS_EMOJI[index]!
    out.push({ index, emoji, name })
  }
  return out
}

export function encodeQrPayload(offer: LinkOffer, sessionId: string, ephemeralPublic: Uint8Array, linkSecret: Uint8Array): string {
  if (offer.mode !== 'qr') throw new CryptoError('Malformed', 'QR payload for a SAS offer')
  return LINK_QR_PREFIX + toB64url(encodeLinkQr({ offer, sessionId, ephemeralPublic, linkSecret }))
}

/** HMAC-SHA256(K_link, "done" ‖ th). */
export function doneConfirmation(key: Uint8Array, transcriptHash: Uint8Array): Uint8Array {
  return hmac(sha256, key, concatBytes(utf8('done'), transcriptHash))
}

export interface LinkProtocolExt extends LinkProtocol {
  confirmation(key: Uint8Array, transcriptHash: Uint8Array): Uint8Array
  verifyConfirmation(key: Uint8Array, transcriptHash: Uint8Array, confirmation: Uint8Array): boolean
}

export const link: LinkProtocolExt = {
  encodeOffer: encodeLinkOffer,
  decodeOffer: decodeLinkOffer,

  /** qrPayload is null: the caller calls encodeQr with the session id (LinkQr.session_id). */
  createOffer(base, mode) {
    const privateKey = x25519.utils.randomSecretKey()
    const ephemeral = { privateKey, publicKey: x25519.getPublicKey(privateKey) }
    const secrets: LinkSecrets = { ephemeral, linkSecret: mode === 'qr' ? randomBytes(LINK_SECRET_BYTES) : null }
    const commitment = mode === 'sas' ? sha256(ephemeral.publicKey) : new Uint8Array(0)
    const offer: LinkOffer = { ...base, mode, commitment }
    encodeLinkOffer(offer) // validates the fields
    return { offer, secrets, qrPayload: null }
  },

  encodeQr: encodeQrPayload,

  parseQr(payload) {
    const text = payload.trim()
    if (!text.startsWith(LINK_QR_PREFIX)) throw new CryptoError('Malformed', 'not a link QR code')
    let qr
    try {
      qr = decodeLinkQr(fromB64url(text.slice(LINK_QR_PREFIX.length)))
    } catch (e) {
      throw new CryptoError('Malformed', `link QR code: ${(e as Error).message}`)
    }
    if (qr.offer.mode !== 'qr') throw new CryptoError('Malformed', 'the QR code carries a SAS offer')
    return { offer: qr.offer, ephemeralPublic: qr.ephemeralPublic, linkSecret: qr.linkSecret, sessionId: qr.sessionId }
  },

  encodeMessage: encodeLinkMessage,
  decodeMessage: decodeLinkMessage,

  deriveSession({ offer, existingPublic, newPublic, ownPrivate, linkSecret }) {
    if (offer.mode === 'sas') {
      if (linkSecret !== null) throw new CryptoError('Malformed', 'SAS mode has no link secret')
      if (!equalBytes(sha256(newPublic), offer.commitment)) throw new CryptoError('SasMismatch', 'the revealed key does not match the commitment')
    } else if (linkSecret?.length !== LINK_SECRET_BYTES || offer.commitment.length !== 0) {
      throw new CryptoError('Malformed', 'QR mode needs a 16-byte link secret and no commitment')
    }
    const ownPublic = x25519.getPublicKey(ownPrivate)
    const peer = equalBytes(ownPublic, newPublic) ? existingPublic : equalBytes(ownPublic, existingPublic) ? newPublic : null
    if (peer === null) throw new CryptoError('Malformed', 'own key is neither link key')
    let shared: Uint8Array
    try {
      shared = x25519.getSharedSecret(ownPrivate, peer)
    } catch {
      throw new CryptoError('Malformed', 'bad peer link key')
    }
    if (shared.every((b) => b === 0)) throw new CryptoError('Malformed', 'low-order peer link key')
    const transcriptHash = sha256(concatBytes(encodeLinkOffer(offer), existingPublic, newPublic))
    const ikm = linkSecret === null ? shared : concatBytes(shared, linkSecret)
    const sas = hkdf(sha256, ikm, transcriptHash, utf8(HkdfInfo.LINK_SAS), 6)
    const key = hkdf(sha256, ikm, transcriptHash, utf8(HkdfInfo.LINK_KEY), 32)
    return { sas: sasEmoji(sas), key, transcriptHash }
  },

  sealTransfer(key, transcriptHash, t: LinkTransfer) {
    const nonce = randomBytes(12)
    return concatBytes(nonce, gcm(key, nonce, transcriptHash).encrypt(encodeLinkTransfer(t)))
  },

  openTransfer(key, transcriptHash, sealed) {
    if (sealed.length < 12 + 16) throw new CryptoError('Malformed', 'short link transfer')
    let plain: Uint8Array
    try {
      plain = gcm(key, sealed.subarray(0, 12), transcriptHash).decrypt(sealed.subarray(12))
    } catch {
      throw new CryptoError('LinkAborted', 'the link transfer does not open')
    }
    try {
      return decodeLinkTransfer(plain)
    } catch (e) {
      throw new CryptoError('Malformed', `link transfer: ${(e as Error).message}`)
    }
  },

  confirmation: doneConfirmation,
  verifyConfirmation: (key, th, c) => equalBytes(doneConfirmation(key, th), c),
}
