import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, MessageCircle, MoreHorizontal, Search, SquarePen, Users } from 'lucide-react'
import type { User } from '@hachiman/client'
import { ActiveNow } from '@/components/people/active-now'
import { BlockConfirmDialog } from '@/components/people/block-dialog'
import { NewMessageDialog } from '@/components/people/new-message-dialog'
import { PresenceSections } from '@/components/people/presence-sections'
import { filterPeople, usePeople } from '@/components/people/use-people'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { PokeMenuItem } from '@/components/people/poke-menu-item'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { PRESENCE_LABEL } from '@/components/ui/presence'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { TitleBar } from '@/components/ui/title-bar'
import { useAction } from '@/hooks/use-action'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { useOpenDm, usePresence } from '@/hooks/use-member'
import { activityLabel } from '@/lib/member-activity'
import { cn } from '@/lib/utils'
import { blockService } from '@/services/guild-features'
import { usePoke } from '@/services/poke'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

type Tab = 'online' | 'all' | 'blocked'

const userId = (u: User): string => u.id

/**
 * The DM home with no DM open (E1): everyone I share a guild with, in the tabs Online, All and
 * Blocked, with "New message", a filter, and the "Active now" column on the right.
 */
export function HomePane(): React.JSX.Element {
  const people = usePeople()
  const blocks = useUserStore((s) => s.blocks)
  const presences = useGuildStore((s) => s.presences)
  const [tab, setTab] = useState<Tab>('online')
  const [query, setQuery] = useState('')
  const [composing, setComposing] = useState(false)

  const visible = useMemo(() => people.filter((u) => !blocks.has(u.id)), [people, blocks])
  const online = useMemo(
    () => visible.filter((u) => (presences.get(u.id) ?? 'offline') !== 'offline'),
    [visible, presences]
  )
  const list = tab === 'online' ? online : visible
  const matches = useMemo(() => filterPeople(list, query), [list, query])

  const tabs: SegmentedOption<Tab>[] = [
    { value: 'online', label: 'Online', count: online.length },
    { value: 'all', label: 'All', count: visible.length },
    { value: 'blocked', label: 'Blocked', count: blocks.size }
  ]

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <section className="bg-background flex min-h-0 min-w-0 flex-1 flex-col">
        <TitleBar
          left={
            <>
              <Users className="text-text-tertiary size-[18px] shrink-0" aria-hidden />
              <h1 className="truncate">People</h1>
              <SegmentedControl
                label="Show people"
                options={tabs}
                value={tab}
                onChange={setTab}
                className="ml-2"
              />
            </>
          }
          right={
            <Button onClick={() => setComposing(true)}>
              <SquarePen />
              New message
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-6 py-5">
            <label className="rounded-control border-line-strong bg-surface-sunken focus-within:border-accent-primary flex h-9 items-center gap-2 border px-3">
              <Search className="text-text-tertiary size-4 shrink-0" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter people"
                aria-label="Filter people"
                className="placeholder:text-text-tertiary min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>

            {tab === 'blocked' ? (
              <BlockedList people={people} query={query} />
            ) : list.length === 0 ? (
              <Empty>
                {tab === 'online' && visible.length > 0
                  ? 'No one is online right now.'
                  : 'Nobody here yet. People you share a guild with show up in this list.'}
              </Empty>
            ) : matches.length === 0 ? (
              <Empty>No one matches “{query.trim()}”.</Empty>
            ) : (
              <div className="flex flex-col gap-4">
                <PresenceSections
                  items={matches}
                  idOf={userId}
                  labelClassName="px-2 pb-1"
                  renderRow={(u, offline) => <PersonRow key={u.id} user={u} dim={offline} />}
                />
              </div>
            )}
          </div>
        </div>
      </section>
      <ActiveNow />
      <NewMessageDialog open={composing} onClose={() => setComposing(false)} />
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-text-tertiary py-10 text-center text-sm">{children}</p>
}

const ROW =
  'group rounded-control hover:bg-surface-hover flex min-h-[52px] items-center gap-3 px-2 py-1.5'

/** A person: avatar, name, what they do (voice, custom status or presence), Message and More. */
function PersonRow({ user, dim }: { user: User; dim: boolean }): React.JSX.Element {
  const status = usePresence(user.id)
  const custom = useCustomStatus(user.id)
  const activity = useVoiceActivity(user.id, null)
  const dm = useOpenDm(user.id)
  const poke = usePoke()
  const [confirm, setConfirm] = useState(false)

  return (
    <li className={ROW}>
      <UserAvatar
        avatar={user.avatar}
        name={user.username}
        status={status}
        cutout="bg-background group-hover:bg-surface-hover"
        className={cn(dim && 'opacity-50')}
      />
      <div className={cn('flex min-w-0 flex-1 flex-col', dim && 'opacity-60')}>
        <span className="text-text-primary truncate text-sm leading-5 font-semibold">
          {user.username}
        </span>
        {poke.error ? (
          <span className="text-feature-danger-text truncate text-xs leading-4" title={poke.error}>
            {poke.error}
          </span>
        ) : activity && !dim ? (
          <span className="text-feature-voice-text truncate text-xs leading-4 font-semibold">
            {activity.streaming ? `Live in ${activity.channelName}` : activityLabel(activity)}
          </span>
        ) : custom && !dim ? (
          <span className="text-text-secondary truncate text-xs leading-4" title={custom.text}>
            {custom.text}
          </span>
        ) : (
          <span
            className={cn(
              'truncate text-xs leading-4',
              status === 'dnd' ? 'text-feature-danger-text' : 'text-text-tertiary'
            )}
          >
            {PRESENCE_LABEL[status]}
          </span>
        )}
      </div>
      <IconButton
        label={`Message ${user.username}`}
        disabled={dm.busy}
        onClick={() => void dm.open()}
      >
        <MessageCircle />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label="More"
            className="hidden group-focus-within:inline-flex group-hover:inline-flex data-[state=open]:inline-flex"
          >
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!dim && <PokeMenuItem poke={poke} userId={user.id} name={user.username} />}
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
            <Ban /> Block
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BlockConfirmDialog
        userId={user.id}
        name={user.username}
        open={confirm}
        onClose={() => setConfirm(false)}
      />
    </li>
  )
}

