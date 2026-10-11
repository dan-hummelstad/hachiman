import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban } from 'lucide-react'
import { Permissions, has, type Channel, type User } from '@hachiman/client'
import { DropZone } from '@/components/chat/attachments/drop-zone'
import { useUploads, type Uploads } from '@/components/chat/attachments/use-uploads'
import { Composer } from '@/components/chat/composer'
import { Transcript } from '@/components/chat/transcript'
import { TypingLine } from '@/components/chat/typing-line'
import { MobileChatFooter } from '@/components/mobile/mobile-chat-footer'
import { FollowButton } from '@/components/notify/notify-menu'
import { usePermissions } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { useMemberView } from '@/hooks/use-member'
import { channelLabel } from '@/lib/model'
import { BLOCKED_SEND_ERROR, messagesService } from '@/services/MessagesService'
import { useChannelAccess } from '@/lib/channel-access'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { blockService } from '@/services/guild-features'
import { useMessageStore, useReplyTarget, type ChatMessage } from '@/stores/messagesStore'
import { useIsBlocked, useUserStore } from '@/stores/userStore'
import { useComposerStore, useReplyTargetId } from '@/stores/composerStore'
import { openDialog, useDialogStore } from '@/stores/dialogStore'
import { cantPostReason } from './channel-states'
import { rowPolicy, type RowPolicy } from './row-policy'
import { useSendPaused } from './use-dm-trust'

const EMPTY_ROWS: ChatMessage[] = []

/** The props of the `Composer` that a chat footer renders. */
export type ChatComposerProps = React.ComponentProps<typeof Composer>

/** What the transcript and the two footers of a channel chat need (`useChannelChat`). */
export interface ChannelChatState {
  policy: RowPolicy
  uploads: Uploads
  /** SEND_MESSAGES and ATTACH_FILES: the drop zone and the attach buttons work. */
  canAttach: boolean
  /** "#general" or "@marlowe": the drop zone label. */
  where: string
  editingId: string | null
  setEditingId: (messageId: string | null) => void
  /** The other person of a 1:1 DM when I blocked them (N23): a notice replaces the composer. */
  blockedPeer: User | null
  /** The other person of a 1:1 DM when the server refused a send to them (their block). */
  refusedPeer: User | null
  composer: ChatComposerProps
  /**
   * Sending is paused (a verified contact's key changed): opens the key change dialog again, also
   * after its "not now" (M58). A tap on the paused mobile composer calls it. Unset while sending
   * is not paused.
   */
  onPausedTap?: () => void
}

/**
 * Body of a text channel or DM: transcript, composer + typing line. Shell never renders it for a
 * voice channel (Takusen rejects messages there), so no history fetch, typing or send happens.
 */
export function ChatBody({ channel }: { channel: Channel }): React.JSX.Element {
  // Keyed: scroll, editing and pending uploads are per channel; leaving aborts the uploads.
  return <ChannelChat key={channel.id} channel={channel} />
}

/**
 * The state of a channel chat: the row policy, the uploads, the edit target, the block state of a
 * DM and the props of its composer. The desktop and the mobile footer share it.
 */
function useChannelChat(channel: Channel): ChannelChatState {
  const perms = usePermissions(channel.guildId, channel.id)
  const label = channelLabel(channel)
  const where = `${label.sigil}${label.name}`
  const policy = useMemo(() => rowPolicy(channel, perms), [channel, perms])
  const { canSend } = policy
  const canAttach = canSend && has(perms, Permissions.ATTACH_FILES)
  const uploads = useUploads()
  const access = useChannelAccess(channel)
  const recipients = channel.recipients
  const recipientIds = useMemo(() => (recipients ?? []).map((u) => u.id), [recipients])
  const pausedBy = useSendPaused(recipientIds)
  const pausedName = recipients?.find((u) => u.id === pausedBy)?.username ?? 'this contact'
  // N23: a 1:1 DM with a block. Mine shows a notice; theirs shows when the server refuses a send.
  const dmPeer = channel.type === 'dm' ? (recipients?.[0] ?? null) : null
  const blockedPeer = useIsBlocked(dmPeer?.id ?? '')
  const refused = useMessageStore((s) =>
    (s.byChannel.get(channel.id) ?? EMPTY_ROWS).some(
      (m) => m.failed && m.sendError === BLOCKED_SEND_ERROR
    )
  )
  const replyTo = useReplyTargetId(channel.id)
  const replyName = useReplyName(channel, replyTo)
  const clearReply = (): void => useComposerStore.getState().clearReplyTarget(channel.id)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Arrow Up in an empty composer edits my newest message here (as in Discord).
  const editLast = (): boolean => {
    const myId = useUserStore.getState().me?.id
    const rows = useMessageStore.getState().byChannel.get(channel.id) ?? EMPTY_ROWS
    const last = rows.findLast(
      (m) => m.author.id === myId && !m.pending && !m.failed && m.decrypt.status === 'ok'
    )
    if (!last) return false
    setEditingId(last.id)
    return true
  }

  // The read-only notice names who can post (B7); the "Follow" button (N9) goes next to it. The
  // mobile layout says it shorter (M62).
  const mobile = useLayout() === 'mobile'
  const posters = access.posters.map((r) => r.name)
  const disabledReason = canSend
    ? undefined
    : cantPostReason(where, access.readOnly, posters, mobile)

  return {
    policy,
    uploads,
    canAttach,
    where,
    editingId,
    setEditingId,
    blockedPeer: dmPeer && blockedPeer ? dmPeer : null,
    refusedPeer: dmPeer && refused ? dmPeer : null,
    onPausedTap: pausedBy
      ? () => openDialog({ kind: 'keyChange', userId: pausedBy, severity: 'blocking' })
      : undefined,
    composer: {
      channel,
      placeholder: `Message ${where}`,
      disabledReason,
      disabledAction: !canSend && access.readOnly ? <FollowButton channel={channel} /> : undefined,
      paused: pausedBy
        ? {
            notice: `The security key of ${pausedName} changed. Sending is paused until you check it.`,
            placeholder: `Sending is paused, check the new key of ${pausedName}`
          }
        : undefined,
      uploads,
      canAttach,
      onTyping: () => messagesService.typing(channel.id),
      onEditLast: editLast,
      reply: replyTo !== null ? { name: replyName, onCancel: clearReply } : undefined,
      onSend: (text, attachments) => {
        void messagesService.send(channel.id, text, attachments, replyTo)
        clearReply()
      }
    }
  }
}

