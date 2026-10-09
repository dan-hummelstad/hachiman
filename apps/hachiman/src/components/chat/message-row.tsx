import { memo, useMemo, useState } from 'react'
import { CircleAlert, EyeOff, RotateCw } from 'lucide-react'
import type { DecryptFailure } from '@hachiman/crypto'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { useAction } from '@/hooks/use-action'
import { useMemberView } from '@/hooks/use-member'
import { pageLinksOf, stripPageLinks } from '@/lib/page-link-text'
import { cn } from '@/lib/utils'
import { messagesService } from '@/services/MessagesService'
import type { ChatMessage } from '@/stores/messagesStore'
import type { MessageDisplay } from '@/stores/prefsStore'
import { useComposerStore } from '@/stores/composerStore'
import { openDialog } from '@/stores/dialogStore'
import { useIsBlocked, useUserStore } from '@/stores/userStore'
import { MessageAttachments } from './attachments/message-attachments'
import { messageMentionsMe, tokenize, type Token } from '@/lib/mentions'
import { decryptText } from './decrypt-text'
import { formatFull, formatTime } from './format'
import { useMessageMoreItems } from './message-more-items'
import { MessageToolbar } from './message-toolbar'
import { MessageTokens } from './message-tokens'
import { PageLinkCard } from './page-cards'
import { ReactionChips } from './reactions'
import { ReplyQuote } from './reply-quote'
import { react } from './transcript-actions'
import { type RowPolicy } from './row-policy'
import { submitOnEnter } from './submit-on-enter'

export interface TranscriptRowProps {
  message: ChatMessage
  groupStart: boolean
  display: MessageDisplay
  guildId: string | null
  /** The same object for every row of the channel. */
  policy: RowPolicy
  editing: boolean
  /** Called with this message's id to start editing, null to stop. */
  onEditingChange: (messageId: string | null) => void
}

/** One row of the transcript: a blocked author's row stays collapsed until the user shows it (N23). */
export const TranscriptRow = memo(function TranscriptRow(
  props: TranscriptRowProps
): React.JSX.Element {
  const [shown, setShown] = useState(false)
  const blocked = useIsBlocked(props.message.author.id)
  if (blocked && !shown) return <BlockedRow message={props.message} onShow={() => setShown(true)} />
  return <MessageRow {...props} />
})

/**
 * A message of a blocked user (N23): one collapsed line. The row still decrypted (MLS needs it);
 * "Show" renders it in full.
 */
function BlockedRow({
  message,
  onShow
}: {
  message: ChatMessage
  onShow: () => void
}): React.JSX.Element {
  return (
    <div
      className="text-text-tertiary mx-2 flex items-center gap-2 px-2.5 py-1 text-[13px] leading-5"
      data-message-id={message.id}
    >
      <EyeOff className="size-3.5 shrink-0" aria-hidden />
      <span>Blocked message</span>
      <span aria-hidden>·</span>
      <LinkButton onClick={onShow}>Show</LinkButton>
    </div>
  )
}

