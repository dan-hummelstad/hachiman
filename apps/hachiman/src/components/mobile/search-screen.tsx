import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  CircleX,
  FileText,
  Globe,
  Hash,
  MessageSquare,
  Pin,
  Search,
  Users,
  Volume2,
  type LucideIcon
} from 'lucide-react'
import { countLocalPushed } from '@/components/mobile/drawer-state'
import { FilterChip, FilterChips, type FilterChipOption } from '@/components/mobile/filter-chips'
import {
  MenuSheet,
  MenuSheetContent,
  MenuSheetRadioGroup,
  MenuSheetRadioItem,
  MenuSheetTrigger
} from '@/components/mobile/menu-sheet'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import {
  activateItem,
  closeSwitcher,
  isPinnedItem,
  setSwitcherFilter,
  useSwitcher,
  useSwitcherResults,
  type SwitcherMode
} from '@/components/shell/switcher-state'
import { UserAvatar } from '@/components/shell/user-avatar'
import { PresenceWord } from '@/components/shell/presence-word'
import { GuildTile } from '@/components/ui/guild-tile'
import { LivePill } from '@/components/ui/live'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { LONG_PRESS_TARGET, useLongPress } from '@/hooks/use-long-press'
import { usePresence } from '@/hooks/use-member'
import { captureOpener, restoreFocus } from '@/lib/focus-opener'
import { voiceActivity, type VoiceActivity } from '@/lib/member-activity'
import {
  groupResults,
  matchRange,
  type SwitchFilterKind,
  type SwitchGroup,
  type SwitchItem,
  type SwitchKind
} from '@/lib/quick-switcher'
import { orderedIds } from '@/lib/sidebar-tiles'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useGuildOrder } from '@/stores/prefsStore'
import { useTabs, type TabTarget } from '@/stores/tabsStore'
import { useChannelUnread } from '@/stores/unreadStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** The most results the screen lists (the desktop switcher lists 30). */
const RESULT_LIMIT = 50

/** A move (px) of a finger on the results that puts the keyboard away. */
const DISMISS_MOVE = 10

/** Messages and From wait for message search (spec section 5). */
const CHIPS: readonly FilterChipOption<SwitchFilterKind>[] = [
  { value: 'all', label: 'All' },
  { value: 'people', label: 'People' },
  { value: 'channels', label: 'Channels' }
]

const GROUP_LABEL: Record<SwitchGroup, string> = {
  recent: 'Recent',
  channels: 'Channels',
  people: 'People'
}

const EMPTY_NOUN: Record<SwitchFilterKind, string> = {
  all: 'channels, pages, DMs or people',
  people: 'DMs or people',
  channels: 'channels or pages'
}

/** The "In:" menu value for any guild (guild ids are snowflakes). */
const ANY_GUILD = 'any'

type ChannelKind = Exclude<SwitchKind, 'dm' | 'person'>

const KIND_ICON: Record<ChannelKind, LucideIcon> = {
  text: Hash,
  voice: Volume2,
  pages: FileText,
  page: FileText
}

const META = 'text-text-disabled font-mono text-[8.5px] tracking-[1px] uppercase'

const NO_SPEAKERS: ReadonlySet<string> = new Set()

/**
 * The search screen on a phone (M66, J3): the quick switcher full screen. On the tinted window the
 * search field (44, 16 px text, the Search key) and Cancel; on the content card the chips (All,
 * People, Channels, "In:" a guild) and the results grouped as RECENT (the nav history), CHANNELS
 * and PEOPLE, with the match lit. A tap opens a result, the Search key opens the first one, and a
 * hold pins it to the tabs (a light haptic). In pin mode (the tab strip's "+") a tap pins.
 * VoiceOver pins through that "+".
 *
 * `openSwitcher` renders it inside the opening tap, and the field takes the focus as it mounts, so
 * the keyboard is up (spec §2.8). The MobileShell root holds it, so the guild tint shows behind the
 * field. While it shows, the chat underneath counts as covered (no mark-read) and the tab strip is
 * inert. No message search and no saved queries: the server holds only ciphertext (spec section 5).
 */
