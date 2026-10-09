import { Info, MessagesSquare, Pin, PinOff } from 'lucide-react'
import { defaultThreadName } from '@/components/threads/thread-name'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { pinsService } from '@/services/guild-features'
import { openDialog } from '@/stores/dialogStore'
import type { ChatMessage } from '@/stores/messagesStore'
import { usePinned } from '@/stores/pinsStore'
import type { RowPolicy } from './row-policy'

/**
 * The items of a message's "More" menu: pin (N13), thread (N12) and info. A row that did not
 * decrypt can be pinned but starts no thread (its text is unknown).
 */
export function useMessageMoreItems(message: ChatMessage, policy: RowPolicy): React.ReactNode {
  const pinned = usePinned(message.channelId, message.id)
  const { canPin } = policy
  const canThread = policy.canThread && message.decrypt.status === 'ok'
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
      <DropdownMenuItem
        onSelect={() =>
          openDialog({ kind: 'messageInfo', channelId: message.channelId, messageId: message.id })
        }
      >
        <Info />
        Info
      </DropdownMenuItem>
    </>
  )
}
