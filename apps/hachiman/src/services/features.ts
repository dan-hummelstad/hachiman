/**
 * The client features (unread, sounds, pins, events, blocks, tabs, ...) hook into the session here,
 * not into services/hachiman.ts. hachiman.ts calls the registry at READY, on each dispatch, on each
 * decrypted MESSAGE_CREATE, when the crypto Worker becomes ready, when the keys of a group arrive,
 * and at sign-out. A feature lists only the hooks it needs.
 */
import type { GatewayDispatch, Message } from '@hachiman/client'
import type { MessageContext } from '@/services/message-context'
import type { ChatMessage } from '@/stores/messagesStore'

export interface ClientFeature {
  /** For logs. */
  name: string
  /** READY of a new gateway session, after the stores have the new cache. */
  onReady?(): void
  /** Every gateway dispatch, after the cache applied it. */
  onDispatch?(e: GatewayDispatch): void
  /**
   * MESSAGE_CREATE after the decrypt. `row` is the stored row, undefined when the message is no row
   * (a reaction) or the session ended meanwhile.
   */
  onMessage?(m: Message, row: ChatMessage | undefined, ctx: MessageContext): void
  /** The crypto Worker became ready. */
  onCryptoReady?(): void
  /** The keys of `groupId` arrived (epochKeysAvailable). */
  onGroupKeys?(groupId: string): void
  /** Sign-out. */
  reset?(): void
}

/** Runs one hook on every feature. A throwing feature does not stop the others. */
function each(run: (f: ClientFeature) => void): void {
  for (const f of registered) {
    try {
      run(f)
    } catch (e) {
      console.error(`[features] ${f.name} failed`, e)
    }
  }
}

const registered: ClientFeature[] = []

export const features = {
  /** Adds features, once each, in the order their hooks run. */
  register(...list: ClientFeature[]): void {
    for (const f of list) if (!registered.includes(f)) registered.push(f)
  },
  ready: (): void => each((f) => f.onReady?.()),
  dispatch: (e: GatewayDispatch): void => each((f) => f.onDispatch?.(e)),
  message: (m: Message, row: ChatMessage | undefined, ctx: MessageContext): void =>
    each((f) => f.onMessage?.(m, row, ctx)),
  cryptoReady: (): void => each((f) => f.onCryptoReady?.()),
  groupKeys: (groupId: string): void => each((f) => f.onGroupKeys?.(groupId)),
  reset: (): void => each((f) => f.reset?.())
}