function MessageRow(props: TranscriptRowProps): React.JSX.Element {
  const { message, display, guildId, editing, policy } = props
  const { name, avatar, ink } = useMemberView(guildId, message.author.id, message.author)
  const me = useUserStore((s) => s.me)
  const text = useMemo(() => stripPageLinks(message.content), [message.content])
  const pageIds = useMemo(() => pageLinksOf(message.content), [message.content])
  const tokens = useMemo(() => tokenize(text), [text])
  const mentioned = !!me && message.author.id !== me.id && messageMentionsMe(message, me)
  const readable = message.decrypt.status === 'ok'
  const settled = !message.pending && !message.failed
  // A reply always shows its author: the quote sits above the name.
  const groupStart = props.groupStart || message.replyTo !== null
  const target = message.clientMsgId
  const mine = !!me && message.author.id === me.id
  const canAnswer = policy.canSend && settled && target !== ''
  const more = useMessageMoreItems(message, policy)

  const toolbar = settled && !editing && (
    <MessageToolbar
      className="absolute -top-5 right-4 z-10"
      guildId={guildId}
      onReact={
        canAnswer && readable
          ? (emoji) => react(message.channelId, target, emoji, false)
          : undefined
      }
      onReply={
        canAnswer
          ? () => useComposerStore.getState().setReplyTarget(message.channelId, target)
          : undefined
      }
      copyText={readable ? message.content : undefined}
      onEdit={mine && readable ? () => props.onEditingChange(message.id) : undefined}
      onDelete={
        mine || policy.canManage
          ? () =>
              void messagesService
                .delete(message.channelId, message.id)
                .catch((e) => console.error('[chat] delete failed', e))
          : undefined
      }
      more={more}
    />
  )

  const body = (
    <>
      {editing ? (
        <EditBox message={message} onDone={() => props.onEditingChange(null)} />
      ) : (
        <MessageBody message={message} text={text} tokens={tokens} authorName={name} />
      )}
      {readable && message.attachments.length > 0 && (
        <MessageAttachments attachments={message.attachments} />
      )}
      {readable && pageIds.length > 0 && (
        <div className="flex flex-col items-start gap-1 py-1">
          {pageIds.map((id) => (
            <PageLinkCard key={id} pageId={id} guildId={guildId} />
          ))}
        </div>
      )}
      {readable && target !== '' && <ReactionChips channelId={message.channelId} target={target} />}
    </>
  )

  const quote = message.replyTo !== null && (
    <ReplyQuote
      channelId={message.channelId}
      replyTo={message.replyTo}
      guildId={guildId}
      compact={display === 'compact'}
    />
  )

  const profile = (trigger: React.ReactElement): React.JSX.Element => (
    <UserProfilePopover
      userId={message.author.id}
      guildId={guildId}
      user={message.author}
      side="right"
    >
      {trigger}
    </UserProfilePopover>
  )

  const author = profile(
    <button
      type="button"
      className={cn(
        'inline-block max-w-full cursor-pointer truncate align-top font-bold hover:underline',
        'focus-visible:outline-line-focus outline-none focus-visible:outline-2',
        !ink && 'text-text-primary'
      )}
      style={ink ? { color: ink } : undefined}
    >
      {name}
    </button>
  )

  // A rounded hover block inside the transcript gutter (Arc: rounded is interaction).
  const rowClass = cn(
    'group/row rounded-control relative mx-2 px-2.5',
    !editing && 'hover:bg-surface-hover',
    editing && 'bg-surface-hover',
    mentioned &&
      'bg-feature-event/10 hover:bg-feature-event/15 rounded-l-none shadow-[inset_3px_0_0_var(--feature-event)]',
    message.pending && !message.failed && 'opacity-50'
  )

  if (display === 'compact') {
    return (
      <div className={cn(rowClass, 'py-[3px]')} data-message-id={message.id}>
        {quote}
        <div className="text-body flex gap-3">
          <Timestamp iso={message.createdAt} className="w-11 shrink-0 leading-[22px]" />
          <span className="w-[10ch] shrink-0 truncate text-right leading-[22px]">{author}</span>
          <div className="max-w-[90ch] min-w-0 flex-1">{body}</div>
        </div>
        {toolbar}
      </div>
    )
  }

  return (
    <div
      className={cn(rowClass, 'py-0.5', groupStart && 'mt-2 pt-1.5')}
      data-message-id={message.id}
    >
      {quote}
      <div className="flex gap-3.5">
        <div className="flex w-10 shrink-0 justify-center">
          {groupStart ? (
            profile(
              // The name is the keyboard path to the same card; keep the avatar out of the tab order.
              <button
                type="button"
                tabIndex={-1}
                aria-label={name}
                className="mt-0.5 h-fit cursor-pointer rounded-full"
              >
                <UserAvatar avatar={avatar} name={name} color={ink} size={40} />
              </button>
            )
          ) : (
            <Timestamp
              iso={message.createdAt}
              className="text-[11px] leading-[22px] opacity-0 group-hover/row:opacity-100"
            />
          )}
        </div>
        <div className="max-w-[90ch] min-w-0 flex-1">
          {groupStart && (
            <div className="flex items-baseline gap-2 text-[15px] leading-[22px]">
              {author}
              <Timestamp iso={message.createdAt} />
            </div>
          )}
          {body}
        </div>
      </div>
      {toolbar}
    </div>
  )
}

