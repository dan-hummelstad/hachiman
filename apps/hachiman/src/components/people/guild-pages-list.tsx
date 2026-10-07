import { useEffect, useMemo, useState } from 'react'
import { FileText, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { useViewableChannels } from '@/hooks/use-hachiman'
import { guildPagesSections } from '@/lib/right-column'
import { docsService } from '@/services/docs/DocsService'
import { pageTitle } from '@/services/docs/page-tree'
import { useDocsStore } from '@/stores/docsStore'

/**
 * The Pages tab of a text channel (feature plan N21.1): the pages of every pages channel of the
 * guild that the user can view, with a filter. `onOpen` opens one beside the chat.
 */
export function GuildPagesList({
  guildId,
  onOpen
}: {
  guildId: string
  onOpen: (channelId: string, pageId: string) => void
}): React.JSX.Element {
  const channels = useViewableChannels(guildId, 'pages')
  const pagesByChannel = useDocsStore((s) => s.pagesByChannel)
  const [query, setQuery] = useState('')

  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let live = true
    for (const c of channels) {
      if (useDocsStore.getState().pagesByChannel.has(c.id)) continue
      docsService.loadPages(c.id).catch((e) => {
        console.warn('[pages] could not load the pages of', c.id, e)
        if (live) setFailed((f) => new Set(f).add(c.id))
      })
    }
    return () => {
      live = false
    }
  }, [channels])

  const sections = useMemo(
    () => guildPagesSections(channels, pagesByChannel, query),
    [channels, pagesByChannel, query]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0 px-2 pt-3 pb-1">
        <Search
          className="text-text-tertiary pointer-events-none absolute top-1/2 left-4.5 mt-1 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          aria-label="Filter pages"
          placeholder="Filter pages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-8 pl-8"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 px-2 py-2">
          {channels.length === 0 && (
            <p className="text-text-tertiary px-2 py-4 text-center text-sm">
              This guild has no pages channels.
            </p>
          )}
          {channels.length > 0 && sections.length === 0 && (
            <p className="text-text-tertiary px-2 py-4 text-center text-sm">No page matches.</p>
          )}
          {sections.map(({ channel, pages }) => (
            <section key={channel.id} aria-label={channel.name ?? 'Pages'}>
              <h3 className="section-label truncate px-2 pb-1">{channel.name}</h3>
              {!pages && failed.has(channel.id) ? (
                <p className="text-text-tertiary px-2 text-xs">Could not load the pages.</p>
              ) : !pages ? (
                <div className="flex flex-col gap-1.5 px-2 py-1" aria-busy="true">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : pages.length === 0 ? (
                <p className="text-text-tertiary px-2 text-xs">No pages yet.</p>
              ) : (
                <ul className="flex flex-col gap-px">
                  {pages.map(({ page, depth }) => (
                    <li key={page.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(channel.id, page.id)}
                        className="rounded-control hover:bg-surface-hover text-text-secondary hover:text-text-primary focus-visible:outline-line-focus flex h-8 w-full min-w-0 items-center gap-2 pr-2 text-left text-sm font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2"
                        style={{ paddingLeft: 8 + Math.min(depth, 4) * 14 }}
                      >
                        <FileText className="text-feature-page-text size-4 shrink-0" aria-hidden />
                        <span className="truncate">{pageTitle(page)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
