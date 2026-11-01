import type { BotMessage } from './runtime'

/** Decrypted messages kept per channel, for edits, replies and reactions. */
const KEEP_PER_CHANNEL = 500

/** Per channel: message id → message, and client_msg_id → message id, newest last. */
export class History {
  private byChannel = new Map<string, Map<string, BotMessage>>()
  private byClientId = new Map<string, string>()

  put(m: BotMessage): void {
    let ch = this.byChannel.get(m.channelId)
    if (!ch) this.byChannel.set(m.channelId, (ch = new Map()))
    ch.delete(m.id)
    ch.set(m.id, m)
    this.byClientId.set(`${m.channelId}:${m.clientMsgId}`, m.id)
    if (ch.size > KEEP_PER_CHANNEL) {
      const [oldest] = ch.values()
      if (oldest) {
        ch.delete(oldest.id)
        this.byClientId.delete(`${oldest.channelId}:${oldest.clientMsgId}`)
      }
    }
  }
  get(channelId: string, id: string): BotMessage | undefined {
    return this.byChannel.get(channelId)?.get(id)
  }
  idOf(channelId: string, clientMsgId: string): string | null {
    return this.byClientId.get(`${channelId}:${clientMsgId}`) ?? null
  }
  drop(channelId: string, id: string): void {
    const m = this.byChannel.get(channelId)?.get(id)
    if (!m) return
    this.byChannel.get(channelId)?.delete(id)
    this.byClientId.delete(`${channelId}:${m.clientMsgId}`)
  }
}
