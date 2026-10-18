import {
  ChevronRight,
  FileText,
  Lock,
  MessagesSquare,
  UserRound,
  Users,
  Volume2
} from 'lucide-react'
import type { Channel, Role, User } from '@hachiman/client'
import { chipRoles, hasTitleChip } from '@/components/chat/channel-states'
import { ChannelInfoSheet } from '@/components/mobile/channel-info-sheet'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { AddPeopleButton } from '@/components/people/add-people-button'
import { GroupSettingsButton } from '@/components/people/group-dm-settings'
import { TrustButton } from '@/components/people/trust-chip'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { VoiceActivityLine } from '@/components/people/voice-activity-line'
import { PinsButton } from '@/components/pins/pins-button'
import { HeaderChannelIcon, HeaderChip } from '@/components/shell/channel-pane'
import { UserAvatar } from '@/components/shell/user-avatar'
import { canHoldThreads } from '@/components/threads/thread-name'
import { ThreadsButton } from '@/components/threads/threads-button'
import { DmCallButton } from '@/components/voice/dm-call'
import { VoiceHeaderExtras, VoiceHeaderMeta } from '@/components/voice/voice-header'
import { usePresence } from '@/hooks/use-member'
import { joinNames, useChannelAccess, type ChannelAccess } from '@/lib/channel-access'
import { channelLabel, isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'

/** What the right drawer shows: the member list, the pages of a pages channel, a DM's profile. */
export type MobileSide = 'members' | 'pages' | 'profile'

const SIDE_ICON: Record<MobileSide, React.ReactNode> = {
  members: <Users />,
  pages: <FileText />,
  profile: <UserRound />
}

/** The 36 icon buttons of the header: icon 19 in the secondary text colour. */
const HEADER_BUTTON = cn(KIT_ICON_BUTTON, 'text-text-secondary active:bg-surface-hover')

/**
 * The title stack: a button over the full width that is left, which opens the channel sheet. At
 * least 44 high, so one line (no topic) is still a full touch target, centred in the header.
 */
const STACK = cn(
  'rounded-control flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center gap-0.5 py-1 pr-1 text-left',
  'active:bg-surface-hover focus-visible:outline-line-focus outline-none focus-visible:outline-2'
)

/** Line 1: name 17/800. */
const NAME = 'text-text-primary truncate text-[17px] leading-[22px] font-extrabold'
/** Line 2: the topic, 12.5/500. */
const LINE_2 = 'text-text-tertiary w-full truncate text-[12.5px] leading-4 font-medium'

const Chevron = (): React.JSX.Element => (
  <ChevronRight className="text-text-disabled size-3.5 shrink-0" aria-hidden />
)

/**
 * The channel header on the mobile layout (M1, 56): padding 0/10/0/16, gap 6. The title stack is
 * one button that opens the channel sheet (notify level, Pin to tabs, Channel settings), so the
 * bell and the gear of the desktop header are not here. Then, by channel kind:
 *
 * - text and pages: the Threads and Pins chips (lists as sheets), the right drawer toggle. A chip
 *   in the title row (read only M62, restricted M63) needs the room, so Threads is left out there.
 * - voice: the Volume2 icon, "n in call" as line 2, "Verify call" in the own call, the toggle
 * - DM (M7, M57, padding 0/10/0/14, gap 8): the avatar (32), the name over the voice activity,
 *   the trust button, Call and the profile toggle. Poke, Pins and Notify are in the profile
 *   drawer. A group DM's drawer holds its members, so its Pins stay here, with the group
 *   settings.
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
        'border-line-hairline flex h-14 shrink-0 items-center gap-1.5 border-b pr-2.5 pl-4',
        isDm && 'gap-2 pl-3.5'
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
          <Volume2 className="text-feature-voice-text size-5 shrink-0" aria-hidden />
          <h1 className="flex min-w-0 flex-1">
            <ChannelInfoSheet channel={channel}>
              <button type="button" className={cn(STACK, 'pl-1')}>
                <span className="flex max-w-full min-w-0 items-center gap-[5px]">
                  <span className={NAME}>{channelLabel(channel).name}</span>
                  <Chevron />
                </span>
                <span className={cn(LINE_2, '[&>span]:text-[12.5px]')}>
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
      {isDm && <AddPeopleButton channel={channel} className={HEADER_BUTTON} />}
      {isDm && <GroupSettingsButton channel={channel} className={HEADER_BUTTON} />}
      {voice && <VoiceHeaderExtras channel={voice} />}
      {canHoldThreads(channel) && !hasTitleChip(access) && <ThreadsButton channel={channel} />}
      {hasMessages && !solo && <PinsButton channel={channel} />}
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
 * A DM: the avatar (32) or the group icon, the name (17/800) and, in a 1:1 DM, the voice activity
 * of the other person as line 2 (12.5/700).
 */
function DmLines({ channel }: { channel: Channel }): React.JSX.Element {
  const solo = soloOf(channel)
  const status = usePresence(solo?.id)
  const name = channelLabel(channel).name
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
        <span className={cn(NAME, 'max-w-full')}>{name}</span>
        {solo && <DmVoiceLine userId={solo.id} />}
      </span>
    </>
  )
}

/** Where the other person of a 1:1 DM is in voice, when the viewer can see it (M7). */
function DmVoiceLine({ userId }: { userId: string }): React.JSX.Element | null {
  const activity = useVoiceActivity(userId, null)
  if (!activity) return null
  return (
    <VoiceActivityLine
      activity={activity}
      className="text-feature-voice-text max-w-full text-[12.5px] leading-4 font-bold [&_svg]:size-3"
    />
  )
}

/**
 * Line 1: the type icon (18), the name, the chip and the chevron. Line 2: the topic. The chip is
 * "Read only" (M62) or, for a restricted channel, the roles that can see it (M63).
 */
function ChannelLines({
  channel,
  access
}: {
  channel: Channel
  access: ChannelAccess
}): React.JSX.Element {
  return (
    <>
      <span className="flex max-w-full min-w-0 items-center gap-[5px]">
        <HeaderChannelIcon channel={channel} readOnly={access.readOnly} className="size-[18px]" />
        <span className={NAME}>{channelLabel(channel).name}</span>
        {access.readOnly && (
          <HeaderChip>
            <Lock className="text-text-tertiary" aria-hidden />
            Read only
          </HeaderChip>
        )}
        {access.restricted && access.viewers.length > 0 && (
          <RestrictedChip roles={access.viewers} />
        )}
        <Chevron />
      </span>
      {channel.topic && <span className={LINE_2}>{channel.topic}</span>}
    </>
  )
}

/**
 * The restricted chip (M63): the lock and two role names in the accent, then "+n". It shrinks
 * before it pushes the chevron out on a 375 wide phone. A screen reader hears every role.
 */
function RestrictedChip({ roles }: { roles: Role[] }): React.JSX.Element {
  const { shown, more } = chipRoles(roles)
  return (
    <span className="bg-surface-hover text-accent-text inline-flex h-[22px] min-w-0 items-center gap-1 px-[7px] text-[11.5px] leading-none font-extrabold">
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
  return (
    <>
      <span className="flex max-w-full min-w-0 items-center gap-[5px]">
        <MessagesSquare className="text-feature-thread-text size-[18px] shrink-0" aria-hidden />
        <span className={NAME}>{thread.name}</span>
        <Chevron />
      </span>
      {parent && <span className={LINE_2}>Thread in #{parent.name}</span>}
    </>
  )
}
