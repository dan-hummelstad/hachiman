import { useMemo } from 'react'
import { Ban } from 'lucide-react'
import { Permissions, has, type Channel, type User } from '@hachiman/client'
import { DropZone } from '@/components/chat/attachments/drop-zone'
import { useUploads } from '@/components/chat/attachments/use-uploads'
import { Composer } from '@/components/chat/composer'
import { Transcript } from '@/components/chat/transcript'
import { TypingLine } from '@/components/chat/typing-line'
import { FollowButton } from '@/components/notify/notify-menu'
import { usePermissions } from '@/hooks/use-hachiman'
import { useMemberView } from '@/hooks/use-member'
import { channelLabel } from '@/lib/model'
import { BLOCKED_SEND_ERROR, messagesService } from '@/services/MessagesService'
import { useChannelAccess, joinNames } from '@/lib/channel-access'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { blockService } from '@/services/guild-features'
import { useMessageStore, useReplyTarget, type ChatMessage } from '@/stores/messagesStore'
import { useIsBlocked } from '@/stores/userStore'
import { useComposerStore, useReplyTargetId } from '@/stores/composerStore'
import { rowPolicy } from './row-policy'
import { useSendPaused } from './use-dm-trust'

const EMPTY_ROWS: ChatMessage[] = []

/**
 * Body of a text channel or DM: transcript, composer + typing line. Shell never renders it for a
 * voice channel (Takusen rejects messages there), so no history fetch, typing or send happens.
 */
export function ChatBody({ channel }: { channel: Channel }): React.JSX.Element {
  // Keyed: scroll, editing and pending uploads are per channel; leaving aborts the uploads.
  return <ChannelChat key={channel.id} channel={channel} />
}

function ChannelChat({ channel }: { channel: Channel }): React.JSX.Element {
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

  // The read-only notice names who can post (B7); the "Follow" button (N9) goes next to it.
  const disabledReason = canSend
    ? undefined
    : access.readOnly
      ? access.posters.length > 0
        ? `You can't post in ${where}. Only ${joinNames(access.posters.map((r) => r.name))} can.`
        : `You can't post in ${where}.`
      : `You don't have permission to send messages in ${where}.`

  return (
    <DropZone
      enabled={canAttach}
      label={where}
      onFiles={uploads.add}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Transcript
        channel={channel}
        policy={policy}
        onUpload={canAttach ? uploads.add : undefined}
      />
      <footer className="flex min-h-[calc(var(--dock-height,0px)+8px)] shrink-0 flex-col justify-end pr-4 pl-[calc(var(--dock-inset,0px)+16px)]">
        {dmPeer && blockedPeer ? (
          <BlockedNotice user={dmPeer} />
        ) : (
          <>
            {dmPeer && refused && (
              <p role="status" className="text-text-tertiary px-1 pb-1.5 text-[13px]">
                You can&apos;t message {dmPeer.username}.
              </p>
            )}
            <Composer
              channel={channel}
              placeholder={`Message ${where}`}
              disabledReason={disabledReason}
              disabledAction={
                !canSend && access.readOnly ? <FollowButton channel={channel} /> : undefined
              }
              paused={
                pausedBy
                  ? {
                      notice: `The security key of ${pausedName} changed. Sending is paused until you check it.`,
                      placeholder: `Sending is paused, check the new key of ${pausedName}`
                    }
                  : undefined
              }
              uploads={uploads}
              canAttach={canAttach}
              onTyping={() => messagesService.typing(channel.id)}
              reply={replyTo !== null ? { name: replyName, onCancel: clearReply } : undefined}
              onSend={(text, attachments) => {
                void messagesService.send(channel.id, text, attachments, replyTo)
                clearReply()
              }}
            />
            <TypingLine channel={channel} />
          </>
        )}
      </footer>
    </DropZone>
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
