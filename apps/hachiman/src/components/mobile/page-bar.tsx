import { useEffect } from 'react'
import { ArrowUpRight, ChevronDown, FileText, Loader2, Plus } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { openDrawer } from '@/components/mobile/drawer-state'
import { Skeleton } from '@/components/ui/skeleton'
import { usePermissions } from '@/hooks/use-hachiman'
import { cn } from '@/lib/utils'
import { channelPageId, pageTitle } from '@/services/docs/page-tree'
import {
  rememberPage,
  useChannelPages,
  useLastPageId,
  useNewPage
} from '@/services/docs/use-channel-pages'
import { useDocsStore } from '@/stores/docsStore'
import { navigate } from '@/stores/navStore'

/** "Open page" (M37): 38 high, the page violet with a dark ink, 14/800, icon 16. */
const ACTION = cn(
  'rounded-control bg-feature-page flex h-[38px] shrink-0 items-center gap-1.5 pr-3 pl-[13px] text-[14px] leading-[18px] font-extrabold text-[#1b0f33]',
  'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:outline-offset-2 active:brightness-90 disabled:opacity-60',
  '[&_svg]:size-4 [&_svg]:shrink-0'
)

/**
 * The page bar of a pages channel on its chat (M37, 60, under the header): rule 05 "pages open on
 * their chat", the page one tap up. The tile, the page that the channel names (the open page,
 * else the one opened last, else the first of the tree), and "Open page", which pushes it. The
 * title opens the right drawer, which shows the pages of the channel. The meta line counts the
 * pages: a page has no last-edit time yet (spec §5). The bar goes while the keyboard is open, so
 * the chat keeps its room on a small phone.
 */
export function ChannelPageBar({ channel }: { channel: Channel }): React.JSX.Element {
  const channelId = channel.id
  const guildId = channel.guildId
  const { pages, loaded, failed } = useChannelPages(channelId)
  const openId = useDocsStore((s) => s.openPageByChannel.get(channelId) ?? null)
  const lastId = useLastPageId(channelId)
  const canEdit = has(usePermissions(guildId, channelId), Permissions.SEND_MESSAGES)
  const newPage = useNewPage(channel)

  useEffect(() => {
    if (openId !== null) rememberPage(channelId, openId)
  }, [channelId, openId])

  const pageId = channelPageId(pages, openId, lastId)
  const page = pageId !== null ? pages.find((p) => p.id === pageId) : undefined
  const count = pages.length

  const title = page
    ? pageTitle(page)
    : !loaded
      ? failed !== null
        ? 'Could not load the pages'
        : null
      : 'No pages yet'
  const meta =
    newPage.error ??
    (page
      ? `${count} ${count === 1 ? 'page' : 'pages'}`
      : loaded && canEdit
        ? 'Start the first page'
        : null)

  return (
    <div
      data-slot="page-bar"
      className="bg-feature-page/8 border-feature-page/20 flex h-15 shrink-0 items-center gap-3 border-b px-3 in-data-[keyboard=open]:hidden"
    >
      <span
        aria-hidden
        className="bg-feature-page/15 text-feature-page-text flex size-10 shrink-0 items-center justify-center"
      >
        <FileText className="size-5" />
      </span>
      <button
        type="button"
        onClick={() => openDrawer('right')}
        className="rounded-control focus-visible:outline-line-focus flex h-full min-w-0 flex-1 flex-col items-start justify-center gap-0.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 active:opacity-70"
      >
        <span className="flex max-w-full min-w-0 items-center gap-1">
          {title === null ? (
            <Skeleton className="h-4 w-36" />
          ) : (
            <span
              className={cn(
                'text-text-primary truncate text-[15px] leading-[18px] font-extrabold',
                page && page.titleState !== 'ok' && 'text-text-tertiary italic'
              )}
            >
              {title}
            </span>
          )}
          <ChevronDown className="text-text-tertiary size-[15px] shrink-0" aria-hidden />
          <span className="sr-only">, show the pages of #{channel.name}</span>
        </span>
        {meta !== null && (
          <span
            className={cn(
              'w-full truncate text-[12.5px] leading-4 font-medium',
              newPage.error !== null ? 'text-feature-danger-text' : 'text-text-tertiary'
            )}
          >
            {meta}
          </span>
        )}
      </button>
      {page && guildId !== null ? (
        <button
          type="button"
          className={ACTION}
          onClick={() => navigate({ kind: 'page', guildId, channelId, pageId: page.id })}
        >
          Open page
          <ArrowUpRight aria-hidden />
        </button>
      ) : (
        loaded &&
        canEdit && (
          <button type="button" className={ACTION} disabled={newPage.busy} onClick={newPage.create}>
            {newPage.busy ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            New page
          </button>
        )
      )}
    </div>
  )
}
