import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AtSign, FileText, Hash, Pin, Search, Volume2, type LucideIcon } from 'lucide-react'
import { MobileSearchScreen } from '@/components/mobile/search-screen'
import { PresenceWord } from '@/components/shell/presence-word'
import {
  activateItem,
  closeSwitcher,
  isPinnedItem,
  openSwitcher,
  useSwitcher,
  useSwitcherResults,
  type SwitcherMode
} from '@/components/shell/switcher-state'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Keycap } from '@/components/ui/keycap'
import { LivePill } from '@/components/ui/live'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useChannelOccupants } from '@/hooks/use-hachiman'
import { useKeybindLabel } from '@/hooks/use-keybinds'
import { useLayout } from '@/hooks/use-layout'
import { usePresence } from '@/hooks/use-member'
import { MOD_KEY } from '@/lib/mod-key'
import {
  groupResults,
  type SwitchGroup,
  type SwitchItem,
  type SwitchKind
} from '@/lib/quick-switcher'
import { cn } from '@/lib/utils'
import { useTabs } from '@/stores/tabsStore'
import { useSelectedGuildId } from '@/stores/navStore'
import { useChannelUnread } from '@/stores/unreadStore'

/** The field at the top of the sidebar: "Search or jump to… ⌘K". No keycap on a phone. */
export function SwitcherField(): React.JSX.Element {
  const key = useKeybindLabel('switcher')
  return (
    <button
      type="button"
      onClick={() => openSwitcher('open')}
      className="border-line-hairline bg-surface-sunken text-text-tertiary hover:text-text-secondary hover:border-line-strong rounded-control mobile:h-[38px] mobile:rounded-pill mobile:px-3.5 mobile:text-[14px] flex h-[34px] w-full items-center gap-2 border px-2.5 text-left text-[12.5px]"
    >
      <Search className="size-[13px] shrink-0" />
      <span className="flex-1 truncate">Search or jump to…</span>
      {key && <Keycap className="mobile:hidden">{key}</Keycap>}
    </button>
  )
}

const KIND_ICON: Record<SwitchKind, LucideIcon> = {
  text: Hash,
  voice: Volume2,
  pages: FileText,
  page: FileText,
  dm: AtSign,
  person: AtSign
}

const GROUP_LABEL: Record<SwitchGroup, string> = {
  recent: 'Recent',
  channels: 'Channels',
  people: 'People'
}

const META = 'text-text-disabled font-mono text-[8.5px] tracking-[1px] uppercase'
const FOOT_LABEL = 'text-text-disabled font-mono text-[8.5px] tracking-[0.9px]'

/**
 * The command palette (N6): a 640-wide panel with one field and the results across all guilds,
 * grouped as RECENT, CHANNELS and PEOPLE. On the mobile layout, the Jump-to sheet. No message
 * search: the server holds only ciphertext. Mount once in the shell.
 */