/** `10:42` with the full date on hover. Default size `text-xs`; pass classes to adjust. */
function Timestamp({ iso, className }: { iso: string; className?: string }): React.JSX.Element {
  return (
    <time
      dateTime={iso}
      title={formatFull(iso)}
      className={cn('text-text-tertiary text-meta tabular-nums', className)}
    >
      {formatTime(iso)}
    </time>
  )
}

/** Results that say the sender's identity did not check out: verifying the sender is the next step. */
const IDENTITY_FAILURES: ReadonlySet<DecryptFailure> = new Set([
  'invalid_chain',
  'device_mismatch',
  'edit_not_author',
  'bad_signature'
])

function MessageBody({
  message,
  text,
  tokens,
  authorName
}: {
  message: ChatMessage
  /** The text without its page links (they show as cards). */
  text: string
  tokens: Token[]
  authorName: string
}): React.JSX.Element {
  const unreadable = decryptText(message.decrypt)
  if (unreadable) {
    if (message.decrypt.status === 'pending')
      return <p className="text-text-tertiary text-[13.5px] leading-[22px] italic">{unreadable}</p>
    return (
      <div
        role="note"
        className="border-feature-danger/40 bg-feature-danger/10 text-feature-danger-text my-0.5 inline-flex max-w-full items-center gap-2 border px-2.5 py-1.5 text-[13.5px] leading-5 font-semibold"
      >
        <CircleAlert className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0">{unreadable}</span>
        {message.decrypt.status === 'failed' && IDENTITY_FAILURES.has(message.decrypt.reason) && (
          <Button
            variant="danger"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => openDialog({ kind: 'verification', userId: message.author.id })}
          >
            Verify {authorName}
          </Button>
        )}
      </div>
    )
  }
  // An attachment-only message has no text line, unless "(edited)" needs one.
  const showText = text !== '' || message.editedAt !== null
  return (
    <>
      {showText && (
        <p
          className={cn(
            'text-body break-words whitespace-pre-wrap',
            message.failed ? 'text-feature-danger-text' : 'text-text-primary'
          )}
        >
          <MessageTokens tokens={tokens} guildId={message.guildId} />
          {message.editedAt && (
            <span className="text-text-tertiary ml-1.5 text-[11px] select-none">(edited)</span>
          )}
        </p>
      )}
      {message.failed && (
        <div className="flex flex-wrap items-center gap-2 py-1 text-[13px] leading-5 font-semibold">
          <span className="text-feature-danger-text inline-flex items-center gap-1.5">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            {message.sendError ?? 'Not sent.'}
          </span>
          <Button
            variant="danger"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void messagesService.retry(message)}
          >
            <RotateCw className="size-3.5" aria-hidden />
            Retry
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="text-text-secondary h-6 px-2 text-xs"
            onClick={() => messagesService.discard(message)}
          >
            Delete
          </Button>
        </div>
      )}
    </>
  )
}

function LinkButton(props: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="text-text-primary focus-visible:outline-line-focus font-semibold underline-offset-2 outline-none hover:underline focus-visible:outline-2"
    >
      {props.children}
    </button>
  )
}

function EditBox({
  message,
  onDone
}: {
  message: ChatMessage
  onDone: () => void
}): React.JSX.Element {
  const [text, setText] = useState(message.content)
  const { run, busy, error } = useAction()
  const save = async (): Promise<void> => {
    const empty = !text.trim() && message.attachments.length === 0
    if (empty || text === message.content) return onDone()
    const edited = await run('save the edit', () =>
      messagesService.edit(message.channelId, message.id, text)
    )
    if (edited.ok) onDone()
  }
  return (
    <div className="py-1">
      <textarea
        autoFocus
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(text.length, text.length)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          } else submitOnEnter(e, () => void save())
        }}
        className="rounded-option bg-surface-raised border-line-hairline focus-visible:border-accent-primary text-body field-sizing-content block max-h-[198px] min-h-[38px] w-full resize-none border px-3 py-2 outline-none"
      />
      <p className="text-text-tertiary pt-1 text-xs">
        Enter to <LinkButton onClick={() => void save()}>save</LinkButton>, Esc to{' '}
        <LinkButton onClick={onDone}>cancel</LinkButton>
      </p>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
