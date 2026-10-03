/**
 * Hachiman SignWithLabel (docs/gateway-protocol.md §12.2). Synchronous on purpose:
 * ts-mls calls its commit callback synchronously, and the chain check runs there.
 */
import { ed25519 } from '@noble/curves/ed25519.js'

import type { Ed25519KeyPair } from './api'
import { encode } from './codec'
import { SIGN_LABEL_PREFIX } from './constants'

/** encode(struct { opaque label<V> = "Hachiman 1.0 " + label; opaque content<V> }). */
export function signContent(label: string, content: Uint8Array): Uint8Array {
  return encode((w) => w.utf8(SIGN_LABEL_PREFIX + label).opaque(content))
}

export function signWithLabel(privateKey: Uint8Array, label: string, content: Uint8Array): Uint8Array {
  return ed25519.sign(signContent(label, content), privateKey)
}

/** False for a bad signature and for malformed keys or signatures. */
export function verifyWithLabel(publicKey: Uint8Array, label: string, content: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, signContent(label, content), publicKey)
  } catch {
    return false
  }
}

export function generateEd25519(): Ed25519KeyPair {
  const privateKey = ed25519.utils.randomSecretKey()
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) }
}