export function MobileSearchScreen({ mode }: { mode: SwitcherMode }): React.JSX.Element {
  const filter = useSwitcher((s) => s.filter)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [opener] = useState(captureOpener)
  const field = useRef<HTMLInputElement>(null)
  const touchY = useRef<number | null>(null)
  const { results, recent, here } = useSwitcherResults(query, filter, RESULT_LIMIT)
  const sections = useMemo(
    () =>
      groupResults(
        results,
        recent.filter((k) => k !== here)
      ),
    [results, recent, here]
  )
  const tabs = useTabs()
  const pinMode = mode === 'pin'
  const typed = query.trim() !== ''
  const first = sections[0]?.items[0]
  const count = useMemo(() => sections.reduce((n, g) => n + g.items.length, 0), [sections])

  // Inside the opening tap: `openSwitcher` commits this screen synchronously.
  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true })
  }, [])

  // A local overlay over the chat card (spec §2.6): no mark-read under it, the tab strip inert.
  useEffect(() => {
    countLocalPushed(1)
    return () => countLocalPushed(-1)
  }, [])

  const run = (it: SwitchItem, pin: boolean): void => {
    setError(null)
    activateItem(it, pin).then(
      () => {
        // A hold pins and stays, so more results can be pinned; the row shows the pin.
        if (!pin || pinMode) closeSwitcher()
      },
      () => setError('Could not open the conversation.')
    )
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (first) run(first, pinMode)
  }

  const onTouchStart = (e: React.TouchEvent): void => {
    touchY.current = e.touches[0]?.clientY ?? null
  }
  const onTouchMove = (e: React.TouchEvent): void => {
    const y = e.touches[0]?.clientY
    if (touchY.current === null || y === undefined) return
    if (Math.abs(y - touchY.current) < DISMISS_MOVE) return
    touchY.current = null
    if (document.activeElement === field.current) field.current?.blur()
  }

  const label = pinMode ? 'Pin a channel, page or DM' : 'Search channels, pages, DMs and people'

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && closeSwitcher()}>
      <div aria-hidden className="bg-surface-scrim fixed inset-0 z-50" onClick={closeSwitcher} />
      <DialogPrimitive.Content
        data-slot="search-screen"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          restoreFocus(opener)
        }}
        className={cn(
          'border-line-strong bg-surface-panel fixed inset-x-0 top-[calc(var(--safe-top)+96px)] bottom-0 z-50 flex flex-col rounded-t-[26px] border-t pb-(--safe-bottom) outline-none in-data-[keyboard=open]:pb-0',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 duration-150'
        )}
      >
        <DialogPrimitive.Title className="sr-only">
          {pinMode ? 'Pin to tabs' : 'Search'}
        </DialogPrimitive.Title>
        <div aria-hidden className="flex h-[26px] shrink-0 items-center justify-center">
          <span className="bg-line-strong h-1 w-10 rounded-[2px]" />
        </div>
        <div className="shrink-0 px-4 pt-0.5 pb-3">
          <form
            role="search"
            onSubmit={submit}
            className="rounded-pill border-here/40 bg-surface-sunken focus-within:border-here flex h-[46px] min-w-0 items-center gap-2.5 border-[1.5px] px-4"
          >
            {pinMode ? (
              <Pin aria-hidden className="text-here size-[17px] shrink-0" />
            ) : (
              <Search aria-hidden className="text-here size-[17px] shrink-0" />
            )}
            <input
              ref={field}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setError(null)
              }}
              placeholder={pinMode ? 'Pin a channel, page or DM' : 'Search or jump to'}
              aria-label={label}
              className="text-text-primary placeholder:text-text-tertiary caret-here h-full min-w-0 flex-1 appearance-none bg-transparent text-base leading-5 font-normal outline-none [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
            />
            {typed && (
              <span className={cn(META, 'shrink-0')}>
                {count} {count === 1 ? 'RESULT' : 'RESULTS'}
              </span>
            )}
            {query !== '' && (
              <button
                type="button"
                aria-label="Clear search"
                // Keeps the focus (and the keyboard) in the field.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery('')
                  setError(null)
                  field.current?.focus()
                }}
                className={cn(KIT_ICON_BUTTON, 'text-text-tertiary active:bg-surface-hover -mr-2')}
              >
                <CircleX className="size-[17px]" />
              </button>
            )}
          </form>
          <DialogPrimitive.Close className="sr-only">Close</DialogPrimitive.Close>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <FilterChips
            type="single"
            label="Show"
            options={CHIPS}
            value={filter.kind}
            onValueChange={(kind) => setSwitcherFilter({ kind })}
            className="shrink-0 px-4 pb-2"
          >
            <GuildChip guildId={filter.guildId} />
          </FilterChips>
          {error && (
            <p
              role="alert"
              className="text-you-text shrink-0 px-4 pt-1.5 text-[13px] leading-4 font-semibold"
            >
              {error}
            </p>
          )}
          <div
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            className={cn(
              'min-h-0 flex-1 overflow-y-auto overscroll-contain px-0 pt-0.5 pb-3'
            )}
          >
            {sections.length === 0 ? (
              <p className="text-text-tertiary px-4 py-8 text-center text-[14px] leading-5 font-medium">
                {typed
                  ? `No ${EMPTY_NOUN[filter.kind]} match.`
                  : `No ${EMPTY_NOUN[filter.kind]} yet.`}
              </p>
            ) : (
              sections.map((s) => (
                <ResultSection
                  key={s.group}
                  group={s.group}
                  items={s.items}
                  query={query}
                  lit={typed ? first : undefined}
                  tabs={tabs}
                  pinMode={pinMode}
                  onPick={run}
                />
              ))
            )}
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  )
}

