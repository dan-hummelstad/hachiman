import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, FileText, Lock } from 'lucide-react'
import { LiveDot, LivePill } from '@/components/ui/live'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { hashString } from '@/lib/hash'
import { cn, errMsg } from '@/lib/utils'
import { countWords } from '@/lib/word-count'
import { docsService } from '@/services/docs/DocsService'
import { pagePath, pageTitle } from '@/services/docs/page-tree'
import type { DocHandle, DocStatus } from '@/services/docs/types'
import { useChannelStore } from '@/stores/channelStore'
import { findPage, useDocsStore, type DocPeer, type PageNode } from '@/stores/docsStore'
import { openChannel } from '@/stores/navStore'
import { usePageEditorFocused } from './page-editor-state'
import { PageLabels } from './page-labels'

/*
 * The parts of an open page that the desktop panel (`PagesPanel`, C1) and the phone's page screen
 * (`components/mobile/page-screen.tsx`, M38) share. `panel` is the desktop form, `screen` the
 * phone form (the kit sizes, a 20 px gutter, one scroller for the hero, the labels and the text).
 */

// Crepe, CodeMirror and KaTeX are large: they load with the first open page.
const PageEditor = lazy(() => import('./page-editor').then((m) => ({ default: m.PageEditor })))

const EMPTY_PEERS: DocPeer[] = []

/** The desktop panel or the phone's page screen. */
export type PageVariant = 'panel' | 'screen'

/**
 * Opens `pageId` in its pages channel. A page of another channel also selects that channel, or
 * calls `elsewhere` when the panel shows beside another channel (N21.1).
 * A page of a channel that is not loaded cannot be found, so the click does nothing.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function openPageAnywhere(
  pageId: string,
  fromChannelId: string,
  elsewhere?: (channelId: string) => void
): void {
  const page = findPage(pageId)
  if (!page) {
    console.warn('[pages] link to an unknown page', pageId)
    return
  }
  useDocsStore.getState().setOpenPage(page.channelId, pageId)
  if (page.channelId === fromChannelId) return
  if (elsewhere) return elsewhere(page.channelId)
  const channel = useChannelStore.getState().channels.get(page.channelId)
  if (channel?.guildId) openChannel(channel.guildId, channel.id)
}

/**
 * "channel › parent › page": the channel, then the path of the open page. On the screen, 12.5
 * with no icon in a 20 px gutter (M38); each step is a hit area at least 36 × 36.
 */
