import { FileText, Settings, Users } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { IconButton } from '@/components/ui/icon-button'
import { PresenceDot } from '@/components/ui/presence'
import { TitleBar } from '@/components/ui/title-bar'
import { usePermissions } from '@/hooks/use-hachiman'
import { usePresence } from '@/hooks/use-member'
import { ChannelIcon } from '@/lib/channel-icon'
import { channelLabel } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'

const PANE = 'bg-background flex min-h-0 min-w-0 flex-1 flex-col'

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

/** Main pane frame for a channel: 48px title bar (title, member toggle, settings) over a body. */
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

  return (
    <section className={cn(PANE, ROLE_INK_SCOPE)}>
      <TitleBar
        left={isDm ? <DmTitle channel={channel} /> : <ChannelTitle channel={channel} />}
        right={
          <>
            {onToggleSide && (
              <IconButton
                label={sideOpen ? `Hide ${side}` : `Show ${side}`}
                tooltipSide="bottom"
                pressed={sideOpen}
                onClick={onToggleSide}
              >
                {side === 'pages' ? <FileText /> : <Users />}
              </IconButton>
            )}
            {canManage && (
              <IconButton
                label="Channel settings"
                tooltipSide="bottom"
                onClick={() => openDialog({ kind: 'channelSettings', channelId: channel.id })}
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
      <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
        Pick a channel to start reading.
      </div>
    </section>
  )
}

function ChannelTitle({ channel }: { channel: Channel }): React.JSX.Element {
  return (
    <>
      <ChannelIcon
        type={channel.type}
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden
      />
      <h1 className="shrink-0 truncate">{channelLabel(channel).name}</h1>
      {channel.topic && (
        <>
          <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
          <span
            className="text-muted-foreground min-w-0 truncate text-sm font-normal"
            title={channel.topic}
          >
            {channel.topic}
          </span>
        </>
      )}
    </>
  )
}

function DmTitle({ channel }: { channel: Channel }): React.JSX.Element {
  const recipients = channel.recipients ?? []
  const solo = recipients.length === 1 ? recipients[0] : undefined
  const status = usePresence(solo?.id)
  return (
    <>
      {solo ? (
        <PresenceDot status={status} className="mx-1" />
      ) : (
        <Users className="text-muted-foreground size-4 shrink-0" aria-hidden />
      )}
      <h1 className="truncate">{channelLabel(channel).name}</h1>
    </>
  )
}
