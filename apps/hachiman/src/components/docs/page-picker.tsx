import { useMemo, useState } from 'react'
import { FileText } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { pageTitle } from '@/services/docs/page-tree'

const MAX_ROWS = 50

/** "Link to page": a filterable list of the pages of every loaded pages channel, at a point. */
export function PagePicker({
  at,
  excludeId,
  onPick,
  onClose
}: {
  at: { left: number; top: number }
  excludeId?: string
  onPick: (page: { id: string; title: string }) => void
  onClose: () => void
}): React.JSX.Element {
  const pagesByChannel = useDocsStore((s) => s.pagesByChannel)
  const channels = useChannelStore((s) => s.channels)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out: { page: PageNode; title: string; channel: string }[] = []
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
