import { Suspense, lazy, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { LoadingBody, PanelMessage, Presence, useOpenDoc } from '@/components/docs/page-parts'
import { PageDeleteConfirm } from '@/components/docs/page-tree-actions'
import { PageTitleField } from '@/components/docs/page-title-field'
import { PageTreePopover } from '@/components/docs/page-tree-popover'
import { IconButton } from '@/components/ui/icon-button'
import { usePermissions } from '@/hooks/use-hachiman'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { docsService } from '@/services/docs/DocsService'
import { flattenPages, pageTitle } from '@/services/docs/page-tree'
import { useChannelPages } from '@/services/docs/use-channel-pages'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { navigate } from '@/stores/navStore'
import { WebView } from './web-view'

// Excalidraw is large: it loads with the first canvas.
const CanvasView = lazy(() => import('./canvas-view'))

/**
 * The body of a canvas or web channel: a bar to pick, add, rename and delete the channel's boards
 * (its pages, contract §4 Pages), over the open board. Each board is its own encrypted doc: a
 * whiteboard in a canvas channel, a shared web view in a web channel.
 */
export function BoardBody({
  channel
}: {
  channel: Channel & { type: 'canvas' | 'web' }
}): React.JSX.Element {
  const { pages, loaded, failed } = useChannelPages(channel.id)
  const openId = useDocsStore((s) => s.openPageByChannel.get(channel.id) ?? null)
  const canEdit = has(usePermissions(channel.guildId, channel.id), Permissions.SEND_MESSAGES)
  const noun = channel.type === 'canvas' ? 'canvas' : 'tab'
  const pageId = useMemo(() => {
    if (openId !== null && pages.some((p) => p.id === openId)) return openId
    return flattenPages(pages)[0]?.page.id ?? null
  }, [openId, pages])
  const page = pages.find((p) => p.id === pageId)
  const open = (id: string): void => {
    if (channel.guildId)
      navigate({ kind: 'page', guildId: channel.guildId, channelId: channel.id, pageId: id })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <BoardBar
        channel={channel}
        pages={pages}
        page={page}
        canEdit={canEdit}
        noun={noun}
        onOpen={open}
      />
      {failed !== null && !loaded ? (
        <PanelMessage>
          Could not load the {noun}s: {failed}
        </PanelMessage>
      ) : !loaded ? (
        <LoadingBody />
      ) : pageId === null ? (
        <PanelMessage>
          {canEdit ? `Add a ${noun} with the + button.` : `This channel has no ${noun}s yet.`}
        </PanelMessage>
      ) : (
        <OpenBoard
          key={pageId}
          type={channel.type}
          channelId={channel.id}
          pageId={pageId}
          canEdit={canEdit}
        />
      )}
    </div>
  )
}

function BoardBar({
  channel,
  pages,
  page,
  canEdit,
  noun,
  onOpen
}: {
  channel: Channel
  pages: PageNode[]
  page: PageNode | undefined
  canEdit: boolean
  noun: string
  onOpen: (pageId: string) => void
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  const { run, busy, error } = useAction()
  const [deleting, setDeleting] = useState<PageNode | null>(null)
  const [titleError, setTitleError] = useState<string | null>(null)
  const create = (): void => {
    const title = `${noun === 'canvas' ? 'Canvas' : 'Tab'} ${pages.length + 1}`
    void run(`create the ${noun}`, () => docsService.createPage(channel.id, title, null)).then(
      (r) => r.ok && onOpen(r.value)
    )
  }
  return (
    <div className="border-line-hairline flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <PageTreePopover
        channelId={channel.id}
        pages={pages}
        openPageId={page?.id ?? null}
        canEdit={canEdit}
        onOpen={onOpen}
        noun={noun}
      />
      <span className="text-text-primary flex min-w-0 flex-1 items-center text-sm font-semibold">
        {page &&
          (canEdit ? (
            <PageTitleField
              key={page.id}
              page={page}
              current
              // 16 on a phone, so iOS does not zoom into the field (as the page screen).
              className="mobile:text-[16px]"
              onError={setTitleError}
            />
          ) : (
            <span className="truncate px-1">{pageTitle(page)}</span>
          ))}
      </span>
      {(titleError ?? error) && (
        <span role="alert" className="text-you-text truncate text-xs">
          {titleError ?? error}
        </span>
      )}
      {page && <Presence pageId={page.id} variant={mobile ? 'screen' : 'panel'} />}
      {canEdit && (
        <IconButton label={`New ${noun}`} tooltipSide="bottom" disabled={busy} onClick={create}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
        </IconButton>
      )}
      {canEdit && page && (
        <IconButton label={`Delete ${noun}`} tooltipSide="bottom" onClick={() => setDeleting(page)}>
          <Trash2 />
        </IconButton>
      )}
      <PageDeleteConfirm pages={pages} page={deleting} onClose={() => setDeleting(null)} />
    </div>
  )
}

function OpenBoard({
  type,
  channelId,
  pageId,
  canEdit
}: {
  type: 'canvas' | 'web'
  channelId: string
  pageId: string
  canEdit: boolean
}): React.JSX.Element {
  const { handle, status, error } = useOpenDoc(channelId, pageId)
  // A canvas binds once the doc loaded: an empty doc would get a default page of its own.
  const [loadedOnce, setLoadedOnce] = useState(false)
  if (status === 'ready' && !loadedOnce) setLoadedOnce(true)

  if (error !== null) return <PanelMessage>Could not open it: {error}</PanelMessage>
  if (status === 'waiting')
    return (
      <PanelMessage>
        Waiting for a member to share this. It opens when a member who can read it is online.
      </PanelMessage>
    )
  if (status === 'error') return <PanelMessage>This cannot be read.</PanelMessage>
  if (!handle || !loadedOnce) return <LoadingBody />
  return type === 'canvas' ? (
    <Suspense fallback={<LoadingBody />}>
      <CanvasView handle={handle} canEdit={canEdit} />
    </Suspense>
  ) : (
    <WebView handle={handle} canEdit={canEdit} />
  )
}
