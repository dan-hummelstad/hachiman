import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, MessageCircle, MicOff, MoreHorizontal, ShieldCheck, VolumeX } from 'lucide-react'
import type { User } from '@hachiman/client'
import { useUserBanner } from '@/components/people/use-user-banner'
import { BlockConfirmDialog } from '@/components/people/block-dialog'
import {
  ModerationDialogs,
  ModerationMenuItems,
  type ModerationDialog
} from '@/components/people/member-moderation'
import { useModerationRights } from '@/components/people/use-moderation-rights'
import { CustomStatusLine } from '@/components/people/custom-status-line'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { PokeMenuItem } from '@/components/people/poke-menu-item'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PRESENCE_LABEL, PresenceDot } from '@/components/ui/presence'
import { RoleChip } from '@/components/ui/role-chip'
import { UserAudioControl } from '@/components/voice/user-audio-control'
import { useAction } from '@/hooks/use-action'
import { useMemberView, useOpenDm, usePresence } from '@/hooks/use-member'
import { memberRoles } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { blockService } from '@/services/guild-features'
import { usePoke } from '@/services/poke'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useIsBlocked, useUserStore } from '@/stores/userStore'
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
  // Right-click opens the card at the cursor; a click opens it at the trigger.
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  // The confirm window lives outside the popover, which closes when it opens.
  const [blocking, setBlocking] = useState<string | null>(null)
  const [moderating, setModerating] = useState<{ kind: ModerationDialog; name: string } | null>(
    null
  )
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          asChild
          onClick={() => setPoint(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            setPoint({ x: e.clientX, y: e.clientY })
            setOpen(true)
          }}
        >
          {children}
        </PopoverTrigger>
        {/* Portaled so that a transformed ancestor does not move the fixed anchor. */}
        {point &&
          createPortal(
            <PopoverAnchor
              className="pointer-events-none fixed size-0"
              style={{ left: point.x, top: point.y }}
            />,
            document.body
          )}
        <PopoverContent
          side={point ? 'right' : side}
          align="start"
          sideOffset={point ? 2 : 8}
          className={cn('w-72 p-0', ROLE_INK_SCOPE)}
        >
          <ProfileCard
            userId={userId}
            guildId={guildId}
            user={user}
            onDone={() => setOpen(false)}
            onBlock={(name) => {
              setOpen(false)
              setBlocking(name)
            }}
            onModerate={(kind, name) => {
              setOpen(false)
              setModerating({ kind, name })
            }}
          />
        </PopoverContent>
      </Popover>
      <BlockConfirmDialog
        userId={userId}
        name={blocking ?? ''}
        open={blocking !== null}
        onClose={() => setBlocking(null)}
      />
      <ModerationDialogs
        guildId={guildId}
        userId={userId}
        name={moderating?.name ?? ''}
        open={moderating?.kind ?? null}
        onClose={() => setModerating(null)}
      />
    </>
  )
}

