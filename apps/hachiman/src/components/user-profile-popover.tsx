import { useMemo, useState } from 'react'
import { BadgeCheck, Headphones, MicOff, VolumeX } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useServerRoles } from '@/hooks/use-server-roles'
import { useServerStore } from '@/stores/serverStore'
import type { ServerMember } from '@/hooks/use-server-members'
import { cn } from '@/lib/utils'

interface UserProfilePopoverProps {
  /** Wrapped target (the member row). Receives onContextMenu wiring transparently. */
  children: React.ReactNode
  /** The member to describe. Can be a guest (no userId) — roles section just hides. */
  member: ServerMember
  /** Server context, used to look up the user's role memberships. */
  serverId: string | null
}

/**
 * Right-click on a member row opens this card. Renders identity (name +
 * Oracle handle / verified badge), live audio status (mute/deafen), and
 * — when the viewer has admin permission to read role data — the user's
 * role memberships.
 */
export function UserProfilePopover(props: UserProfilePopoverProps): React.JSX.Element {
  const { children, member, serverId } = props
  const [open, setOpen] = useState(false)
  const roles = useServerRoles(serverId)
  const server = useServerStore((s) => (serverId ? s.servers.get(serverId) : undefined))

  const memberRoles = useMemo(() => {
    if (member.userId === undefined) return []
    return roles.roles.filter((r) => r.memberIds.has(member.userId!)).map((r) => r.name)
  }, [member.userId, roles.roles])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          onContextMenu={(e) => {
            e.preventDefault()
            setOpen(true)
          }}
        >
          {children}
        </div>
      </PopoverAnchor>
      {/* Hidden trigger keeps Radix's focus management happy when we open
          via onContextMenu instead of click. */}
      <PopoverTrigger className="sr-only" tabIndex={-1} aria-hidden />
      <PopoverContent side="left" align="start" className="w-72">
        <UserProfileCard
          member={member}
          roles={memberRoles}
          serverName={server?.name ?? serverId ?? ''}
        />
      </PopoverContent>
    </Popover>
  )
}

interface UserProfileCardProps {
  member: ServerMember
  roles: string[]
  serverName: string
}

function UserProfileCard({ member, roles, serverName }: UserProfileCardProps): React.JSX.Element {
  const initials = member.name.slice(0, 1).toUpperCase()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Avatar className="h-12 w-12">
          {/* TODO(oracle): once the Oracle userinfo response carries an
              avatar URL, plumb it through ServerMember and render here. */}
          <AvatarImage alt={member.name} />
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold">{member.name}</span>
            {member.verified && (
              <BadgeCheck className="h-3.5 w-3.5 shrink-0 text-blue-500" aria-label="Verified" />
            )}
          </div>
          {member.oracleHandle && member.oracleHandle !== member.name && (
            <span className="text-muted-foreground truncate text-xs">{member.oracleHandle}</span>
          )}
          <span className="text-muted-foreground/70 truncate text-[10px]">on {serverName}</span>
        </div>
      </div>

      <StatusRow member={member} />

      {roles.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
            Roles
          </span>
          <div className="flex flex-wrap gap-1">
            {roles.map((r) => (
              <span
                key={r}
                className="bg-muted text-foreground rounded-full px-2 py-0.5 text-[11px]"
              >
                {r}
              </span>
            ))}
          </div>
        </div>
      )}

      {member.userId === undefined && (
        <p className="text-muted-foreground text-[11px] italic">
          Guest session — not registered on this server.
        </p>
      )}
    </div>
  )
}

function StatusRow({ member }: { member: ServerMember }): React.JSX.Element {
  const items: { icon: React.ReactNode; label: string; tone: 'normal' | 'warn' }[] = []
  if (member.selfMute) {
    items.push({ icon: <MicOff className="h-3 w-3" />, label: 'Muted', tone: 'warn' })
  }
  if (member.selfDeaf) {
    items.push({ icon: <VolumeX className="h-3 w-3" />, label: 'Deafened', tone: 'warn' })
  }
  if (!member.selfMute && !member.selfDeaf) {
    items.push({ icon: <Headphones className="h-3 w-3" />, label: 'Listening', tone: 'normal' })
  }
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => (
        <span
          key={i.label}
          className={cn(
            'flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]',
            i.tone === 'warn' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-foreground'
          )}
        >
          {i.icon}
          {i.label}
        </span>
      ))}
    </div>
  )
}
