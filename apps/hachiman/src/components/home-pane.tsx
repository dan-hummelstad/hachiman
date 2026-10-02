import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { User } from '@hachiman/client'
import { PresenceSections } from '@/components/people/presence-sections'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { PRESENCE_LABEL } from '@/components/ui/presence'
import { TitleBar } from '@/components/ui/title-bar'
import { useOpenDm, usePresence } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

const userId = (u: User): string => u.id

/** DM home with no DM open: everyone I share a guild with, a Slack-like directory. */
export function HomePane(): React.JSX.Element {
  const members = useGuildStore((s) => s.members)
  const myId = useUserStore((s) => s.me?.id)
  const [query, setQuery] = useState('')

  const people = useMemo(() => {
    const byId = new Map<string, User>()
    for (const guild of members.values()) {
      for (const m of guild.values()) {
        if (m.user.id !== myId && !byId.has(m.user.id)) byId.set(m.user.id, m.user)
      }
    }
    return [...byId.values()].sort((a, b) => a.username.localeCompare(b.username))
  }, [members, myId])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? people.filter((u) => u.username.toLowerCase().includes(q)) : people
  }, [people, query])

  return (
    <section className="bg-background flex min-h-0 min-w-0 flex-1 flex-col">
      <TitleBar left={<h1 className="truncate">People</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-6 py-6">
          <label className="bg-card focus-within:border-ring flex h-9 items-center gap-2 border px-3">
            <Search className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter people"
              aria-label="Filter people"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>

          {people.length === 0 ? (
            <Empty>Nobody here yet. People you share a guild with show up in this list.</Empty>
          ) : matches.length === 0 ? (
            <Empty>No one matches “{query.trim()}”.</Empty>
          ) : (
            <PresenceSections
              items={matches}
              idOf={userId}
              labelClassName="border-b pb-2"
              renderRow={(u, offline) => <PersonRow key={u.id} user={u} dim={offline} />}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-muted-foreground py-10 text-center text-sm">{children}</p>
}

function PersonRow({ user, dim }: { user: User; dim: boolean }): React.JSX.Element {
  const status = usePresence(user.id)
  const dm = useOpenDm(user.id)
  return (
    <li className="group hover:bg-accent flex h-14 items-center gap-3 border-b px-2">
      <UserAvatar
        avatar={user.avatar}
        name={user.username}
        status={status}
        cutout="bg-background group-hover:bg-accent"
        className={cn(dim && 'opacity-50')}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-sans text-sm leading-5 font-semibold">{user.username}</span>
        <span className="text-muted-foreground text-xs">{PRESENCE_LABEL[status]}</span>
      </div>
      <Button size="sm" variant="outline" disabled={dm.busy} onClick={() => void dm.open()}>
        Message
      </Button>
    </li>
  )
}