function ProfileCard(props: {
  userId: string
  guildId: string | null
  user: User | undefined
  onDone: () => void
  onBlock: (name: string) => void
  onModerate: (kind: ModerationDialog, name: string) => void
}): React.JSX.Element {
  const { userId, guildId } = props
  const { member, name, ink } = useMemberView(guildId, userId, props.user)
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined))
  const status = usePresence(userId)
  const voice = useVoiceStore((s) =>
    guildId ? s.voiceStates.get(guildId)?.get(userId) : undefined
  )
  const isMe = useUserStore((s) => s.me?.id === userId)
  const myCall = useVoiceStore((s) => s.channelId)
  const dm = useOpenDm(userId)
  const blocked = useIsBlocked(userId)
  const unblock = useAction()
  const poke = usePoke()
  const moderate = useAction()
  const rights = useModerationRights(guildId, userId)
  // The safety number needs the crypto Worker (§12.5).
  const encryption = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const chips = memberRoles(member, roles)
  const identity = member?.user ?? props.user
  const banner = useUserBanner(userId, identity?.avatar)

  return (
    <div className="flex flex-col">
      <div className="h-16" style={{ background: banner }} />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="-mt-10 w-fit">
          <UserAvatar
            avatar={identity?.avatar}
            name={name}
            color={ink}
            size={64}
            status={status}
            cutout="bg-popover"
            className="ring-popover rounded-full ring-4"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-text-primary truncate text-lg leading-6 font-extrabold">
            {name}
          </span>
          <span className="text-text-tertiary truncate font-mono text-[13px]">
            {identity?.username ?? userId}
          </span>
          <span className="text-text-secondary mt-1 flex items-center gap-2 text-xs">
            <PresenceDot status={status} />
            {PRESENCE_LABEL[status]}
          </span>
          <CustomStatusLine userId={userId} className="mt-0.5" />
        </div>

        {voice?.channelId && (voice.selfMute || voice.selfDeaf || voice.mute || voice.deaf) && (
          <div className="flex flex-wrap gap-1">
            {voice.mute && (
              <span className="bg-feature-danger text-text-on-accent flex items-center gap-1 px-1.5 py-0.5 text-xs font-semibold">
                <MicOff className="size-3" /> Server muted
              </span>
            )}
            {voice.deaf && (
              <span className="bg-feature-danger text-text-on-accent flex items-center gap-1 px-1.5 py-0.5 text-xs font-semibold">
                <VolumeX className="size-3" /> Server deafened
              </span>
            )}
            {voice.selfMute && (
              <span className="bg-feature-danger/15 text-feature-danger-text flex items-center gap-1 px-1.5 py-0.5 text-xs font-semibold">
                <MicOff className="size-3" /> Muted
              </span>
            )}
            {voice.selfDeaf && (
              <span className="bg-feature-danger/15 text-feature-danger-text flex items-center gap-1 px-1.5 py-0.5 text-xs font-semibold">
                <VolumeX className="size-3" /> Deafened
              </span>
            )}
          </div>
        )}

        {chips.length > 0 && (
          <div className="border-line-hairline flex flex-col gap-1.5 border-t pt-3">
            <span className="section-label">Roles</span>
            <div className="flex flex-wrap gap-1">
              {chips.map((r) => (
                <RoleChip key={r.id} role={r} />
              ))}
            </div>
          </div>
        )}

        {!isMe && myCall !== null && voice?.channelId === myCall && (
          <UserAudioControl userId={userId} />
        )}

        {!isMe && (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={dm.busy || blocked}
              onClick={() => void dm.open().then((ok) => ok && props.onDone())}
            >
              <MessageCircle className="size-3.5" /> Message
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              disabled={!encryption}
              onClick={() => {
                props.onDone()
                openDialog({ kind: 'verification', userId })
              }}
            >
              <ShieldCheck className="size-3.5" /> Verify
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label="More" size="sm" className="rounded-control">
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!blocked && <PokeMenuItem poke={poke} userId={userId} name={name} />}
                {blocked ? (
                  <DropdownMenuItem
                    disabled={unblock.busy}
                    onSelect={() =>
                      void unblock.run(`unblock ${name}`, () => blockService.unblock(userId))
                    }
                  >
                    <Ban /> Unblock
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem variant="destructive" onSelect={() => props.onBlock(name)}>
                    <Ban /> Block
                  </DropdownMenuItem>
                )}
                {guildId && (
                  <ModerationMenuItems
                    guildId={guildId}
                    userId={userId}
                    name={name}
                    rights={rights}
                    action={moderate}
                    onDialog={(kind) => props.onModerate(kind, name)}
                  />
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {blocked && !isMe && <p className="text-text-tertiary text-xs">You blocked {name}.</p>}
        <ErrorText>{unblock.error ?? poke.error}</ErrorText>
        <ErrorText>{moderate.error}</ErrorText>
      </div>
    </div>
  )
}
