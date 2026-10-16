/**
 * Push previews (docs/gateway-protocol.md §12.22). A sender seals the sender name and the text to
 * the push key of each recipient device, so the notification shows them while Takusen relays
 * only ciphertext. The recipient decrypts outside this Worker (the iOS Notification Service
 * Extension, the browser service worker), which holds the push private key.
 *
 * HPKE base mode, DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM: the suite that both
 * CryptoKit (`P256_SHA256_AES_GCM_256`) and WebCrypto can open. info = "hachiman push preview
 * v1", aad = the recipient device id (UTF-8). A push key is trusted only through its signature
 * by the MLS key of the device's leaf, so Takusen cannot put in a key of its own.
 */
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'

import type { CryptoApi, GroupService, IdentityService, PushPreview } from '../api'
import { fromB64url, toB64url } from '../codec'
import { HkdfInfo, PUSH_PREVIEW_MAX_BODY, PUSH_PREVIEW_MAX_TITLE, SignLabel } from '../constants'
import { signWithLabel, verifyWithLabel } from '../sign'

export type PushService = Pick<CryptoApi, 'signPushKey' | 'sealPushPreviews'>

let suite: CipherSuite | null = null
const hpke = (): CipherSuite =>
  (suite ??= new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() }))

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer

/** The signed content: the device id (36 characters, so the split is unique) ‖ the push key. */
export function pushKeyContent(deviceId: string, pushKey: Uint8Array): Uint8Array {
  const id = utf8(deviceId)
  const out = new Uint8Array(id.length + pushKey.length)
  out.set(id)
  out.set(pushKey, id.length)
  return out
}

/** The preview plaintext, cut to the limits. */
export function encodePushPreview(p: PushPreview): Uint8Array {
  return utf8(JSON.stringify({ t: p.title.slice(0, PUSH_PREVIEW_MAX_TITLE), b: p.body.slice(0, PUSH_PREVIEW_MAX_BODY), c: p.channelId }))
}

export async function sealPushPreview(pushKey: Uint8Array, deviceId: string, plaintext: Uint8Array): Promise<string> {
  const s = hpke()
  const ctx = await s.createSenderContext({ recipientPublicKey: await s.kem.deserializePublicKey(buf(pushKey)), info: buf(utf8(HkdfInfo.PUSH_PREVIEW)) })
  const ct = new Uint8Array(await ctx.seal(buf(plaintext), buf(utf8(deviceId))))
  const enc = new Uint8Array(ctx.enc)
  const out = new Uint8Array(enc.length + ct.length)
  out.set(enc)
  out.set(ct, enc.length)
  return toB64url(out)
}

export function createPushService(identity: IdentityService, groups: Pick<GroupService, 'channelRoster'>): PushService {
  return {
    async signPushKey(pushKey) {
      const self = identity.self()
      return toB64url(signWithLabel(self.mlsSignatureKey.privateKey, SignLabel.PUSH_KEY, pushKeyContent(self.deviceId, fromB64url(pushKey))))
    },

    async sealPushPreviews(channelId, preview, targets) {
      const self = identity.self()
      const leaves = new Map((await groups.channelRoster(channelId)).map((l) => [l.deviceId, l]))
      const plaintext = encodePushPreview(preview)
      const out: Record<string, string> = {}
      for (const t of targets) {
        const leaf = leaves.get(t.deviceId)
        if (!leaf || t.deviceId === self.deviceId) continue
        let key: Uint8Array
        let sig: Uint8Array
        try {
          key = fromB64url(t.pushKey)
          sig = fromB64url(t.signature)
        } catch {
          continue
        }
        // Fail closed: a key that the device did not sign gets nothing.
        if (key.length !== 65 || !verifyWithLabel(leaf.signatureKey, SignLabel.PUSH_KEY, pushKeyContent(t.deviceId, key), sig)) continue
        out[t.deviceId] = await sealPushPreview(key, t.deviceId, plaintext)
      }
      return out
    },
  }
}