/**
 * The people I blocked, with Unblock. A blocked user I no longer share a guild with is not in the
 * member lists, so their name comes from the block list of blockService.
 */
function BlockedList({ people, query }: { people: User[]; query: string }): React.JSX.Element {
  const blocks = useUserStore((s) => s.blocks)
  const blockedUsers = useUserStore((s) => s.blockedUsers)
  const channels = useChannelStore((s) => s.channels)
  // One reload per mount for a name that the list lacks (a user blocked since the last load).
  const reloaded = useRef(false)

  const known = useMemo(() => {
    const byId = new Map<string, User>(blockedUsers)
    for (const u of people) byId.set(u.id, u)
    for (const c of channels.values()) for (const u of c.recipients ?? []) byId.set(u.id, u)
    return byId
  }, [people, channels, blockedUsers])
  const missing = [...blocks].some((id) => !known.has(id))

  useEffect(() => {
    if (!missing || reloaded.current) return
    reloaded.current = true
    void blockService.load()
  }, [missing])

  const users = useMemo(
    () =>
      [...blocks]
        .map((id) => known.get(id))
        .filter((u): u is User => u !== undefined)
        .sort((a, b) => a.username.localeCompare(b.username)),
    [blocks, known]
  )
  const matches = filterPeople(users, query)

  if (blocks.size === 0) return <Empty>You haven&apos;t blocked anyone.</Empty>
  if (users.length === 0) return <Empty>Loading…</Empty>
  if (matches.length === 0) return <Empty>No one matches “{query.trim()}”.</Empty>
  return (
    <section>
      <h3 className="section-label px-2 pb-1">Blocked — {users.length}</h3>
      <ul className="flex flex-col">
        {matches.map((u) => (
          <BlockedRow key={u.id} user={u} />
        ))}
      </ul>
    </section>
  )
}

function BlockedRow({ user }: { user: User }): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <li className={ROW}>
      <UserAvatar
        avatar={user.avatar}
        name={user.username}
        cutout="bg-background group-hover:bg-surface-hover"
        className="opacity-60"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-text-primary truncate text-sm leading-5 font-semibold">
          {user.username}
        </span>
        {error ? (
          <ErrorText>{error}</ErrorText>
        ) : (
          <span className="text-text-tertiary text-xs leading-4">Blocked</span>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => void run(`unblock ${user.username}`, () => blockService.unblock(user.id))}
      >
        Unblock
      </Button>
    </li>
  )
}
