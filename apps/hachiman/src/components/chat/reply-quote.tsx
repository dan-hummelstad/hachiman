import { UserAvatar } from '@/components/shell/user-avatar'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { replyPreviewOf, useReplyTarget, type ChatMessage } from '@/stores/messagesStore'
import { quoteText, scrollToMessage } from './transcript-actions'

/**
 * The one-line quote above a reply (N11, B1): a link curve from the avatar column, the small
 * avatar and the name of the target's author in their colour, and one line of its text. A click
 * scrolls to the target. "Encrypted message" when it did not decrypt, "Original message not
 * loaded" when it is not in the store.
 */
export function ReplyQuote({
  channelId,
  replyTo,
  guildId,
  compact
}: {
  channelId: string
  replyTo: string
  guildId: string | null
  compact: boolean
}): React.JSX.Element {
  const target = useReplyTarget(channelId, replyTo)
  const preview = replyPreviewOf(target ? [target] : undefined, replyTo)
  return (
    <div
      className={cn(
        'relative flex h-[22px] min-w-0 items-center text-[13px] leading-[18px]',
        compact ? 'pl-[calc(2.75rem+14ch+1.5rem)]' : 'pl-[54px]'
      )}
    >
      {!compact && (
        // The link curve: from above the avatar's centre to the quote.
        <span
          aria-hidden
          className="border-line-strong pointer-events-none absolute top-[11px] left-[20px] h-[9px] w-[28px] rounded-tl-[6px] border-t-2 border-l-2"
        />
      )}
      {preview.status === 'missing' ? (
        <span className="text-text-tertiary truncate italic">Original message not loaded</span>
      ) : (
        <QuoteLine
          target={preview.message}
          guildId={guildId}
          encrypted={preview.status === 'encrypted'}
        />
      )}
    </div>
  )
}

function QuoteLine({
  target,
  guildId,
  encrypted
}: {
  target: ChatMessage
  guildId: string | null
  encrypted: boolean
}): React.JSX.Element {
  const { name, avatar, ink } = useMemberView(guildId, target.author.id, target.author)
  return (
    <button
      type="button"
      onClick={() => scrollToMessage(target.id)}
      aria-label={`Replying to ${name}. Go to the message`}
      className="focus-visible:outline-line-focus group/quote flex min-w-0 cursor-pointer items-center gap-1.5 outline-none focus-visible:outline-2"
    >
      <UserAvatar avatar={avatar} name={name} color={ink} size={16} />
      <span
        className={cn('shrink-0 font-semibold', !ink && 'text-text-primary')}
        style={ink ? { color: ink } : undefined}
      >
        {name}
      </span>
      <span
        className={cn(
          'text-text-secondary group-hover/quote:text-text-primary min-w-0 truncate',
          encrypted && 'text-text-tertiary italic'
        )}
      >
        {encrypted ? 'Encrypted message' : quoteText(target)}
      </span>
    </button>
  )
}
