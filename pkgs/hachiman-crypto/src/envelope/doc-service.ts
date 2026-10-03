/**
 * DocService (docs/gateway-protocol.md §12.20): page envelopes in the MLS group of a pages channel.
 * GroupService and IdentityService are injected, as for MessageService.
 */
import type { CreateDocService, DocDecryptFailure, DocDecryptResult, DocEnvelopeHeader, EncryptedDocItem, UserId } from '../api'
import { CryptoError } from '../api'
import { fromB64url, toB64url } from '../codec'
import { MAX_DOC_AWARENESS_B64_BYTES } from '../constants'
import { decodeDocEnvelope } from './codec'
import { openDoc, sealDoc } from './doc'
import { decryptEach, envelopeLimitOf, isRevokedSender, missingEpochReason } from './service'

export const createDocService: CreateDocService = (ctx, identity, groups) => {
  const envelopeLimit = envelopeLimitOf(ctx)

  /**
   * A doc item names no author, so the lookup starts at the user that the membership timeline
   * names for the device, else at this user. deviceOwnerCertificate then looks at every user
   * whose keys this Worker verified.
   */
  async function ownerHint(groupIdB64: string, deviceId: string): Promise<UserId> {
    const events = (await ctx.store.get('timeline', groupIdB64))?.events ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const s = events[i]!.subjects.find((x) => x.deviceId === deviceId)
      if (s !== undefined) return s.userId
    }
    return identity.self().userId
  }

  async function decryptOne(item: EncryptedDocItem): Promise<DocDecryptResult> {
    const fail = (reason: DocDecryptFailure): DocDecryptResult => ({ status: 'failed', id: item.id, reason })

    // Step 1: the header against the item.
    let bytes: Uint8Array
    let header: DocEnvelopeHeader
    try {
      bytes = fromB64url(item.envelope)
      header = decodeDocEnvelope(bytes).header
    } catch {
      return fail('malformed')
    }
    if (header.channelId !== item.channelId) return fail('wrong_channel')
    if (header.pageId !== item.pageId) return fail('wrong_page')
    if (header.kind !== item.kind) return fail('wrong_kind')
    if (item.senderDevice !== null && header.senderDeviceId !== item.senderDevice) return fail('device_mismatch')

    // Step 2: the epoch secret (a retained one for an old epoch).
    const epochSecret = await groups.epochSecret(header.groupId, header.epoch)
    if (epochSecret === null) return { status: 'pending', id: item.id, reason: await missingEpochReason(ctx, groups, header.groupId, header.epoch) }

    const opened = await openDoc<{ signatureKey: Uint8Array; userId: UserId }>(bytes, epochSecret, async (h) => {
      const cert = await identity.deviceOwnerCertificate(h.senderDeviceId, await ownerHint(toB64url(h.groupId), h.senderDeviceId))
      if (cert?.deviceId !== h.senderDeviceId) return { failure: 'invalid_chain' }
      if (await isRevokedSender(identity, groups, h, cert.userId)) return { failure: 'invalid_chain' }
      return { signatureKey: cert.mlsSignatureKey, userId: cert.userId }
    })
    if ('failure' in opened) {
      if (opened.failure === 'aead') await groups.reportAeadFailure(header.groupId, header.epoch, header.senderDeviceId)
      return fail(opened.failure)
    }
    const { userId } = opened.sender
    const leaf = await groups.leafAt(header.groupId, header.senderDeviceId, header.epoch)
    return {
      status: 'ok',
      id: item.id,
      kind: header.kind,
      bytes: opened.body,
      sender: {
        userId,
        deviceId: header.senderDeviceId,
        leafIndex: header.senderLeaf,
        trust: await identity.trustOf(userId),
        membershipVerified: leaf !== null && leaf === header.senderLeaf,
      },
    }
  }

  return {
    async encryptDoc(input) {
      if (!(input.bytes instanceof Uint8Array)) throw new CryptoError('Malformed', 'bytes must be a Uint8Array')
      const state = await groups.sendState(input.channelId)
      const self = identity.self()
      const sealed = await sealDoc({
        header: {
          kind: input.kind,
          groupId: state.groupId,
          channelId: input.channelId,
          pageId: input.pageId,
          epoch: state.epoch,
          senderLeaf: state.ownLeaf,
          senderDeviceId: self.deviceId,
        },
        body: input.bytes,
        sentAtMs: ctx.now(),
        epochSecret: state.epochSecret,
        signatureKey: self.mlsSignatureKey.privateKey,
      })
      const envelope = toB64url(sealed)
      if (input.kind === 'doc_awareness') {
        if (envelope.length > MAX_DOC_AWARENESS_B64_BYTES) throw new CryptoError('TooLarge', `awareness envelope of ${envelope.length} characters exceeds ${MAX_DOC_AWARENESS_B64_BYTES}`)
      } else {
        const limit = await envelopeLimit()
        if (sealed.length > limit) throw new CryptoError('TooLarge', `envelope of ${sealed.length} bytes exceeds ${limit}`)
      }
      return { envelope, groupId: toB64url(state.groupId), epoch: state.epoch }
    },

    decryptDoc: (items) => decryptEach<EncryptedDocItem, DocDecryptResult>(ctx, 'decryptDoc', items, decryptOne, (item) => ({ status: 'pending', id: item.id, reason: 'transport' })),
  }
}