export function Breadcrumb({
  channelName,
  pages,
  pageId,
  onOpen,
  variant = 'panel',
  afterTile = true,
  current,
  trailing
}: {
  channelName: string
  pages: PageNode[]
  pageId: string
  onOpen: (pageId: string) => void
  variant?: PageVariant
  /** `screen`: the path sits under the page tile of the banner (M38), which sets its margins. */
  afterTile?: boolean
  /** `panel`: in place of the last step, the open page (the title field of an editor). */
  current?: React.ReactNode
  /** `panel`: at the right end of the row ("Add banner"). */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const path = useMemo(() => pagePath(pages, pageId), [pages, pageId])
  if (variant === 'screen') {
    return (
      <nav
        aria-label="Page path"
        className={cn(
          'flex h-9 min-w-0 shrink-0 items-stretch gap-1.5 overflow-hidden px-5 text-[12.5px] leading-[15px]',
          afterTile ? 'relative z-[1] mt-[1.5px] -mb-[10.5px]' : 'mt-1 -mb-[10.5px]'
        )}
      >
        <span className="text-text-tertiary flex max-w-32 min-w-0 shrink items-center font-medium">
          <span className="truncate">{channelName}</span>
        </span>
        {path.map((p, i) => {
          const last = i === path.length - 1
          return (
            <Fragment key={p.id}>
              <ChevronRight
                className="text-text-disabled size-3 shrink-0 self-center"
                aria-hidden
              />
              <button
                type="button"
                className={cn(
                  // A short title ("Q3") or a squeezed step keeps a 36 wide hit area (§2.12).
                  'focus-visible:outline-line-focus min-w-9 truncate text-center outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
                  last
                    ? 'text-text-primary font-semibold'
                    : 'text-text-tertiary active:text-text-primary max-w-28 shrink font-medium'
                )}
                aria-current={last ? 'page' : undefined}
                onClick={() => onOpen(p.id)}
              >
                {pageTitle(p)}
              </button>
            </Fragment>
          )
        })}
      </nav>
    )
  }
  return (
    <nav
      aria-label="Page path"
      className="flex min-w-0 shrink-0 items-center gap-1 px-16 pt-5 text-[12.5px] font-medium"
    >
      <span className="text-text-tertiary flex max-w-40 min-w-0 shrink items-center gap-1.5">
        <FileText className="text-text-tertiary size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{channelName}</span>
      </span>
      {path.map((p, i) => {
        const last = i === path.length - 1
        return (
          <Fragment key={p.id}>
            <ChevronRight className="text-text-disabled size-3.5 shrink-0" aria-hidden />
            {last && current ? (
              current
            ) : (
              <button
                type="button"
                className={cn(
                  'min-w-0 truncate',
                  last
                    ? 'text-text-primary font-semibold'
                    : 'text-text-tertiary hover:text-text-primary max-w-32 shrink'
                )}
                aria-current={last ? 'page' : undefined}
                onClick={() => onOpen(p.id)}
              >
                {pageTitle(p)}
              </button>
            )}
          </Fragment>
        )
      })}
      {trailing && (
        <>
          <span className="min-w-2 flex-1" />
          {trailing}
        </>
      )}
    </nav>
  )
}

const MAX_AVATARS: Record<PageVariant, number> = { panel: 5, screen: 3 }

/** The neutral avatar of a peer: a shade picked by the user id, the initial in mono. */
function PeerFace({ peer, className }: { peer: DocPeer; className: string }): React.JSX.Element {
  const shade = ['bg-avatar-1', 'bg-avatar-2', 'bg-avatar-3'][hashString(peer.userId) % 3]
  return (
    <span
      className={cn(
        'text-text-secondary ring-live inline-flex items-center justify-center font-mono font-medium ring-2',
        shade,
        className
      )}
    >
      <span aria-hidden>{peer.name.slice(0, 1).toUpperCase()}</span>
    </span>
  )
}

/** The remote viewers of a page: one entry per user. */
function usePageUsers(pageId: string): DocPeer[] {
  const peers = useDocsStore((s) => s.presence.get(pageId) ?? EMPTY_PEERS)
  return useMemo(() => {
    const byUser = new Map<string, DocPeer>()
    for (const p of peers) if (!byUser.has(p.userId)) byUser.set(p.userId, p)
    return [...byUser.values()]
  }, [peers])
}

/**
 * The people who have the page open, one avatar per user in a `live` ring (someone editing a page
 * is `live`), then a pill with the count. On the screen the avatars are 26 and overlap by 7 in the
 * nav bar (M38), with at most 3 so the title keeps its room on an iPhone SE; there are no tooltips
 * on touch, so each has its name as its label.
 */
export function Presence({
  pageId,
  variant = 'panel'
}: {
  pageId: string
  variant?: PageVariant
}): React.JSX.Element | null {
  const users = usePageUsers(pageId)
  if (users.length === 0) return null
  const shown = users.slice(0, MAX_AVATARS[variant])
  const more = users.length - shown.length
  if (variant === 'screen') {
    return (
      <div
        role="list"
        aria-label="On this page"
        className="flex shrink-0 items-center -space-x-[7px]"
      >
        {shown.map((u) => (
          <span key={u.userId} role="listitem" aria-label={u.name} className="inline-flex">
            <PeerFace peer={u} className="size-[26px] rounded-full text-[11px]" />
          </span>
        ))}
        {more > 0 && (
          <span role="listitem" className="text-text-tertiary pl-2.5 text-xs font-semibold">
            +{more}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="flex shrink-0 items-center gap-2 px-1" aria-label="On this page">
      <div className="flex items-center -space-x-2">
        {shown.map((u) => (
          <Tooltip key={u.userId}>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <PeerFace peer={u} className="size-7 rounded-[8px] text-[11px]" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{u.name}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {more > 0 && <span className="text-text-tertiary text-xs">+{more}</span>}
      <LivePill>{users.length} HERE</LivePill>
    </div>
  )
}

/** The phone's "Editing now" line: a `live` note of who has the page open. Nothing while alone. */
export function PageLiveLine({ pageId }: { pageId: string }): React.JSX.Element | null {
  const users = usePageUsers(pageId)
  if (users.length === 0) return null
  const text =
    users.length === 1
      ? `${users[0].name} has this page open`
      : `${users[0].name} and ${users.length - 1} ${users.length === 2 ? 'other' : 'others'} have this page open`
  return (
    <div
      role="status"
      className="border-live-line bg-live-tint mx-[18px] mt-3 flex items-center gap-[9px] rounded-[10px] border px-3 py-[9px]"
    >
      <LiveDot className="size-[7px]" />
      <span className="text-live-text min-w-0 truncate text-[12px] font-medium">{text}</span>
    </div>
  )
}

/** The doc handle of an open page and its status, from `docsService.openPage` to the close. */
export function useOpenDoc(
  channelId: string,
  pageId: string
): { handle: DocHandle | null; status: DocStatus; error: string | null } {
  const [handle, setHandle] = useState<DocHandle | null>(null)
  const [status, setStatus] = useState<DocStatus>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let closed = false
    let h: DocHandle | null = null
    let unsubscribe = (): void => {}
    docsService.openPage(channelId, pageId).then(
      (opened) => {
        if (closed) {
          opened.close()
          return
        }
        h = opened
        setStatus(opened.status)
        unsubscribe = opened.onStatus(setStatus)
        setHandle(opened)
      },
      (e) => {
        if (!closed) setError(errMsg(e))
      }
    )
    return () => {
      closed = true
      unsubscribe()
      h?.close()
    }
  }, [channelId, pageId])

  return { handle, status, error }
}

/**
 * The page screen's body (M38): what scrolls (the hero, the path, the labels and the text), a
 * layer over its bottom edge (the Chat pill), then the docked foot. The foot and the layer go
 * while the editor has the focus, so the text keeps the room on a small phone and the keyboard
 * toolbar does not cover them. That is also true with no software keyboard: a hardware keyboard,
 * or the browser host at a narrow width.
 */
export function PageScreenLayout({
  overlay,
  foot,
  children
}: {
  overlay?: React.ReactNode
  foot?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  // Only an editable touch editor tracks the focus, and only it shows the keyboard toolbar.
  const editing = usePageEditorFocused()
  const hide = cn('contents in-data-[keyboard=open]:hidden', editing && 'hidden')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          data-slot="page-scroll"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        >
          {children}
        </div>
        {overlay && <div className={hide}>{overlay}</div>}
      </div>
      {foot && <div className={hide}>{foot}</div>}
    </div>
  )
}

/**
 * One open page: its doc, the read-only or offline line, the labels, the editor and the footer.
 * `panel`: the editor scrolls on its own between the labels and the footer (C1). `screen`: `head`
 * (the hero and the path) scrolls with the labels and the text, `overlay` floats over the bottom
 * (M38).
 */
export function OpenPage({
  channelId,
  pageId,
  canEdit,
  onOpen,
  variant = 'panel',
  head,
  overlay
}: {
  channelId: string
  pageId: string
  canEdit: boolean
  onOpen: (pageId: string) => void
  variant?: PageVariant
  /** `screen`: the top of the scroller, above the labels. */
  head?: React.ReactNode
  /** `screen`: floats over the bottom of the scroller (the Chat pill). */
  overlay?: React.ReactNode
}): React.JSX.Element {
  const { handle, status, error } = useOpenDoc(channelId, pageId)
  const screen = variant === 'screen'

  const onNewSubPage = useCallback(async () => {
    const id = await docsService.createPage(channelId, 'Untitled', pageId)
    return { id, title: 'Untitled' }
  }, [channelId, pageId])

  let message: React.ReactNode = null
  if (error !== null) message = <PanelMessage>Could not open the page: {error}</PanelMessage>
  else if (!handle || status === 'loading') message = <LoadingBody variant={variant} />
  else if (status === 'waiting') {
    message = (
      <PanelMessage>
        Waiting for a member to share this page. It opens when a member who can read it is online.
      </PanelMessage>
    )
  } else if (status === 'error') message = <PanelMessage>This page cannot be read.</PanelMessage>

  if (screen) {
    return (
      <PageScreenLayout
        overlay={overlay}
        foot={
          message === null &&
          handle && <PageFooter handle={handle} status={status} variant={variant} />
        }
      >
        {head}
        {message ??
          (handle && (
            <>
              {(status === 'offline' || !canEdit) && (
                <p className="text-text-tertiary px-5 pt-3 text-[12.5px] leading-4 font-medium">
                  {status === 'offline'
                    ? 'Offline. Your edits are sent when the connection is back.'
                    : 'Read only. You cannot edit pages in this channel.'}
                </p>
              )}
              <PageLabels handle={handle} editable={canEdit} variant="touch" />
              <div aria-hidden className="bg-line-hairline mx-5 mt-3 h-px shrink-0" />
              <Suspense fallback={<LoadingBody variant={variant} />}>
                <PageEditor
                  handle={handle}
                  editable={canEdit}
                  onOpenPage={onOpen}
                  onNewSubPage={onNewSubPage}
                  variant="touch"
                />
              </Suspense>
            </>
          ))}
      </PageScreenLayout>
    )
  }

  if (message !== null || !handle) return <>{message}</>
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {(status === 'offline' || !canEdit) && (
        <div className="text-text-tertiary border-line-hairline shrink-0 border-b px-4 py-1 text-xs">
          {status === 'offline'
            ? 'Offline. Your edits are sent when the connection is back.'
            : 'Read only. You cannot edit pages in this channel.'}
        </div>
      )}
      <PageLabels handle={handle} editable={canEdit} />
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<LoadingBody />}>
          <PageEditor
            handle={handle}
            editable={canEdit}
            onOpenPage={onOpen}
            onNewSubPage={onNewSubPage}
          />
        </Suspense>
      </div>
      <PageFooter handle={handle} status={status} />
    </div>
  )
}

const WORD_COUNT_DELAY_MS = 1000

/** The footer line of each page status. OpenPage shows the footer only for 'ready' and 'offline'. */
const FOOTER: Record<DocStatus, { label: string; waiting: boolean }> = {
  ready: { label: 'Saved', waiting: false },
  offline: { label: 'Offline', waiting: true },
  loading: { label: 'Loading', waiting: false },
  waiting: { label: 'Waiting for a member', waiting: false },
  error: { label: 'Cannot be read', waiting: false }
}

/**
 * "Saved · end-to-end encrypted" while the page is live (each edit goes out encrypted within
 * 100 ms), "Offline" while edits wait. The word count reads the markdown that the editor
 * registers (DocsService.copyMarkdown), when typing pauses and the main thread is idle.
 * On the screen it is the 34 foot of M38 (12.5, lock 13).
 */
export function PageFooter({
  handle,
  status,
  variant = 'panel'
}: {
  handle: DocHandle
  status: DocStatus
  variant?: PageVariant
}): React.JSX.Element {
  const words = useWordCount(handle)
  const { label, waiting } = FOOTER[status]
  const screen = variant === 'screen'
  return (
    <footer
      className={cn(
        'border-line-hairline flex shrink-0 items-center border-t px-4',
        screen
          ? 'h-[34px] gap-1.5 text-[12.5px] leading-[15px] font-medium'
          : 'h-10 gap-2 text-xs font-medium'
      )}
    >
      <span
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          // Offline: the edits wait on you.
          waiting ? 'text-you-text' : 'text-text-tertiary'
        )}
      >
        <Lock className={cn('shrink-0', screen ? 'size-[13px]' : 'size-3.5')} aria-hidden />
        <span className={cn(screen && 'truncate')}>{label} · end-to-end encrypted</span>
      </span>
      <span className="flex-1" />
      {words !== null && (
        <span
          className={cn(
            'text-text-disabled shrink-0 font-mono text-[9px] tracking-[0.8px] uppercase tabular-nums',
            screen && 'font-medium'
          )}
        >
          {words} {words === 1 ? 'word' : 'words'}
        </span>
      )}
    </footer>
  )
}

function useWordCount(handle: DocHandle): number | null {
  const [words, setWords] = useState<number | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let idle: number | undefined
    const measure = (): void => {
      idle = undefined
      const md = docsService.copyMarkdown(handle.pageId)
      setWords(md === null ? null : countWords(md))
    }
    // The whole page goes to markdown: only after typing pauses, and when the thread is idle.
    const count = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (idle !== undefined) return
        if (typeof requestIdleCallback === 'function')
          idle = requestIdleCallback(measure, { timeout: 2000 })
        else measure()
      }, WORD_COUNT_DELAY_MS)
    }
    // The editor registers its markdown source after it mounts (lazy chunk): count once after that.
    count()
    handle.doc.on('update', count)
    return () => {
      clearTimeout(timer)
      if (idle !== undefined) cancelIdleCallback(idle)
      handle.doc.off('update', count)
    }
  }, [handle])
  return words
}

export function LoadingBody({ variant = 'panel' }: { variant?: PageVariant }): React.JSX.Element {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-3xl flex-col gap-3',
        variant === 'screen' ? 'px-5 py-5' : 'px-14 py-6'
      )}
      aria-busy="true"
    >
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

export function PanelMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-text-tertiary flex flex-1 items-center justify-center p-6 text-center text-sm">
      <div className="max-w-xs">{children}</div>
    </div>
  )
}
