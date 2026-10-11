import { memo, useCallback, useMemo, useState } from 'react'
import { CircleAlert, EyeOff, RotateCw } from 'lucide-react'
import type { DecryptFailure } from '@hachiman/crypto'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { useAction } from '@/hooks/use-action'
import { LONG_PRESS_TARGET, useLongPress, type LongPressHandlers } from '@/hooks/use-long-press'
import { useMemberView } from '@/hooks/use-member'
import { pageLinksOf, stripPageLinks } from '@/lib/page-link-text'
import { cn } from '@/lib/utils'
import { messagesService } from '@/services/MessagesService'
import type { ChatMessage } from '@/stores/messagesStore'
import type { MessageDisplay } from '@/stores/prefsStore'
import { openDialog } from '@/stores/dialogStore'
import { useIsBlocked, useUserStore } from '@/stores/userStore'
import { MessageAttachments } from './attachments/message-attachments'
import { messageMentionsMe, tokenize, type Token } from '@/lib/mentions'
import { decryptText } from './decrypt-text'
import { formatFull, formatTime } from './format'
import { useMessageActions } from './message-actions'
import { MessageToolbar } from './message-toolbar'
import { MessageTokens } from './message-tokens'
import { PageLinkCard } from './page-cards'
import { ReactionChips } from './reactions'
import { ReplyQuote } from './reply-quote'
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
  /**
   * The mobile layout: opens the action sheet of the message (spec A3), from a long press on the
   * row or its sr-only "Message actions" button. The row then has no hover toolbar. Undefined on
   * the desktop layout.
   */
  onActions?: (messageId: string, row: HTMLElement) => void
}

