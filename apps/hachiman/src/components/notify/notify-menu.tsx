import { useState } from 'react'
import { AtSign, Bell, BellOff, BellRing, Undo2 } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  MenuSheetCheckboxItem,
  MenuSheetItem,
  MenuSheetLabel,
  MenuSheetRadioGroup,
  MenuSheetRadioItem
} from '@/components/mobile/menu-sheet'
import { IconButton } from '@/components/ui/icon-button'
import { ModalWindow } from '@/components/ui/modal-window'
import { RadioCard } from '@/components/ui/radio-card'
import { Switch } from '@/components/ui/switch'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'
import {
  guildNotifyLevel,
  isFollowing,
  isMuted,
  notifyLevel,
  notifyLevelLabel,
  type NotifyLevel
} from '@/lib/notify'
import type { DialogOf } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useNotifyPrefs, usePrefsStore } from '@/stores/prefsStore'
import type { Guild } from '@hachiman/client'

/** The three levels of N9, in menu order. The labels are `notifyLevelLabel`'s, on both layouts. */
const NOTIFY_LEVELS: readonly { value: NotifyLevel; label: string; hint: string }[] = [
  { value: 'all', label: notifyLevelLabel('all'), hint: 'Every new message counts and pings' },
  {
    value: 'mentions',
    label: notifyLevelLabel('mentions'),
    hint: 'Only messages that mention you'
  },
  { value: 'none', label: notifyLevelLabel('none'), hint: 'No pings and no unread marks' }
]

const LEVEL_ICON: Record<NotifyLevel, React.ReactNode> = {
  all: <BellRing />,
  mentions: <AtSign />,
  none: <BellOff />
}

/** The notification state of one channel (N9) and its setters. */
interface ChannelNotify {
  /** The level in force: the channel's own, else the guild's. */
  level: NotifyLevel
  /** The channel has a level of its own. */
  own: boolean
  /** Muted here or through the guild. */
  muted: boolean
  /** Muted here. */
  mutedHere: boolean
  /** No pings: muted or the level "Nothing". */
  silent: boolean
  /** null goes back to the guild setting. */
  setLevel: (level: NotifyLevel | null) => void
  setMuted: (muted: boolean) => void
}

/** The bell menu of the desktop header and the channel sheet of the mobile header share this. */
function useChannelNotify(channel: Channel): ChannelNotify {
  const prefs = useNotifyPrefs()
  const setNotifyLevel = usePrefsStore((s) => s.setNotifyLevel)
  const setMuted = usePrefsStore((s) => s.setMuted)
  const level = notifyLevel(prefs, channel.id, channel.guildId)
  const muted = isMuted(prefs, channel.id, channel.guildId)
  return {
    level,
    own: prefs.notify[channel.id] !== undefined,
    muted,
    mutedHere: prefs.muted.includes(channel.id),
    silent: muted || level === 'none',
    setLevel: (l) => setNotifyLevel(channel.id, l),
    setMuted: (m) => setMuted(channel.id, m)
  }
}

