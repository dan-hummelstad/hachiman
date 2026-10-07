import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Check,
  ChevronRight,
  FileText,
  Link2,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus
} from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePermissions } from '@/hooks/use-hachiman'
import { cn, errMsg } from '@/lib/utils'
import { countWords } from '@/lib/word-count'
import { docsService } from '@/services/docs/DocsService'
import type { DocHandle, DocStatus } from '@/services/docs/types'
import { useChannelStore } from '@/stores/channelStore'
import { flattenPages, pagePath, pageTitle } from '@/services/docs/page-tree'
import { findPage, useDocsStore, type DocPeer, type PageNode } from '@/stores/docsStore'
import { openChannel } from '@/stores/navStore'
import { PageLabels } from './page-labels'
import { pageHref } from './page-links'
import { PageTreePopover } from './page-tree-popover'

// Crepe, CodeMirror and KaTeX are large: they load with the first open page.
const PageEditor = lazy(() => import('./page-editor').then((m) => ({ default: m.PageEditor })))

const EMPTY_PAGES: PageNode[] = []
const EMPTY_PEERS: DocPeer[] = []
const MAX_AVATARS = 5

/**
 * Opens `pageId` in its pages channel. A page of another channel also selects that channel, or
 * calls `elsewhere` when the panel shows beside another channel (N21.1).
 * A page of a channel that is not loaded cannot be found, so the click does nothing.
 */
