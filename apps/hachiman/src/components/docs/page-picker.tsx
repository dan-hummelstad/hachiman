import { useId, useMemo, useState } from 'react'
import { FileText, Link2, Search } from 'lucide-react'
import { ListGroup, ListRow } from '@/components/mobile/list'
import { Sheet, SheetBody, SheetContent, SheetHeader } from '@/components/mobile/sheet'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { pageTitle } from '@/services/docs/page-tree'
import { focusMoreIfLost } from './page-editor-state'

const MAX_ROWS = 50

interface PageRow {
  page: PageNode
  title: string
  channel: string
}

/** The pages of every loaded pages channel whose title holds `filter`, but `excludeId`. */
function usePageRows(filter: string, excludeId: string | undefined): PageRow[] {
  const pagesByChannel = useDocsStore((s) => s.pagesByChannel)
  const channels = useChannelStore((s) => s.channels)
  return useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: PageRow[] = []
    for (const [channelId, list] of pagesByChannel) {
      const channel = channels.get(channelId)?.name ?? ''
      for (const page of list) {
        if (page.id === excludeId || page.titleState !== 'ok') continue
        const title = pageTitle(page)
        if (q && !title.toLowerCase().includes(q)) continue
        out.push({ page, title, channel })
      }
    }
    return out.slice(0, MAX_ROWS)
  }, [pagesByChannel, channels, filter, excludeId])
}

interface PickerBase {
  excludeId?: string
  onPick: (page: { id: string; title: string }) => void
  onClose: () => void
}

/**
 * "Link to page": a filterable list of the pages of every loaded pages channel. `popover` (the
 * desktop editor): at a point. `sheet` (the touch editor, docs/ios-mobile-ui-spec.md F3a): a bottom
 * sheet with a search field.
 */
export function PagePicker(
  props: PickerBase &
    (
      | { variant?: 'popover'; at: { left: number; top: number } }
      | { variant: 'sheet'; open: boolean }
    )
): React.JSX.Element {
  if (props.variant === 'sheet') return <PagePickerSheet {...props} />
  return <PagePickerPopover {...props} />
}

function PagePickerPopover({
  at,
  excludeId,
  onPick,
  onClose
}: PickerBase & { at: { left: number; top: number } }): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const rows = usePageRows(filter, excludeId)

  const pick = (i: number): void => {
    const row = rows[i]
    if (row) onPick({ id: row.page.id, title: row.title })
  }

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none fixed size-0" style={{ left: at.left, top: at.top }} />
      </PopoverAnchor>
      <PopoverContent align="start" className="w-72 p-1">
        <Input
          autoFocus
          value={filter}
          placeholder="Search pages"
          className="mb-1 h-8"
          onChange={(e) => {
            setFilter(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive((i) => Math.min(rows.length - 1, i + 1))
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
            else if (e.key === 'Enter') pick(active)
            else return
            e.preventDefault()
          }}
        />
        <ul className="max-h-64 overflow-y-auto" role="listbox">
          {rows.length === 0 && (
            <li className="text-muted-foreground px-2 py-1.5 text-sm">No pages</li>
          )}
          {rows.map((r, i) => (
            <li key={r.page.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={cn(
                  'hover:bg-accent flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm',
                  i === active && 'bg-accent'
                )}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <FileText className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                {r.channel && (
                  <span className="text-muted-foreground shrink-0 truncate text-xs">
                    {r.channel}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The touch form: a sheet with a Sheet Header, a 48 search field and 54 page rows (title, channel).
 * The sheet sits on the keyboard (`--kb`) and its list scrolls, so it fits an iPhone SE with the
 * keyboard up. Opening moves the focus straight to the search field: the editor opens the sheet in
 * the tap, so iOS keeps the keyboard up. The sheet gives no focus back on close: a pick inserts the
 * link and focuses the editor in its own tap; a sheet closed with no pick leaves the keyboard down.
 */
function PagePickerSheet({
  open,
  excludeId,
  onPick,
  onClose
}: PickerBase & { open: boolean }): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const field =
            e.currentTarget instanceof HTMLElement && e.currentTarget.querySelector('input')
          if (field) field.focus({ preventScroll: true })
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          focusMoreIfLost()
        }}
      >
        <SheetHeader icon={<Link2 />} feature="page" title="Link to page" />
        <PickerList excludeId={excludeId} onPick={onPick} />
      </SheetContent>
    </Sheet>
  )
}

/** The search field and the rows. Mounted with the open sheet, so each open starts empty. */
function PickerList({
  excludeId,
  onPick
}: Pick<PickerBase, 'excludeId' | 'onPick'>): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const rows = usePageRows(filter, excludeId)
  const listId = useId()
  const pick = (row: PageRow | undefined): void => {
    if (row) onPick({ id: row.page.id, title: row.title })
  }
  return (
    <>
      <Input
        size="touch"
        type="search"
        enterKeyHint="go"
        autoComplete="off"
        lead={<Search />}
        value={filter}
        placeholder="Search pages"
        aria-label="Search pages"
        aria-controls={listId}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          pick(rows[0])
        }}
      />
      <SheetBody>
        {rows.length === 0 ? (
          <p
            id={listId}
            className="text-text-tertiary py-6 text-center text-[13.5px] leading-5 font-medium"
          >
            {filter.trim() ? 'No page has this name.' : 'No pages to link.'}
          </p>
        ) : (
          <ListGroup id={listId} aria-label="Pages" className="shrink-0">
            {rows.map((row) => (
              <ListRow
                key={row.page.id}
                icon={<FileText />}
                tile="page"
                label={row.title}
                detail={row.channel ? `#${row.channel}` : undefined}
                chevron={false}
                onClick={() => pick(row)}
              />
            ))}
          </ListGroup>
        )}
      </SheetBody>
    </>
  )
}
