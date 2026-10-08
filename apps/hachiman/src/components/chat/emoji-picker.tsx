import { useMemo, useRef, useState } from 'react'
import { Clock, Search } from 'lucide-react'
import type { Guild, GuildEmoji } from '@hachiman/client'
import { GuildTile } from '@/components/ui/guild-tile'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useEmojiData } from '@/hooks/use-emoji-data'
import { parseReactionKey, reactionKeyOf, type EmojiPick } from '@/lib/custom-emoji'
import {
  EMOJI_GROUPS,
  SKIN_TONES,
  searchEmoji,
  withSkin,
  type EmojiData,
  type UnicodeEmoji
} from '@/lib/emoji-data'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { CustomEmojiImage } from './emoji'

const COLS = 8
const FOCUS = 'focus-visible:outline-line-focus outline-none focus-visible:outline-2'
const NO_EMOJIS: readonly GuildEmoji[] = []

/** One cell of the grid. */
type Cell =
  | { kind: 'unicode'; key: string; emoji: string; base: UnicodeEmoji | null }
  | { kind: 'custom'; key: string; emoji: GuildEmoji }

interface Section {
  id: string
  label: string
  /** The category tab. */
  tab: React.ReactNode
  cells: Cell[]
}

const unicodeCell = (e: UnicodeEmoji, tone: number): Cell => {
  const emoji = withSkin(e, tone)
  return { kind: 'unicode', key: emoji, emoji, base: e }
}
const customCell = (e: GuildEmoji): Cell => ({ kind: 'custom', key: e.id, emoji: e })

/**
 * The emoji picker in a popover anchored to `children` (the button that opens it): search by name,
 * shortcode or tag, a section per guild with custom emojis (the current guild first), the
 * recently used emojis and the Unicode categories. Controlled, so the message toolbar can stay
 * shown while it is open. Recent picks and the skin tone persist in prefsStore.
 */
