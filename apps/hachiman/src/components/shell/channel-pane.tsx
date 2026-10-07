import {
  AudioLines,
  ChevronRight,
  FileText,
  Lock,
  Megaphone,
  MessagesSquare,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Users,
  Volume2
} from 'lucide-react'
import { Permissions, has, type Channel, type Role } from '@hachiman/client'
import { useChannelAccess } from '@/lib/channel-access'
import { useTrustBadge, type TrustBadge } from '@/components/chat/use-dm-trust'
import { NotifyButton } from '@/components/notify/notify-menu'
import { openChannelView } from '@/components/pins/jump'
import { PinsButton } from '@/components/pins/pins-button'
import { canHoldThreads } from '@/components/threads/thread-name'
import { ThreadsButton } from '@/components/threads/threads-button'
import { UserAvatar } from '@/components/shell/user-avatar'
import { IconButton } from '@/components/ui/icon-button'
import { TitleBar } from '@/components/ui/title-bar'
import { VoiceHeaderExtras, VoiceHeaderMeta } from '@/components/voice/voice-header'
import { usePermissions } from '@/hooks/use-hachiman'
import { usePresence } from '@/hooks/use-member'
import { ChannelIcon } from '@/lib/channel-icon'
import { channelLabel, hexColor, isGuildChannel } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { openDialog } from '@/stores/dialogStore'
import { useVoiceStore } from '@/stores/voiceStore'

const PANE = 'bg-surface-content flex min-h-0 min-w-0 flex-1 flex-col'
/** The pressed header toggle takes the accent tint. */
const HEADER_BUTTON =
  'aria-pressed:bg-accent-tint aria-pressed:text-accent-text [&_svg]:size-[18px]'

export interface ChannelPaneProps {
  channel: Channel
  /** The right column that the title bar toggle shows and hides. */
  side?: 'members' | 'pages'
  sideOpen: boolean
  /** Omitted in DMs (no member list). */
  onToggleSide?: () => void
  /** The body: `ChatBody` for text and pages channels and DMs, `VoiceRoom` for voice channels. */
  children: React.ReactNode
}

/**
 * Main pane frame for a channel: the 56px header (type icon, name, chips, topic; the threads,
 * pins and bell buttons of N12, N13 and N9, the side toggle and channel settings) over a body. A
 * thread shows "#parent › thread" as its title.
 */
export function ChannelPane({
  channel,
  side = 'members',
  sideOpen,
  onToggleSide,
  children
}: ChannelPaneProps): React.JSX.Element {
  const perms = usePermissions(channel.guildId, channel.id)
  const isDm = channel.guildId === null
  const canManage = !isDm && has(perms, Permissions.MANAGE_CHANNELS)
  const hasMessages = channel.type !== 'voice' && channel.type !== 'category'

  return (
    <section className={cn(PANE, ROLE_INK_SCOPE)}>
      <TitleBar
        left={isDm ? <DmTitle channel={channel} /> : <ChannelTitle channel={channel} />}
        right={
          <>
            {isDm && <DmTrustChip channel={channel} />}
            {channel.type === 'voice' && isGuildChannel(channel) && (
              <VoiceHeaderExtras channel={channel} />
            )}
            {canHoldThreads(channel) && <ThreadsButton channel={channel} />}
            {hasMessages && <PinsButton channel={channel} />}
            {hasMessages && <NotifyButton channel={channel} />}
            {onToggleSide && (
              <IconButton
                label={sideOpen ? `Hide ${side}` : `Show ${side}`}
                tooltipSide="bottom"
                pressed={sideOpen}
                onClick={onToggleSide}
                className={HEADER_BUTTON}
              >
                {side === 'pages' ? <FileText /> : <Users />}
              </IconButton>
            )}
            {canManage && (
              <IconButton
                label="Channel settings"
                tooltipSide="bottom"
                onClick={() => openDialog({ kind: 'channelSettings', channelId: channel.id })}
                className={HEADER_BUTTON}
              >
                <Settings />
              </IconButton>
            )}
          </>
        }
      />
      {children}
    </section>
  )
}

/** Main pane with nothing selected. */
export function NoChannelPane(): React.JSX.Element {
  return (
    <section className={PANE}>
      <TitleBar />
      <div className="text-text-tertiary flex flex-1 items-center justify-center text-sm">
        Pick a channel to start reading.
      </div>
    </section>
  )
}

/** The header icon of a channel: megaphone for a read-only text channel (plan decision 7). */
export function HeaderChannelIcon({
  channel,
  readOnly,
  className
}: {
  channel: Channel
  readOnly: boolean
  className?: string
}): React.JSX.Element {
  const cls = cn('size-5 shrink-0', className)
  if (readOnly) return <Megaphone className={cn(cls, 'text-feature-event-text')} aria-hidden />
  if (channel.type === 'voice')
    return <Volume2 className={cn(cls, 'text-feature-voice-text')} aria-hidden />
  if (channel.type === 'pages')
    return <FileText className={cn(cls, 'text-feature-page-text')} aria-hidden />
  return <ChannelIcon type={channel.type} className={cn(cls, 'text-text-tertiary')} aria-hidden />
}

