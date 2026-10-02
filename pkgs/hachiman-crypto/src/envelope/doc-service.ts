/**
 * DocService (docs/gateway-protocol.md §12.20): page envelopes in the MLS group of a pages channel.
 * GroupService and IdentityService are injected, as for MessageService.
 */
import type { CreateDocService, CryptoErrorShape, DocDecryptFailure, DocDecryptResult, EncryptedDocItem, UserId } from '../api'
import { CryptoError } from '../api'
import { fromB64url, toB64url } from '../codec'
import { MAX_DOC_AWARENESS_B64_BYTES } from '../constants'
import { decodeDocEnvelope } from './codec'
import { openDoc, sealDoc } from './doc'

function dsCodeOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'dsCode' in e && typeof e.dsCode === 'string') return e.dsCode
  return undefined
}

function isTransient(e: unknown): boolean {
  return dsCodeOf(e) !== undefined || (e instanceof CryptoError && e.code === 'Transport')
}

export const createDocService: CreateDocService = (ctx, identity, groups) => {
  let maxEnvelopeBytes: Promise<number> | null = null

  function envelopeLimit(): Promise<number> {
    if (maxEnvelopeBytes === null) {
      maxEnvelopeBytes = ctx.transport.getDsInfo().then((info) => info.limits.maxEnvelopeBytes)
      maxEnvelopeBytes.catch(() => {
        maxEnvelopeBytes = null
      })
    }
    return maxEnvelopeBytes
  }

  async function isKnownGroup(groupIdB64: string): Promise<boolean> {
    if ((await ctx.store.get('groups', groupIdB64)) !== undefined) return true
    return (await ctx.store.list('epochSecrets', `${groupIdB64}:`)).length > 0
  }

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
    let header: ReturnType<typeof decodeDocEnvelope>['header']
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
    const groupIdB64 = toB64url(header.groupId)
    const epochSecret = await groups.epochSecret(header.groupId, header.epoch)
    if (epochSecret === null) {
      const current = await groups.currentEpoch(header.groupId)
      if (current !== null && header.epoch > current) return { status: 'pending', id: item.id, reason: 'epoch_ahead' }
      const reason = current === null && !(await isKnownGroup(groupIdB64)) ? 'group_unknown' : 'no_history_key'
      return { status: 'pending', id: item.id, reason }
    }

    // Steps 3 to 5.
    const opened = await openDoc<{ signatureKey: Uint8Array; userId: UserId }>(bytes, epochSecret, async (h) => {
      const cert = await identity.deviceOwnerCertificate(h.senderDeviceId, await ownerHint(groupIdB64, h.senderDeviceId))
      if (cert?.deviceId !== h.senderDeviceId) return { failure: 'invalid_chain' }
      // The revoked-sender rule of §12.8.5 step 4.
      const removedAt = await groups.removedAt(h.groupId, h.senderDeviceId)
      if (removedAt !== null && h.epoch >= removedAt && (await identity.chainContextFor(cert.userId, false)).revokedDeviceIds.has(h.senderDeviceId)) return { failure: 'invalid_chain' }
      return { signatureKey: cert.mlsSignatureKey, userId: cert.userId }
    })
    if ('failure' in opened) {
      if (opened.failure === 'aead') await groups.reportAeadFailure(header.groupId, header.epoch, header.senderDeviceId)
      return fail(opened.failure)
    }
    const sender = opened.sender.userId
    const leaf = await groups.leafAt(header.groupId, header.senderDeviceId, header.epoch)
    return {
      status: 'ok',
      id: item.id,
      kind: header.kind,
      bytes: opened.body,
      sender: {
        userId: sender,
        deviceId: header.senderDeviceId,
        leafIndex: header.senderLeaf,
        trust: await identity.trustOf(sender),
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

    async decryptDoc(items) {
      const out: DocDecryptResult[] = []
      let transient: { first: CryptoErrorShape; count: number } | null = null
      for (const item of items) {
        try {
          out.push(await decryptOne(item))
        } catch (e) {
          if (!isTransient(e)) throw e
          out.push({ status: 'pending', id: item.id, reason: 'transport' })
          transient ??= { first: { code: 'Transport', message: e instanceof Error ? e.message : String(e), dsCode: dsCodeOf(e) }, count: 0 }
          transient.count++
        }
      }
      if (transient !== null) {
        const { first, count } = transient
        ctx.emit('error', { ...first, message: `decryptDoc: ${count} of ${items.length} items pending after a DS error: ${first.message}` })
      }
      return out
    },
  }
}
