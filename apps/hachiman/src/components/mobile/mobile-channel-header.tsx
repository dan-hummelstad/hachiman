import { FileText, Lock, MessagesSquare, UserRound, Users, Volume2 } from 'lucide-react'
import type { Channel, PresenceStatus, Role, User } from '@hachiman/client'
import { chipRoles, hasTitleChip } from '@/components/chat/channel-states'
import { ChannelInfoSheet } from '@/components/mobile/channel-info-sheet'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { AddPeopleButton } from '@/components/people/add-people-button'
import { TrustButton } from '@/components/people/trust-chip'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { VoiceActivityLine } from '@/components/people/voice-activity-line'
import { PinsButton } from '@/components/pins/pins-button'
import { HeaderChip } from '@/components/shell/channel-pane'
import { UserAvatar } from '@/components/shell/user-avatar'
import { PRESENCE_LABEL } from '@/components/ui/presence'
import { canHoldThreads } from '@/components/threads/thread-name'
import { ThreadsButton } from '@/components/threads/threads-button'
import { DmCallButton } from '@/components/voice/dm-call'
import { CallClock, VoiceHeaderExtras, VoiceHeaderMeta } from '@/components/voice/voice-header'
import { usePresence } from '@/hooks/use-member'
import { joinNames, useChannelAccess, type ChannelAccess } from '@/lib/channel-access'
import { channelLabel, isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** What the right drawer shows: the member list, the pages of a pages channel, a DM's profile. */
export type MobileSide = 'members' | 'pages' | 'profile'

const SIDE_ICON: Record<MobileSide, React.ReactNode> = {
  members: <Users />,
  pages: <FileText />,
  profile: <UserRound />
}

/** The 36 icon buttons of the header: icon 17 in the tertiary text colour. */
const HEADER_BUTTON = cn(
  KIT_ICON_BUTTON,
  'text-text-tertiary active:bg-surface-hover [&_svg]:size-[17px]'
)

/**
 * The title stack: a button over the full width that is left, which opens the channel sheet. At
 * least 44 high, so one line (no topic) is still a full touch target, centred in the header.
 */
const STACK = cn(
  'rounded-control flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center gap-0.5 py-1 pr-1 text-left',
  'active:bg-surface-hover focus-visible:outline-line-focus outline-none focus-visible:outline-2'
)

/** Line 1: name 14.5/600. */
const NAME =
  'text-text-primary truncate text-[14.5px] leading-[18px] font-semibold tracking-[-0.2px]'
/** Line 2: a mono cap line. */
const LINE_2 = 'cap-sm w-full truncate text-[7.5px] tracking-[1px]'

/**
 * The channel header on the mobile layout (A1, 46): a `here` square, the name and a cap line. The title stack is
 * one button that opens the channel sheet (notify level, Pin to tabs, Channel settings), so the
 * bell and the gear of the desktop header are not here. Then, by channel kind:
 *
 * - text and pages: the Threads and Pins chips (lists as sheets), the right drawer toggle. A chip
 *   in the title row (read only M62, restricted M63) needs the room, so Threads is left out there.
 * - voice: the Volume2 icon, "n in call" as line 2, "Verify call" in the own call, the toggle
 * - DM (M7, M57, padding 0/10/0/14, gap 8): the avatar (32), the name over the voice activity,
 *   the trust button, Call and the profile toggle. Poke, Pins and Notify are in the profile
 *   drawer. A group DM keeps Call and the members toggle; Add people, Group settings, Pins and
 *   Notify are in its members drawer.
 */
export function MobileChannelHeader({
  channel,
  side,
  onToggleSide
}: {
  channel: Channel
  side: MobileSide
  /** Opens the right drawer. Omitted when it has nothing to show (a DM with no recipient). */
  onToggleSide?: () => void
}): React.JSX.Element {
  const isDm = channel.guildId === null
  const solo = isDm ? soloOf(channel) : undefined
  const voice = channel.type === 'voice' && isGuildChannel(channel) ? channel : null
  const hasMessages = channel.type !== 'voice' && channel.type !== 'category'
  const access = useChannelAccess(channel)

  return (
    <header
      className={cn(
        'border-line-hairline bg-surface-content flex h-[46px] shrink-0 items-center gap-[9px] border-b px-3.5',
        isDm && 'h-[52px] gap-2.5'
      )}
    >
      {isDm ? (
        <h1 className="flex min-w-0 flex-1">
          <ChannelInfoSheet channel={channel}>
            <button
              type="button"
              className={cn(STACK, 'flex-row items-center justify-start gap-2')}
            >
              <DmLines channel={channel} />
            </button>
          </ChannelInfoSheet>
        </h1>
      ) : voice ? (
        <>
          <Volume2 className="text-live-text size-5 shrink-0" aria-hidden />
          <h1 className="flex min-w-0 flex-1">
            <ChannelInfoSheet channel={channel}>
              <button type="button" className={cn(STACK, 'pl-1')}>
                <span className="flex max-w-full min-w-0 items-center gap-[5px]">
                  <span className={NAME}>{channelLabel(channel).name}</span>
                </span>
                <span className={cn(LINE_2, 'text-live-text [&>span]:font-medium')}>
                  <VoiceHeaderMeta channel={voice} />
                </span>
              </button>
            </ChannelInfoSheet>
          </h1>
        </>
      ) : (
        <h1 className="flex min-w-0 flex-1">
          <ChannelInfoSheet channel={channel}>
            <button type="button" className={STACK}>
              {channel.type === 'thread' ? (
                <ThreadLines thread={channel} />
              ) : (
                <ChannelLines channel={channel} access={access} />
              )}
            </button>
          </ChannelInfoSheet>
        </h1>
      )}
      {solo && <TrustButton userId={solo.id} name={channelLabel(channel).name} />}
      {isDm && <DmCallButton channel={channel} className={HEADER_BUTTON} />}
      {channel.type === 'dm' && <AddPeopleButton channel={channel} className={HEADER_BUTTON} />}
      {voice && <VoiceHeaderExtras channel={voice} />}
      {canHoldThreads(channel) && !hasTitleChip(access) && <ThreadsButton channel={channel} />}
      {hasMessages && !isDm && <PinsButton channel={channel} />}
      {onToggleSide && (
        <button
          type="button"
          aria-label={`Show ${side}`}
          onClick={onToggleSide}
          className={HEADER_BUTTON}
        >
          {SIDE_ICON[side]}
        </button>
      )}
    </header>
  )
}

/** The other person of a 1:1 DM. */
const soloOf = (channel: Channel): User | undefined => {
  const recipients = channel.recipients ?? []
  return recipients.length === 1 ? recipients[0] : undefined
}

/**
 * A DM: the avatar (32) or the group icon, the name (15/600) and, in a 1:1 DM, the presence (and the
 * voice activity) of the other person as line 2.
 */
function DmLines({ channel }: { channel: Channel }): React.JSX.Element {
  const solo = soloOf(channel)
  const status = usePresence(solo?.id)
  const name = channelLabel(channel).name
  const inCall = useVoiceStore((s) => s.channelId === channel.id)
  return (
    <>
      {solo ? (
        <span aria-hidden className="flex shrink-0">
          <UserAvatar
            name={name}
            avatar={solo.avatar}
            size={32}
            status={status}
            cutout="bg-surface-content"
          />
        </span>
      ) : (
        <span className="bg-surface-raised flex size-8 shrink-0 items-center justify-center rounded-full">
          <Users className="text-text-tertiary size-[18px]" aria-hidden />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col items-start gap-px">
        <span className={cn(NAME, 'max-w-full text-[15px]')}>{name}</span>
        {solo && <DmLine2 userId={solo.id} status={status} />}
      </span>
      {inCall && <CallClock channelId={channel.id} />}
    </>
  )
}

/** Line 2 of a 1:1 DM: where the other person is in voice (M7), else their presence. */
function DmLine2({
  userId,
  status
}: {
  userId: string
  status: PresenceStatus
}): React.JSX.Element {
  const activity = useVoiceActivity(userId, null)
  if (activity)
    return (
      <VoiceActivityLine
        activity={activity}
        className="max-w-full font-mono text-[8px] leading-4 tracking-[0.8px] uppercase [&_svg]:size-3"
      />
    )
  return <span className={LINE_2}>{PRESENCE_LABEL[status]}</span>
}

/**
 * Line 1: the `here` square, the name and the chip. Line 2: the guild and its member count. The chip is
 * "Read only" (M62) or, for a restricted channel, the roles that can see it (M63).
 */
function ChannelLines({
  channel,
  access
}: {
  channel: Channel
  access: ChannelAccess
}): React.JSX.Element {
  const { name, sigil } = channelLabel(channel)
  const guildName = useGuildStore((s) =>
    channel.guildId ? s.guilds.get(channel.guildId)?.name : undefined
  )
  const memberCount = useGuildStore((s) =>
    channel.guildId ? s.members.get(channel.guildId)?.size : undefined
  )
  return (
    <>
      <span className="flex max-w-full min-w-0 items-center gap-[5px]">
        <span aria-hidden className="bg-here size-2 shrink-0" />
        <span className={NAME}>
          {sigil} {name}
        </span>
        {access.readOnly && (
          <HeaderChip>
            <Lock className="text-text-tertiary" aria-hidden />
            Read only
          </HeaderChip>
        )}
        {access.restricted && access.viewers.length > 0 && (
          <RestrictedChip roles={access.viewers} />
        )}
      </span>
      {guildName !== undefined && memberCount !== undefined ? (
        <span className={LINE_2}>
          {guildName} · {memberCount} members
        </span>
      ) : (
        channel.topic && <span className={LINE_2}>{channel.topic}</span>
      )}
    </>
  )
}

/**
 * The restricted chip (M63): the lock and two role names, then "+n". It shrinks
 * on a 375 wide phone. A screen reader hears every role.
 */
function RestrictedChip({ roles }: { roles: Role[] }): React.JSX.Element {
  const { shown, more } = chipRoles(roles)
  return (
    <span className="rounded-badge bg-surface-raised text-text-secondary inline-flex h-[22px] min-w-0 items-center gap-1 px-[7px] font-mono text-[9px] leading-none tracking-[0.8px] uppercase">
      <Lock className="size-3 shrink-0" aria-hidden />
      <span aria-hidden className="truncate">
        {shown.map((r) => r.name).join(' · ')}
      </span>
      {more > 0 && (
        <span aria-hidden className="shrink-0">
          +{more}
        </span>
      )}
      <span className="sr-only">, only {joinNames(roles.map((r) => r.name))} can see it</span>
    </span>
  )
}

/** A thread: its name, and its parent channel as line 2 (the sheet opens the parent). */
function ThreadLines({ thread }: { thread: Channel }): React.JSX.Element {
  const parent = useChannelStore((s) =>
    thread.parentId ? s.channels.get(thread.parentId) : undefined
  )
  const guildName = useGuildStore((s) =>
    thread.guildId ? s.guilds.get(thread.guildId)?.name : undefined
  )
  return (
    <>
      <span className="flex max-w-full min-w-0 items-center gap-[5px]">
        <MessagesSquare className="text-text-tertiary size-[18px] shrink-0" aria-hidden />
        <span className={NAME}>{thread.name}</span>
      </span>
      {parent && (
        <span className={LINE_2}>
          # {parent.name}
          {guildName && ` · ${guildName}`}
        </span>
      )}
    </>
  )
}
