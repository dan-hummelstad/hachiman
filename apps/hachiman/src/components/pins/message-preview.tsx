import { useMemo } from 'react'
import { FileText, Paperclip } from 'lucide-react'
import { decryptText } from '@/components/chat/decrypt-text'
import { formatFull, formatTime } from '@/components/chat/format'
import { messageSummary } from '@/components/chat/message-summary'
import { MessageTokens } from '@/components/chat/message-tokens'
import { UserAvatar } from '@/components/shell/user-avatar'
import { useMemberView } from '@/hooks/use-member'
import { tokenize } from '@/lib/mentions'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/messagesStore'

/**
 * One decrypted message in a list (pins N13, the inbox N8): avatar, author, time, three lines of
 * text and an action slot. A row that did not decrypt shows its placeholder, never the envelope.
 */
export function MessagePreview({
  message,
  context,
  actions,
  className
}: {
  message: ChatMessage
  /** A line above the author, e.g. the channel of an inbox mention. */
  context?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const { name, avatar, ink } = useMemberView(message.guildId, message.author.id, message.author)
  const unreadable = message.blocked ? 'Blocked message' : decryptText(message.decrypt)
  return (
    <div
      className={cn(
        'group/preview rounded-option hover:bg-surface-hover flex gap-3 px-2.5 py-2',
        className
      )}
    >
      <UserAvatar name={name} avatar={avatar} size={32} color={ink} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {context}
        <div className="flex items-baseline gap-2">
          <span
            className={cn('truncate text-[14px] font-bold', !ink && 'text-text-primary')}
            style={ink ? { color: ink } : undefined}
          >
            {name}
          </span>
          <time
            dateTime={message.createdAt}
            title={formatFull(message.createdAt)}
            className="text-text-tertiary shrink-0 text-[11.5px] font-medium"
          >
            {formatTime(message.createdAt)}
          </time>
        </div>
        {unreadable ? (
          <p className="text-text-tertiary text-[13.5px] leading-5 italic">{unreadable}</p>
        ) : (
          <PreviewText message={message} />
        )}
      </div>
      {actions && <div className="flex shrink-0 items-start gap-1">{actions}</div>}
    </div>
  )
}

function PreviewText({ message }: { message: ChatMessage }): React.JSX.Element {
  const { text, files, pageLink } = useMemo(() => messageSummary(message), [message])
  const tokens = useMemo(() => tokenize(text), [text])
  return (
    <>
      {text !== '' && (
        <p className="text-text-primary line-clamp-3 text-[13.5px] leading-5 break-words whitespace-pre-wrap">
          <MessageTokens tokens={tokens} guildId={message.guildId} />
        </p>
      )}
      {files !== null && (
        <p className="text-text-secondary inline-flex items-center gap-1 text-[12.5px] font-semibold">
          <Paperclip className="size-3.5" aria-hidden />
          {files}
        </p>
      )}
      {text === '' && files === null && pageLink && (
        <p className="text-text-secondary inline-flex items-center gap-1 text-[12.5px] font-semibold">
          <FileText className="size-3.5" aria-hidden />
          Page link
        </p>
      )}
    </>
  )
}
