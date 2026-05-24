import { useEffect, useState } from 'react'
import { BadgeCheck, Headphones, Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { serversService } from '@/services/ServersService'
import { useVoiceStore } from '@/stores/voiceStore'
import type { IMumbleService, MumbleEvents } from '@/shared/IMumbleService'

export interface MemberRow {
  session: number
  name: string
  selfMute: boolean
  selfDeaf: boolean
  /** Set by the server when the session was bound to an Oracle account. */
  verified: boolean
  /** Display handle from Oracle (e.g. `@alice`); may differ from the Mumble name. */
  oracleHandle?: string
}

interface MemberListProps {
  serverId: string | null
  channelId: number | null
  channelName: string | null
}

/**
 * Right column: lists Mumble users currently in the selected channel.
 * Membership is derived from the live UserManager on the connected server
 * and refreshed on user-create/update/remove events.
 *
 * Note: this view follows the **selected** channel, not the user's
 * voice-connected channel. Looking at a different channel still shows
 * who is in *that* channel.
 */
export function MemberList(props: MemberListProps): React.JSX.Element | null {
  const { serverId, channelId, channelName } = props
  const speakingUsers = useVoiceStore((s) => s.speakingUsers)
  const [members, setMembers] = useState<MemberRow[]>([])

  useEffect(() => {
    // Reset-on-prop-change is the intent here: member list is per-channel.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!serverId || channelId === null) {
      setMembers([])
      return
    }
    const server = serversService.getServer(serverId)
    if (!server) {
      setMembers([])
      return
    }

    const refresh = (): void => setMembers(collectMembers(server, channelId))
    refresh()

    const onUserChange: MumbleEvents['userUpdate'] = () => refresh()
    const onUserCreate: MumbleEvents['userCreate'] = () => refresh()
    const onUserRemove: MumbleEvents['userRemove'] = () => refresh()
    server.on('userUpdate', onUserChange)
    server.on('userCreate', onUserCreate)
    server.on('userRemove', onUserRemove)
    return () => {
      server.off('userUpdate', onUserChange)
      server.off('userCreate', onUserCreate)
      server.off('userRemove', onUserRemove)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [serverId, channelId])

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-screen w-60 shrink-0 flex-col border-l">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="text-muted-foreground truncate text-xs font-semibold uppercase tracking-wide">
          Members — {channelName ?? '—'} ({members.length})
        </h2>
      </header>
      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {members.map((m) => (
            <MemberRowItem key={m.session} member={m} speaking={speakingUsers.has(m.session)} />
          ))}
          {members.length === 0 && (
            <li className="text-muted-foreground px-2 py-4 text-xs">No one here.</li>
          )}
        </ul>
      </ScrollArea>
    </aside>
  )
}

function MemberRowItem({
  member,
  speaking
}: {
  member: MemberRow
  speaking: boolean
}): React.JSX.Element {
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        speaking
          ? 'bg-primary/10 text-foreground'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
      )}
    >
      <div className="relative">
        <Avatar className="h-7 w-7">
          <AvatarFallback className="text-xs">
            {member.name.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {speaking && (
          <span
            aria-hidden
            className="bg-primary absolute -bottom-0.5 -right-0.5 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full ring-2 ring-sidebar"
          >
            <Volume2 className="text-primary-foreground h-2 w-2" />
          </span>
        )}
      </div>
      <span className="flex flex-1 items-center gap-1 truncate">
        <span className="truncate">{member.name}</span>
        {member.verified && <VerifiedBadge name={member.name} handle={member.oracleHandle} />}
      </span>
      <span className="text-muted-foreground flex items-center gap-1">
        {member.selfMute ? (
          <MicOff className="h-3 w-3 text-destructive" />
        ) : (
          <Mic className="h-3 w-3 opacity-50" />
        )}
        {member.selfDeaf && <VolumeX className="h-3 w-3 text-destructive" />}
        {speaking && <Headphones className="h-3 w-3 text-primary" />}
      </span>
    </li>
  )
}

function VerifiedBadge({
  name,
  handle
}: {
  name: string
  handle: string | undefined
}): React.JSX.Element {
  const label = handle ? `Verified as ${handle}` : 'Verified'
  const badge = <BadgeCheck className="h-3 w-3 shrink-0 text-blue-500" aria-label={label} />
  // Show a tooltip only when the Oracle handle differs from the Mumble name,
  // otherwise the badge alone speaks for itself.
  if (!handle || handle === name) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}

function collectMembers(server: IMumbleService, channelId: number): MemberRow[] {
  return server.users
    .filter((u) => u.channelId === channelId)
    .map((u) => {
      // Agent A surfaces `verified` and `oracleHandle` on the User shape; we
      // read them defensively so this code compiles before those proto fields
      // land. Cast preserves the contract documented in the team handoff.
      const oracleish = u as unknown as { verified?: boolean; oracleHandle?: string }
      return {
        session: u.session,
        name: u.name ?? `user-${u.session}`,
        selfMute: u.selfMute ?? false,
        selfDeaf: u.selfDeaf ?? false,
        verified: oracleish.verified === true,
        oracleHandle: oracleish.oracleHandle
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