export function EmojiPicker({
  open,
  onOpenChange,
  onPick,
  guildId,
  label = 'Pick an emoji',
  side = 'top',
  align = 'end',
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (pick: EmojiPick) => void
  /** The guild of the conversation: its custom emojis come first. */
  guildId: string | null
  label?: string
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex">{children}</span>
      </PopoverAnchor>
      <PopoverContent
        side={side}
        align={align}
        className="bg-surface-raised border-line-hairline flex h-[420px] w-[360px] flex-col p-0"
        aria-label={label}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).querySelector('input')?.focus()
        }}
      >
        {open && (
          <PickerPanel
            guildId={guildId}
            onPick={(pick) => {
              onPick(pick)
              onOpenChange(false)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function useSections(data: EmojiData | null, guildId: string | null, tone: number): Section[] {
  const emojis = useGuildStore((s) => s.emojis)
  const guilds = useGuildStore((s) => s.guilds)
  const index = useGuildStore((s) => s.emojiIndex)
  const recent = usePrefsStore((s) => s.recentEmojis)
  return useMemo(() => {
    const out: Section[] = []
    const recentCells = recent.flatMap((key): Cell[] => {
      const custom = parseReactionKey(key)
      if (!custom)
        return [{ kind: 'unicode', key, emoji: key, base: data?.byEmoji.get(key) ?? null }]
      const e = index.get(custom.id)
      return e ? [customCell(e)] : []
    })
    if (recentCells.length > 0)
      out.push({
        id: 'recent',
        label: 'Recently used',
        tab: <Clock className="size-[18px]" />,
        cells: recentCells
      })
    const order = [...guilds.values()].sort((a, b) =>
      a.id === guildId ? -1 : b.id === guildId ? 1 : 0
    )
    for (const g of order) {
      const list = emojis.get(g.id) ?? NO_EMOJIS
      if (list.length === 0) continue
      out.push({
        id: `guild:${g.id}`,
        label: g.name,
        tab: <GuildTile guild={g} className="size-5 text-[9px]" />,
        cells: list.map(customCell)
      })
    }
    if (data) {
      const byGroup = EMOJI_GROUPS.map((): Cell[] => [])
      for (const e of data.emojis) byGroup[e.group]?.push(unicodeCell(e, tone))
      EMOJI_GROUPS.forEach((g, i) =>
        out.push({
          id: g.id,
          label: g.label,
          tab: <span className="text-[17px] leading-none">{g.icon}</span>,
          cells: byGroup[i] ?? []
        })
      )
    }
    return out
  }, [data, guildId, tone, emojis, guilds, index, recent])
}

/** Custom emojis whose names match `query`, the current guild first. */
function searchCustom(
  emojis: ReadonlyMap<string, readonly GuildEmoji[]>,
  guilds: ReadonlyMap<string, Guild>,
  guildId: string | null,
  query: string
): GuildEmoji[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '')
  if (!q) return []
  const all = [...emojis.entries()]
    .filter(([g]) => guilds.has(g))
    .sort(([a], [b]) => (a === guildId ? -1 : b === guildId ? 1 : 0))
    .flatMap(([, list]) => list)
  const starts = all.filter((e) => e.name.startsWith(q))
  const contains = all.filter((e) => !e.name.startsWith(q) && e.name.includes(q))
  return [...starts, ...contains].slice(0, 40)
}

function PickerPanel({
  guildId,
  onPick
}: {
  guildId: string | null
  onPick: (pick: EmojiPick) => void
}): React.JSX.Element {
  const data = useEmojiData()
  const tone = usePrefsStore((s) => s.skinTone)
  const setTone = usePrefsStore((s) => s.setSkinTone)
  const addRecent = usePrefsStore((s) => s.addRecentEmoji)
  const emojis = useGuildStore((s) => s.emojis)
  const guilds = useGuildStore((s) => s.guilds)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<Cell | null>(null)
  const [tones, setTones] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const sections = useSections(data, guildId, tone)

  const results = useMemo((): Cell[] | null => {
    if (!query.trim()) return null
    const custom = searchCustom(emojis, guilds, guildId, query).map(customCell)
    const unicode = data ? searchEmoji(data, query).map((e) => unicodeCell(e, tone)) : []
    return [...custom, ...unicode]
  }, [query, emojis, guilds, guildId, data, tone])

  const pick = (cell: Cell): void => {
    const p: EmojiPick =
      cell.kind === 'unicode'
        ? { kind: 'unicode', emoji: cell.emoji }
        : { kind: 'custom', emoji: cell.emoji }
    addRecent(reactionKeyOf(p))
    onPick(p)
  }

  /** Arrow keys move between the cells; Enter and Space pick (the buttons' own click). */
  const gridKey = (e: React.KeyboardEvent): void => {
    const cells = [...(body.current?.querySelectorAll<HTMLElement>('[data-emoji-cell]') ?? [])]
    const at = cells.indexOf(document.activeElement as HTMLElement)
    if (at < 0) return
    const step =
      e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowLeft'
          ? -1
          : e.key === 'ArrowDown'
            ? COLS
            : e.key === 'ArrowUp'
              ? -COLS
              : 0
    if (step === 0) return
    e.preventDefault()
    const next = at + step
    if (next < 0) return body.current?.closest('[role="dialog"]')?.querySelector('input')?.focus()
    cells[Math.min(next, cells.length - 1)]?.focus()
  }

  const grid = (cells: readonly Cell[]): React.JSX.Element => (
    <div className="grid grid-cols-8 gap-0.5 px-2" role="group">
      {cells.map((c) => (
        <button
          key={c.key}
          type="button"
          tabIndex={-1}
          data-emoji-cell
          aria-label={cellName(c)}
          onClick={() => pick(c)}
          onMouseEnter={() => setHover(c)}
          onFocus={() => setHover(c)}
          className={cn(
            'rounded-control hover:bg-surface-hover focus-visible:bg-surface-hover flex size-10 items-center justify-center text-[24px] leading-none',
            FOCUS
          )}
        >
          {c.kind === 'unicode' ? c.emoji : <CustomEmojiImage emoji={c.emoji} className="size-7" />}
        </button>
      ))}
    </div>
  )

  return (
    <>
      <div className="border-line-hairline flex items-center gap-2 border-b p-2">
        <label className="bg-surface-panel rounded-control flex h-8 min-w-0 flex-1 items-center gap-2 px-2">
          <Search className="text-text-tertiary size-4 shrink-0" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results?.[0]) {
                e.preventDefault()
                pick(results[0])
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                body.current?.querySelector<HTMLElement>('[data-emoji-cell]')?.focus()
              }
            }}
            placeholder="Search emoji"
            aria-label="Search emoji"
            className="placeholder:text-text-tertiary text-text-primary min-w-0 flex-1 bg-transparent text-[14px] outline-none"
          />
        </label>
        <div className="relative">
          <button
            type="button"
            aria-label={`Skin tone: ${SKIN_TONES[tone]?.label ?? 'Default'}`}
            aria-expanded={tones}
            onClick={() => setTones((v) => !v)}
            className={cn(
              'rounded-control hover:bg-surface-hover flex size-8 items-center justify-center text-[18px]',
              FOCUS
            )}
          >
            {SKIN_TONES[tone]?.swatch}
          </button>
          {tones && (
            <div
              role="radiogroup"
              aria-label="Skin tone"
              className="bg-surface-raised border-line-hairline absolute top-full right-0 z-10 mt-1 flex flex-col border p-1 shadow-lg"
            >
              {SKIN_TONES.map((t, i) => (
                <button
                  key={t.label}
                  type="button"
                  role="radio"
                  aria-checked={i === tone}
                  aria-label={t.label}
                  onClick={() => {
                    setTone(i)
                    setTones(false)
                  }}
                  className={cn(
                    'rounded-control hover:bg-surface-hover flex size-8 items-center justify-center text-[18px]',
                    i === tone && 'bg-surface-selected',
                    FOCUS
                  )}
                >
                  {t.swatch}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {results === null && (
        <nav
          aria-label="Emoji categories"
          className="border-line-hairline flex gap-0.5 overflow-x-auto border-b px-2 py-1"
        >
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.label}
              aria-label={s.label}
              onClick={() =>
                body.current
                  ?.querySelector(`[data-section="${s.id}"]`)
                  ?.scrollIntoView({ block: 'start' })
              }
              className={cn(
                'rounded-control text-text-tertiary hover:bg-surface-hover hover:text-text-primary flex size-8 shrink-0 items-center justify-center',
                FOCUS
              )}
            >
              {s.tab}
            </button>
          ))}
        </nav>
      )}
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto pb-2" onKeyDown={gridKey}>
        {results !== null ? (
          results.length > 0 ? (
            <div className="pt-2">{grid(results)}</div>
          ) : (
            <p className="text-text-tertiary px-4 py-8 text-center text-[13px]">
              {data ? 'No emoji matches.' : 'Loading emoji…'}
            </p>
          )
        ) : (
          <>
            {sections.map((s) => (
              <section
                key={s.id}
                data-section={s.id}
                aria-label={s.label}
                className="[content-visibility:auto]"
              >
                <h3 className="bg-surface-raised text-text-tertiary sticky top-0 z-[1] px-3 pt-2 pb-1 text-[11px] font-extrabold tracking-[0.4px] uppercase">
                  {s.label}
                </h3>
                {grid(s.cells)}
              </section>
            ))}
            {!data && (
              <p className="text-text-tertiary px-4 py-6 text-center text-[13px]">Loading emoji…</p>
            )}
          </>
        )}
      </div>
      <div
        className="border-line-hairline flex h-11 shrink-0 items-center gap-2 border-t px-3"
        aria-live="polite"
      >
        {hover ? (
          <>
            <span className="flex size-7 items-center justify-center text-[22px] leading-none">
              {hover.kind === 'unicode' ? (
                hover.emoji
              ) : (
                <CustomEmojiImage emoji={hover.emoji} className="size-6" />
              )}
            </span>
            <span className="text-text-primary min-w-0 truncate text-[13px] font-semibold">
              {cellCode(hover)}
            </span>
          </>
        ) : (
          <span className="text-text-tertiary text-[12.5px]">Pick an emoji</span>
        )}
      </div>
    </>
  )
}

/** The accessible name of a cell. */
function cellName(c: Cell): string {
  if (c.kind === 'custom') return `:${c.emoji.name}:`
  return c.base?.label ?? c.emoji
}

/** The footer text of a cell: its shortcode (custom: `:name:`), else its label. */
function cellCode(c: Cell): string {
  if (c.kind === 'custom') return `:${c.emoji.name}:`
  const sc = c.base?.shortcodes[0]
  return sc ? `:${sc}:` : (c.base?.label ?? c.emoji)
}
