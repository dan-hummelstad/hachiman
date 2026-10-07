import { useMemo } from 'react'
import {
  HeadphoneOff,
  Lock,
  Megaphone,
  MicOff,
  PhoneCall,
  Settings,
  Trash2,
  UserPlus
} from 'lucide-react'
import { Permissions, has, type Channel, type VoiceState } from '@hachiman/client'
import { PinToTabsMenuItem } from '@/components/shell/tab-bar'
import { UserAvatar } from '@/components/shell/user-avatar'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/icon-button'
import { sidebarRowClass } from '@/components/sidebar/sidebar-row'
import { SystemTag } from '@/components/ui/system-tag'
import { UnreadMark, UnreadPip } from '@/components/ui/unread-mark'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { useElapsed } from '@/hooks/use-elapsed'
import { useChannelOccupants, usePermissions } from '@/hooks/use-hachiman'
import { useSpeakingMember } from '@/hooks/use-member'
import { useSortableRow } from '@/hooks/use-sortable-row'
import { callStartedAt } from '@/lib/call-timer'
import { useChannelAccess } from '@/lib/channel-access'
import { ChannelIcon } from '@/lib/channel-icon'
import { isMuted } from '@/lib/notify'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { openDialog } from '@/stores/dialogStore'
import { openSettings, selectChannel } from '@/stores/navStore'
import { useNotifyPrefs } from '@/stores/prefsStore'
import { useChannelUnread } from '@/stores/unreadStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** Edit + delete items for a channel's or category's context menu. */
export function ChannelManageItems({
  channelId,
  noun
}: {
  channelId: string
  noun: 'channel' | 'category'
}): React.JSX.Element {
  return (
    <>
      <ContextMenuItem onSelect={() => openSettings({ kind: 'channel', channelId })}>
        <Settings /> Edit {noun}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => openDialog({ kind: 'deleteChannel', channelId })}
      >
        <Trash2 /> Delete {noun}
      </ContextMenuItem>
    </>
  )
}

export function ChannelRow({
  guildId,
  channel,
  selected,
  canManage,
  canInvite
}: {
  guildId: string
  channel: Channel
  selected: boolean
  canManage: boolean
  /** The guild's CREATE_INSTANT_INVITE, worked out once for the list. */
  canInvite: boolean
}): React.JSX.Element {
  const isVoice = channel.type === 'voice'
  const occupants = useChannelOccupants(guildId, channel.id)
  const isVoiceHere = useVoiceStore((s) => isVoice && s.channelId === channel.id)
  const canConnect = has(usePermissions(guildId, channel.id), Permissions.CONNECT)
  const { readOnly, restricted } = useChannelAccess(channel)
  const badge = useChannelUnread(channel.id)
  const muted = isMuted(useNotifyPrefs(), channel.id, guildId)
  const unread = badge.unread && !selected
  const callSince = useMemo(() => (isVoice ? callStartedAt(occupants) : null), [isVoice, occupants])
  const callElapsed = useElapsed(callSince)

  const { setNodeRef, attributes, listeners, style } = useSortableRow({
    id: channel.id,
    disabled: !canManage
  })

  const join = (): void => void voiceService.join(channel)
  const lockLabel = restricted ? 'Restricted channel' : 'Read only'
  const showActions = selected ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li ref={setNodeRef} style={style}>
          <div
            {...attributes}
            {...listeners}
            role={undefined}
            tabIndex={-1}
            className={sidebarRowClass(selected, 'group/row relative gap-1 pr-1 pl-0')}
          >
            {unread && <UnreadPip className="-left-2.5" />}
            <button
              type="button"
              onClick={() => selectChannel(channel.id)}
              onDoubleClick={isVoice ? join : undefined}
              className={cn(
                'flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left',
                isVoiceHere && !selected && 'text-feature-voice-text',
                unread && 'text-text-primary font-bold',
                muted && !selected && 'opacity-50'
              )}
              aria-current={selected ? 'page' : undefined}
              aria-label={
                readOnly
                  ? `${channel.name} (read only)`
                  : channel.type === 'text'
                    ? undefined
                    : `${channel.name} (${channel.type})`
              }
            >
              {readOnly ? (
                <Megaphone className="text-feature-event size-4 shrink-0" aria-hidden />
              ) : (
                <ChannelIcon
                  type={channel.type}
                  className={cn(
                    'size-4 shrink-0',
                    isVoice ? 'text-feature-voice' : 'text-text-tertiary'
                  )}
                  aria-hidden
                />
              )}
              <span className="truncate">{channel.name}</span>
            </button>
            <span
              className={cn(
                'items-center gap-1 pr-1',
                selected ? 'hidden' : 'flex group-hover/row:hidden group-focus-within/row:hidden'
              )}
            >
              {channel.type === 'pages' && <SystemTag kind="page" />}
              {(readOnly || restricted) && (
                <Lock aria-label={lockLabel} className="text-text-tertiary size-3.5" />
              )}
              {callElapsed && (
                <span
                  aria-label={`Call running for ${callElapsed}`}
                  className="bg-feature-voice/15 text-feature-voice-text px-1.5 py-0.5 font-mono text-[11px] leading-4 font-semibold tabular-nums"
                >
                  {callElapsed}
                </span>
              )}
              <UnreadMark badge={badge} dot={false} />
            </span>
            <span className={cn('items-center', showActions)}>
              {isVoice && canConnect && !isVoiceHere && (
                <IconButton size="sm" label="Join voice" onClick={join} className="rounded-control">
                  <PhoneCall />
                </IconButton>
              )}
              {canInvite && (
                <IconButton
                  size="sm"
                  label="Invite people"
                  onClick={() => openDialog({ kind: 'invite', guildId })}
                  className="rounded-control"
                >
                  <UserPlus />
                </IconButton>
              )}
              {canManage && (
                <IconButton
                  size="sm"
                  label="Channel settings"
                  onClick={() => openSettings({ kind: 'channel', channelId: channel.id })}
                  className="rounded-control"
                >
                  <Settings />
                </IconButton>
              )}
            </span>
          </div>
          {occupants.length > 0 && (
            <ul className={cn('flex flex-col pt-0.5 pb-1', ROLE_INK_SCOPE)}>
              {occupants.map((vs) => (
                <VoiceMemberRow key={vs.userId} guildId={guildId} state={vs} />
              ))}
            </ul>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PinToTabsMenuItem view={{ kind: 'channel', guildId, channelId: channel.id }} />
        {canManage && <ContextMenuSeparator />}
        {canManage && <ChannelManageItems channelId={channel.id} noun="channel" />}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** A voice participant: 26 high, indent 34, with the LIVE tag and the mute and deafen marks. */
function VoiceMemberRow({
  guildId,
  state
}: {
  guildId: string
  state: VoiceState
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, state.userId)
  return (
    <li>
      <UserProfilePopover userId={state.userId} guildId={guildId}>
        <button
          type="button"
          className={cn(
            'hover:bg-surface-hover rounded-control flex h-[26px] w-full items-center gap-2 pr-2 pl-[34px] text-left text-[14px]',
            speaking ? 'text-text-primary font-semibold' : 'text-text-secondary'
          )}
        >
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={20}
            speaking={speaking}
          />
          <span className="flex-1 truncate" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
          {state.selfStream && <SystemTag kind="live" />}
          {state.selfMute && (
            <MicOff aria-label="Muted" className="text-feature-danger size-3.5 shrink-0" />
          )}
          {state.selfDeaf && (
            <HeadphoneOff aria-label="Deafened" className="text-feature-danger size-3.5 shrink-0" />
          )}
        </button>
      </UserProfilePopover>
    </li>
  )
}
