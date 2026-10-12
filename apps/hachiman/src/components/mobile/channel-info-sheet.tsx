import { useState } from 'react'
import { CornerUpLeft, MessagesSquare, Pin, PinOff, Settings } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetItem,
  MenuSheetSeparator,
  MenuSheetTrigger
} from '@/components/mobile/menu-sheet'
import { hasTitleChip } from '@/components/chat/channel-states'
import { NotifySheetRows } from '@/components/notify/notify-menu'
import { HeaderChannelIcon } from '@/components/shell/channel-pane'
import { canHoldThreads } from '@/components/threads/thread-name'
import { ThreadsSheet } from '@/components/threads/threads-button'
import { usePermissions } from '@/hooks/use-hachiman'
import { useChannelAccess } from '@/lib/channel-access'
import { channelLabel } from '@/lib/model'
import { openChannelView } from '@/lib/navigation'
import { useChannelStore } from '@/stores/channelStore'
import { openSettings } from '@/stores/navStore'
import { usePlatform } from '@/shared/PlatformContext'
import { pinTab, unpinTab, useIsPinned, type TabTarget } from '@/stores/tabsStore'

/**
 * The channel sheet of the mobile header (A2): a tap on the title stack opens it. It holds what
 * the desktop header shows as the bell and the gear: the notify level and the mute (N9), Pin to
 * tabs, the parent of a thread, Threads where the header leaves its button out for a title chip
 * (M62, M63), and Channel settings (pushes M48). `children` is the trigger.
 */
export function ChannelInfoSheet({
  channel,
  children
}: {
  channel: Channel
  children: React.ReactNode
}): React.JSX.Element {
  const label = channelLabel(channel)
  const [threads, setThreads] = useState(false)
  return (
    <>
      <MenuSheet>
        <MenuSheetTrigger asChild>{children}</MenuSheetTrigger>
        <MenuSheetContent title={`${label.sigil}${label.name}`}>
          <InfoHead channel={channel} />
          {channel.type !== 'voice' && channel.type !== 'category' && (
            <NotifySheetRows channel={channel} />
          )}
          <MenuSheetSeparator />
          <ChannelRows channel={channel} onThreads={() => setThreads(true)} />
        </MenuSheetContent>
      </MenuSheet>
      <ThreadsSheet channel={channel} open={threads} onOpenChange={setThreads} />
    </>
  )
}

/** The name and the whole topic, which the header cuts to one line. */
function InfoHead({ channel }: { channel: Channel }): React.JSX.Element {
  const label = channelLabel(channel)
  const { readOnly } = useChannelAccess(channel)
  return (
    <div className="flex flex-col gap-1 px-1 pt-1">
      <p className="text-text-primary flex min-w-0 items-center gap-1.5 text-[18px] leading-[22px] font-extrabold">
        <HeaderChannelIcon channel={channel} readOnly={readOnly} className="size-[18px]" />
        <span className="truncate">{label.name}</span>
      </p>
      {channel.topic && (
        <p className="text-text-tertiary text-[13px] leading-[18px] font-medium break-words">
          {channel.topic}
        </p>
      )}
    </div>
  )
}

/** Pin to tabs, the parent of a thread, Threads, and Channel settings for a manager. */
function ChannelRows({
  channel,
  onThreads
}: {
  channel: Channel
  onThreads: () => void
}): React.JSX.Element {
  const platform = usePlatform()
  const access = useChannelAccess(channel)
  const threadsRow = canHoldThreads(channel) && hasTitleChip(access)
  const isDm = channel.guildId === null
  const target: TabTarget = {
    kind: isDm ? 'dm' : 'channel',
    id: channel.id,
    guildId: channel.guildId
  }
  const pinned = useIsPinned(target)
  const perms = usePermissions(channel.guildId, channel.id)
  // A thread has no settings page of its own: only its name changes (N12).
  const canManage = !isDm && channel.type !== 'thread' && has(perms, Permissions.MANAGE_CHANNELS)
  const parent = useChannelStore((s) =>
    channel.type === 'thread' && channel.parentId ? s.channels.get(channel.parentId) : undefined
  )
  return (
    <>
      <MenuSheetItem
        onSelect={() => {
          platform.haptic('light')
          if (pinned) unpinTab(target)
          else pinTab(target)
        }}
      >
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? 'Unpin from tabs' : 'Pin to tabs'}
      </MenuSheetItem>
      {parent && (
        <MenuSheetItem onSelect={() => openChannelView(parent)}>
          <CornerUpLeft />
          Open #{parent.name}
        </MenuSheetItem>
      )}
      {threadsRow && (
        <MenuSheetItem onSelect={onThreads}>
          <MessagesSquare />
          Threads
        </MenuSheetItem>
      )}
      {canManage && (
        <MenuSheetItem onSelect={() => openSettings({ kind: 'channel', channelId: channel.id })}>
          <Settings />
          Channel settings
        </MenuSheetItem>
      )}
    </>
  )
}
