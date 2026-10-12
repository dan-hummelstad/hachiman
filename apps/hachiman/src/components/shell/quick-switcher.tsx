import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AtSign, FileText, Hash, Pin, Search, Volume2, type LucideIcon } from 'lucide-react'
import { MobileSearchScreen } from '@/components/mobile/search-screen'
import {
  activateItem,
  closeSwitcher,
  isPinnedItem,
  openSwitcher,
  useSwitcher,
  useSwitcherResults,
  type SwitcherMode
} from '@/components/shell/switcher-state'
import { useSidebarView } from '@/components/shell/sidebar-state'
import { FEATURE_TEXT } from '@/components/ui/feature'
import { Keycap } from '@/components/ui/keycap'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useKeybindLabel } from '@/hooks/use-keybinds'
import { useLayout } from '@/hooks/use-layout'
import { MOD_KEY } from '@/lib/mod-key'
import type { SwitchItem, SwitchKind } from '@/lib/quick-switcher'
import { cn } from '@/lib/utils'
import { useTabs } from '@/stores/tabsStore'
import { useChannelUnread } from '@/stores/unreadStore'
import { selectableRowClass } from '@/components/ui/selectable-row'

/** The field at the top of the sidebar: "Search or jump to… ⌘K". No keycap on a phone. */
export function SwitcherField(): React.JSX.Element {
  const key = useKeybindLabel('switcher')
  return (
    <button
      type="button"
      onClick={() => openSwitcher('open')}
      className="border-line-hairline bg-surface-sunken/60 text-text-tertiary hover:text-text-secondary hover:border-line-strong rounded-control flex h-9 w-full items-center gap-2 border px-2.5 text-left text-[13px]"
    >
      <Search className="size-4 shrink-0" />
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

const KIND_COLOUR: Record<SwitchKind, string> = {
  text: 'text-text-tertiary',
  voice: FEATURE_TEXT.voice,
  pages: FEATURE_TEXT.page,
  page: FEATURE_TEXT.page,
  dm: 'text-text-tertiary',
  person: 'text-text-tertiary'
}

/**
 * The quick switcher (N5): a 480-wide popover with one field and one list of results across all
 * guilds. On the mobile layout, the full-screen search (M66). No message search: the server holds
 * only ciphertext. Mount once in the shell.
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
  const sidebar = useSidebarView()
  const anchored = mode === 'open' && sidebar !== 'tucked'

  const { results } = useSwitcherResults(query)
  const tabs = useTabs()
  const selected = Math.min(index, Math.max(results.length - 1, 0))

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
      const n = results.length
      if (n > 0) setIndex((selected + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[selected], mode === 'pin' || e.metaKey || e.ctrlKey)
    }
  }

  return (
    <>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50" />
      <DialogPrimitive.Content
        data-slot="quick-switcher"
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        className={cn(
          'border-line-strong bg-surface-raised text-text-primary rounded-control fixed z-50 flex w-[480px] max-w-[calc(100vw-32px)] flex-col overflow-hidden border shadow-xl',
          anchored ? 'top-[54px] left-2.5' : 'top-14 left-1/2 -translate-x-1/2'
        )}
      >
        <DialogPrimitive.Title className="sr-only">
          {mode === 'pin' ? 'Pin to tabs' : 'Search or jump to'}
        </DialogPrimitive.Title>
        <div className="border-line-hairline flex h-11 shrink-0 items-center gap-2 border-b px-3">
          {mode === 'pin' ? (
            <Pin className="text-accent-text size-4 shrink-0" />
          ) : (
            <Search className="text-text-tertiary size-4 shrink-0" />
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
            aria-activedescendant={results[selected] ? `qs-${results[selected].key}` : undefined}
            className="placeholder:text-text-tertiary min-w-0 flex-1 bg-transparent text-[14px] outline-none"
          />
          <Keycap>Esc</Keycap>
        </div>
        <ul
          ref={listRef}
          id="quick-switcher-results"
          role="listbox"
          className="max-h-[360px] overflow-y-auto p-1.5"
        >
          {results.length === 0 && (
            <li className="text-text-tertiary px-2.5 py-3 text-[13px]">
              No channels, pages, DMs or people match.
            </li>
          )}
          {results.map((it, i) => (
            <ResultRow
              key={it.key}
              item={it}
              index={i}
              active={i === selected}
              pinned={isPinnedItem(tabs, it)}
              onHover={() => setIndex(i)}
              onPick={(pin) => run(it, mode === 'pin' || pin)}
            />
          ))}
        </ul>
        <div className="border-line-hairline text-text-tertiary flex h-8 shrink-0 items-center gap-3 border-t px-3 text-[11px]">
          {error ? (
            <span className="text-feature-danger-text">{error}</span>
          ) : mode === 'pin' ? (
            <span>
              <Keycap>↵</Keycap> pin
            </span>
          ) : (
            <>
              <span>
                <Keycap>↵</Keycap> open
              </span>
              <span>
                <Keycap>{MOD_KEY}↵</Keycap> pin to tabs
              </span>
            </>
          )}
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
  const Icon = KIND_ICON[item.kind]
  return (
    <li
      id={`qs-${item.key}`}
      role="option"
      aria-selected={active}
      data-index={index}
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onPick(e.metaKey || e.ctrlKey)}
      className={selectableRowClass(
        active,
        'text-text-primary flex h-9 cursor-pointer items-center gap-2.5 px-2.5 text-[14px]'
      )}
    >
      <Icon className={cn('size-4 shrink-0', KIND_COLOUR[item.kind])} />
      <span className={cn('min-w-0 truncate', badge.unread && 'font-bold')}>
        {item.name || 'Untitled'}
      </span>
      {item.kind === 'person' && <span className="text-text-tertiary text-xs">Person</span>}
      <span className="text-text-tertiary min-w-0 flex-1 truncate text-xs">
        {item.guildName ?? (item.kind === 'dm' ? 'Direct message' : '')}
      </span>
      {pinned && <Pin aria-label="Pinned" className="text-text-tertiary size-3.5 shrink-0" />}
      <UnreadMark badge={badge} size="sm" />
    </li>
  )
}
