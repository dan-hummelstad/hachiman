import { useMemo, useState } from 'react'
import { Ban, MessageCircle, MoreHorizontal, Search, SquarePen, Users } from 'lucide-react'
import type { PresenceStatus, User } from '@hachiman/client'
import { MobileDmHome } from '@/components/mobile/dm-home-screen'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { ActiveNow } from '@/components/people/active-now'
import { BlockConfirmDialog } from '@/components/people/block-dialog'
import { NewMessageDialog } from '@/components/people/new-message-dialog'
import { PresenceSections } from '@/components/people/presence-sections'
import { filterPeople, useOnlinePeople, useVisiblePeople } from '@/components/people/use-people'
import { useVoiceActivity } from '@/components/people/use-voice-activity'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { PokeMenuItem } from '@/components/people/poke-menu-item'
import { ErrorText } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { PRESENCE_LABEL } from '@/components/ui/presence'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { TitleBar } from '@/components/ui/title-bar'
import { useAction } from '@/hooks/use-action'
import { useBlockedUsers } from '@/hooks/use-blocked-users'
import { useCustomStatus } from '@/hooks/use-custom-status'
import { useLayout } from '@/hooks/use-layout'
import { useOpenDm, usePresence } from '@/hooks/use-member'
import { activityLabel } from '@/lib/member-activity'
import { cn } from '@/lib/utils'
import { blockService } from '@/services/guild-features'
import { usePoke } from '@/services/poke'
import { useUserStore } from '@/stores/userStore'

type Tab = 'online' | 'all' | 'blocked'

const userId = (u: User): string => u.id

/** The People view: everyone I share a guild with, the tab, the filter and what they select. */
function usePeopleView(): {
  tab: Tab
  setTab: (tab: Tab) => void
  query: string
  setQuery: (query: string) => void
  tabs: SegmentedOption<Tab>[]
  online: User[]
  visible: User[]
  list: User[]
  matches: User[]
} {
  const blocks = useUserStore((s) => s.blocks)
  const [tab, setTab] = useState<Tab>('online')
  const [query, setQuery] = useState('')

  const visible = useVisiblePeople()
  const online = useOnlinePeople()
  const list = tab === 'online' ? online : visible
  const matches = useMemo(() => filterPeople(list, query), [list, query])

  const tabs: SegmentedOption<Tab>[] = [
    { value: 'online', label: 'Online', count: online.length },
    { value: 'all', label: 'All', count: visible.length },
    { value: 'blocked', label: 'Blocked', count: blocks.size }
  ]
  return { tab, setTab, query, setQuery, tabs, online, visible, list, matches }
}

/**
 * The DM home with no DM open (E1): everyone I share a guild with, in the tabs Online, All and
 * Blocked, with "New message", a filter, and the "Active now" column on the right. On the mobile
 * layout: the DM home of M56, whose People row pushes this list (`MobilePeopleScreen`).
 */
export function HomePane(): React.JSX.Element {
  if (useLayout() === 'mobile') return <MobileDmHome people={<MobilePeopleScreen />} />
  return <DesktopHomePane />
}

function DesktopHomePane(): React.JSX.Element {
  const view = usePeopleView()
  const { tab, setTab, query, setQuery, tabs } = view
  const [composing, setComposing] = useState(false)

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

            <PeopleResults
              view={view}
              renderRow={(u, offline) => <PersonRow key={u.id} user={u} dim={offline} />}
            />
          </div>
        </div>
      </section>
      <ActiveNow />
      <NewMessageDialog open={composing} onClose={() => setComposing(false)} />
    </div>
  )
}

/**
 * The People list of the mobile DM home (M56), pushed by its People row: the tabs, the filter
 * and the people. A hold on a person opens their menu (no hover More button on touch).
 */