/** "In: any guild" or "In: <guild>": a menu sheet with the guilds in the user's order. */
function GuildChip({ guildId }: { guildId: string | null }): React.JSX.Element | null {
  const guilds = useGuildStore((s) => s.guilds)
  const order = useGuildOrder()
  const ids = useMemo(() => orderedIds([...guilds.keys()], order), [guilds, order])
  if (ids.length === 0) return null
  const name = guildId !== null ? guilds.get(guildId)?.name : undefined
  return (
    <MenuSheet>
      <MenuSheetTrigger asChild>
        <FilterChip
          menu
          active={name !== undefined}
          className={cn(
            'h-8 gap-[5px] border px-2.5',
            name !== undefined ? 'border-here/40 bg-here-tint' : 'border-line-strong bg-transparent'
          )}
        >
          <span
            className={cn(
              'font-mono text-[7.5px] tracking-[0.8px] uppercase',
              name !== undefined ? 'text-here-text' : 'text-text-disabled'
            )}
          >
            IN
          </span>
          <span
            className={cn(
              'max-w-40 truncate text-[11.5px] font-semibold',
              name !== undefined ? 'text-here-text' : 'text-text-secondary'
            )}
          >
            {name ?? 'Any space'}
          </span>
        </FilterChip>
      </MenuSheetTrigger>
      <MenuSheetContent title="Search in">
        <MenuSheetRadioGroup
          aria-label="Space"
          value={name !== undefined && guildId !== null ? guildId : ANY_GUILD}
          onValueChange={(v) => setSwitcherFilter({ guildId: v === ANY_GUILD ? null : v })}
        >
          <MenuSheetRadioItem value={ANY_GUILD}>
            <Globe />
            Any space
          </MenuSheetRadioItem>
          {ids.map((id) => {
            const g = guilds.get(id)
            if (!g) return null
            return (
              <MenuSheetRadioItem key={id} value={id}>
                <GuildTile guild={g} className="size-5 border-0 text-[9px]" />
                <span className="min-w-0 truncate">{g.name}</span>
              </MenuSheetRadioItem>
            )
          })}
        </MenuSheetRadioGroup>
      </MenuSheetContent>
    </MenuSheet>
  )
}