function ChannelTitle({ channel }: { channel: Channel }): React.JSX.Element {
  const access = useChannelAccess(channel)
  if (channel.type === 'thread') return <ThreadTitle thread={channel} />
  return (
    <>
      <HeaderChannelIcon channel={channel} readOnly={access.readOnly} />
      <h1 className="text-heading text-text-primary shrink-0 truncate">
        {channelLabel(channel).name}
      </h1>
      {channel.type === 'voice' && isGuildChannel(channel) && <VoiceHeaderMeta channel={channel} />}
      {access.readOnly && (
        <HeaderChip>
          <Lock aria-hidden />
          Read only
        </HeaderChip>
      )}
      {access.restricted && access.viewers.length > 0 && (
        <HeaderChip title={`Only ${access.viewers.map((r) => r.name).join(', ')} can see it`}>
          <Lock aria-hidden />
          {access.viewers.map((r, i) => (
            <span key={r.id} className="contents">
              {i > 0 && <span aria-hidden>·</span>}
              <RoleName role={r} />
            </span>
          ))}
        </HeaderChip>
      )}
      {channel.topic && (
        <>
          <span className="bg-line-hairline mx-1 h-5 w-px shrink-0" aria-hidden />
          <span
            className="text-text-secondary min-w-0 truncate text-[13.5px] leading-5 font-medium"
            title={channel.topic}
          >
            {channel.topic}
          </span>
        </>
      )}
    </>
  )
}

/** "#parent › thread name": the parent opens on click. */
function ThreadTitle({ thread }: { thread: Channel }): React.JSX.Element {
  const parent = useChannelStore((s) =>
    thread.parentId ? s.channels.get(thread.parentId) : undefined
  )
  return (
    <>
      {parent && (
        <>
          <button
            type="button"
            onClick={() => openChannelView(parent)}
            className={cn(
              'text-text-secondary hover:text-text-primary rounded-control inline-flex min-w-0 shrink items-center gap-1 text-[15px] font-semibold',
              'focus-visible:outline-line-focus outline-none focus-visible:outline-2'
            )}
          >
            <HeaderChannelIcon channel={parent} readOnly={false} className="size-[18px]" />
            <span className="truncate">{parent.name}</span>
          </button>
          <ChevronRight className="text-text-tertiary size-4 shrink-0" aria-hidden />
        </>
      )}
      <MessagesSquare className="text-feature-thread-text size-5 shrink-0" aria-hidden />
      <h1 className="text-heading text-text-primary min-w-0 truncate">{thread.name}</h1>
    </>
  )
}

function HeaderChip({
  title,
  children
}: {
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      title={title}
      className="rounded-check bg-surface-raised text-text-secondary inline-flex h-[22px] shrink-0 items-center gap-1 px-1.5 text-[11.5px] leading-none font-bold [&_svg]:size-3"
    >
      {children}
    </span>
  )
}

function RoleName({ role }: { role: Role }): React.JSX.Element {
  return <span style={role.color ? { color: hexColor(role.color) } : undefined}>{role.name}</span>
}

function DmTitle({ channel }: { channel: Channel }): React.JSX.Element {
  const recipients = channel.recipients ?? []
  const solo = recipients.length === 1 ? recipients[0] : undefined
  const status = usePresence(solo?.id)
  const name = channelLabel(channel).name
  return (
    <>
      {solo ? (
        <UserAvatar
          name={name}
          avatar={solo.avatar}
          size={26}
          status={status}
          cutout="bg-surface-content"
        />
      ) : (
        <Users className="text-text-tertiary size-5 shrink-0" aria-hidden />
      )}
      <h1 className="text-heading text-text-primary truncate">{name}</h1>
      {solo && <VoiceActivity userId={solo.id} />}
    </>
  )
}

/** "In Lounge" / "Speaking in Lounge" from the user's voice state, when one is known. */
function VoiceActivity({ userId }: { userId: string }): React.JSX.Element | null {
  const channelId = useVoiceStore((s) => {
    for (const guild of s.voiceStates.values()) {
      const vs = guild.get(userId)
      if (vs?.channelId) return vs.channelId
    }
    return null
  })
  const speaking = useVoiceStore((s) => s.speaking.has(userId))
  const name = useChannelStore((s) => (channelId ? s.channels.get(channelId)?.name : undefined))
  if (!channelId || !name) return null
  return (
    <span className="text-feature-voice-text inline-flex min-w-0 items-center gap-1 truncate text-[13px] leading-5 font-semibold">
      {speaking ? (
        <AudioLines className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <Volume2 className="size-3.5 shrink-0" aria-hidden />
      )}
      {speaking ? 'Speaking in' : 'In'} {name}
    </span>
  )
}

const TRUST: Record<TrustBadge, { label: string; icon: React.ReactNode; className: string }> = {
  unverified: {
    label: 'Not verified',
    icon: <ShieldQuestion />,
    className: 'bg-feature-event/15 text-feature-event-text'
  },
  verified: {
    label: 'Verified',
    icon: <ShieldCheck />,
    className: 'bg-feature-voice/15 text-feature-voice-text'
  },
  changed: {
    label: 'Key changed',
    icon: <ShieldAlert />,
    className: 'bg-feature-danger/15 text-feature-danger-text'
  }
}

/** The trust of the other person in a 1:1 DM. Opens the verification dialog. */
function DmTrustChip({ channel }: { channel: Channel }): React.JSX.Element | null {
  const recipients = channel.recipients ?? []
  const solo = recipients.length === 1 ? recipients[0] : undefined
  const badge = useTrustBadge(solo?.id)
  if (!solo || !badge) return null
  const t = TRUST[badge]
  return (
    <button
      type="button"
      onClick={() => openDialog({ kind: 'verification', userId: solo.id })}
      className={cn(
        'rounded-control inline-flex h-8 items-center gap-1.5 px-2.5 text-[13px] leading-none font-bold transition-opacity hover:opacity-85 [&_svg]:size-4',
        'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:outline-offset-1',
        t.className
      )}
    >
      {t.icon}
      {t.label}
    </button>
  )
}
