import { useState } from 'react'
import type { Guild } from '@hachiman/client'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { hachiman } from '@/services/hachiman'
import type { DialogOf } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

const useRemovedGuild = (d: DialogOf<'removeGuild'>): Guild | undefined =>
  useGuildStore((s) => s.guilds.get(d.guildId))

/** Leave a guild, or delete it when the current user owns it (type the name to confirm). */
export function RemoveServerDialog(): React.JSX.Element {
  const { subject: guild, open, close } = useDialogSubject('removeGuild', useRemovedGuild)
  const myId = useUserStore((s) => s.me?.id)
  // From the latched guild, so the wording holds while the window animates closed.
  const isOwner = myId !== undefined && guild?.ownerId === myId
  const [typed, setTyped] = useState('')
  const name = guild?.name ?? 'this guild'

  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      title={isOwner ? `Delete ${name}?` : `Leave ${name}?`}
      body={
        isOwner ? (
          <div className="grid gap-3">
            <p>
              This deletes the guild, its channels and every message for everyone. You can’t undo
              this.
            </p>
            <Field id="confirm-guild-name" label="Type the guild name to confirm">
              <Input
                id="confirm-guild-name"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
              />
            </Field>
          </div>
        ) : (
          'You’ll lose access to its channels. To come back you’ll need a new invite.'
        )
      }
      confirmLabel={isOwner ? 'Delete guild' : 'Leave guild'}
      what={`${isOwner ? 'delete' : 'leave'} ${name}`}
      tone="danger"
      confirmDisabled={isOwner && typed.trim() !== guild?.name}
      onConfirm={async () => {
        if (!guild) return
        await (isOwner ? hachiman.rest.deleteGuild(guild.id) : hachiman.rest.leaveGuild(guild.id))
      }}
    />
  )
}