interface ResultProps {
  item: SwitchItem
  query: string
  /** The result that the Search key opens: lit. */
  lit: boolean
  pinned: boolean
  pinMode: boolean
  onPick: (item: SwitchItem, pin: boolean) => void
}

function ResultSection({
  group,
  items,
  query,
  lit,
  tabs,
  pinMode,
  onPick
}: {
  group: SwitchGroup
  items: SwitchItem[]
  query: string
  lit: SwitchItem | undefined
  tabs: readonly TabTarget[]
  pinMode: boolean
  onPick: (item: SwitchItem, pin: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id}>
      <h2
        id={id}
        className="text-text-disabled flex h-[30px] items-center px-[18px] font-mono text-[8px] tracking-[1.4px] uppercase"
      >
        {GROUP_LABEL[group]}
      </h2>
      <ul className="flex flex-col">
        {items.map((it) => (
          <Result
            key={it.key}
            item={it}
            query={query}
            lit={it === lit}
            pinned={isPinnedItem(tabs, it)}
            pinMode={pinMode}
            onPick={onPick}
          />
        ))}
      </ul>
    </section>
  )
}

function Result(props: ResultProps): React.JSX.Element {
  const { item } = props
  if (item.kind === 'voice') return <VoiceResult {...props} />
  if (item.kind === 'person' || item.kind === 'dm') return <PersonResult {...props} />
  return <ChannelResult {...props} />
}

function KindIcon({
  kind,
  lit,
  live = false
}: {
  kind: ChannelKind
  lit: boolean
  live?: boolean
}): React.JSX.Element {
  const Icon = KIND_ICON[kind]
  return (
    <Icon
      aria-hidden
      className={cn(
        'size-[18px] shrink-0',
        lit ? 'text-here' : live ? 'text-live' : 'text-text-tertiary'
      )}
    />
  )
}

/** A text or pages channel, or a page: the guild, and for a page its pages channel. */
function ChannelResult(props: ResultProps): React.JSX.Element {
  const { item } = props
  const kind = item.kind as ChannelKind
  const parent = useChannelStore((s) =>
    item.kind === 'page' && item.channelId ? s.channels.get(item.channelId)?.name : undefined
  )
  const where = item.guildName ?? ''
  const detail = kind === 'page' && parent ? `${where} · #${parent}` : where
  return (
    <ResultRow {...props} lead={<KindIcon kind={kind} lit={props.lit} />} detail={detail} />
  )
}

/** A voice channel: the live pill while someone is in the call. */
function VoiceResult(props: ResultProps): React.JSX.Element {
  const { item } = props
  const occupants = useChannelOccupants(item.guildId, item.channelId ?? '')
  const inCall = occupants.length > 0
  return (
    <ResultRow
      {...props}
      lead={<KindIcon kind="voice" lit={props.lit} live={inCall} />}
      detail={item.guildName ?? ''}
      marks={inCall && <LivePill className="px-2 py-[3px] text-[7.5px]">IN A CALL</LivePill>}
    />
  )
}

/**
 * Where `userId` is in voice, in any guild. Unlike `useVoiceActivity` it does not follow who
 * speaks, so a long result list does not re-render on every speaking change of the own call.
 */
function useVoicePlace(userId: string): VoiceActivity | null {
  const voiceStates = useVoiceStore((s) => s.voiceStates)
  const channels = useChannelStore((s) => s.channels)
  const guilds = useGuildStore((s) => s.guilds)
  return useMemo(
    () =>
      voiceActivity(userId, null, {
        voiceStates,
        channels,
        guilds,
        speaking: NO_SPEAKERS,
        myChannelId: null
      }),
    [userId, voiceStates, channels, guilds]
  )
}

/**
 * A DM or a person: the avatar, the name, the guild (or "Direct message" or the voice place) and
 * the presence as a word. A group DM has a tile. A Message button sits beside the row.
 */
