import type { Channel } from '@hachiman/client'
import type { ChannelChatState } from '@/components/chat/chat-body'
import { Composer } from '@/components/chat/composer'
import { TypingLine } from '@/components/chat/typing-line'
import { VoiceBar } from '@/components/mobile/voice-bar'

/**
 * Focuses the composer field of the open chat. Call it synchronously in a tap handler (Reply,
 * "Paste a link"): WKWebView raises the keyboard only for a focus inside a user gesture
 * (docs/ios-mobile-ui-spec.md §2.8).
 */
// eslint-disable-next-line react-refresh/only-export-components -- A3 and J1 call it from a tap.
export function focusComposer(): void {
  document.querySelector<HTMLTextAreaElement>('[data-slot=chat-footer] textarea')?.focus()
}

/**
 * The foot of the chat card on the mobile layout (M1): the typing line (22), the voice bar while
 * in a call, the composer, then the home-indicator inset on the content colour. With the keyboard
 * open the inset and the voice bar go, so the composer sits on the keyboard. `blocked` replaces
 * the typing line and the composer (a 1:1 DM with someone I blocked, N23).
 */
export function MobileChatFooter({
  channel,
  chat,
  blocked
}: {
  channel: Channel
  chat: ChannelChatState
  blocked: React.ReactNode
}): React.JSX.Element {
  return (
    <footer
      data-slot="chat-footer"
      className="flex shrink-0 flex-col pb-(--safe-bottom) in-data-[keyboard=open]:pb-0"
    >
      {!blocked && <TypingLine channel={channel} className="h-[22px] pr-4 pl-5 leading-[22px]" />}
      {/* A DM call shows its stage above this chat: the bar would repeat it. */}
      <VoiceBar stageChannelId={channel.id} />
      <div className="px-3 pt-2 pb-2">
        {blocked ?? (
          <>
            {chat.refusedPeer && (
              <p role="status" className="text-text-tertiary px-1 pb-1.5 text-[13px]">
                You can&apos;t message {chat.refusedPeer.username}.
              </p>
            )}
            <Composer {...chat.composer} />
          </>
        )}
      </div>
    </footer>
  )
}
