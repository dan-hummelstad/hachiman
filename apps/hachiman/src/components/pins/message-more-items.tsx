import { MessagesSquare, Pin, PinOff } from 'lucide-react'
import { Permissions, has } from '@hachiman/client'
import { canHoldThreads, defaultThreadName } from '@/components/threads/thread-name'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { usePermissions } from '@/hooks/use-hachiman'
import { pinsService } from '@/services/guild-features'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog } from '@/stores/dialogStore'
import type { ChatMessage } from '@/stores/messagesStore'
import { usePinned } from '@/stores/pinsStore'
import { useCanPin } from './use-can-pin'

/**
 * The pin (N13) and thread (N12) items of a message's "More" menu, or null when I may do
 * neither. A row that did not decrypt can be pinned but starts no thread (its text is unknown).
 */
export function useMessageMoreItems(message: ChatMessage): React.ReactNode | null {
  const channel = useChannelStore((s) => s.channels.get(message.channelId))
  const pinned = usePinned(message.channelId, message.id)
  const canPin = useCanPin({ id: message.channelId, guildId: message.guildId })
  const perms = usePermissions(message.guildId, message.channelId)
  const canThread =
    !!channel &&
    canHoldThreads(channel) &&
    message.decrypt.status === 'ok' &&
    has(perms, Permissions.SEND_MESSAGES)
  if (!canPin && !canThread) return null

  const togglePin = (): void => {
    const call = pinned ? pinsService.unpin : pinsService.pin
    call(message.channelId, message.id).catch((e: unknown) =>
      console.warn(`[pins] ${pinned ? 'unpin' : 'pin'} failed`, e)
    )
  }

  return (
    <>
      {canPin && (
        <DropdownMenuItem onSelect={togglePin}>
          {pinned ? <PinOff /> : <Pin />}
          {pinned ? 'Unpin message' : 'Pin message'}
        </DropdownMenuItem>
      )}
      {canThread && (
        <DropdownMenuItem
          onSelect={() =>
            openDialog({
              kind: 'createThread',
              parentId: message.channelId,
              startMessageId: message.id,
              name: defaultThreadName(message.content)
            })
          }
        >
          <MessagesSquare />
          Create thread
        </DropdownMenuItem>
      )}
    </>
  )
}
