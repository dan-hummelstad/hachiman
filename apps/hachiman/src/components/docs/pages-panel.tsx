import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, FileText, Link2, Loader2, MoreHorizontal, Plus } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { usePermissions } from '@/hooks/use-hachiman'
import { useCopy } from '@/hooks/use-copy'
import { errMsg } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { flattenPages } from '@/services/docs/page-tree'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { pageLinkMarkdown } from './page-links'
import {
  Breadcrumb,
  LoadingBody,
  OpenPage,
  PanelMessage,
  Presence,
  openPageAnywhere
} from './page-parts'
import { PageTreePopover } from './page-tree-popover'

const EMPTY_PAGES: PageNode[] = []

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

/** Copies a markdown link to the page. Pasted into a page, it is a page link (page-links.ts). */
function CopyLink({ page }: { page: PageNode }): React.JSX.Element {
  const { copied, copy } = useCopy()
  const copyLink = (): void => copy(pageLinkMarkdown(page))
  return (
    <IconButton
      label={copied !== null ? 'Copied' : 'Copy link'}
      tooltipSide="bottom"
      onClick={copyLink}
    >
      {copied !== null ? <Check /> : <Link2 />}
    </IconButton>
  )
}

function MoreMenu({ pageId }: { pageId: string }): React.JSX.Element {
  const { copied, copy } = useCopy()
  const copyMarkdown = (): void => {
    const md = docsService.copyMarkdown(pageId)
    if (md !== null) copy(md)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={copied !== null ? 'Copied' : 'More'} tooltipSide="bottom">
          {copied !== null ? <Check /> : <MoreHorizontal />}
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyMarkdown}>Copy as markdown</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
