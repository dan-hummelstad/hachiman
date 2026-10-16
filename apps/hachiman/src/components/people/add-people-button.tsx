import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { IconButton } from '@/components/ui/icon-button'
import { NewMessageDialog } from './new-message-dialog'

/** The header button of a DM or group DM: starts a group with its people and more. */
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
        include={channel.recipients ?? []}
      />
    </>
  )
}