/** The bell of the channel header (N9): the level of this channel and its mute. */
export function NotifyButton({ channel }: { channel: Channel }): React.JSX.Element {
  // Mobile (the DM profile drawer): the level is in the name, not only in the icon, and the open
  // menu shows through aria-expanded alone.
  const mobile = useLayout() === 'mobile'
  const [open, setOpen] = useState(false)
  const { level, own, muted, mutedHere, silent, setLevel, setMuted } = useChannelNotify(channel)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={
            mobile ? `Notifications: ${muted ? 'muted' : notifyLevelLabel(level)}` : 'Notifications'
          }
          tooltipSide="bottom"
          pressed={mobile ? undefined : open}
          className="aria-pressed:bg-accent-tint aria-pressed:text-accent-text mobile:aria-expanded:bg-accent-tint mobile:aria-expanded:text-accent-text mobile:size-9 [&_svg]:size-[18px] mobile:[&_svg]:size-[19px]"
        >
          {silent ? <BellOff /> : level === 'all' ? <BellRing /> : <Bell />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Notify me about</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={level} onValueChange={(v) => setLevel(v as NotifyLevel)}>
          {NOTIFY_LEVELS.map((l) => (
            <DropdownMenuRadioItem key={l.value} value={l.value}>
              {l.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {own && channel.guildId !== null && (
          <DropdownMenuItem onSelect={() => setLevel(null)}>Use the guild setting</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={mutedHere}
          disabled={muted && !mutedHere}
          onCheckedChange={(c) => setMuted(c === true)}
        >
          {muted && !mutedHere ? 'Guild is muted' : 'Mute channel'}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The bell menu as rows of the mobile channel sheet (A2, `components/mobile/channel-info-sheet`):
 * "Notify me about" with the three levels, back to the guild setting (its level as the hint), and
 * the mute. Put it inside a `MenuSheetContent`.
 */
export function NotifySheetRows({ channel }: { channel: Channel }): React.JSX.Element {
  const { level, own, muted, mutedHere, setLevel, setMuted } = useChannelNotify(channel)
  const prefs = useNotifyPrefs()
  const guildLevel = channel.guildId !== null ? guildNotifyLevel(prefs, channel.guildId) : null
  return (
    <>
      <MenuSheetLabel>Notify me about</MenuSheetLabel>
      <MenuSheetRadioGroup
        aria-label="Notify me about"
        value={level}
        onValueChange={(v) => setLevel(v as NotifyLevel)}
      >
        {NOTIFY_LEVELS.map((l) => (
          <MenuSheetRadioItem key={l.value} value={l.value}>
            {LEVEL_ICON[l.value]}
            {l.label}
          </MenuSheetRadioItem>
        ))}
      </MenuSheetRadioGroup>
      {own && guildLevel !== null && (
        <MenuSheetItem onSelect={() => setLevel(null)} hint={notifyLevelLabel(guildLevel)}>
          <Undo2 />
          Use the guild setting
        </MenuSheetItem>
      )}
      <MenuSheetCheckboxItem
        checked={mutedHere}
        disabled={muted && !mutedHere}
        onCheckedChange={setMuted}
      >
        <BellOff />
        {muted && !mutedHere ? 'Guild is muted' : 'Mute channel'}
      </MenuSheetCheckboxItem>
    </>
  )
}

/**
 * "Follow" in the read-only notice (B7): sets the channel to all messages. While followed
 * (isFollowing) it shows "Following"; a click there goes back to the guild setting. On the mobile
 * layout (M62) it is the kit's Secondary button at 44, and a toggle taps the haptic engine.
 */
export function FollowButton({ channel }: { channel: Channel }): React.JSX.Element {
  const platform = usePlatform()
  const mobile = useLayout() === 'mobile'
  const prefs = useNotifyPrefs()
  const setNotifyLevel = usePrefsStore((s) => s.setNotifyLevel)
  const following = isFollowing(prefs, channel.id)
  return (
    <Button
      variant="secondary"
      size={mobile ? 'mobile' : 'default'}
      aria-pressed={following}
      className={cn('shrink-0', mobile && 'h-11 w-auto')}
      onClick={() => {
        platform.haptic('light')
        setNotifyLevel(channel.id, following ? null : 'all')
      }}
    >
      {following ? <BellRing className="text-feature-event-text" /> : <Bell />}
      {following ? 'Following' : 'Follow'}
    </Button>
  )
}

const useNotifyGuild = (d: DialogOf<'notifySettings'>): Guild | undefined =>
  useGuildStore((s) => s.guilds.get(d.guildId))

/** "Notification settings" of the guild menu (B4): the guild level and the guild mute. */
export function NotifySettingsDialog(): React.JSX.Element {
  const { subject: guild, open, close } = useDialogSubject('notifySettings', useNotifyGuild)
  const prefs = useNotifyPrefs()
  const setNotifyLevel = usePrefsStore((s) => s.setNotifyLevel)
  const setMuted = usePrefsStore((s) => s.setMuted)
  const guildId = guild?.id ?? ''
  const level = guildNotifyLevel(prefs, guildId)
  const muted = prefs.muted.includes(guildId)
  const mobile = useLayout() === 'mobile'

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title="Notification settings"
      description={
        guild ? `For every channel of ${guild.name} without its own setting.` : undefined
      }
      icon={<Bell />}
    >
      <div role="radiogroup" aria-label="Notify me about" className="grid gap-2">
        {NOTIFY_LEVELS.map((l) => (
          <RadioCard
            key={l.value}
            name="guild-notify-level"
            value={l.value}
            checked={level === l.value}
            onChange={() => setNotifyLevel(guildId, l.value)}
            icon={LEVEL_ICON[l.value]}
            title={l.label}
            description={l.hint}
            size={mobile ? 'mobile' : 'default'}
          />
        ))}
      </div>
      <label className="flex items-center gap-3 pt-1">
        <span className="grid flex-1">
          <span className="text-label text-text-primary">Mute guild</span>
          <span className="text-meta text-text-secondary">
            No unread marks and no sounds, except mentions.
          </span>
        </span>
        <Switch
          size={mobile ? 'touch' : 'default'}
          checked={muted}
          onCheckedChange={(c) => setMuted(guildId, c)}
        />
      </label>
    </ModalWindow>
  )
}
