import { useState } from 'react'
import { LogOut, Trash2 } from 'lucide-react'
import type { Guild } from '@hachiman/client'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { GuildTile } from '@/components/ui/guild-tile'
import { Input } from '@/components/ui/input'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { hachiman } from '@/services/hachiman'
import type { DialogOf } from '@/stores/dialogStore'
import { useChannelStore } from '@/stores/channelStore'
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
  const guildId = guild?.id
  const channelCount = useChannelStore((s) => {
    let n = 0
    for (const c of s.channels.values()) if (c.guildId === guildId && c.type !== 'category') n++
    return n
  })
  const memberCount = useGuildStore((s) => (guildId ? (s.members.get(guildId)?.size ?? 0) : 0))
  const joinedAt = useGuildStore((s) =>
    guildId && myId ? (s.members.get(guildId)?.get(myId)?.joinedAt ?? null) : null
  )

  const card = guild && (
    <div className="border-line-hairline bg-surface-sunken mb-3 flex items-center gap-3 border p-3">
      <GuildTile guild={guild} />
      <span className="grid min-w-0">
        <span className="text-label truncate">{guild.name}</span>
        <span className="text-meta text-text-tertiary truncate">
          {[
            plural(channelCount, 'channel'),
            memberCount > 0 && plural(memberCount, 'member'),
            joinedAt && !isOwner && `member since ${memberSince(joinedAt)}`
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </div>
  )

  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      title={isOwner ? `Delete ${name}?` : `Leave ${name}?`}
      body={
        isOwner ? (
          <div className="grid gap-3">
            {card}
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
          <>
            {card}
            <p>You’ll lose access to its channels. To come back you’ll need a new invite.</p>
          </>
        )
      }
      confirmLabel={isOwner ? 'Delete guild' : 'Leave guild'}
      what={`${isOwner ? 'delete' : 'leave'} ${name}`}
      tone="danger"
      icon={isOwner ? <Trash2 /> : <LogOut />}
      confirmDisabled={isOwner && typed.trim() !== guild?.name}
      onConfirm={async () => {
        if (!guild) return
        await (isOwner ? hachiman.rest.deleteGuild(guild.id) : hachiman.rest.leaveGuild(guild.id))
      }}
    />
  )
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Aug" this year, "Aug 2025" before. */
function memberSince(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short' } : { month: 'short', year: 'numeric' }
  )
}
