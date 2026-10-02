/**
 * MessageService (docs/gateway-protocol.md §12.8.3, §12.8.5, §12.9, §12.16): message send and
 * receive, franking reports and attachment blobs. GroupService and IdentityService are injected.
 */
import type {
  AttachmentPointer,
  CreateMessageService,
  CryptoErrorShape,
  DecryptFailure,
  DecryptResult,
  EncryptedMessage,
  EnvelopeHeader,
  EnvelopeOpenResult,
  MessageContent,
  ThumbnailPointer,
} from '../api'
import { CryptoError } from '../api'
import { fromB64url, toB64url } from '../codec'
import { CLIENT_MSG_ID_LENGTH } from '../constants'
import { attachments } from '../attachments'
import { encodeContent, envelopeLength, uploadIdsOf } from './codec'
import { envelope } from './index'

/** Placeholder upload id: a draft validates its pointer fields before the upload ids exist. */
const DRAFT_UPLOAD_ID = '00000000-0000-0000-0000-000000000000'

/** Lowercase type/subtype without parameters. An empty or odd type becomes application/octet-stream. */
export function normalizeMime(mime: string): string {
  const base = mime.split(';', 1)[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) && base.length <= 127 ? base : 'application/octet-stream'
}

export function seenKey(channelId: string, clientMsgId: string): string {
  return `${channelId}:${clientMsgId}`
}

function bytesFromB64(s: string, length: number | null, what: string): Uint8Array {
  let out: Uint8Array
  try {
    out = fromB64url(s)
  } catch {
    throw new CryptoError('Malformed', `${what} is not base64url`)
  }
  if (length !== null && out.length !== length) throw new CryptoError('Malformed', `${what} must be ${length} bytes`)
  return out
}

/** Steps 1 to 8 passed: the opened envelope and the values the later steps need. */
interface Verified {
  opened: EnvelopeOpenResult
  header: EnvelopeHeader
}

type Step = { ok: true; value: Verified } | { ok: false; result: DecryptResult }

function dsCodeOf(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'dsCode' in e && typeof e.dsCode === 'string') return e.dsCode
  return undefined
}

/** A DS or transport failure: the message is retried later, never given a failure code. */
function isTransient(e: unknown): boolean {
  return dsCodeOf(e) !== undefined || (e instanceof CryptoError && e.code === 'Transport')
}