function PersonResult(props: ResultProps): React.JSX.Element {
  const { item, pinMode, onPick } = props
  const userId = item.userId ?? ''
  const firstGuild = item.guildIds?.[0] ?? null
  const status = usePresence(item.userId)
  const activity = useVoicePlace(userId)
  const guildName = useGuildStore((s) => (firstGuild ? s.guilds.get(firstGuild)?.name : undefined))
  const more = (item.guildIds?.length ?? 0) - 1
  const group = item.kind === 'dm' && item.userId === undefined

  let detail: string
  if (group) detail = 'Group message'
  else if (activity) {
    const verb = activity.streaming ? 'Streaming' : 'In'
    const where = activity.otherGuildName ? ` · ${activity.otherGuildName}` : ''
    detail = `${verb} ${activity.channelName}${where}`
  } else if (item.kind === 'dm') detail = 'Direct message'
  else detail = guildName ? `${guildName}${more > 0 ? ` +${more}` : ''}` : ''

  return (
    <ResultRow
      {...props}
      lead={
        group ? (
          <span
            aria-hidden
            className="bg-surface-raised text-text-tertiary flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-4"
          >
            <Users />
          </span>
        ) : (
          <UserAvatar name={item.name} avatar={item.avatar} size={28} />
        )
      }
      detail={detail}
      marks={!group && <PresenceWord status={status} />}
      action={
        !group &&
        !pinMode && (
          <button
            type="button"
            aria-label={`Message ${item.name}`}
            onClick={() => onPick(item, false)}
            className={cn(
              KIT_ICON_BUTTON,
              'bg-surface-hover text-text-secondary active:bg-surface-selected [&_svg]:size-[17px]'
            )}
          >
            <MessageSquare />
          </button>
        )
      }
    />
  )
}

/** The name with the match lit (`matchRange`). */
function Lit({ name, query }: { name: string; query: string }): React.JSX.Element {
  const range = matchRange(name, query)
  if (!range) return <>{name}</>
  const [from, to] = range
  return (
    <>
      {name.slice(0, from)}
      <mark className="border-you/40 bg-you-tint text-you-text rounded-[3px] border px-1 py-px font-semibold">
        {name.slice(from, to)}
      </mark>
      {name.slice(to)}
    </>
  )
}

/**
 * One result row (50): the icon or avatar, the name (15) with the match lit, the guild or place
 * as a mono caption on the right, then the marks (live, presence, pinned, unread) and an optional
 * action button beside the row.
 */
function ResultRow({
  item,
  query,
  lit,
  pinned,
  pinMode,
  onPick,
  lead,
  detail,
  marks,
  action
}: ResultProps & {
  lead: React.ReactNode
  detail: string
  marks?: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  const badge = useChannelUnread(item.channelId ?? '')
  const hold = useLongPress(() => onPick(item, true))
  return (
    <li data-lit={lit || undefined} className={cn('relative flex h-[50px] items-center', lit && 'bg-here-tint')}>
      {lit && (
        <span
          aria-hidden
          className="bg-here absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-[2px]"
        />
      )}
      <button
        type="button"
        onClick={() => onPick(item, pinMode)}
        {...hold}
        className={cn(
          'flex h-full min-w-0 flex-1 items-center gap-[13px] px-[18px] text-left outline-none',
          'focus-visible:outline-line-focus active:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2',
          action && 'pr-3',
          LONG_PRESS_TARGET
        )}
      >
        {lead}
        <span
          className={cn(
            'text-text-primary min-w-0 truncate text-[15px] leading-[18px]',
            lit && 'font-semibold'
          )}
        >
          <Lit name={item.name || 'Untitled'} query={query} />
        </span>
        <span className="flex-1" />
        {detail && <span className={cn(META, 'min-w-0 truncate')}>{detail}</span>}
        {marks}
        {pinned && <Pin aria-label="Pinned" className="text-text-disabled size-3.5 shrink-0" />}
        <UnreadMark badge={badge} size="sm" />
      </button>
      {action && <span className="flex shrink-0 pr-3">{action}</span>}
    </li>
  )
}
