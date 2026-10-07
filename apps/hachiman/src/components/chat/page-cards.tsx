import { useEffect } from 'react'
import { FileText, PanelRight } from 'lucide-react'
import { UserAvatar } from '@/components/shell/user-avatar'
import { useMemberView } from '@/hooks/use-member'
import { useNow } from '@/hooks/use-elapsed'
import { relativeTime } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { pageTitle } from '@/services/docs/page-tree'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { navigate } from '@/stores/navStore'
import type { ChatMessage } from '@/stores/messagesStore'
import { formatFull } from './format'

const FOCUS = 'focus-visible:outline-line-focus outline-none focus-visible:outline-2'

/** The pages channels whose page list is loading. */
const loading = new Set<string>()

/**
 * A page of a loaded pages channel (the stored node, so the selector result is stable), or
 * undefined. While it is not found, loads the page lists of the guild's pages channels once:
 * a link in #general names a page that the UI may not have loaded.
 */
function usePage(pageId: string, guildId: string | null): PageNode | undefined {
  const page = useDocsStore((s) => {
    for (const list of s.pagesByChannel.values()) {
      const p = list.find((x) => x.id === pageId)
      if (p) return p
    }
    return undefined
  })
  const found = page !== undefined
  useEffect(() => {
    if (found || guildId === null) return
    const { channels } = useChannelStore.getState()
    const loaded = useDocsStore.getState().pagesByChannel
    for (const c of channels.values()) {
      if (c.guildId !== guildId || c.type !== 'pages' || loaded.has(c.id) || loading.has(c.id))
        continue
      loading.add(c.id)
      docsService
        .loadPages(c.id)
        .catch((e: unknown) => console.warn('[chat] page list failed', e))
        .finally(() => loading.delete(c.id))
    }
  }, [found, guildId])
  return page
}

function openPage(page: PageNode, guildId: string): void {
  navigate({ kind: 'page', guildId, channelId: page.channelId, pageId: page.id })
}

/**
 * The square card of a page link in a message (N21.2, B1): the page icon, the decrypted title,
 * "Page in #channel · edited <time>" and "Open". A page that is not found (deleted, or in a
 * channel that I can't view) shows a muted card without "Open".
 */
export function PageLinkCard({
  pageId,
  guildId
}: {
  pageId: string
  guildId: string | null
}): React.JSX.Element {
  const page = usePage(pageId, guildId)
  const now = useNow(true, 60_000)
  const channelName = useChannelStore((s) =>
    page ? s.channels.get(page.channelId)?.name : undefined
  )
  return (
    <div
      className="bg-surface-panel border-line-hairline flex w-[440px] max-w-full items-center gap-3 border px-3 py-2.5"
      data-slot="page-link-card"
    >
      <span className="bg-feature-page/15 text-feature-page-text flex size-9 shrink-0 items-center justify-center">
        <FileText className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate text-[14px] leading-5 font-bold',
            page ? 'text-text-primary' : 'text-text-tertiary'
          )}
        >
          {page ? pageTitle(page) : 'Page not available'}
        </p>
        <p className="text-text-tertiary text-meta truncate">
          {page ? (
            <>
              Page in #{channelName ?? 'pages'} ·{' '}
              <time dateTime={page.updatedAt} title={formatFull(page.updatedAt)}>
                edited {relativeTime(page.updatedAt, now)}
              </time>
            </>
          ) : (
            'Deleted, or in a channel you can’t view'
          )}
        </p>
      </div>
      {page && guildId !== null && (
        <button
          type="button"
          onClick={() => openPage(page, guildId)}
          className={cn(
            'rounded-control bg-accent-tint text-accent-text hover:bg-accent-primary hover:text-text-on-accent flex h-8 shrink-0 items-center gap-1.5 px-3 text-[13px] font-semibold transition-colors',
            FOCUS
          )}
        >
          <PanelRight className="size-4" aria-hidden />
          Open
        </button>
      )}
    </div>
  )
}

/**
 * A page activity row (N21.3, C1): "<author> edited <page> · n changes · <time> · View". The
 * page is in the channel of the row (a pages channel). `rowKind` shows it only for a decrypted
 * row with `pageActivity`.
 */
export function PageActivityRow({ message }: { message: ChatMessage }): React.JSX.Element {
  const activity = message.pageActivity ?? { pageId: '', changes: 0 }
  const { name, avatar, ink } = useMemberView(message.guildId, message.author.id, message.author)
  const page = usePage(activity.pageId, message.guildId)
  const now = useNow(true, 60_000)
  const guildId = message.guildId
  const changes = `${activity.changes} ${activity.changes === 1 ? 'change' : 'changes'}`
  return (
    <div className="px-4 py-1" data-message-id={message.id}>
      <div className="bg-surface-panel border-line-hairline flex max-w-[640px] items-center gap-3 border px-3 py-2">
        <UserAvatar avatar={avatar} name={name} color={ink} size={24} />
        <div className="min-w-0 flex-1 text-[13.5px] leading-5">
          <p className="text-text-secondary truncate">
            <span
              className={cn('font-bold', !ink && 'text-text-primary')}
              style={ink ? { color: ink } : undefined}
            >
              {name}
            </span>{' '}
            edited{' '}
            <span className="text-text-primary font-semibold">
              {page ? pageTitle(page) : 'a page'}
            </span>
          </p>
          <p className="text-text-tertiary text-meta">
            {changes} ·{' '}
            <time dateTime={message.createdAt} title={formatFull(message.createdAt)}>
              {relativeTime(message.createdAt, now)}
            </time>
          </p>
        </div>
        {page && guildId !== null && (
          <button
            type="button"
            onClick={() => openPage(page, guildId)}
            className={cn(
              'rounded-control text-accent-text hover:bg-accent-tint h-8 shrink-0 px-3 text-[13px] font-semibold',
              FOCUS
            )}
          >
            View
          </button>
        )}
      </div>
    </div>
  )
}
