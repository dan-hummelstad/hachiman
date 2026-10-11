import { ChevronRight, FileText, MessagesSquare, User, Users, Volume2 } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { ChannelInfoSheet } from '@/components/mobile/channel-info-sheet'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { PinsButton } from '@/components/pins/pins-button'
import {
  ChannelChips,
  DmTitle,
  DmTrustChip,
  HeaderChannelIcon
} from '@/components/shell/channel-pane'
import { canHoldThreads } from '@/components/threads/thread-name'
import { ThreadsButton } from '@/components/threads/threads-button'
import { DmCallButton } from '@/components/voice/dm-call'
import { VoiceHeaderExtras, VoiceHeaderMeta } from '@/components/voice/voice-header'
import { useChannelAccess } from '@/lib/channel-access'
import { channelLabel, isGuildChannel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'

/** What the right drawer shows: the member list, the pages of a pages channel, a DM's profile. */
export type MobileSide = 'members' | 'pages' | 'profile'

const SIDE_ICON: Record<MobileSide, React.ReactNode> = {
  members: <Users />,
  pages: <FileText />,
  profile: <User />
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
 * - text and pages: the Threads and Pins chips (lists as sheets), the right drawer toggle
 * - voice: the Volume2 icon, "n in call" as line 2, "Verify call" in the own call, the toggle
 * - DM: the avatar and the name, the trust chip, Call, the profile toggle
 */
export function MobileChannelHeader({
  channel,
  side,
  onToggleSide
}: {
  channel: Channel
  side: MobileSide
  /** Opens the right drawer. Omitted when it has nothing to show (a group DM). */
  onToggleSide?: () => void
}): React.JSX.Element {
  const isDm = channel.guildId === null
  const voice = channel.type === 'voice' && isGuildChannel(channel) ? channel : null
  const hasMessages = channel.type !== 'voice' && channel.type !== 'category'

  return (
    <header className="border-line-hairline flex h-14 shrink-0 items-center gap-1.5 border-b pr-2.5 pl-4">
      {isDm ? (
        <ChannelInfoSheet channel={channel}>
          <button
            type="button"
            className={cn(STACK, 'flex-row items-center justify-start gap-2.5')}
          >
            <DmTitle channel={channel} />
          </button>
        </ChannelInfoSheet>
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
                <ChannelLines channel={channel} />
              )}
            </button>
          </ChannelInfoSheet>
        </h1>
      )}
      {isDm && <DmTrustChip channel={channel} />}
      {isDm && <DmCallButton channel={channel} className={HEADER_BUTTON} />}
      {voice && <VoiceHeaderExtras channel={voice} />}
      {canHoldThreads(channel) && <ThreadsButton channel={channel} />}
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

/** Line 1: the type icon (18), the name, the chips and the chevron. Line 2: the topic. */
function ChannelLines({ channel }: { channel: Channel }): React.JSX.Element {
  const access = useChannelAccess(channel)
  return (
    <>
      <span className="flex max-w-full min-w-0 items-center gap-[5px]">
        <HeaderChannelIcon channel={channel} readOnly={access.readOnly} className="size-[18px]" />
        <span className={NAME}>{channelLabel(channel).name}</span>
        <ChannelChips access={access} />
        <Chevron />
      </span>
      {channel.topic && <span className={LINE_2}>{channel.topic}</span>}
    </>
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
