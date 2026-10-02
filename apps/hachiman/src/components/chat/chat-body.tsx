import { Permissions, has, type Channel } from '@hachiman/client'
import { DropZone } from '@/components/chat/attachments/drop-zone'
import { useUploads } from '@/components/chat/attachments/use-uploads'
import { Composer } from '@/components/chat/composer'
import { Transcript } from '@/components/chat/transcript'
import { TypingLine } from '@/components/chat/typing-line'
import { usePermissions } from '@/hooks/use-hachiman'
import { channelLabel } from '@/lib/model'
import { messagesService } from '@/services/MessagesService'

/**
 * Body of a text channel or DM: transcript, composer + typing line. Shell never renders it for a
 * voice channel (Oracle rejects messages there), so no history fetch, typing or send happens.
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

  return (
    <DropZone
      enabled={canAttach}
      label={where}
      onFiles={uploads.add}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Transcript channel={channel} canManageMessages={has(perms, Permissions.MANAGE_MESSAGES)} />
      <footer className="shrink-0 px-4">
        <Composer
          placeholder={`Message ${where}`}
          disabledReason={
            canSend ? undefined : `You don't have permission to send messages in ${where}.`
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