function ChannelChat({ channel }: { channel: Channel }): React.JSX.Element {
  const chat = useChannelChat(channel)
  const mobile = useLayout() === 'mobile'
  const blocked = chat.blockedPeer ? <BlockedNotice user={chat.blockedPeer} /> : null
  const transcript = (
    <Transcript
      channel={channel}
      policy={chat.policy}
      onUpload={chat.canAttach ? chat.uploads.add : undefined}
      editingId={chat.editingId}
      onEditingChange={chat.setEditingId}
    />
  )

  return (
    <DropZone
      enabled={chat.canAttach}
      label={chat.where}
      onFiles={chat.uploads.add}
      className="flex min-h-0 flex-1 flex-col"
    >
      {mobile ? (
        <KeyChangeCover>
          {transcript}
          <MobileChatFooter channel={channel} chat={chat} blocked={blocked} />
        </KeyChangeCover>
      ) : (
        <>
          {transcript}
          <DesktopChatFooter channel={channel} chat={chat} blocked={blocked} />
        </>
      )}
    </DropZone>
  )
}

/**
 * Mobile: while a key change dialog shows over the chat (M58), the chat is inert and the composer
 * loses the focus, so the keyboard goes down. `display: contents` keeps the chat's flex layout.
 */
function KeyChangeCover({ children }: { children: React.ReactNode }): React.JSX.Element {
  const covered = useDialogStore((s) => s.dialog?.kind === 'keyChange')
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const focused = document.activeElement
    if (covered && focused instanceof HTMLElement && root.current?.contains(focused)) focused.blur()
  }, [covered])
  return (
    <div ref={root} className="contents" inert={covered}>
      {children}
    </div>
  )
}

/** Composer, then the typing line, clear of the voice dock (`--dock-inset`, `--dock-height`). */
function DesktopChatFooter({
  channel,
  chat,
  blocked
}: {
  channel: Channel
  chat: ChannelChatState
  blocked: React.ReactNode
}): React.JSX.Element {
  return (
    <footer className="flex min-h-[calc(var(--dock-height,0px)+8px)] shrink-0 flex-col justify-end pr-4 pl-[calc(var(--dock-inset,0px)+16px)]">
      {blocked ?? (
        <>
          {chat.refusedPeer && (
            <p role="status" className="text-text-tertiary px-1 pb-1.5 text-[13px]">
              You can&apos;t message {chat.refusedPeer.username}.
            </p>
          )}
          <Composer {...chat.composer} />
          <TypingLine channel={channel} />
        </>
      )}
    </footer>
  )
}

/** In a 1:1 DM with someone I blocked (N23): sending is refused, so the composer is replaced. */
function BlockedNotice({ user }: { user: User }): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <div className="pb-4">
      <div
        role="note"
        className="bg-surface-panel border-line-hairline text-text-secondary flex min-h-[52px] items-center gap-3 border px-4 py-2.5 text-[14px] leading-5"
      >
        <Ban className="text-text-tertiary size-4 shrink-0" aria-hidden />
        <span className="flex-1">You blocked {user.username}. Unblock to send messages.</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void run(`unblock ${user.username}`, () => blockService.unblock(user.id))}
        >
          Unblock
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  )
}

/** The display name of the reply target's author, or "a message" when it is not loaded. */
function useReplyName(channel: Channel, replyTo: string | null): string {
  const target = useReplyTarget(channel.id, replyTo)
  const { name } = useMemberView(channel.guildId, target?.author.id ?? '', target?.author)
  return target ? name : 'a message'
}
