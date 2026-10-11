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
import { SectionLabel } from '@/components/mobile/list'
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
import { FEATURE_TILE } from '@/components/ui/feature'
import { GuildTile } from '@/components/ui/guild-tile'
import { SystemTag } from '@/components/ui/system-tag'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { LONG_PRESS_TARGET, useLongPress } from '@/hooks/use-long-press'
import { useMemberView, usePresence } from '@/hooks/use-member'
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
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
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

/**
 * The tinted window behind the search field: the shell's wallpaper (`WALLPAPER` in
 * `components/shell/shell.tsx`). The `--wallpaper-*` vars come from the MobileShell root, which
 * holds the screen (no portal).
 */
const WINDOW = 'bg-surface-window bg-(image:--wallpaper-light) dark:bg-(image:--wallpaper-dark)'

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

const KIND_TILE: Record<ChannelKind, string> = {
  text: 'bg-surface-hover text-text-tertiary',
  voice: FEATURE_TILE.voice,
  pages: FEATURE_TILE.page,
  page: FEATURE_TILE.page
}

/** The 32 square tile of a result (icon 16). */
const TILE = 'flex size-8 shrink-0 items-center justify-center [&_svg]:size-4'

/** The LIVE tag of the kit: 22 high, padding 7, 11/800, radius 4. */
const LIVE_TAG = 'h-[22px] rounded-[4px] px-[7px] text-[11px]'

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
      <DialogPrimitive.Content
        data-slot="search-screen"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          restoreFocus(opener)
        }}
        className={cn(
          'fixed inset-x-0 top-0 z-50 flex h-(--app-height,100dvh) flex-col pt-(--safe-top) outline-none',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-150',
          WINDOW
        )}
      >
        <DialogPrimitive.Title className="sr-only">
          {pinMode ? 'Pin to tabs' : 'Search'}
        </DialogPrimitive.Title>
        <div className="flex h-14 shrink-0 items-center gap-2.5 pr-2 pl-3">
          <form
            role="search"
            onSubmit={submit}
            className="rounded-control border-line-strong bg-surface-hover focus-within:border-line-focus focus-within:ring-line-focus flex h-11 min-w-0 flex-1 items-center gap-2.5 border pr-1 pl-3 focus-within:ring-[0.5px]"
          >
            {pinMode ? (
              <Pin aria-hidden className="text-accent-text size-[17px] shrink-0" />
            ) : (
              <Search aria-hidden className="text-text-secondary size-[17px] shrink-0" />
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
              className="text-text-primary placeholder:text-text-tertiary h-full min-w-0 flex-1 appearance-none bg-transparent text-base leading-5 font-medium outline-none [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
            />
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
                className={cn(KIT_ICON_BUTTON, 'text-text-tertiary active:bg-surface-hover')}
              >
                <CircleX className="size-[17px]" />
              </button>
            )}
          </form>
          <DialogPrimitive.Close className="text-accent-text focus-visible:outline-line-focus rounded-control h-11 shrink-0 px-1.5 text-[15px] leading-[18px] font-bold outline-none focus-visible:outline-2 active:opacity-70">
            Cancel
          </DialogPrimitive.Close>
        </div>
        <div className="bg-surface-content border-line-hairline flex min-h-0 flex-1 flex-col border-t pb-(--safe-bottom) in-data-[keyboard=open]:pb-0">
          <FilterChips
            type="single"
            label="Show"
            options={CHIPS}
            value={filter.kind}
            onValueChange={(kind) => setSwitcherFilter({ kind })}
            className="shrink-0 px-4 pt-2.5 pb-1.5"
          >
            <GuildChip guildId={filter.guildId} />
          </FilterChips>
          {error && (
            <p
              role="alert"
              className="text-feature-danger-text shrink-0 px-4 pt-1.5 text-[13px] leading-4 font-semibold"
            >
              {error}
            </p>
          )}
          <div
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            className={cn(
              'min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-0.5 pb-3',
              ROLE_INK_SCOPE
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
        <FilterChip menu active={name !== undefined}>
          <span className="max-w-40 truncate">In: {name ?? 'any guild'}</span>
        </FilterChip>
      </MenuSheetTrigger>
      <MenuSheetContent title="Search in">
        <MenuSheetRadioGroup
          aria-label="Guild"
          value={name !== undefined && guildId !== null ? guildId : ANY_GUILD}
          onValueChange={(v) => setSwitcherFilter({ guildId: v === ANY_GUILD ? null : v })}
        >
          <MenuSheetRadioItem value={ANY_GUILD}>
            <Globe />
            Any guild
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
      <SectionLabel id={id} className="flex h-[30px] items-end px-2 pt-0 pb-1">
        {GROUP_LABEL[group]}
      </SectionLabel>
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

function KindTile({ kind }: { kind: ChannelKind }): React.JSX.Element {
  const Icon = KIND_ICON[kind]
  return (
    <span aria-hidden className={cn(TILE, KIND_TILE[kind])}>
      <Icon />
    </span>
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
  const detail =
    kind === 'page' && parent
      ? `${where} · #${parent}`
      : kind === 'pages'
        ? `${where} · pages`
        : where
  return <ResultRow {...props} lead={<KindTile kind={kind} />} detail={detail} />
}

/** A voice channel: "n in call", and LIVE while someone streams. */
function VoiceResult(props: ResultProps): React.JSX.Element {
  const { item } = props
  const occupants = useChannelOccupants(item.guildId, item.channelId ?? '')
  const live = occupants.some((vs) => vs.selfStream)
  const count = occupants.length
  const detail = [item.guildName, 'voice', count > 0 && `${count} in call`]
    .filter(Boolean)
    .join(' · ')
  return (
    <ResultRow
      {...props}
      lead={<KindTile kind="voice" />}
      detail={detail}
      marks={live && <SystemTag kind="live" className={LIVE_TAG} />}
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
 * A DM or a person: the avatar with presence (purple while streaming), the name in the role ink of
 * a shared guild, the voice activity or the guild, and a Message button. A group DM has a tile.
 */
function PersonResult(props: ResultProps): React.JSX.Element {
  const { item, pinMode, onPick } = props
  const userId = item.userId ?? ''
  const firstGuild = item.guildIds?.[0] ?? null
  const status = usePresence(item.userId)
  const activity = useVoicePlace(userId)
  const { ink } = useMemberView(firstGuild, userId)
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
            className={cn(TILE, 'bg-surface-hover text-text-tertiary rounded-full')}
          >
            <Users />
          </span>
        ) : (
          <UserAvatar
            name={item.name}
            avatar={item.avatar}
            color={ink}
            size={32}
            status={status}
            live={activity?.streaming ?? false}
            ringHole
          />
        )
      }
      nameStyle={group ? undefined : { color: ink }}
      detail={detail}
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
      <mark className="bg-accent-primary/32 text-text-primary rounded-[3px] px-px font-extrabold">
        {name.slice(from, to)}
      </mark>
      {name.slice(to)}
    </>
  )
}

/**
 * One result row (52): the tile or avatar, the name (15/700) with the match lit, the detail line
 * (12.5/500), then the marks (LIVE, pinned, unread) and an optional action button beside the row.
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
  nameStyle,
  marks,
  action
}: ResultProps & {
  lead: React.ReactNode
  detail: string
  nameStyle?: React.CSSProperties
  marks?: React.ReactNode
  action?: React.ReactNode
}): React.JSX.Element {
  const badge = useChannelUnread(item.channelId ?? '')
  const hold = useLongPress(() => onPick(item, true))
  return (
    <li
      data-lit={lit || undefined}
      className={cn('rounded-control flex h-[52px] items-center', lit && 'bg-accent-primary/12')}
    >
      <button
        type="button"
        onClick={() => onPick(item, pinMode)}
        {...hold}
        className={cn(
          'rounded-control flex h-full min-w-0 flex-1 items-center gap-3 px-2 text-left outline-none',
          'focus-visible:outline-line-focus active:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2',
          action ? 'pr-3' : 'pr-2',
          LONG_PRESS_TARGET
        )}
      >
        {lead}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            style={nameStyle}
            className="text-text-primary truncate text-[15px] leading-[18px] font-bold"
          >
            <Lit name={item.name || 'Untitled'} query={query} />
          </span>
          {detail && (
            <span className="text-text-tertiary truncate text-[12.5px] leading-[15px] font-medium">
              {detail}
            </span>
          )}
        </span>
        {marks}
        {pinned && <Pin aria-label="Pinned" className="text-text-tertiary size-3.5 shrink-0" />}
        <UnreadMark badge={badge} size="sm" />
      </button>
      {action && <span className="flex shrink-0 pr-2">{action}</span>}
    </li>
  )
}