export const createMessageService: CreateMessageService = (ctx, identity, groups) => {
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

  async function buffer(groupIdB64: string, m: EncryptedMessage): Promise<void> {
    await ctx.store.transaction(['buffered'], async (tx) => {
      const row = await tx.get('buffered', groupIdB64)
      const messages = (row?.messages ?? []).filter((x) => x.id !== m.id)
      messages.push(m)
      await tx.put('buffered', groupIdB64, { messages })
    })
  }

  /** §12.8.5 steps 1 to 8. */
  async function verify(m: EncryptedMessage): Promise<Step> {
    const fail = (reason: DecryptFailure): Step => ({ ok: false, result: { status: 'failed', messageId: m.id, reason } })

    // Step 1: the header against the row.
    let bytes: Uint8Array
    let header: EnvelopeHeader
    try {
      bytes = fromB64url(m.envelope)
      header = envelope.decodeHeader(bytes).header
    } catch {
      return fail('malformed')
    }
    const groupIdB64 = toB64url(header.groupId)
    if (header.channelId !== m.channelId) return fail('wrong_channel')
    if (groupIdB64 !== m.groupId || header.epoch !== m.epoch) return fail('wrong_group')
    if (toB64url(header.clientMsgId) !== m.clientMsgId) return fail('replay')
    if (header.senderDeviceId !== m.senderDevice) return fail('device_mismatch')

    // Step 2: the epoch secret.
    const epochSecret = await groups.epochSecret(header.groupId, header.epoch)
    if (epochSecret === null) {
      const current = await groups.currentEpoch(header.groupId)
      if (current !== null && header.epoch > current) {
        await buffer(groupIdB64, m)
        return { ok: false, result: { status: 'pending', messageId: m.id, reason: 'epoch_ahead' } }
      }
      const reason = current === null && !(await isKnownGroup(groupIdB64)) ? 'group_unknown' : 'no_history_key'
      return { ok: false, result: { status: 'pending', messageId: m.id, reason } }
    }

    // Steps 3 to 7. Step 4 runs in the callback, after the decrypt. The lookup finds the device
    // under any known user, so a foreign device gives device_mismatch or edit_not_author.
    const opened = await envelope.open(bytes, epochSecret, async (h, kind) => {
      const cert = await identity.deviceOwnerCertificate(h.senderDeviceId, m.authorId)
      if (cert === null) return { failure: 'invalid_chain' }
      if (cert.deviceId !== h.senderDeviceId) return { failure: 'invalid_chain' }
      if (cert.userId !== m.authorId) return { failure: kind === 'message' ? 'device_mismatch' : 'edit_not_author' }
      // A revoked device: no envelope of an epoch at or after the Remove that this client processed.
      // Older epochs stay valid (the residual risk of §12.8.5 step 4).
      const removedAt = await groups.removedAt(h.groupId, h.senderDeviceId)
      if (removedAt !== null && h.epoch >= removedAt && (await identity.chainContextFor(cert.userId, false)).revokedDeviceIds.has(h.senderDeviceId)) return { failure: 'invalid_chain' }
      return { signatureKey: cert.mlsSignatureKey }
    })
    if ('failure' in opened) {
      if (opened.failure === 'aead') await groups.reportAeadFailure(header.groupId, header.epoch, header.senderDeviceId)
      return fail(opened.failure)
    }

    // Step 8: pointer upload ids and blob sizes against the row, in order.
    const ids = uploadIdsOf(opened.content.attachments)
    if (ids.length !== m.attachments.length) return fail('attachments_mismatch')
    for (let i = 0; i < ids.length; i++) {
      const row = m.attachments[i]!
      if (ids[i]!.id !== row.id || ids[i]!.blobSize !== row.size) return fail('attachments_mismatch')
    }

    return { ok: true, value: { opened, header } }
  }

  async function decryptOne(m: EncryptedMessage): Promise<DecryptResult> {
    const step = await verify(m)
    if (!step.ok) return step.result
    const { opened, header } = step.value

    // Step 9: membership at that epoch, as this client observed it.
    const leaf = await groups.leafAt(header.groupId, header.senderDeviceId, header.epoch)
    const membershipVerified = leaf !== null && leaf === header.senderLeaf

    // Step 10: dedupe and rollback, keyed by (channel_id, client_msg_id).
    const key = seenKey(header.channelId, m.clientMsgId)
    const sentAtMs = opened.content.sentAtMs
    const seen = await ctx.store.transaction(['seen'], async (tx): Promise<DecryptFailure | null> => {
      const row = await tx.get('seen', key)
      if (row !== undefined) {
        if (row.messageId !== m.id) return 'replay'
        if (sentAtMs < row.sentAtMs) return 'stale_edit'
        if (sentAtMs === row.sentAtMs) return null
      }
      await tx.put('seen', key, { messageId: m.id, sentAtMs })
      return null
    })
    if (seen !== null) return { status: 'failed', messageId: m.id, reason: seen }

    // Step 11: KT gossip. A bad tree head raises ktAlert in IdentityService; the message stays valid.
    if (opened.ktTreeHead !== null) {
      try {
        await identity.observeTreeHead(opened.ktTreeHead, m.authorId)
      } catch (e) {
        ctx.emit('error', { code: 'Malformed', message: `KT gossip: ${e instanceof Error ? e.message : String(e)}` })
      }
    }

    return {
      status: 'ok',
      messageId: m.id,
      clientMsgId: m.clientMsgId,
      kind: opened.kind,
      editOf: opened.editOf === null ? null : toB64url(opened.editOf),
      content: opened.content,
      sender: {
        userId: m.authorId,
        deviceId: header.senderDeviceId,
        leafIndex: header.senderLeaf,
        trust: await identity.trustOf(m.authorId),
        membershipVerified,
      },
    }
  }

  async function encryptBlob(file: Blob): Promise<{ key: Uint8Array; blob: Blob; sha256: Uint8Array }> {
    const key = attachments.generateKey()
    const { blob, sha256 } = await attachments.encrypt(file, key)
    return { key, blob, sha256 }
  }

  return {
    async encryptMessage(input) {
      let clientMsgId: Uint8Array
      if (input.kind === 'message') {
        if (input.editOf !== null) throw new CryptoError('Malformed', 'kind message has no editOf')
        clientMsgId = ctx.random(CLIENT_MSG_ID_LENGTH)
        if (clientMsgId.length !== CLIENT_MSG_ID_LENGTH) throw new CryptoError('Malformed', 'random source returned a wrong length')
      } else {
        if (input.editOf === null) throw new CryptoError('Malformed', 'kind edit needs editOf')
        clientMsgId = bytesFromB64(input.editOf, CLIENT_MSG_ID_LENGTH, 'editOf')
      }

      // An edit must carry a sent_at_ms above every version that this client accepted (step 10).
      let sentAtMs = ctx.now()
      if (input.kind === 'edit') {
        const prev = await ctx.store.get('seen', seenKey(input.channelId, toB64url(clientMsgId)))
        if (prev !== undefined && sentAtMs <= prev.sentAtMs) sentAtMs = prev.sentAtMs + 1
      }
      const content: MessageContent = { ...input.content, sentAtMs }
      const editOf = input.kind === 'edit' ? clientMsgId : null

      const state = await groups.sendState(input.channelId)
      const self = identity.self()
      const ktTreeHead = await identity.treeHeadForGossip(toB64url(state.groupId))

      const contentBytes = encodeContent({ kind: input.kind, editOf, content, ktTreeHead })
      const limit = await envelopeLimit()
      const size = envelopeLength(contentBytes.length)
      if (size > limit) throw new CryptoError('TooLarge', `envelope of ${size} bytes exceeds ${limit}`)

      const sealed = await envelope.seal({
        header: {
          groupId: state.groupId,
          channelId: input.channelId,
          epoch: state.epoch,
          senderLeaf: state.ownLeaf,
          senderDeviceId: self.deviceId,
          clientMsgId,
        },
        kind: input.kind,
        editOf,
        content,
        epochSecret: state.epochSecret,
        signatureKey: self.mlsSignatureKey.privateKey,
        ktTreeHead,
      })
      return { envelope: toB64url(sealed), clientMsgId: toB64url(clientMsgId), groupId: toB64url(state.groupId), epoch: state.epoch }
    },

    async decryptMessages(messages) {
      const out: DecryptResult[] = []
      let transient: { first: CryptoErrorShape; count: number } | null = null
      for (const m of messages) {
        try {
          out.push(await decryptOne(m))
        } catch (e) {
          // One failed DS call marks only its own message. 'pending' and not 'failed': the UI
          // decrypts it again later (a transient error is never a verdict on the message).
          if (!isTransient(e)) throw e
          out.push({ status: 'pending', messageId: m.id, reason: 'transport' })
          transient ??= { first: { code: 'Transport', message: e instanceof Error ? e.message : String(e), dsCode: dsCodeOf(e) }, count: 0 }
          transient.count++
        }
      }
      if (transient !== null) {
        const { first, count } = transient
        ctx.emit('error', { ...first, message: `decryptMessages: ${count} of ${messages.length} messages pending after a DS error: ${first.message}` })
      }
      return out
    },

    async buildReport(message) {
      const step = await verify(message)
      if (!step.ok) {
        const r = step.result
        const why = r.status === 'ok' ? 'ok' : r.reason
        throw new CryptoError('Malformed', `cannot build a report: ${why}`)
      }
      return { content: toB64url(step.value.opened.contentBytes), frankingKey: toB64url(step.value.opened.frankingKey) }
    },

    async encryptAttachment(input) {
      const file = await encryptBlob(input.file)
      const thumb = input.thumbnail === null ? null : { ...(await encryptBlob(input.thumbnail.blob)), meta: input.thumbnail }
      const thumbnail: Omit<ThumbnailPointer, 'uploadId'> | null =
        thumb === null
          ? null
          : {
              key: toB64url(thumb.key),
              sha256: toB64url(thumb.sha256),
              size: thumb.meta.blob.size,
              blobSize: thumb.blob.size,
              mime: normalizeMime(thumb.meta.mime),
              width: thumb.meta.width,
              height: thumb.meta.height,
            }
      const draft = {
        key: toB64url(file.key),
        sha256: toB64url(file.sha256),
        size: input.file.size,
        blobSize: file.blob.size,
        mime: normalizeMime(input.mime),
        name: input.name,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs,
        blurhash: input.blurhash,
        thumbnail,
      }
      // Fail before upload when a field breaks a §12.8.1 limit (name, blurhash, dimensions).
      const probe: AttachmentPointer = {
        ...draft,
        uploadId: DRAFT_UPLOAD_ID,
        thumbnail: thumbnail === null ? null : { ...thumbnail, uploadId: DRAFT_UPLOAD_ID },
      }
      encodeContent({ kind: 'message', editOf: null, content: { text: '', mentions: [], attachments: [probe], replyTo: null, sentAtMs: 0 }, ktTreeHead: null })
      return { blob: file.blob, thumbnailBlob: thumb?.blob ?? null, draft }
    },

    async decryptAttachment(pointer, blob) {
      const key = bytesFromB64(pointer.key, null, 'key')
      const sha256 = bytesFromB64(pointer.sha256, null, 'sha256')
      return attachments.decrypt(blob, key, sha256, pointer.size, pointer.mime)
    },
  }
}