export function QuickSwitcher(): React.JSX.Element | null {
  const mode = useSwitcher((s) => s.mode)
  const mobile = useLayout() === 'mobile'
  if (mode === null) return null
  if (mobile) return <MobileSearchScreen mode={mode} />
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && closeSwitcher()}>
      <DialogPrimitive.Portal>
        <SwitcherPanel mode={mode} />
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function SwitcherPanel({ mode }: { mode: SwitcherMode }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const { results, recent, here } = useSwitcherResults(query)
  const sections = useMemo(
    () =>
      groupResults(
        results,
        recent.filter((k) => k !== here)
      ),
    [results, recent, here]
  )
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections])
  const tabs = useTabs()
  const selected = Math.min(index, Math.max(flat.length - 1, 0))

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const run = (it: SwitchItem | undefined, pin: boolean): void => {
    if (!it) return
    activateItem(it, pin).then(closeSwitcher, () => setError('Could not open the conversation.'))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = flat.length
      if (n > 0) setIndex((selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(flat[selected], mode === 'pin' || e.metaKey || e.ctrlKey)
    }
  }

  const count = flat.length
  let at = 0

  return (
    <>
      <DialogPrimitive.Overlay className="bg-surface-scrim fixed inset-0 z-50" />
      <DialogPrimitive.Content
        data-slot="quick-switcher"
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        className="border-line-strong bg-surface-raised text-text-primary fixed top-[13vh] left-1/2 z-50 flex w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-[12px] border shadow-(--shadow-soft)"
      >
        <DialogPrimitive.Title className="sr-only">
          {mode === 'pin' ? 'Pin to tabs' : 'Search or jump to'}
        </DialogPrimitive.Title>
        <div className="border-line-hairline flex h-[58px] shrink-0 items-center gap-3 border-b px-[18px]">
          {mode === 'pin' ? (
            <Pin className="text-here-text size-[18px] shrink-0" />
          ) : (
            <Search className="text-text-tertiary size-[18px] shrink-0" />
          )}
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
              setError(null)
            }}
            placeholder={mode === 'pin' ? 'Pin a channel, page or DM…' : 'Search or jump to…'}
            aria-label="Search channels, pages, DMs and people"
            aria-controls="quick-switcher-results"
            aria-activedescendant={flat[selected] ? `qs-${flat[selected].key}` : undefined}
            className="placeholder:text-text-tertiary caret-here min-w-0 flex-1 bg-transparent text-[16px] outline-none"
          />
          {query.trim() !== '' && (
            <span className={cn(META, 'tracking-[1.2px]')}>
              {count} {count === 1 ? 'RESULT' : 'RESULTS'}
            </span>
          )}
          <Keycap>Esc</Keycap>
        </div>
        <ul
          ref={listRef}
          id="quick-switcher-results"
          role="listbox"
          className="flex max-h-[452px] flex-col gap-px overflow-y-auto p-2"
        >
          {flat.length === 0 && (
            <li className="text-text-tertiary px-2.5 py-3 text-[13px]">
              No channels, pages, DMs or people match.
            </li>
          )}
          {sections.map((s) => (
            <Fragment key={s.group}>
              <li role="presentation" className="flex h-[30px] items-center px-2.5">
                <span className="text-text-disabled font-mono text-[8.5px] tracking-[1.4px] uppercase">
                  {GROUP_LABEL[s.group]}
                </span>
              </li>
              {s.items.map((it) => {
                const i = at++
                return (
                  <ResultRow
                    key={it.key}
                    item={it}
                    index={i}
                    active={i === selected}
                    pinned={isPinnedItem(tabs, it)}
                    onHover={() => setIndex(i)}
                    onPick={(pin) => run(it, mode === 'pin' || pin)}
                  />
                )
              })}
            </Fragment>
          ))}
        </ul>
        <div className="border-line-hairline bg-surface-sunken flex h-10 shrink-0 items-center gap-3.5 border-t px-4">
          {error ? (
            <span className="text-you-text text-[12px]">{error}</span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <Keycap>↑↓</Keycap>
                <span className={FOOT_LABEL}>navigate</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Keycap>↵</Keycap>
                <span className={FOOT_LABEL}>{mode === 'pin' ? 'pin' : 'open'}</span>
              </span>
              {mode !== 'pin' && (
                <span className="flex items-center gap-1.5">
                  <Keycap>{MOD_KEY}↵</Keycap>
                  <span className={FOOT_LABEL}>pin to tabs</span>
                </span>
              )}
            </>
          )}
          <span className="text-here-text ml-auto font-mono text-[8.5px] tracking-[1.1px]">
            SEARCHING ALL SPACES
          </span>
        </div>
      </DialogPrimitive.Content>
    </>
  )
}

function ResultRow({
  item,
  index,
  active,
  pinned,
  onHover,
  onPick
}: {
  item: SwitchItem
  index: number
  active: boolean
  pinned: boolean
  onHover: () => void
  onPick: (pin: boolean) => void
}): React.JSX.Element {
  const badge = useChannelUnread(item.channelId ?? '')
  const occupants = useChannelOccupants(item.guildId, item.channelId ?? '')
  const status = usePresence(item.userId)
  const selectedGuild = useSelectedGuildId()
  const Icon = KIND_ICON[item.kind]
  const person = item.kind === 'person' || item.kind === 'dm'
  const inCall = item.kind === 'voice' && occupants.length > 0
  return (
    <li
      id={`qs-${item.key}`}
      role="option"
      aria-selected={active}
      data-index={index}
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onPick(e.metaKey || e.ctrlKey)}
      className={cn(
        'rounded-control text-text-primary relative flex h-[42px] cursor-pointer items-center gap-[11px] px-2.5 text-[14px]',
        active && 'bg-here-tint font-semibold'
      )}
    >
      {active && (
        <span className="bg-here absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-[2px]" />
      )}
      {person ? (
        <UserAvatar name={item.name} avatar={item.avatar} size={24} cutout="bg-transparent" />
      ) : (
        <Icon
          className={cn(
            'size-4 shrink-0',
            active ? 'text-here' : inCall ? 'text-live' : 'text-text-tertiary'
          )}
        />
      )}
      <span className={cn('min-w-0 truncate', badge.unread && 'font-semibold')}>
        {item.name || 'Untitled'}
      </span>
      {(item.guildName || item.kind === 'dm') && (
        <span className={cn(META, 'flex min-w-0 items-center gap-1.5 truncate tracking-[0.9px]')}>
          {item.guildName ? (
            <>
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  item.guildId !== null && item.guildId === selectedGuild
                    ? 'bg-here'
                    : 'bg-text-disabled'
                )}
              />
              {item.guildName}
            </>
          ) : (
            'DIRECT MESSAGE'
          )}
        </span>
      )}
      <span className="flex-1" />
      {inCall && <LivePill>IN A CALL</LivePill>}
      {person && <PresenceWord status={status} />}
      {pinned && <Pin aria-label="Pinned" className="text-text-disabled size-3.5 shrink-0" />}
      <UnreadMark badge={badge} size="sm" />
    </li>
  )
}
