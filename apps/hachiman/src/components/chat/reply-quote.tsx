import { UserAvatar } from '@/components/shell/user-avatar'
import { useMemberView } from '@/hooks/use-member'
import { TOUCH_HIT_BAND } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { replyPreviewOf, useReplyTarget, type ChatMessage } from '@/stores/messagesStore'
import { highlightRow } from '@/lib/navigation'
import { quoteText } from './message-summary'

/**
 * The one-line quote above a reply (N11, B1): a link curve from the avatar column, the small
 * avatar and the name of the target's author, and one line of its text. A click
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
        compact ? 'pl-[calc(2.75rem+10ch+1.5rem)]' : 'mobile:pl-[42px] pl-[50px]'
      )}
    >
      {!compact && (
        // The link curve: from above the avatar's centre to the quote.
        <span
          aria-hidden
          className="border-line-strong pointer-events-none absolute top-[11px] left-[18px] h-[9px] w-[26px] mobile:left-[16px] mobile:w-[22px] rounded-tl-[6px] border-t-2 border-l-2"
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
  const { name, avatar } = useMemberView(guildId, target.author.id, target.author)
  return (
    <button
      type="button"
      onClick={() => highlightRow(target.id)}
      aria-label={`Replying to ${name}. Go to the message`}
      className={cn(
        'focus-visible:outline-line-focus group/quote flex min-w-0 cursor-pointer items-center gap-1.5 outline-none focus-visible:outline-2',
        TOUCH_HIT_BAND
      )}
    >
      <UserAvatar avatar={avatar} name={name} size={16} />
      <span className="text-text-secondary shrink-0 font-semibold">{name}</span>
      <span
        className={cn(
          'text-text-tertiary group-hover/quote:text-text-secondary min-w-0 truncate',
          encrypted && 'text-text-tertiary italic'
        )}
      >
        {encrypted ? 'Encrypted message' : quoteText(target)}
      </span>
    </button>
  )
}
