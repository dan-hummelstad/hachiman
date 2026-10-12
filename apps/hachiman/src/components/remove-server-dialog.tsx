import { useState } from 'react'
import { LogOut, Trash2 } from 'lucide-react'
import type { Guild } from '@hachiman/client'
import { MobileField } from '@/components/mobile/field'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field } from '@/components/ui/field'
import { GuildTile } from '@/components/ui/guild-tile'
import { Input } from '@/components/ui/input'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useLayout } from '@/hooks/use-layout'
import { guildAfterLeave } from '@/lib/model'
import { orderedIds } from '@/lib/sidebar-tiles'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import type { DialogOf } from '@/stores/dialogStore'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { selectGuild, useNavStore } from '@/stores/navStore'
import { accountPrefs, usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'

const useRemovedGuild = (d: DialogOf<'removeGuild'>): Guild | undefined =>
  useGuildStore((s) => s.guilds.get(d.guildId))

/**
 * Leave a guild, or delete it when the current user owns it (type the name to confirm). On the
 * mobile layout (M50) it is a centred dialog over the open drawer: the guild card (icon 40, name
 * 15.5), one plain sentence, and the owner's field as a kit field with no autofocus. Once the
 * guild is gone, the drawer shows the next guild of the guild row.
 */
export function RemoveServerDialog(): React.JSX.Element {
  const { subject: guild, open, close } = useDialogSubject('removeGuild', useRemovedGuild)
  const mobile = useLayout() === 'mobile'
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
    <div
      className={cn(
        'border-line-hairline bg-surface-sunken flex items-center gap-3 border p-3',
        mobile ? 'border-line-strong' : 'mb-3'
      )}
    >
      <GuildTile guild={guild} />
      <span className="mobile:gap-0.5 grid min-w-0">
        <span className="text-label mobile:text-[15.5px] mobile:leading-[19px] mobile:font-extrabold truncate">
          {guild.name}
        </span>
        <span className="text-meta text-text-tertiary mobile:text-[13px] mobile:leading-4 mobile:font-medium truncate">
          {[
            plural(channelCount, 'channel'),
            memberCount > 0 && plural(memberCount, 'member'),
            joinedAt &&
              !isOwner &&
              (mobile
                ? `since ${memberSince(joinedAt, 'long')}`
                : `member since ${memberSince(joinedAt)}`)
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </div>
  )

  /** On the mobile layout: after the guild that the drawer showed is gone, show the next one. */
  const showNextGuild = (): (() => void) => {
    if (!mobile || !guild) return () => undefined
    const nav = useNavStore.getState()
    if (nav.guildKey !== guild.id) return () => undefined
    const guilds = [...useGuildStore.getState().guilds.keys()]
    const order = orderedIds(guilds, accountPrefs(usePrefsStore.getState()).guildOrder ?? [])
    const next = guildAfterLeave(order, guild.id)
    return () => {
      if (next !== null && useGuildStore.getState().guilds.has(next)) selectGuild(next)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      title={isOwner ? `Delete ${name}?` : `Leave ${name}?`}
      body={
        isOwner ? (
          <div className="mobile:gap-3.5 grid gap-3">
            {card}
            <p className={BODY_TEXT}>
              This deletes the guild, its channels and every message for everyone. You can’t undo
              this.
            </p>
            {mobile ? (
              // No autoFocus: the keyboard rises when the user taps the field (spec §2.8).
              <MobileField id="confirm-guild-name" label="Type the guild name to confirm">
                <Input
                  size="touch"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </MobileField>
            ) : (
              <Field id="confirm-guild-name" label="Type the guild name to confirm">
                <Input
                  id="confirm-guild-name"
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                />
              </Field>
            )}
          </div>
        ) : mobile ? (
          <div className="grid gap-3.5">
            {card}
            <p className={BODY_TEXT}>
              You’ll lose access to its channels. To come back you’ll need a new invite.
            </p>
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
      confirmIcon
      confirmDisabled={isOwner && typed.trim() !== guild?.name}
      onConfirm={async () => {
        if (!guild) return
        const showNext = showNextGuild()
        await (isOwner ? hachiman.rest.deleteGuild(guild.id) : hachiman.rest.leaveGuild(guild.id))
        showNext()
      }}
    />
  )
}

/** The body text of the mobile confirm (M50): 15/500, line height 1.5. */
const BODY_TEXT = 'mobile:text-[15px] mobile:leading-[1.5] mobile:font-medium'

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Aug" this year, "Aug 2025" before; `long`: "August", "August 2025". */
function memberSince(iso: string, month: 'short' | 'long' = 'short'): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month } : { month, year: 'numeric' })
}
