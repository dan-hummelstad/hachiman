import { useState } from 'react'
import { MessageCircle, MicOff, ShieldCheck, VolumeX } from 'lucide-react'
import type { User } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PRESENCE_LABEL, PresenceDot } from '@/components/ui/presence'
import { RoleChip } from '@/components/ui/role-chip'
import { useMemberView, useOpenDm, usePresence } from '@/hooks/use-member'
import { memberRoles } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

interface UserProfilePopoverProps {
  /** The trigger: one focusable element (a button). Opens on click or right-click. */
  children: React.ReactElement
  userId: string
  /** null in DMs: the card shows identity and presence only. */
  guildId: string | null
  /** Identity fallback when there's no guild member (DMs). */
  user?: User
  /** Which side of the target the card opens on. Default `left` (member list). */
  side?: 'left' | 'right' | 'top' | 'bottom'
}

/**
 * Member card: identity, presence, voice status, roles, a "Message" (open DM) action and "Verify"
 * (the safety number, §12.5).
 */
export function UserProfilePopover({
  children,
  userId,
  guildId,
  user,
  side = 'left'
}: UserProfilePopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onContextMenu={(e) => {
          e.preventDefault()
          setOpen(true)
        }}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        sideOffset={8}
        className={cn('w-72 p-0', ROLE_INK_SCOPE)}
      >
        <ProfileCard userId={userId} guildId={guildId} user={user} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function ProfileCard(props: {
  userId: string
  guildId: string | null
  user: User | undefined
  onDone: () => void
}): React.JSX.Element {
  const { userId, guildId } = props
  const { member, name, ink } = useMemberView(guildId, userId, props.user)
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined))
  const status = usePresence(userId)
  const voice = useVoiceStore((s) =>
    guildId ? s.voiceStates.get(guildId)?.get(userId) : undefined
  )
  const isMe = useUserStore((s) => s.me?.id === userId)
  const dm = useOpenDm(userId)
  // The safety number needs the crypto Worker (§12.5).
  const encryption = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const chips = memberRoles(member, roles)
  const identity = member?.user ?? props.user

  return (
    <div className="flex flex-col">
      <div
        className={cn('h-14 border-b', !ink && 'bg-accent')}
        style={ink ? { background: ink } : undefined}
      />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="bg-popover -mt-9 w-fit border-4 border-[var(--popover)]">
          <UserAvatar avatar={identity?.avatar} name={name} color={ink} size={64} />
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-base leading-6 font-semibold">{name}</span>
          <span className="text-muted-foreground truncate font-mono text-[13px]">
            {identity?.username ?? userId}
          </span>
          <span className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
            <PresenceDot status={status} />
            {PRESENCE_LABEL[status]}
          </span>
        </div>

        {voice?.channelId && (voice.selfMute || voice.selfDeaf) && (
          <div className="flex gap-1">
            {voice.selfMute && (
              <span className="text-destructive border-destructive/40 flex items-center gap-1 border px-1.5 py-0.5 text-xs">
                <MicOff className="size-3" /> Muted
              </span>
            )}
            {voice.selfDeaf && (
              <span className="text-destructive border-destructive/40 flex items-center gap-1 border px-1.5 py-0.5 text-xs">
                <VolumeX className="size-3" /> Deafened
              </span>
            )}
          </div>
        )}

        {chips.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <span className="section-label">Roles</span>
            <div className="flex flex-wrap gap-1">
              {chips.map((r) => (
                <RoleChip key={r.id} role={r} className="bg-background" />
              ))}
            </div>
          </div>
        )}

        {!isMe && (
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              disabled={dm.busy}
              onClick={() => void dm.open().then((ok) => ok && props.onDone())}
            >
              <MessageCircle className="size-3.5" /> Message
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!encryption}
              onClick={() => {
                props.onDone()
                openDialog({ kind: 'verification', userId })
              }}
            >
              <ShieldCheck className="size-3.5" /> Verify
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
