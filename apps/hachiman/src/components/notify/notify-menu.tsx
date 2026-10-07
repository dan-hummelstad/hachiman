import { useState } from 'react'
import { AtSign, Bell, BellOff, BellRing } from 'lucide-react'
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
import { IconButton } from '@/components/ui/icon-button'
import { ModalWindow } from '@/components/ui/modal-window'
import { RadioCard } from '@/components/ui/radio-card'
import { Switch } from '@/components/ui/switch'
import { useDialogSubject } from '@/hooks/use-dialog-subject'
import { isMuted, notifyLevel, type NotifyLevel } from '@/lib/notify'
import type { DialogOf } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { useNotifyPrefs, usePrefsStore } from '@/stores/prefsStore'
import type { Guild } from '@hachiman/client'

/** The three levels of N9, in menu order. */
const NOTIFY_LEVELS: readonly { value: NotifyLevel; label: string; hint: string }[] = [
  { value: 'all', label: 'All messages', hint: 'Every new message counts and pings' },
  { value: 'mentions', label: 'Mentions only', hint: 'Only messages that mention you' },
  { value: 'none', label: 'Nothing', hint: 'No pings and no unread marks' }
]

const LEVEL_ICON: Record<NotifyLevel, React.ReactNode> = {
  all: <BellRing />,
  mentions: <AtSign />,
  none: <BellOff />
}

/** The bell of the channel header (N9): the level of this channel and its mute. */
export function NotifyButton({ channel }: { channel: Channel }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const prefs = useNotifyPrefs()
  const setNotifyLevel = usePrefsStore((s) => s.setNotifyLevel)
  const setMuted = usePrefsStore((s) => s.setMuted)
  const level = notifyLevel(prefs, channel.id, channel.guildId)
  const own = prefs.notify[channel.id] !== undefined
  const muted = isMuted(prefs, channel.id, channel.guildId)
  const mutedHere = prefs.muted.includes(channel.id)
  const silent = muted || level === 'none'

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label="Notifications"
          tooltipSide="bottom"
          pressed={open}
          className="aria-pressed:bg-accent-tint aria-pressed:text-accent-text [&_svg]:size-[18px]"
        >
          {silent ? <BellOff /> : level === 'all' ? <BellRing /> : <Bell />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Notify me about</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={level}
          onValueChange={(v) => setNotifyLevel(channel.id, v as NotifyLevel)}
        >
          {NOTIFY_LEVELS.map((l) => (
            <DropdownMenuRadioItem key={l.value} value={l.value}>
              {l.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {own && channel.guildId !== null && (
          <DropdownMenuItem onSelect={() => setNotifyLevel(channel.id, null)}>
            Use the guild setting
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={mutedHere}
          disabled={muted && !mutedHere}
          onCheckedChange={(c) => setMuted(channel.id, c === true)}
        >
          {muted && !mutedHere ? 'Guild is muted' : 'Mute channel'}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * "Follow" in the read-only notice (B7): sets the channel to all messages. While followed it
 * shows "Following"; a click there goes back to the guild setting.
 */
export function FollowButton({ channel }: { channel: Channel }): React.JSX.Element {
  const prefs = useNotifyPrefs()
  const setNotifyLevel = usePrefsStore((s) => s.setNotifyLevel)
  const following = notifyLevel(prefs, channel.id, channel.guildId) === 'all'
  return (
    <Button
      variant="secondary"
      aria-pressed={following}
      className="shrink-0"
      onClick={() => setNotifyLevel(channel.id, following ? null : 'all')}
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
  const level = prefs.notify[guildId] ?? 'mentions'
  const muted = prefs.muted.includes(guildId)

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
        <Switch checked={muted} onCheckedChange={(c) => setMuted(guildId, c)} />
      </label>
    </ModalWindow>
  )
}
