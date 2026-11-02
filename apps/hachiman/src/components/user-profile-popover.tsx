import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, MessageCircle, MicOff, MoreHorizontal, ShieldCheck, VolumeX } from 'lucide-react'
import type { User } from '@hachiman/client'
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
import { GuildTile } from '@/components/ui/guild-tile'
import { LiveDot } from '@/components/ui/live'
import { useMutualGuilds } from '@/components/people/use-mutual-guilds'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PRESENCE_LABEL } from '@/components/ui/presence'
import { UserAudioControl } from '@/components/voice/user-audio-control'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { useMemberView, useOpenDm, usePresence } from '@/hooks/use-member'
import { displayName, memberRoles } from '@/lib/model'
import { cn } from '@/lib/utils'
import { blockService } from '@/services/guild-features'
import { usePoke } from '@/services/poke'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
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
 * (the safety number, §12.5). On the mobile layout the popover is a bottom sheet (P6) with touch
 * size actions (docs/ios-mobile-ui-spec.md A4).
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
            // A touch hold that opened the trigger's own menu (the mobile member sheet).
            if (e.defaultPrevented) return
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
          className="bg-surface-content border-line-hairline rounded-control w-[344px] overflow-hidden p-0"
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
  const { member, name } = useMemberView(guildId, userId, props.user)
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined))
  const guildName = useGuildStore((s) => (guildId ? s.guilds.get(guildId)?.name : undefined))
  const guildMembers = useGuildStore((s) => (guildId ? s.members.get(guildId) : undefined))
  const status = usePresence(userId)
  const guildVoice = useVoiceStore((s) => (guildId ? s.voiceStates.get(guildId) : undefined))
  const voice = guildVoice?.get(userId)
  const voiceChannel = useChannelStore((s) =>
    voice?.channelId ? s.channels.get(voice.channelId) : undefined
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
  const mutual = useMutualGuilds(userId)
  const mobile = useLayout() === 'mobile'
  const actionSize = mobile ? 'mobile' : 'sm'
  const actionIcon = mobile ? undefined : 'size-3.5'
  const inRoom = voice?.channelId && voiceChannel?.type === 'voice' ? voiceChannel : undefined
  const company = useMemo(() => {
    if (!inRoom || !guildVoice) return []
    const names: string[] = []
    for (const [id, v] of guildVoice) {
      if (id === userId || v.channelId !== inRoom.id) continue
      names.push(displayName(guildMembers?.get(id)))
    }
    return names
  }, [inRoom, guildVoice, guildMembers, userId])
  const alsoIn = mutual.filter((g) => g.id !== guildId).slice(0, 3)
  const since = member?.joinedAt
    ? new Date(member.joinedAt)
        .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
        .toUpperCase()
    : null
  const topRole = chips[0]?.name
  const withLine =
    company.length === 0
      ? 'Alone for now'
      : company.length === 1
        ? `With ${company[0]}`
        : company.length === 2
          ? `With ${company[0]} and ${company[1]}`
          : `With ${company[0]}, ${company[1]} and ${company.length - 2} ${company.length === 3 ? 'other' : 'others'}`
  const tag =
    'rounded-badge border-line-strong text-text-tertiary inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.8px] uppercase'

  return (
    <div className="flex flex-col">
      {guildId && (
        <div className="bg-surface-raised mobile:hidden flex h-[34px] items-center gap-[9px] px-3.5">
          <span aria-hidden className="bg-here h-[13px] w-0.5" />
          <span className="cap-sm text-text-tertiary truncate text-[8.5px] tracking-[1.2px]">
            AS SEEN IN {guildName ?? 'THIS SPACE'}
          </span>
        </div>
      )}
      <div className="flex gap-3.5 px-4 pt-[18px] pb-4">
        <UserAvatar
          avatar={identity?.avatar}
          name={name}
          size={mobile ? 64 : 56}
          status={status}
          cutout="bg-surface-content"
          className="mobile:rounded-full rounded-[15px] [--presence-bar:var(--surface-content)]"
        />
        <div className="grid min-w-0 gap-[5px]">
          <span className="text-text-primary mobile:text-[22px] mobile:tracking-[-0.5px] truncate text-[19px] leading-6 font-semibold tracking-[-0.4px]">
            {name}
          </span>
          <span className="text-text-disabled mobile:text-[11.5px] mobile:normal-case mobile:tracking-normal mobile:text-text-tertiary truncate font-mono text-[9.5px] tracking-[0.9px] uppercase">
            @{identity?.username ?? userId}
            {topRole && <span className="mobile:hidden"> · {topRole}</span>}
          </span>
          <span className="text-text-tertiary text-[12px]">{PRESENCE_LABEL[status]}</span>
          <CustomStatusLine userId={userId} />
        </div>
      </div>

      {inRoom && (
        <div className="bg-live-tint mobile:mx-[18px] mobile:mb-3.5 mobile:h-[52px] mobile:rounded-[12px] mobile:px-3 flex h-[46px] items-center gap-2.5 px-3.5">
          <LiveDot className="mobile:block mobile:size-2 hidden" />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-live-text mobile:font-sans mobile:normal-case mobile:text-[13.5px] mobile:tracking-normal truncate font-mono text-[8.5px] font-semibold tracking-[1.1px] uppercase">
              <span className="mobile:hidden">IN {inRoom.name} NOW</span>
              <span className="mobile:inline hidden">In {inRoom.name}</span>
            </span>
            <span className="text-text-secondary mobile:font-mono mobile:text-[8.5px] mobile:uppercase mobile:tracking-[0.9px] mobile:text-text-tertiary truncate text-[12px]">
              <span className="mobile:hidden">{withLine}</span>
              <span className="mobile:inline hidden">{company.length + 1} aboard</span>
            </span>
          </div>
          {!isMe && myCall !== inRoom.id && (
            <Button
              variant="voice"
              size="sm"
              className="rounded-badge mobile:h-8 mobile:rounded-pill mobile:px-3.5 mobile:text-[13px] mobile:font-sans mobile:normal-case h-[23px] px-[9px] text-[9.5px]"
              onClick={() => {
                void voiceService.join(inRoom)
                props.onDone()
              }}
            >
              <span className="mobile:hidden">JOIN</span>
              <span className="mobile:inline hidden">Join</span>
            </Button>
          )}
        </div>
      )}

      {voice?.channelId && (voice.selfMute || voice.selfDeaf || voice.mute || voice.deaf) && (
        <div className="flex flex-wrap gap-1 px-4 pb-3">
          {voice.mute && (
            <span className={tag}>
              <MicOff className="size-3" /> Server muted
            </span>
          )}
          {voice.deaf && (
            <span className={tag}>
              <VolumeX className="size-3" /> Server deafened
            </span>
          )}
          {voice.selfMute && (
            <span className={tag}>
              <MicOff className="size-3" /> Muted
            </span>
          )}
          {voice.selfDeaf && (
            <span className={tag}>
              <VolumeX className="size-3" /> Deafened
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col px-4 pt-1 pb-4">
        {chips.length > 0 && (
          <>
            <span className="cap text-text-disabled text-[9px] tracking-[1.5px]">
              <span className="mobile:hidden">Roles</span>
              <span className="mobile:inline hidden">Roles in {guildName}</span>
            </span>
            <div className="mt-2 flex flex-wrap gap-[7px]">
              {chips.map((r) => (
                <span
                  key={r.id}
                  className="rounded-pill border-line-strong text-text-secondary mobile:h-7 mobile:px-[11px] mobile:text-[12px] mobile:font-medium inline-flex h-8 items-center border px-3.5 text-[12.5px]"
                >
                  {r.name}
                </span>
              ))}
            </div>
          </>
        )}

        {alsoIn.length > 0 && (
          <div className="mt-[18px] flex flex-col">
            <span className="cap text-text-disabled text-[9px] tracking-[1.5px]">Also in</span>
            <div className="mt-2 flex flex-wrap gap-[7px]">
              {alsoIn.map((g) => (
                <span
                  key={g.id}
                  className="border-line-hairline rounded-control text-text-secondary inline-flex h-[30px] items-center gap-2 border pr-2.5 pl-2 text-[12px]"
                >
                  <GuildTile guild={g} className="size-[18px] rounded-[5px] text-[7px]" />
                  {g.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {!isMe && myCall !== null && voice?.channelId === myCall && (
          <div className="mt-[18px]">
            <UserAudioControl userId={userId} />
          </div>
        )}

        {since && (
          <span className="cap-sm mt-[18px] text-[8.5px] tracking-[1px]">MEMBER SINCE · {since}</span>
        )}
      </div>

      {!isMe && (
        <div className="bg-surface-sunken border-line-hairline mobile:h-auto mobile:border-0 mobile:bg-transparent mobile:px-[18px] mobile:pb-4 flex h-[62px] items-center gap-[9px] border-t px-4">
          <Button
            size={actionSize}
            className="flex-1"
            disabled={dm.busy || blocked}
            onClick={() => void dm.open().then((ok) => ok && props.onDone())}
          >
            {mobile && <MessageCircle className={actionIcon} />} Message
          </Button>
          <Button
            size={actionSize}
            variant="secondary"
            className="flex-1"
            disabled={!encryption}
            onClick={() => {
              props.onDone()
              openDialog({ kind: 'verification', userId })
            }}
          >
            <ShieldCheck className={actionIcon} /> Verify
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                label="More"
                size={mobile ? 'touch' : 'sm'}
                className={cn(
                  'rounded-control border-line-strong text-text-tertiary size-10 border',
                  mobile && 'rounded-pill size-12 border-[1.5px]'
                )}
              >
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
      {blocked && !isMe && (
        <p className="text-text-tertiary px-4 pb-3 text-[12px]">You blocked {name}.</p>
      )}
      <div className="flex flex-col gap-1 px-4 empty:hidden [&>p]:pb-3">
        <ErrorText>{unblock.error ?? poke.error}</ErrorText>
        <ErrorText>{moderate.error}</ErrorText>
      </div>
    </div>
  )
}
