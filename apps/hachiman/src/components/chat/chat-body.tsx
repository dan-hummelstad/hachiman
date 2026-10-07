import { useMemo } from 'react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { DropZone } from '@/components/chat/attachments/drop-zone'
import { useUploads } from '@/components/chat/attachments/use-uploads'
import { Composer } from '@/components/chat/composer'
import { Transcript } from '@/components/chat/transcript'
import { TypingLine } from '@/components/chat/typing-line'
import { usePermissions } from '@/hooks/use-hachiman'
import { channelLabel } from '@/lib/model'
import { messagesService } from '@/services/MessagesService'
import { useChannelAccess, joinNames } from '@/lib/channel-access'
import { useSendPaused } from './use-dm-trust'

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
  const canSend = has(perms, Permissions.SEND_MESSAGES)
  const canAttach = canSend && has(perms, Permissions.ATTACH_FILES)
  const uploads = useUploads()
  const access = useChannelAccess(channel)
  const recipients = channel.recipients
  const recipientIds = useMemo(() => (recipients ?? []).map((u) => u.id), [recipients])
  const pausedBy = useSendPaused(recipientIds)
  const pausedName = recipients?.find((u) => u.id === pausedBy)?.username ?? 'this contact'

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
        canManageMessages={has(perms, Permissions.MANAGE_MESSAGES)}
        onUpload={canAttach ? uploads.add : undefined}
      />
      <footer className="shrink-0 px-4">
        <Composer
          placeholder={`Message ${where}`}
          disabledReason={disabledReason}
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
          onSend={(text, attachments) => void messagesService.send(channel.id, text, attachments)}
        />
        <TypingLine channel={channel} />
      </footer>
    </DropZone>
  )
}
