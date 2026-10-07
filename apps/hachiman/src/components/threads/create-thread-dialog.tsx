import { MessagesSquare } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { openChannelView } from '@/lib/navigation'
import { ModalWindow } from '@/components/ui/modal-window'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useChannelStore } from '@/stores/channelStore'
import type { DialogOf } from '@/stores/dialogStore'
import { NewThreadForm } from './threads-button'

const useParent = (d: DialogOf<'createThread'>): Channel | undefined =>
  useChannelStore((s) => s.channels.get(d.parentId))

/** "Create thread" from a message's "More" menu (N12): the name, prefilled, then the thread opens. */
export function CreateThreadDialog(): React.JSX.Element {
  const { dialog, subject: parent, open, close } = useDialogSubject('createThread', useParent)
  return (
    <ModalWindow
      open={open}
      onClose={close}
      title="Create thread"
      description={parent ? `A thread in #${parent.name} on this message.` : undefined}
      icon={<MessagesSquare />}
      feature="thread"
    >
      <div className="-mx-2.5">
        <NewThreadForm
          parentId={dialog.parentId}
          startMessageId={dialog.startMessageId}
          initialName={dialog.name}
          onCancel={close}
          onCreated={(thread) => {
            close()
            openChannelView(thread)
          }}
        />
      </div>
    </ModalWindow>
  )
}
