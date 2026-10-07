import { LogOut, MessageCircle, Plus } from 'lucide-react'
import type { PresenceStatus } from '@hachiman/client'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { GuildTile } from '@/components/ui/guild-tile'
import { PRESENCE_LABEL, PresenceDot } from '@/components/ui/presence'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuildMenuItems } from '@/components/shell/guild-menu-items'
import { CornerBadge } from '@/components/shell/unread-marks'
import { UserAvatar } from '@/components/shell/user-avatar'
import type { UnreadBadge } from '@/lib/notify'
import { cn } from '@/lib/utils'
import { setMyStatus } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { openDialog, useDialogStore } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { DM_HOME, selectGuild, useSelectedGuildId } from '@/stores/navStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { useDmUnread, useGuildUnread } from '@/stores/unreadStore'
import { useUserStore } from '@/stores/userStore'

/** For my own status, offline is a choice: "Invisible". */
const STATUS_LABEL: Record<PresenceStatus, string> = { ...PRESENCE_LABEL, offline: 'Invisible' }
const STATUSES: PresenceStatus[] = ['online', 'idle', 'dnd', 'offline']

/** Ring of the selected space: a gap in the wallpaper colour, then the primary text colour. */
const RING = 'ring-text-primary ring-offset-surface-window ring-2 ring-offset-2'

/**
 * The space bar at the foot of the sidebar (40 high, icons 26): my avatar (user settings; right
 * click for status and sign out), the DM space, one icon per guild (right click for the guild
 * menu), then "+" (create or join a guild).
 */
export function SpaceBar(): React.JSX.Element {
  const guilds = useGuildStore((s) => s.guilds)
  const selectedGuildId = useSelectedGuildId()
  const dmBadge = useDmUnread()

  return (
    <nav aria-label="Spaces" className="flex h-10 shrink-0 items-center gap-2 px-1">
      <MeButton />
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto px-2 py-2 [scrollbar-width:none]">
        <SpaceButton
          label="Direct messages"
          active={selectedGuildId === null}
          onClick={() => selectGuild(DM_HOME)}
          className="bg-surface-raised text-text-secondary"
          badge={dmBadge}
        >
          <MessageCircle className="size-3.5" />
        </SpaceButton>
        {[...guilds.values()].map((g) => (
          <GuildSpaceButton key={g.id} guildId={g.id} active={selectedGuildId === g.id} />
        ))}
      </div>
      <SpaceButton
        label="Create or join a guild"
        onClick={() => openDialog({ kind: 'addGuild' })}
        className="bg-surface-hover text-text-tertiary hover:text-feature-voice"
      >
        <Plus className="size-3.5" />
      </SpaceButton>
    </nav>
  )
}

/** A guild's space button with its unread dot and mention sum (N7); right click: the guild menu. */
function GuildSpaceButton({
  guildId,
  active
}: {
  guildId: string
  active: boolean
}): React.JSX.Element | null {
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const badge = useGuildUnread(guildId)
  if (!guild) return null
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SpaceButton
          label={guild.name}
          active={active}
          onClick={() => selectGuild(guildId)}
          badge={badge}
        >
          <GuildTile guild={guild} className="bg-surface-raised size-full border-0 text-[10px]" />
        </SpaceButton>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <GuildMenuItems guildId={guildId} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** My avatar: opens user settings (ringed while they are open). */
function MeButton(): React.JSX.Element {
  const me = useUserStore((s) => s.me)
  const status = useUserStore((s) => s.status)
  const handle = useTakusenStore((s) => s.session?.user.handle)
  const settingsOpen = useDialogStore((s) => s.dialog?.kind === 'userSettings')
  const name = me?.username ?? handle ?? 'Guest'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SpaceButton
          label="User settings"
          active={settingsOpen}
          onClick={() => openDialog({ kind: 'userSettings' })}
          className="overflow-visible"
        >
          <UserAvatar
            name={name}
            avatar={me?.avatar}
            size={26}
            status={status}
            cutout="bg-surface-window"
          />
        </SpaceButton>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuLabel className="text-text-tertiary text-xs font-semibold">
          Status
        </ContextMenuLabel>
        {STATUSES.map((s) => (
          <ContextMenuItem key={s} onSelect={() => setMyStatus(s)}>
            <span className="flex size-4 items-center justify-center">
              <PresenceDot status={s} />
            </span>
            <span className={cn(status === s && 'font-semibold')}>{STATUS_LABEL[s]}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => takusenService.signOut()}>
          <LogOut /> Sign out
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * One 26px round space button with a tooltip and an optional unread badge (N7) on its corner.
 * Extra props (from a wrapping `ContextMenuTrigger asChild`) land on the button.
 */
function SpaceButton({
  label,
  active = false,
  badge,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & {
  label: string
  active?: boolean
  badge?: UnreadBadge
}): React.JSX.Element {
  const button = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex size-[26px] shrink-0 items-center justify-center overflow-hidden rounded-full transition-shadow',
            active ? RING : 'hover:ring-line-strong hover:ring-2',
            className
          )}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
  if (!badge) return button
  return (
    <span className="relative flex shrink-0">
      {button}
      <CornerBadge badge={badge} />
    </span>
  )
}
