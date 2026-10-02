import { memo, useMemo, useState } from 'react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { ErrorText } from '@/components/ui/field'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { useAction } from '@/hooks/use-action'
import { useMemberView } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { messagesService } from '@/services/MessagesService'
import type { ChatMessage } from '@/stores/messagesStore'
import type { MessageDisplay } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { MessageAttachments } from './attachments/message-attachments'
import { mentionsUser, tokenize, type MentionToken, type Token } from '@/lib/mentions'
import { formatFull, formatTime } from './format'
import { MessageToolbar } from './message-toolbar'
import { submitOnEnter } from './submit-on-enter'

export interface MessageRowProps {
  message: ChatMessage
  groupStart: boolean
  display: MessageDisplay
  guildId: string | null
  canEdit: boolean
  canDelete: boolean
  editing: boolean
  /** Called with this message's id to start editing, null to stop. */
  onEditingChange: (messageId: string | null) => void
}

export const MessageRow = memo(function MessageRow(props: MessageRowProps): React.JSX.Element {
  const { message, groupStart, display, guildId, editing } = props
  const { name, avatar, ink } = useMemberView(guildId, message.author.id, message.author)
  const me = useUserStore((s) => s.me)
  const tokens = useMemo(() => tokenize(message.content), [message.content])
  const mentioned = !!me && message.author.id !== me.id && tokens.some((t) => mentionsUser(t, me))
  const settled = !message.pending && !message.failed

  const toolbar = settled && !editing && (
    <MessageToolbar
      className="absolute -top-4 right-4 z-10"
      onCopy={() => void navigator.clipboard?.writeText(message.content).catch(() => {})}
      onEdit={props.canEdit ? () => props.onEditingChange(message.id) : undefined}
      onDelete={
        props.canDelete
          ? () =>
              void messagesService
                .delete(message.channelId, message.id)
                .catch((e) => console.error('[chat] delete failed', e))
          : undefined
      }
    />
  )

  const body = (
    <>
      {editing ? (
        <EditBox message={message} onDone={() => props.onEditingChange(null)} />
      ) : (
        <MessageBody message={message} tokens={tokens} />
      )}
      {message.attachments.length > 0 && <MessageAttachments attachments={message.attachments} />}
    </>
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
        'inline-block max-w-full cursor-pointer truncate align-top font-mono font-semibold hover:underline',
        'focus-visible:outline-ring focus-visible:outline-2',
        !ink && 'text-foreground'
      )}
      style={ink ? { color: ink } : undefined}
    >
      {name}
    </button>
  )

  const rowClass = cn(
    'group/row relative px-4',
    !editing && 'hover:bg-accent/70',
    editing && 'bg-accent/50',
    mentioned && 'bg-mention shadow-[inset_2px_0_0_var(--primary)] hover:bg-mention',
    message.pending && 'opacity-50'
  )

  if (display === 'compact') {
    return (
      <div className={cn(rowClass, 'flex gap-3 py-px')} data-message-id={message.id}>
        <Timestamp iso={message.createdAt} className="w-10 shrink-0 leading-[22px]" />
        <span className="w-[14ch] shrink-0 text-right text-[13.5px] leading-[22px]">{author}</span>
        <div className="max-w-[90ch] min-w-0 flex-1">{body}</div>
        {toolbar}
      </div>
    )
  }

  return (
    <div
      className={cn(rowClass, 'flex gap-3 py-px', groupStart && 'mt-3 pt-0.5')}
      data-message-id={message.id}
    >
      <div className="flex w-8 shrink-0 justify-center">
        {groupStart ? (
          profile(
            // The name is the keyboard path to the same card; keep the avatar out of the tab order.
            <button
              type="button"
              tabIndex={-1}
              aria-label={name}
              className="mt-0.5 h-fit cursor-pointer"
            >
              <UserAvatar avatar={avatar} name={name} color={ink} />
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
          <div className="flex items-baseline gap-2 text-[13.5px] leading-[22px]">
            {author}
            <Timestamp iso={message.createdAt} />
          </div>
        )}
        {body}
      </div>
      {toolbar}
    </div>
  )
})

/** `10:42` with the full date on hover. Default size `text-xs`; pass classes to adjust. */
function Timestamp({ iso, className }: { iso: string; className?: string }): React.JSX.Element {
  return (
    <time
      dateTime={iso}
      title={formatFull(iso)}
      className={cn('text-muted-foreground font-sans text-xs tabular-nums', className)}
    >
      {formatTime(iso)}
    </time>
  )
}

function MessageBody({
  message,
  tokens
}: {
  message: ChatMessage
  tokens: Token[]
}): React.JSX.Element {
  // An attachment-only message has no text line, unless "(edited)" needs one.
  const showText = message.content !== '' || message.editedAt !== null
  return (
    <>
      {showText && (
        <p
          className={cn(
            'font-mono text-[13.5px] leading-[22px] break-words whitespace-pre-wrap',
            message.failed ? 'text-destructive' : 'text-foreground'
          )}
        >
          {tokens.map((t, i) =>
            t.kind === 'text' ? (
              t.value
            ) : t.kind === 'link' ? (
              <a
                key={i}
                href={t.value}
                target="_blank"
                rel="noreferrer noopener"
                className="decoration-muted-foreground hover:decoration-foreground underline underline-offset-2"
              >
                {t.value}
              </a>
            ) : (
              <Mention key={i} token={t} guildId={message.guildId} />
            )
          )}
          {message.editedAt && (
            <span className="text-muted-foreground ml-1.5 font-sans text-[11px] select-none">
              (edited)
            </span>
          )}
        </p>
      )}
      {message.failed && (
        <div className="text-muted-foreground flex items-center gap-1 pb-0.5 font-sans text-xs">
          <span className="text-destructive">Not sent.</span>
          <LinkButton onClick={() => void messagesService.retry(message)}>Retry</LinkButton>
          <span aria-hidden>/</span>
          <LinkButton onClick={() => messagesService.discard(message)}>Delete</LinkButton>
        </div>
      )}
    </>
  )
}

/** `@name`, highlighted when it's me. `<@id>` renders as the member's display name when known. */
function Mention({
  token,
  guildId
}: {
  token: MentionToken
  guildId: string | null
}): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const byId = 'userId' in token
  const fallback = byId && me?.id === token.userId ? me : undefined
  const { member, name } = useMemberView(guildId, byId ? token.userId : '', fallback)
  const isMe = !!me && mentionsUser(token, me)
  return (
    <span
      className={cn(
        'font-semibold',
        isMe ? 'bg-primary/20 text-foreground px-0.5' : 'text-primary'
      )}
    >
      {byId && (member || fallback) ? `@${name}` : token.value}
    </span>
  )
}

function LinkButton(props: { onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="text-foreground focus-visible:outline-ring font-medium underline-offset-2 hover:underline focus-visible:outline-2"
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
        className="bg-card focus-visible:border-ring field-sizing-content block max-h-[198px] min-h-[38px] w-full resize-none border px-3 py-2 font-mono text-[13.5px] leading-[22px] outline-none"
      />
      <p className="text-muted-foreground pt-1 font-sans text-xs">
        Enter to <LinkButton onClick={() => void save()}>save</LinkButton>, Esc to{' '}
        <LinkButton onClick={onDone}>cancel</LinkButton>
      </p>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}
