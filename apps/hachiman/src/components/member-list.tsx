import { useMemo } from 'react'
import type { Member } from '@hachiman/client'
import { PresenceSections } from '@/components/people/presence-sections'
import { UserAvatar } from '@/components/shell/user-avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TitleBar } from '@/components/ui/title-bar'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { usePresence, useSpeakingMember } from '@/hooks/use-member'
import { sortMembersByName } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'

const memberId = (m: Member): string => m.user.id

/** Right column: the guild's members split into Online / Offline, names in their highest role colour. */
export function MemberList({ guildId }: { guildId: string }): React.JSX.Element {
  const members = useGuildStore((s) => s.members.get(guildId))
  const sorted = useMemo(() => sortMembersByName(members?.values() ?? []), [members])

  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground flex h-full min-h-0 w-60 shrink-0 flex-col border-l',
        ROLE_INK_SCOPE
      )}
    >
      <TitleBar left={<h2 className="truncate">Members</h2>} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-2 py-3">
          <PresenceSections
            items={sorted}
            idOf={memberId}
            labelClassName="px-2 pb-1"
            renderRow={(m, offline) => (
              <MemberRow key={m.user.id} member={m} guildId={guildId} dim={offline} />
            )}
          />
        </div>
      </ScrollArea>
    </aside>
  )
}

function MemberRow({
  member,
  guildId,
  dim
}: {
  member: Member
  guildId: string
  dim: boolean
}): React.JSX.Element {
  const userId = member.user.id
  const { name, ink, speaking } = useSpeakingMember(guildId, userId)
  const status = usePresence(userId)
  return (
    <li>
      <UserProfilePopover userId={userId} guildId={guildId}>
        <button
          type="button"
          className={cn(
            'group hover:bg-sidebar-accent flex h-10 w-full items-center gap-2.5 px-2 text-left text-sm',
            'focus-visible:outline-ring focus-visible:outline-2 focus-visible:-outline-offset-2',
            dim && 'opacity-50 hover:opacity-100'
          )}
        >
          <UserAvatar
            avatar={member.user.avatar}
            name={name}
            color={ink}
            speaking={speaking}
            status={status}
            cutout="bg-sidebar group-hover:bg-sidebar-accent"
          />
          <span className="truncate font-medium" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
        </button>
      </UserProfilePopover>
    </li>
  )
}
