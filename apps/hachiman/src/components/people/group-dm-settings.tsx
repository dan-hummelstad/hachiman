import { useState } from 'react'
import { LogOut, Settings, Trash2, Users } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { ImageField } from '@/components/settings/image-field'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText, Field } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { useAction } from '@/hooks/use-action'
import { dmName } from '@/lib/model'
import { hachiman } from '@/services/hachiman'
import { navigate } from '@/stores/navStore'
import { useUserStore } from '@/stores/userStore'

type Confirm = 'leave' | 'delete' | null

/**
 * The settings button of a group DM: name and image (any participant), Leave, and Delete for the
 * owner. Leave and Delete ask first, then show the DM home.
 */
export function GroupSettingsButton({
  channel,
  className
}: {
  channel: Channel
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const isOwner = useUserStore((s) => s.me?.id === channel.ownerId)
  const name = dmName(channel)
  const ask = (c: Confirm): void => {
    setOpen(false)
    setConfirm(c)
  }
  return (
    <>
      <IconButton
        label="Group settings"
        tooltipSide="bottom"
        onClick={() => setOpen(true)}
        className={className}
      >
        <Settings />
      </IconButton>
      <ModalWindow
        open={open}
        onClose={() => setOpen(false)}
        title="Group settings"
        icon={<Settings />}
      >
        {open && (
          <GroupSettingsBody
            channel={channel}
            isOwner={isOwner}
            onLeave={() => ask('leave')}
            onDelete={() => ask('delete')}
          />
        )}
      </ModalWindow>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'delete' ? `Delete ${name}?` : `Leave ${name}?`}
        body={
          <p>
            {confirm === 'delete'
              ? 'This deletes the group and every message in it for everyone. You can’t undo this.'
              : 'You won’t get its messages any more. To come back, someone has to start a new group with you.'}
          </p>
        }
        confirmLabel={confirm === 'delete' ? 'Delete group' : 'Leave group'}
        tone="danger"
        icon={confirm === 'delete' ? <Trash2 /> : <LogOut />}
        confirmIcon
        onConfirm={async () => {
          await (confirm === 'delete'
            ? hachiman.rest.deleteChannel(channel.id)
            : hachiman.rest.leaveGroupDm(channel.id))
          navigate({ kind: 'dmHome' })
        }}
      />
    </>
  )
}

function GroupSettingsBody({
  channel,
  isOwner,
  onLeave,
  onDelete
}: {
  channel: Channel
  isOwner: boolean
  onLeave: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [name, setName] = useState(channel.name ?? '')
  const { run, busy, error } = useAction()
  const changed = name.trim() !== (channel.name ?? '')
  // With no name, the group shows its people.
  const fallbackName = dmName({ ...channel, name: null })

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    await run('rename the group', () =>
      hachiman.rest.updateGroupDm(channel.id, { name: name.trim() || null })
    )
  }

  return (
    <div className="grid gap-5">
      <ImageField
        label="Group image"
        hint="Everyone in the group sees it."
        value={channel.icon ?? null}
        fallback={<Users className="text-text-tertiary size-6" aria-hidden />}
        row
        onSave={(icon) => hachiman.rest.updateGroupDm(channel.id, { icon })}
      />
      <form onSubmit={(e) => void save(e)} className="grid gap-2">
        <Field id="group-name" label="Group name">
          <div className="flex gap-2">
            <Input
              id="group-name"
              value={name}
              maxLength={100}
              placeholder={fallbackName}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={busy || !changed}>
              Save
            </Button>
          </div>
        </Field>
        <ErrorText>{error}</ErrorText>
      </form>
      <div className="border-line-hairline flex flex-wrap justify-end gap-2 border-t pt-4">
        <Button variant="danger" onClick={onLeave}>
          <LogOut /> Leave group
        </Button>
        {isOwner && (
          <Button variant="danger" onClick={onDelete}>
            <Trash2 /> Delete group
          </Button>
        )}
      </div>
    </div>
  )
}
