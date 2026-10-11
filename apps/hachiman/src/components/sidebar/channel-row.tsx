import { useMemo } from 'react'
import {
  ArrowDown,
  ArrowUp,
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
import { closeDrawer } from '@/components/mobile/drawer-state'
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
import { CHANNEL_ROW_TOUCH, sidebarRowClass } from '@/components/sidebar/sidebar-row'
import { SystemTag } from '@/components/ui/system-tag'
import { UnreadMark, UnreadPip } from '@/components/ui/unread-mark'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { ServerMark } from '@/components/voice/voice-state-badges'
import { useElapsed } from '@/hooks/use-elapsed'
import { useChannelOccupants, usePermissions } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { useSpeakingMember } from '@/hooks/use-member'
import { SORTABLE_TOUCH, useSortableHoldMenu, useSortableRow } from '@/hooks/use-sortable-row'
import { callStartedAt } from '@/lib/call-timer'
import { useChannelAccess } from '@/lib/channel-access'
import { ChannelIcon } from '@/lib/channel-icon'
import { isMuted } from '@/lib/notify'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { openDialog } from '@/stores/dialogStore'
import { navigate, openSettings, selectChannel } from '@/stores/navStore'
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

/** A 36 touch target with a 16 icon for the row actions on the mobile layout (M3). */
const ACTION_TOUCH = "mobile:size-9 mobile:[&_svg:not([class*='size-'])]:size-4"

/**
 * A channel in the sidebar: drag to reorder (with MANAGE_CHANNELS), right-click or hold for its
 * menu. On the mobile layout (M3, M36) the row is 38 high, only the selected row shows its
 * actions, and a pages channel has the violet icon and the PAGE tag. A tap there opens the
 * channel on its chat (a pages channel too, not its open page) and closes the drawer. There a
 * manager's hold menu also has Move up and Move down: the button path of the drag.
 */
export function ChannelRow({
  guildId,
  channel,
  selected,
  canManage,
  canInvite,
  onMoveUp,
  onMoveDown
}: {
  guildId: string
  channel: Channel
  selected: boolean
  canManage: boolean
  /** The guild's CREATE_INSTANT_INVITE, worked out once for the list. */
  canInvite: boolean
  /** Undefined at the start (or the end) of the group. */
  onMoveUp?: () => void
  onMoveDown?: () => void
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const isVoice = channel.type === 'voice'
  // The PAGE mark is mobile only for now (spec §6.1, decision 3).
  const pageMark = mobile && channel.type === 'pages'
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
  const menu = useSortableHoldMenu(channel.id, { sortable: canManage })

  const join = (): void => void voiceService.join(channel)
  const open = (): void => {
    if (!mobile) return selectChannel(channel.id)
    navigate({ kind: 'channel', guildId, channelId: channel.id })
    // A tap on the open channel changes no view, and the close rule does not run.
    closeDrawer()
  }
  const lockLabel = restricted ? 'Restricted channel' : 'Read only'
  // Touch has no hover: there only the selected row shows its actions.
  const showActions = selected
    ? 'flex'
    : mobile
      ? 'hidden'
      : 'hidden group-hover/row:flex group-focus-within/row:flex'
  const showStatus = selected
    ? 'hidden'
    : mobile
      ? 'flex'
      : 'flex group-hover/row:hidden group-focus-within/row:hidden'

  return (
    <ContextMenu open={menu.open} onOpenChange={menu.onOpenChange}>
      <ContextMenuTrigger asChild longPress={menu.longPress}>
        <li ref={setNodeRef} style={style}>
          <div
            {...attributes}
            {...listeners}
            role={undefined}
            tabIndex={-1}
            className={sidebarRowClass(
              selected,
              cn('group/row relative gap-1 pr-1 pl-0', CHANNEL_ROW_TOUCH, SORTABLE_TOUCH)
            )}
          >
            {unread && <UnreadPip className="-left-2.5" />}
            <button
              type="button"
              onClick={open}
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
                <Megaphone
                  className="text-feature-event mobile:size-[18px] size-4 shrink-0"
                  aria-hidden
                />
              ) : (
                <ChannelIcon
                  type={channel.type}
                  className={cn(
                    'mobile:size-[18px] size-4 shrink-0',
                    isVoice
                      ? 'text-feature-voice'
                      : pageMark
                        ? 'text-feature-page-text'
                        : 'text-text-tertiary'
                  )}
                  aria-hidden
                />
              )}
              <span className="truncate">{channel.name}</span>
              {/* The button's label names the type, so the tag text stays out of it. */}
              {pageMark && <SystemTag kind="page" className="ml-auto" />}
            </button>
            <span className={cn('items-center gap-1 pr-1', showStatus)}>
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
                <IconButton
                  size="sm"
                  label="Join voice"
                  onClick={join}
                  className={cn('rounded-control', ACTION_TOUCH)}
                >
                  <PhoneCall />
                </IconButton>
              )}
              {canInvite && (
                <IconButton
                  size="sm"
                  label="Invite people"
                  onClick={() => openDialog({ kind: 'invite', guildId })}
                  className={cn('rounded-control', ACTION_TOUCH)}
                >
                  <UserPlus />
                </IconButton>
              )}
              {canManage && (
                <IconButton
                  size="sm"
                  label="Channel settings"
                  onClick={() => openSettings({ kind: 'channel', channelId: channel.id })}
                  className={cn('rounded-control', ACTION_TOUCH)}
                >
                  <Settings />
                </IconButton>
              )}
            </span>
          </div>
          {occupants.length > 0 && (
            <ul className={cn('flex flex-col pt-0.5 pb-1', ROLE_INK_SCOPE)}>
              {occupants.map((vs) => (
                <VoiceMemberRow key={vs.userId} guildId={guildId} state={vs} mobile={mobile} />
              ))}
            </ul>
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={(mobile && channel.name) || undefined}>
        {mobile && canManage && (
          <>
            <ContextMenuItem disabled={!onMoveUp} onSelect={onMoveUp}>
              <ArrowUp /> Move up
            </ContextMenuItem>
            <ContextMenuItem disabled={!onMoveDown} onSelect={onMoveDown}>
              <ArrowDown /> Move down
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <PinToTabsMenuItem view={{ kind: 'channel', guildId, channelId: channel.id }} />
        {canManage && <ContextMenuSeparator />}
        {canManage && <ChannelManageItems channelId={channel.id} noun="channel" />}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * A voice participant: 26 high (36 with a 22 avatar on the mobile layout), indent 34, with the
 * LIVE tag and the mute and deafen marks.
 */
function VoiceMemberRow({
  guildId,
  state,
  mobile
}: {
  guildId: string
  state: VoiceState
  mobile: boolean
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, state.userId)
  return (
    <li>
      <UserProfilePopover userId={state.userId} guildId={guildId}>
        <button
          type="button"
          className={cn(
            'hover:bg-surface-hover rounded-control mobile:h-9 flex h-[26px] w-full items-center gap-2 pr-2 pl-[34px] text-left text-[14px]',
            speaking ? 'text-text-primary font-semibold' : 'text-text-secondary'
          )}
        >
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={mobile ? 22 : 20}
            speaking={speaking}
          />
          <span className="flex-1 truncate" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
          {state.selfStream && <SystemTag kind="live" />}
          {state.mute ? (
            <ServerMark label="Server muted" icon={<MicOff />} />
          ) : (
            state.selfMute && (
              <MicOff aria-label="Muted" className="text-feature-danger size-3.5 shrink-0" />
            )
          )}
          {state.deaf ? (
            <ServerMark label="Server deafened" icon={<HeadphoneOff />} />
          ) : (
            state.selfDeaf && (
              <HeadphoneOff
                aria-label="Deafened"
                className="text-feature-danger size-3.5 shrink-0"
              />
            )
          )}
        </button>
      </UserProfilePopover>
    </li>
  )
}
