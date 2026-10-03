/**
 * Message franking reports (docs/gateway-protocol.md §12.16, Phase 4).
 *
 * The reporter reveals the decrypted EnvelopeContent and the franking key.
 * Takusen recomputes the HMAC and compares it with the stored franking tag in
 * constant time (`DsModule.verifyFrankingOpening`). A match proves that the
 * author's device sent this content in this channel. Takusen stores the
 * report with the revealed content either way.
 */
import { FRANKING_KEY_LENGTH, MAX_ENVELOPE_BYTES } from '@hachiman/crypto/constants'
import { z } from 'zod'

import type { MessageRow } from '@/db/schema'
import { b64 } from '@/lib/mls/bytes'
import type { DsModule } from '@/lib/mls/crypto'

export const reportSchema = z.object({
  messageId: z.string().uuid(),
  /** The encoded EnvelopeContent. It is never larger than an envelope. */
  content: b64(MAX_ENVELOPE_BYTES),
  frankingKey: b64(FRANKING_KEY_LENGTH),
  reason: z.string().trim().min(1).max(1000),
})
export type ReportBody = z.infer<typeof reportSchema>

export interface NewReport {
  messageId: string
  channelId: string
  reporterId: string
  reason: string
  content: Uint8Array
  frankingKey: Uint8Array
  verified: boolean
}

/** Checks the opening and builds the row. The route stores it. */
export function openReport(
  ds: Pick<DsModule, 'verifyFrankingOpening'>,
  message: Pick<MessageRow, 'id' | 'channelId' | 'clientMsgId' | 'frankingTag'>,
  reporterId: string,
  body: ReportBody,
): NewReport {
  const verified =
    body.frankingKey.length === FRANKING_KEY_LENGTH &&
    ds.verifyFrankingOpening({
      frankingTag: message.frankingTag,
      frankingKey: body.frankingKey,
      channelId: message.channelId,
      clientMsgId: message.clientMsgId,
      content: body.content,
    })
  return {
    messageId: message.id,
    channelId: message.channelId,
    reporterId,
    reason: body.reason,
    content: body.content,
    frankingKey: body.frankingKey,
    verified,
  }
}