function openPageAnywhere(
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
 * The Pages view of the right column in a pages channel (C1): the column head (the switcher of
 * RightColumn, presence, outline, copy link, more), the path "channel › page", the open page and
 * its footer (save state, word count).
 */
export function PagesPanel({
  channel,
  switcher,
  onOpenElsewhere
}: {
  channel: Channel
  /** The "Members | Pages" control of the right column, at the start of the head. */
  switcher?: React.ReactNode
  /**
   * The panel shows beside another channel (N21.1): a link to a page of another pages channel
   * calls this (with that channel) in place of selecting the channel.
   */
  onOpenElsewhere?: (channelId: string) => void
}): React.JSX.Element {
  const { pages, loaded, openId } = useDocsStore(
    useShallow((s) => ({
      pages: s.pagesByChannel.get(channel.id) ?? EMPTY_PAGES,
      loaded: s.pagesByChannel.has(channel.id),
      openId: s.openPageByChannel.get(channel.id) ?? null
    }))
  )
  const canEdit = has(usePermissions(channel.guildId, channel.id), Permissions.SEND_MESSAGES)
  const [failed, setFailed] = useState<{ channelId: string; message: string } | null>(null)
  const loadError = failed?.channelId === channel.id ? failed.message : null

  useEffect(() => {
    let cancelled = false
    docsService.loadPages(channel.id).catch((e) => {
      if (!cancelled) setFailed({ channelId: channel.id, message: errMsg(e) })
    })
    return () => {
      cancelled = true
    }
  }, [channel.id])

  // The open page, or the first page of the tree when none is open (or it was deleted).
  const pageId = useMemo(() => {
    if (openId !== null && pages.some((p) => p.id === openId)) return openId
    return flattenPages(pages)[0]?.page.id ?? null
  }, [openId, pages])

  const open = useCallback(
    (id: string) => openPageAnywhere(id, channel.id, onOpenElsewhere),
    [channel.id, onOpenElsewhere]
  )

  return (
    <div
      className="bg-surface-content flex h-full min-w-0 flex-1 flex-col"
      data-channel-id={channel.id}
    >
      <PanelHeader
        channelId={channel.id}
        pages={pages}
        pageId={pageId}
        canEdit={canEdit}
        onOpen={open}
        switcher={switcher}
      />
      {pageId && (
        <Breadcrumb channelName={channel.name ?? ''} pages={pages} pageId={pageId} onOpen={open} />
      )}
      {loadError !== null && !loaded ? (
        <PanelMessage>Could not load the pages: {loadError}</PanelMessage>
      ) : !loaded ? (
        <LoadingBody />
      ) : pageId === null ? (
        <EmptyChannel channelId={channel.id} canEdit={canEdit} onCreated={open} />
      ) : (
        <OpenPage
          key={pageId}
          channelId={channel.id}
          pageId={pageId}
          canEdit={canEdit}
          onOpen={open}
        />
      )}
    </div>
  )
}

function PanelHeader({
  channelId,
  pages,
  pageId,
  canEdit,
  onOpen,
  switcher
}: {
  channelId: string
  pages: PageNode[]
  pageId: string | null
  canEdit: boolean
  onOpen: (pageId: string) => void
  switcher: React.ReactNode
}): React.JSX.Element {
  const page = pageId ? pages.find((p) => p.id === pageId) : undefined
  return (
    <header className="border-line-hairline flex h-14 shrink-0 items-center gap-1 border-b px-2">
      {switcher}
      <span className="flex-1" />
      {pageId && <Presence pageId={pageId} />}
      <PageTreePopover
        channelId={channelId}
        pages={pages}
        openPageId={pageId}
        canEdit={canEdit}
        onOpen={onOpen}
      />
      {page && <CopyLink page={page} />}
      {pageId && <MoreMenu pageId={pageId} />}
    </header>
  )
}

/** "channel › parent › page": the channel, then the path of the open page. */
function Breadcrumb({
  channelName,
  pages,
  pageId,
  onOpen
}: {
  channelName: string
  pages: PageNode[]
  pageId: string
  onOpen: (pageId: string) => void
}): React.JSX.Element {
  const path = useMemo(() => pagePath(pages, pageId), [pages, pageId])
  return (
    <nav
      aria-label="Page path"
      className="flex min-w-0 shrink-0 items-center gap-1 px-16 pt-5 text-[13px] font-semibold"
    >
      <span className="text-text-tertiary flex max-w-40 min-w-0 shrink items-center gap-1.5">
        <FileText className="text-feature-page-text size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{channelName}</span>
      </span>
      {path.map((p, i) => {
        const last = i === path.length - 1
        return (
          <Fragment key={p.id}>
            <ChevronRight className="text-text-tertiary size-3.5 shrink-0" aria-hidden />
            <button
              type="button"
              className={cn(
                'min-w-0 truncate',
                last
                  ? 'text-text-primary'
                  : 'text-text-tertiary hover:text-text-primary max-w-32 shrink'
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

/** The remote viewers of the page, one avatar per user, in their cursor color. */
function Presence({ pageId }: { pageId: string }): React.JSX.Element | null {
  const peers = useDocsStore((s) => s.presence.get(pageId) ?? EMPTY_PEERS)
  const users = useMemo(() => {
    const byUser = new Map<string, DocPeer>()
    for (const p of peers) if (!byUser.has(p.userId)) byUser.set(p.userId, p)
    return [...byUser.values()]
  }, [peers])
  if (users.length === 0) return null
  const shown = users.slice(0, MAX_AVATARS)
  return (
    <div className="flex shrink-0 items-center -space-x-1 px-1" aria-label="On this page">
      {shown.map((u) => (
        <Tooltip key={u.userId}>
          <TooltipTrigger asChild>
            <span
              className="border-surface-content text-surface-content inline-flex size-7 items-center justify-center rounded-full border-2 text-[11px] font-bold"
              style={{ backgroundColor: u.color }}
            >
              {u.name.slice(0, 1).toUpperCase()}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{u.name}</TooltipContent>
        </Tooltip>
      ))}
      {users.length > shown.length && (
        <span className="text-text-tertiary pl-2.5 text-xs">+{users.length - shown.length}</span>
      )}
    </div>
  )
}

/** True for 1.5 s after `flash()`. */
function useFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setOn(false), 1500)
    return () => clearTimeout(t)
  }, [on])
  return [on, () => setOn(true)]
}

function copyText(text: string, done: () => void): void {
  navigator.clipboard?.writeText(text).then(done, (e) => console.warn('[pages] copy failed', e))
}

/** Copies a markdown link to the page. Pasted into a page, it is a page link (page-links.ts). */
function CopyLink({ page }: { page: PageNode }): React.JSX.Element {
  const [copied, flash] = useFlash()
  const copy = (): void => {
    const title = pageTitle(page).replace(/[[\]\\]/g, '\\$&')
    copyText(`[${title}](${pageHref(page.id)})`, flash)
  }
  return (
    <IconButton label={copied ? 'Copied' : 'Copy link'} tooltipSide="bottom" onClick={copy}>
      {copied ? <Check /> : <Link2 />}
    </IconButton>
  )
}

function MoreMenu({ pageId }: { pageId: string }): React.JSX.Element {
  const [copied, flash] = useFlash()
  const copyMarkdown = (): void => {
    const md = docsService.copyMarkdown(pageId)
    if (md !== null) copyText(md, flash)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={copied ? 'Copied' : 'More'} tooltipSide="bottom">
          {copied ? <Check /> : <MoreHorizontal />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyMarkdown}>Copy as markdown</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function OpenPage({
  channelId,
  pageId,
  canEdit,
  onOpen
}: {
  channelId: string
  pageId: string
  canEdit: boolean
  onOpen: (pageId: string) => void
}): React.JSX.Element {
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

  const onNewSubPage = useCallback(async () => {
    const id = await docsService.createPage(channelId, 'Untitled', pageId)
    return { id, title: 'Untitled' }
  }, [channelId, pageId])

  if (error !== null) return <PanelMessage>Could not open the page: {error}</PanelMessage>
  if (!handle || status === 'loading') return <LoadingBody />
  if (status === 'waiting') {
    return (
      <PanelMessage>
        Waiting for a member to share this page. It opens when a member who can read it is online.
      </PanelMessage>
    )
  }
  if (status === 'error') return <PanelMessage>This page cannot be read.</PanelMessage>
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

const WORD_COUNT_DELAY_MS = 400

/**
 * "Saved · end-to-end encrypted" while the page is live (each edit goes out encrypted within
 * 100 ms), "Offline" while edits wait. The word count reads the markdown that the editor
 * registers (DocsService.copyMarkdown), after each change of the doc.
 */
function PageFooter({
  handle,
  status
}: {
  handle: DocHandle
  status: DocStatus
}): React.JSX.Element {
  const words = useWordCount(handle)
  const live = status === 'ready'
  return (
    <footer className="border-line-hairline flex h-10 shrink-0 items-center gap-2 border-t px-4 text-xs font-semibold">
      <span
        className={cn(
          'flex items-center gap-1.5',
          live ? 'text-feature-voice-text' : 'text-text-tertiary'
        )}
      >
        <Lock className="size-3.5" aria-hidden />
        {live ? 'Saved' : 'Offline'} · end-to-end encrypted
      </span>
      <span className="flex-1" />
      {words !== null && (
        <span className="text-text-tertiary tabular-nums">
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
    const count = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const md = docsService.copyMarkdown(handle.pageId)
        setWords(md === null ? null : countWords(md))
      }, WORD_COUNT_DELAY_MS)
    }
    // The editor registers its markdown source after it mounts (lazy chunk): count once after that.
    count()
    handle.doc.on('update', count)
    return () => {
      clearTimeout(timer)
      handle.doc.off('update', count)
    }
  }, [handle])
  return words
}

function EmptyChannel({
  channelId,
  canEdit,
  onCreated
}: {
  channelId: string
  canEdit: boolean
  onCreated: (pageId: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = (): void => {
    setBusy(true)
    setError(null)
    docsService
      .createPage(channelId, 'Untitled', null)
      .then(onCreated, (e) => setError(errMsg(e)))
      .finally(() => setBusy(false))
  }
  return (
    <PanelMessage>
      <FileText className="text-feature-page-text mx-auto mb-2 size-8" />
      <p>This channel has no pages yet.</p>
      {canEdit && (
        <Button className="mt-3" size="sm" disabled={busy} onClick={create}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          New page
        </Button>
      )}
      {error && (
        <p className="text-feature-danger-text mt-2 text-xs">Could not create the page: {error}</p>
      )}
    </PanelMessage>
  )
}

function LoadingBody(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-14 py-6" aria-busy="true">
      <Skeleton className="h-7 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

function PanelMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-text-tertiary flex flex-1 items-center justify-center p-6 text-center text-sm">
      <div className="max-w-xs">{children}</div>
    </div>
  )
}