function MobilePeopleScreen(): React.JSX.Element {
  const view = usePeopleView()
  const { tab, setTab, query, setQuery, tabs, online } = view
  return (
    <PushedScreen title="People" subtitle={`${online.length} online`}>
      <SegmentedControl
        size="touch"
        label="Show people"
        options={tabs}
        value={tab}
        onChange={setTab}
      />
      <Input
        size="touch"
        type="search"
        lead={<Search />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter people"
        aria-label="Filter people"
        enterKeyHint="search"
      />
      <div className="-mx-2 flex flex-col gap-4 pt-1.5">
        <PeopleResults
          view={view}
          touch
          renderRow={(u, offline) => <TouchPersonRow key={u.id} user={u} dim={offline} />}
        />
      </div>
    </PushedScreen>
  )
}

/** The list of the selected tab, or why it is empty. */
function PeopleResults({
  view: { tab, query, visible, list, matches },
  touch = false,
  renderRow
}: {
  view: ReturnType<typeof usePeopleView>
  /** The touch sizes of the mobile layout. */
  touch?: boolean
  renderRow: (user: User, offline: boolean) => React.ReactNode
}): React.JSX.Element {
  if (tab === 'blocked') return <BlockedList query={query} touch={touch} />
  if (list.length === 0)
    return (
      <Empty>
        {tab === 'online' && visible.length > 0
          ? 'No one is online right now.'
          : 'Nobody here yet. People you share a guild with show up in this list.'}
      </Empty>
    )
  if (matches.length === 0) return <Empty>No one matches “{query.trim()}”.</Empty>
  return (
    <div className="flex flex-col gap-4">
      <PresenceSections
        items={matches}
        idOf={userId}
        labelClassName="px-2 pb-1"
        renderRow={renderRow}
      />
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-text-tertiary py-10 text-center text-sm">{children}</p>
}

const ROW =
  'group rounded-control hover:bg-surface-hover flex min-h-[52px] items-center gap-3 px-2 py-1.5'

/** What a person does: the poke error, voice, a custom status or the presence. */
function PersonStatus({
  user,
  dim,
  status,
  pokeError,
  touch = false
}: {
  user: User
  dim: boolean
  status: PresenceStatus
  pokeError: string | null
  touch?: boolean
}): React.JSX.Element {
  const custom = useCustomStatus(user.id)
  const activity = useVoiceActivity(user.id, null)
  const line = touch ? 'text-[13px] leading-4' : 'text-xs leading-4'
  if (pokeError)
    return (
      <span className={cn('text-feature-danger-text truncate', line)} title={pokeError}>
        {pokeError}
      </span>
    )
  if (activity && !dim)
    return (
      <span className={cn('text-feature-voice-text truncate font-semibold', line)}>
        {activity.streaming ? `Live in ${activity.channelName}` : activityLabel(activity)}
      </span>
    )
  if (custom && !dim)
    return (
      <span className={cn('text-text-secondary truncate', line)} title={custom.text}>
        {custom.text}
      </span>
    )
  return (
    <span
      className={cn(
        'truncate',
        line,
        status === 'dnd' ? 'text-feature-danger-text' : 'text-text-tertiary'
      )}
    >
      {PRESENCE_LABEL[status]}
    </span>
  )
}

/** A person: avatar, name, what they do (voice, custom status or presence), Message and More. */
function PersonRow({ user, dim }: { user: User; dim: boolean }): React.JSX.Element {
  const status = usePresence(user.id)
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
        <PersonStatus user={user} dim={dim} status={status} pokeError={poke.error} />
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
 * A person on the mobile People screen: avatar 40, name, what they do and Message (36). A hold
 * opens the menu sheet with Poke and Block; an sr-only "More" button opens it for VoiceOver and a
 * keyboard (spec §2.9).
 */
function TouchPersonRow({ user, dim }: { user: User; dim: boolean }): React.JSX.Element {
  const status = usePresence(user.id)
  // The purple live dot, as on the DM home rows and the Active now card (M56).
  const live = useVoiceActivity(user.id, null)?.streaming === true
  const dm = useOpenDm(user.id)
  const poke = usePoke()
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)

  return (
    <>
      <ContextMenu open={menu} onOpenChange={setMenu}>
        <ContextMenuTrigger asChild>
          <li className="rounded-control relative flex min-h-[58px] items-center gap-3 px-2 py-1.5">
            <UserAvatar
              avatar={user.avatar}
              name={user.username}
              size={40}
              status={status}
              live={live}
              cutout="bg-surface-content"
              className={cn(dim && 'opacity-50')}
            />
            <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', dim && 'opacity-60')}>
              <span className="text-text-primary truncate text-[15.5px] leading-[19px] font-bold">
                {user.username}
              </span>
              <PersonStatus user={user} dim={dim} status={status} pokeError={poke.error} touch />
            </div>
            <button
              type="button"
              onClick={() => setMenu(true)}
              className="focus-visible:rounded-control focus-visible:bg-surface-raised focus-visible:outline-line-focus sr-only z-10 focus-visible:not-sr-only focus-visible:absolute focus-visible:top-1 focus-visible:right-12 focus-visible:px-2.5 focus-visible:py-1.5 focus-visible:text-xs focus-visible:font-bold focus-visible:outline-2"
            >
              More for {user.username}
            </button>
            <IconButton
              size="touch"
              label={`Message ${user.username}`}
              disabled={dm.busy}
              onClick={() => void dm.open()}
              className="bg-fill-control rounded-control"
            >
              <MessageCircle />
            </IconButton>
          </li>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={user.username}>
          {!dim && <PokeMenuItem poke={poke} userId={user.id} name={user.username} />}
          <ContextMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
            <Ban /> Block
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <BlockConfirmDialog
        userId={user.id}
        name={user.username}
        open={confirm}
        onClose={() => setConfirm(false)}
      />
    </>
  )
}

/** The people I blocked (`useBlockedUsers`), with Unblock. */
function BlockedList({ query, touch }: { query: string; touch: boolean }): React.JSX.Element {
  const { users, count } = useBlockedUsers()
  const matches = filterPeople(users, query)

  if (count === 0) return <Empty>You haven&apos;t blocked anyone.</Empty>
  if (users.length === 0) return <Empty>Loading…</Empty>
  if (matches.length === 0) return <Empty>No one matches “{query.trim()}”.</Empty>
  return (
    <section>
      <h3 className="section-label px-2 pb-1">Blocked — {users.length}</h3>
      <ul className="flex flex-col">
        {matches.map((u) => (
          <BlockedRow key={u.id} user={u} touch={touch} />
        ))}
      </ul>
    </section>
  )
}

function BlockedRow({ user, touch }: { user: User; touch: boolean }): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <li className={ROW}>
      <UserAvatar
        avatar={user.avatar}
        name={user.username}
        size={touch ? 40 : undefined}
        cutout="bg-background group-hover:bg-surface-hover"
        className="opacity-60"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            'text-text-primary truncate font-semibold',
            touch ? 'text-[15.5px] leading-[19px]' : 'text-sm leading-5'
          )}
        >
          {user.username}
        </span>
        {error ? (
          <ErrorText>{error}</ErrorText>
        ) : (
          <span className="text-text-tertiary text-xs leading-4">Blocked</span>
        )}
      </div>
      <Button
        size={touch ? 'lg' : 'sm'}
        variant="secondary"
        disabled={busy}
        onClick={() => void run(`unblock ${user.username}`, () => blockService.unblock(user.id))}
      >
        Unblock
      </Button>
    </li>
  )
}
