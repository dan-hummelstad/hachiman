import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

/** Composer state per channel that is not the draft text. Not persisted. */
interface ComposerState {
  /** channelId → the client_msg_id of the message that the next send answers (N11). */
  replyTargets: Map<string, string>
  setReplyTarget: (channelId: string, clientMsgId: string) => void
  clearReplyTarget: (channelId: string) => void
}

export const useComposerStore = create<ComposerState>()(
  devtools((set) => ({
    replyTargets: new Map(),
    setReplyTarget: (channelId, clientMsgId) =>
      set((s) => ({ replyTargets: new Map(s.replyTargets).set(channelId, clientMsgId) })),
    clearReplyTarget: (channelId) =>
      set((s) => {
        if (!s.replyTargets.has(channelId)) return {}
        const next = new Map(s.replyTargets)
        next.delete(channelId)
        return { replyTargets: next }
      })
  }))
)

/** The client_msg_id that the composer of `channelId` replies to, or null. */
export function useReplyTargetId(channelId: string): string | null {
  return useComposerStore((s) => s.replyTargets.get(channelId) ?? null)
}

export function resetComposerStore(): void {
  useComposerStore.setState({ replyTargets: new Map() })
}
