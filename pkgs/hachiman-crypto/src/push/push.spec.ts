import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'
import { describe, expect, it } from 'vitest'

import type { IdentityService, LeafEntry, SelfIdentity } from '../api'
import { fromB64url, toB64url } from '../codec'
import { generateEd25519, signWithLabel } from '../sign'
import { SignLabel } from '../constants'
import swSource from '../../../../apps/hachiman-browser/public/sw.js?raw'
import { createPushService, pushKeyContent } from './index'

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() })
const ME = '11111111-1111-4111-8111-111111111111'
const PEER = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

async function pushKeyPair(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return { priv: kp.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) }
}

async function open(priv: CryptoKey, sealed: string, deviceId: string): Promise<unknown> {
  const bytes = fromB64url(sealed)
  const ctx = await suite.createRecipientContext({
    recipientKey: priv,
    enc: bytes.slice(0, 65).buffer,
    info: new TextEncoder().encode('hachiman push preview v1').buffer,
  })
  const pt = await ctx.open(bytes.slice(65).buffer, new TextEncoder().encode(deviceId).buffer)
  return JSON.parse(new TextDecoder().decode(pt))
}

describe('push previews', () => {
  const mine = generateEd25519()
  const peerSig = generateEd25519()
  const identity = { self: () => ({ deviceId: ME, mlsSignatureKey: mine }) as unknown as SelfIdentity } as IdentityService
  const leaf = (deviceId: string, signatureKey: Uint8Array): LeafEntry => ({ leafIndex: 0, userId: deviceId, deviceId, signatureKey, chain: null })
  const service = createPushService(identity, {
    channelRoster: async () => [leaf(ME, mine.publicKey), leaf(PEER, peerSig.publicKey)],
  })

  it('seals to a key that the leaf signed, and to no other', async () => {
    const peer = await pushKeyPair()
    const stranger = await pushKeyPair()
    const signature = toB64url(signWithLabel(peerSig.privateKey, SignLabel.PUSH_KEY, pushKeyContent(PEER, peer.pub)))
    const forged = toB64url(signWithLabel(mine.privateKey, SignLabel.PUSH_KEY, pushKeyContent(PEER, stranger.pub)))
    const sealed = await service.sealPushPreviews('c', { title: 'alice', body: 'hi', channelId: 'c' }, [
      { deviceId: PEER, pushKey: toB64url(peer.pub), signature },
      { deviceId: PEER, pushKey: toB64url(stranger.pub), signature: forged },
      { deviceId: OTHER, pushKey: toB64url(peer.pub), signature },
      { deviceId: ME, pushKey: toB64url(peer.pub), signature },
    ])
    expect(Object.keys(sealed)).toEqual([PEER])
    // The forged entry came second for the same device and was skipped, so the first one stays.
    expect(await open(peer.priv, sealed[PEER]!, PEER)).toEqual({ t: 'alice', b: 'hi', c: 'c' })
    await expect(open(peer.priv, sealed[PEER]!, OTHER)).rejects.toThrow()
  })

  it('the browser service worker opens a sealed preview (apps/hachiman-browser/public/sw.js)', async () => {
    const self: { addEventListener: () => void; hachimanOpenPreview?: (k: object, s: string) => Promise<unknown> } = {
      addEventListener: () => undefined,
    }
    // The worker script runs with its globals as parameters: no IndexedDB, no event loop.
    new Function('self', 'indexedDB', swSource)(self, undefined)
    const openPreview = self.hachimanOpenPreview!
    const peer = await pushKeyPair()
    const signature = toB64url(signWithLabel(peerSig.privateKey, SignLabel.PUSH_KEY, pushKeyContent(PEER, peer.pub)))
    const sealed = await service.sealPushPreviews('c', { title: 'alice in #general', body: 'héllo 👋', channelId: 'c' }, [
      { deviceId: PEER, pushKey: toB64url(peer.pub), signature },
    ])
    const key = { priv: peer.priv, pub: peer.pub, deviceId: PEER }
    expect(await openPreview(key, sealed[PEER]!)).toEqual({ t: 'alice in #general', b: 'héllo 👋', c: 'c' })
    await expect(openPreview({ ...key, deviceId: OTHER }, sealed[PEER]!)).rejects.toThrow()
  })

  it('signPushKey signs deviceId ‖ key with the device MLS key', async () => {
    const { pub } = await pushKeyPair()
    const sig = await service.signPushKey(toB64url(pub))
    const peerService = createPushService(
      { self: () => ({ deviceId: PEER, mlsSignatureKey: peerSig }) as unknown as SelfIdentity } as IdentityService,
      { channelRoster: async () => [leaf(ME, mine.publicKey)] },
    )
    const out = await peerService.sealPushPreviews('c', { title: 't', body: 'b', channelId: 'c' }, [{ deviceId: ME, pushKey: toB64url(pub), signature: sig }])
    expect(Object.keys(out)).toEqual([ME])
  })
})
