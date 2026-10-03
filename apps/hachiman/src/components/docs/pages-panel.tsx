import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, ChevronRight, Copy, FileText, Loader2, Plus } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePermissions } from '@/hooks/use-hachiman'
import { errMsg } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import type { DocHandle, DocStatus } from '@/services/docs/types'
import { useChannelStore } from '@/stores/channelStore'
import { flattenPages, pagePath, pageTitle } from '@/services/docs/page-tree'
import { findPage, useDocsStore, type DocPeer, type PageNode } from '@/stores/docsStore'
import { openChannel } from '@/stores/navStore'
import { PageTreePopover } from './page-tree-popover'

// Crepe, CodeMirror and KaTeX are large: they load with the first open page.
const PageEditor = lazy(() => import('./page-editor').then((m) => ({ default: m.PageEditor })))

const EMPTY_PAGES: PageNode[] = []
const EMPTY_PEERS: DocPeer[] = []
const MAX_AVATARS = 5

/**
 * Opens `pageId` in its pages channel. A page of another channel also selects that channel.
 * A page of a channel that is not loaded cannot be found, so the click does nothing.
 */
function openPageAnywhere(pageId: string, fromChannelId: string): void {
  const page = findPage(pageId)
  if (!page) {
    console.warn('[pages] link to an unknown page', pageId)
    return
  }
  useDocsStore.getState().setOpenPage(page.channelId, pageId)
  if (page.channelId === fromChannelId) return
  const channel = useChannelStore.getState().channels.get(page.channelId)
  if (channel?.guildId) openChannel(channel.guildId, channel.id)
}

/** Right panel of a pages channel: the header (path, tree, presence, copy) over the open page. */
export function PagesPanel({ channel }: { channel: Channel }): React.JSX.Element {
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

  const open = useCallback((id: string) => openPageAnywhere(id, channel.id), [channel.id])

  return (
    <div className="bg-background flex h-full min-w-0 flex-col" data-channel-id={channel.id}>
      <PanelHeader
        channelId={channel.id}
        pages={pages}
        pageId={pageId}
        canEdit={canEdit}
        onOpen={open}
      />
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
  onOpen
}: {
  channelId: string
  pages: PageNode[]
  pageId: string | null
  canEdit: boolean
  onOpen: (pageId: string) => void
}): React.JSX.Element {
  const path = useMemo(() => (pageId ? pagePath(pages, pageId) : EMPTY_PAGES), [pages, pageId])
  return (
    <header className="border-border flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <PageTreePopover
        channelId={channelId}
        pages={pages}
        openPageId={pageId}
        canEdit={canEdit}
        onOpen={onOpen}
      />
      <nav aria-label="Page path" className="flex min-w-0 flex-1 items-center gap-0.5 text-sm">
        {path.map((p, i) => (
          <Fragment key={p.id}>
            {i > 0 && <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />}
            <button
              type="button"
              className={
                i === path.length - 1
                  ? 'text-foreground min-w-0 truncate font-semibold'
                  : 'text-muted-foreground hover:text-foreground max-w-32 min-w-0 shrink truncate'
              }
              aria-current={i === path.length - 1 ? 'page' : undefined}
              onClick={() => onOpen(p.id)}
            >
              {pageTitle(p)}
            </button>
          </Fragment>
        ))}
      </nav>
      {pageId && <Presence pageId={pageId} />}
      {pageId && <CopyMarkdown pageId={pageId} />}
    </header>
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
              className="border-background text-background inline-flex size-6 items-center justify-center border-2 text-[11px] font-semibold"
              style={{ backgroundColor: u.color }}
            >
              {u.name.slice(0, 1).toUpperCase()}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{u.name}</TooltipContent>
        </Tooltip>
      ))}
      {users.length > shown.length && (
        <span className="text-muted-foreground pl-2 text-xs">+{users.length - shown.length}</span>
      )}
    </div>
  )
}

function CopyMarkdown({ pageId }: { pageId: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = (): void => {
    const md = docsService.copyMarkdown(pageId)
    if (md === null) return
    navigator.clipboard?.writeText(md).then(
      () => setCopied(true),
      (e) => console.warn('[pages] copy failed', e)
    )
  }
  return (
    <IconButton label={copied ? 'Copied' : 'Copy as markdown'} tooltipSide="bottom" onClick={copy}>
      {copied ? <Check /> : <Copy />}
    </IconButton>
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
        <div className="text-muted-foreground border-border shrink-0 border-b px-3 py-1 text-xs">
          {status === 'offline'
            ? 'Offline. Your edits are sent when the connection is back.'
            : 'Read only. You cannot edit pages in this channel.'}
        </div>
      )}
      <Suspense fallback={<LoadingBody />}>
        <PageEditor
          handle={handle}
          editable={canEdit}
          onOpenPage={onOpen}
          onNewSubPage={onNewSubPage}
        />
      </Suspense>
    </div>
  )
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
      <FileText className="text-muted-foreground mx-auto mb-2 size-8" />
      <p>This channel has no pages yet.</p>
      {canEdit && (
        <Button className="mt-3" size="sm" disabled={busy} onClick={create}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          New page
        </Button>
      )}
      {error && <p className="text-destructive mt-2 text-xs">Could not create the page: {error}</p>}
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
    <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-center text-sm">
      <div className="max-w-xs">{children}</div>
    </div>
  )
}
