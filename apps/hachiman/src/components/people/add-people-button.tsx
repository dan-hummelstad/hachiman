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
      {/* A group DM takes new members; a 1:1 DM starts a group with its partner. */}
      <NewMessageDialog
        open={open}
        onClose={() => setOpen(false)}
        {...(channel.type === 'group_dm'
          ? { addTo: channel }
          : { include: channel.recipients ?? [] })}
      />
    </>
  )
}
