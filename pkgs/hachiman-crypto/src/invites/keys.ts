/**
 * The invite keys and the bundle seal (docs/gateway-protocol.md §12.11.4). Two key pairs come from
 * the 32-byte invite seed with HKDF-SHA256 (not the RFC 9180 DeriveKeyPair). An InviteBundle is
 * HPKE base mode with the §12.3 suite to `hpke_public`, info "hachiman invite bundle v1" and
 * aad = sign_public ‖ group_id, so a bundle opens only for its invite and its group.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

import { CryptoError, type Ed25519KeyPair, type X25519KeyPair } from '../api'
import { HkdfInfo, INVITE_BUNDLE_HPKE_INFO, INVITE_SEED_BYTES } from '../constants'
import { concatBytes, utf8 } from '../identity/bytes'
import { hpke } from '../identity/device-message'
import { type InviteRecord, decodeInviteBundle, encodeInviteBundle } from './codec'

export interface InviteKeys {
  /** X25519: opens the bundles. */
  hpke: X25519KeyPair
  /** Ed25519: signs InviteAuth. Its public key is the invite key id. */
  sign: Ed25519KeyPair
}

const bytes = (b: ArrayBuffer | Uint8Array): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b))

/** Throws CryptoError('Malformed') unless the seed has INVITE_SEED_BYTES. */
export function deriveInviteKeys(seed: Uint8Array): InviteKeys {
  if (seed.length !== INVITE_SEED_BYTES) throw new CryptoError('Malformed', `the invite seed must be ${INVITE_SEED_BYTES} bytes`)
  const salt = new Uint8Array(0)
  const hpkePrivate = hkdf(sha256, seed, salt, utf8(HkdfInfo.INVITE_HPKE), 32)
  // A noble Ed25519 secret key is the 32-byte seed of the key pair.
  const signPrivate = hkdf(sha256, seed, salt, utf8(HkdfInfo.INVITE_SIGN), 32)
  return {
    hpke: { privateKey: hpkePrivate, publicKey: x25519.getPublicKey(hpkePrivate) },
    sign: { privateKey: signPrivate, publicKey: ed25519.getPublicKey(signPrivate) },
  }
}

const aad = (signPublic: Uint8Array, groupId: Uint8Array): ArrayBuffer => concatBytes(signPublic, groupId).slice().buffer
const info = (): ArrayBuffer => utf8(INVITE_BUNDLE_HPKE_INFO).slice().buffer

/** Seals an encoded InviteBundleContent. Returns the encoded InviteBundle. */
export async function sealInviteBundle(record: Pick<InviteRecord, 'hpkePublic' | 'signPublic'>, groupId: Uint8Array, content: Uint8Array): Promise<Uint8Array> {
  if (record.signPublic.length !== 32) throw new CryptoError('Malformed', 'sign_public must be 32 bytes')
  let sealed: { ct: ArrayBuffer; enc: ArrayBuffer }
  try {
    const s = hpke()
    const recipientPublicKey = await s.kem.deserializePublicKey(record.hpkePublic.slice().buffer)
    sealed = await s.seal({ recipientPublicKey, info: info() }, content.slice().buffer, aad(record.signPublic, groupId))
  } catch {
    throw new CryptoError('Malformed', 'invite bundle does not seal to this record')
  }
  try {
    return encodeInviteBundle({ enc: bytes(sealed.enc), ciphertext: bytes(sealed.ct) })
  } catch (e) {
    throw new CryptoError('Malformed', `invite bundle: ${(e as Error).message}`)
  }
}

/**
 * Opens an encoded InviteBundle of `groupId` with the invite keys. Returns the encoded
 * InviteBundleContent (not verified: see record.ts). Throws CryptoError('Malformed') on any failure.
 */
export async function openInviteBundle(keys: InviteKeys, groupId: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  let b
  try {
    b = decodeInviteBundle(blob)
  } catch (e) {
    throw new CryptoError('Malformed', `invite bundle: ${(e as Error).message}`)
  }
  try {
    const s = hpke()
    const recipientKey = await s.kem.importKey('raw', keys.hpke.privateKey.slice().buffer, false)
    return bytes(await s.open({ recipientKey, enc: b.enc.slice().buffer, info: info() }, b.ciphertext.slice().buffer, aad(keys.sign.publicKey, groupId)))
  } catch {
    throw new CryptoError('Malformed', 'invite bundle does not open for this invite and group')
  }
}
