import { useMemo } from 'react'
import { BadgeCheck, Headphones, Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { useServerMembers, type ServerMember } from '@/hooks/use-server-members'
import { useServerRoles, type ServerRoleInfo } from '@/hooks/use-server-roles'
import { BUILTIN_GROUPS } from '@/lib/mumble-permissions'
import { cn } from '@/lib/utils'
import { useVoiceStore } from '@/stores/voiceStore'

interface MemberListProps {
  serverId: string | null
}

interface RoleSection {
  role: ServerRoleInfo | null
  online: ServerMember[]
  offline: { userId: number; name: string }[]
}

/**
 * Right column: lists Mumble users on the server, grouped by role.
 *
 * - Online users (with a current session) appear in their highest-priority
 *   role section, with voice/mute/deafen indicators.
 * - Offline registered users appear in a muted "offline" bucket inside the
 *   same role section.
 * - Users with no role land in a default "Members" section at the bottom.
 *
 * Role data requires admin permissions on the Mumble server; non-admin
 * sessions get a flat "Online" list (no role grouping).
 */
export function MemberList(props: MemberListProps): React.JSX.Element {
  const { serverId } = props
  const members = useServerMembers(serverId)
  const roles = useServerRoles(serverId)

  const sections = useMemo<RoleSection[]>(
    () => buildSections(members, roles.roles, roles.userNameById),
    [members, roles.roles, roles.userNameById]
  )

  const totalCount = members.length

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-screen w-60 shrink-0 flex-col border-l">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="text-muted-foreground truncate text-xs font-semibold uppercase tracking-wide">
          Members ({totalCount})
        </h2>
      </header>
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-3 p-2">
          {sections.length === 0 ? (
            <p className="text-muted-foreground px-2 py-4 text-xs">No one here.</p>
          ) : (
            sections.map((section) => (
              <RoleSectionView key={sectionKey(section)} section={section} serverId={serverId} />
            ))
          )}
          {roles.error && (
            <p className="text-muted-foreground/70 px-2 pt-2 text-[10px] italic">
              Role data unavailable — admin permission required.
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}

function sectionKey(s: RoleSection): string {
  return s.role?.name ?? '__no_role__'
}

function buildSections(
  members: ServerMember[],
  roles: ServerRoleInfo[],
  userNameById: Map<number, string>
): RoleSection[] {
  // Choose a stable assignment of each online user to a role: pick the first
  // role (in display order) whose memberIds includes the user's registered id.
  const orderedRoles = orderRolesForDisplay(roles)

  const sectionsByName = new Map<string, RoleSection>()
  for (const role of orderedRoles) {
    sectionsByName.set(role.name, { role, online: [], offline: [] })
  }
  const fallback: RoleSection = { role: null, online: [], offline: [] }

  // Bucket online users by their highest-priority role match.
  for (const m of members) {
    if (m.userId === undefined) {
      // Guest / unregistered session — always falls through to the default bucket.
      fallback.online.push(m)
      continue
    }
    const role = orderedRoles.find((r) => r.memberIds.has(m.userId!))
    if (role) sectionsByName.get(role.name)!.online.push(m)
    else fallback.online.push(m)
  }

  // Offline registered users: anyone in a role's memberIds who isn't currently online.
  const onlineUserIds = new Set<number>()
  for (const m of members) if (m.userId !== undefined) onlineUserIds.add(m.userId)
  for (const role of orderedRoles) {
    for (const uid of role.memberIds) {
      if (onlineUserIds.has(uid)) continue
      const name = userNameById.get(uid)
      if (!name) continue
      // Place offline users into their first-matching role section, same
      // priority order as online users. Skip if already placed.
      const target = sectionsByName.get(role.name)!
      if (target.offline.some((o) => o.userId === uid)) continue
      // If the user appears in an earlier role, skip — they'll be in that one already.
      const earlier = orderedRoles.find(
        (r) =>
          r.name !== role.name &&
          r.memberIds.has(uid) &&
          sectionsByName.get(r.name)!.offline.some((o) => o.userId === uid)
      )
      if (earlier) continue
      target.offline.push({ userId: uid, name })
    }
  }

  // Drop empty sections except the fallback when it has rows.
  const out: RoleSection[] = []
  for (const role of orderedRoles) {
    const s = sectionsByName.get(role.name)!
    if (s.online.length === 0 && s.offline.length === 0) continue
    s.online.sort((a, b) => a.name.localeCompare(b.name))
    s.offline.sort((a, b) => a.name.localeCompare(b.name))
    out.push(s)
  }
  if (fallback.online.length > 0 || fallback.offline.length > 0) {
    fallback.online.sort((a, b) => a.name.localeCompare(b.name))
    out.push(fallback)
  }
  return out
}

/**
 * Mumble doesn't expose a "role order" — groups are returned in insertion
 * order by the server. We push built-in groups (all, auth, …) to the bottom
 * because they're plumbing, not display-worthy roles, and keep user-created
 * groups in their server-given order at the top.
 */
function orderRolesForDisplay(roles: ServerRoleInfo[]): ServerRoleInfo[] {
  const custom: ServerRoleInfo[] = []
  const builtin: ServerRoleInfo[] = []
  for (const r of roles) {
    if (BUILTIN_GROUPS.has(r.name)) builtin.push(r)
    else custom.push(r)
  }
  return [...custom, ...builtin]
}

function RoleSectionView({
  section,
  serverId
}: {
  section: RoleSection
  serverId: string | null
}): React.JSX.Element {
  const speakingUsers = useVoiceStore((s) => s.speakingUsers)
  const title = section.role?.name ?? 'Members'
  const count = section.online.length + section.offline.length
  return (
    <div>
      <div className="text-muted-foreground/80 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider">
        {title} — {count}
      </div>
      <ul className="flex flex-col gap-0.5">
        {section.online.map((m) => (
          <MemberRowItem
            key={`s-${m.session}`}
            member={m}
            speaking={speakingUsers.has(m.session)}
            serverId={serverId}
          />
        ))}
        {section.offline.map((o) => (
          <OfflineMemberRow key={`u-${o.userId}`} name={o.name} />
        ))}
      </ul>
    </div>
  )
}

function MemberRowItem({
  member,
  speaking,
  serverId
}: {
  member: ServerMember
  speaking: boolean
  serverId: string | null
}): React.JSX.Element {
  return (
    <li>
      <UserProfilePopover member={member} serverId={serverId}>
        <div
          className={cn(
            'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm',
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
                className="bg-primary ring-sidebar absolute -bottom-0.5 -right-0.5 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full ring-2"
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
        </div>
      </UserProfilePopover>
    </li>
  )
}

function OfflineMemberRow({ name }: { name: string }): React.JSX.Element {
  return (
    <li className="text-muted-foreground/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
      <Avatar className="h-7 w-7 opacity-50">
        <AvatarFallback className="text-xs">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="flex-1 truncate italic">{name}</span>
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