/** A hold that starts on these does not open the action sheet: they keep their own touch. */
const HOLD_IGNORE = 'a[href], audio, video, [data-hold-ignore]'

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
  const { message, display, guildId, editing, policy, onEditingChange, onActions } = props
  const mobile = onActions !== undefined
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
  const startEdit = useCallback(() => onEditingChange(message.id), [onEditingChange, message.id])
  const actions = useMessageActions(message, policy, startEdit)
  const sheet = mobile && !editing && actions.length > 0
  const openActions = (row: HTMLElement): void => onActions?.(message.id, row)
  // The handlers sit on the row, so the press target is the row.
  const hold = useLongPress((at) => openActions(at.target), { enabled: sheet })

  // The toolbar shows on hover and on focus-within, so on touch a tap would show it: mobile rows
  // have the long press and the sr-only button instead.
  const toolbar = !mobile && settled && !editing && (
    <MessageToolbar className="absolute -top-5 right-4 z-10" guildId={guildId} actions={actions} />
  )
  const touch = sheet ? holdHandlers(hold, openActions) : undefined
  const actionsButton = sheet && (
    <button
      type="button"
      data-slot="message-actions-button"
      // Hidden until a keyboard reaches it (an iPad keyboard, a narrow browser window).
      className="focus-visible:rounded-control focus-visible:bg-surface-raised focus-visible:outline-line-focus sr-only z-10 focus-visible:not-sr-only focus-visible:absolute focus-visible:top-1 focus-visible:right-2 focus-visible:px-2.5 focus-visible:py-1.5 focus-visible:text-xs focus-visible:font-bold focus-visible:outline-2"
      aria-label={`Actions for ${name}'s message, ${formatTime(message.createdAt)}`}
      onClick={(e) => {
        const row = e.currentTarget.parentElement
        if (row) openActions(row)
      }}
    >
      Message actions
    </button>
  )

  const body = (
    <>
      {editing ? (
        <EditBox message={message} onDone={() => onEditingChange(null)} />
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
      {readable && target !== '' && (
        <div data-hold-ignore className="contents">
          <ReactionChips channelId={message.channelId} target={target} />
        </div>
      )}
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
    message.pending && !message.failed && 'opacity-50',
    // The touch row (M1, M5): a 9 px block in the 4 px gutter; a mention bar inset in it. No
    // text selection under a hold, except in the edit field (WebKit carries it into the field).
    mobile && cn(!editing && LONG_PRESS_TARGET, 'mx-1 rounded-[9px] px-3'),
    mobile &&
      mentioned &&
      "shadow-none before:bg-feature-event before:absolute before:inset-y-1.5 before:left-1 before:w-[3px] before:rounded-[2px] before:content-['']"
  )

  if (display === 'compact') {
    return (
      <div className={cn(rowClass, 'py-[3px]')} data-message-id={message.id} {...touch}>
        {quote}
        <div className="text-body flex gap-3">
          <Timestamp iso={message.createdAt} className="w-11 shrink-0 leading-[22px]" />
          <span className="w-[10ch] shrink-0 truncate text-right leading-[22px]">{author}</span>
          <div className="max-w-[90ch] min-w-0 flex-1">{body}</div>
        </div>
        {toolbar}
        {actionsButton}
      </div>
    )
  }

  return (
    <div
      className={cn(
        rowClass,
        mobile ? (groupStart ? 'py-2' : 'pt-0 pb-2') : cn('py-0.5', groupStart && 'mt-2 pt-1.5')
      )}
      data-message-id={message.id}
      {...touch}
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
      {actionsButton}
    </div>
  )
}

const ignored = (e: React.SyntheticEvent): boolean =>
  e.target instanceof Element && e.target.closest(HOLD_IGNORE) !== null

/**
 * The long-press handlers of a mobile row, except on a link, a media control or a
 * `[data-hold-ignore]` part (Retry and Delete of a failed send, the reaction chips). A right-click
 * opens the sheet too (a narrow window with a mouse), unless a hold already did.
 */
function holdHandlers(
  hold: LongPressHandlers,
  open: (row: HTMLElement) => void
): LongPressHandlers {
  return {
    ...hold,
    onPointerDown: (e) => {
      if (!ignored(e)) hold.onPointerDown(e)
    },
    onContextMenu: (e) => {
      hold.onContextMenu(e)
      if (e.defaultPrevented || ignored(e)) return
      e.preventDefault()
      open(e.currentTarget)
    }
  }
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
        <div
          data-hold-ignore
          className="mobile:gap-x-3 flex flex-wrap items-center gap-2 py-1 text-[13px] leading-5 font-semibold"
        >
          <span className="text-feature-danger-text inline-flex items-center gap-1.5">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            {message.sendError ?? 'Not sent.'}
          </span>
          <Button
            variant="danger"
            size="sm"
            className={cn('h-6 px-2 text-xs', FAILED_HIT)}
            onClick={() => void messagesService.retry(message)}
          >
            <RotateCw className="size-3.5" aria-hidden />
            Retry
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className={cn('text-text-secondary h-6 px-2 text-xs', FAILED_HIT)}
            onClick={() => messagesService.discard(message)}
          >
            Delete
          </Button>
        </div>
      )}
    </>
  )
}

/**
 * Retry and Delete of a failed send keep their 24 look; on the mobile layout each takes a 36 hit
 * height over its full width (spec §2.10). Delete drops the text for good, so a near miss on
 * Retry must not reach it: the row puts 12 between them.
 */
const FAILED_HIT =
  'mobile:relative mobile:after:absolute mobile:after:inset-x-0 mobile:after:top-1/2 mobile:after:h-9 mobile:after:-translate-y-1/2'

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
      <p className="text-text-tertiary mobile:hidden pt-1 text-xs">
        Enter to <LinkButton onClick={() => void save()}>save</LinkButton>, Esc to{' '}
        <LinkButton onClick={onDone}>cancel</LinkButton>
      </p>
      {/* Touch has no Enter and Esc keys to point at: Save and Cancel, Save last. */}
      <div className="mobile:flex hidden gap-2 pt-2">
        <Button variant="secondary" size="lg" className="flex-1" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button size="lg" className="flex-1" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
