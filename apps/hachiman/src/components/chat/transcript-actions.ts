import { messagesService } from '@/services/MessagesService'

/** Adds or takes back my reaction. A failed send already took the optimistic chip back. */
export function react(channelId: string, target: string, emoji: string, remove: boolean): void {
  void messagesService
    .react(channelId, target, emoji, remove)
    .catch((e: unknown) => console.warn('[chat] reaction failed', e))
}
