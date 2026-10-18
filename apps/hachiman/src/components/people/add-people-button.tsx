import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { IconButton } from '@/components/ui/icon-button'
import { NewMessageDialog } from './new-message-dialog'

export function AddPeopleButton({
  channel,
  className
}: {
  channel: Channel
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton
        label="Add people"
        tooltipSide="bottom"
        onClick={() => setOpen(true)}
        className={className}
      >
        <UserPlus />
      </IconButton>
      <NewMessageDialog
        open={open}
        onClose={() => setOpen(false)}
        mode={
          channel.type === 'group_dm'
            ? { kind: 'add', to: channel }
            : { kind: 'group', with: channel.recipients ?? [] }
        }
      />
    </>
  )
}
