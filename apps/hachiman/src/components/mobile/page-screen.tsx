import { useCallback, useEffect, useRef, useState } from 'react'
import { Ellipsis, FileText, MessagesSquare } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { PageActionsSheet } from '@/components/docs/page-actions'
import {
  blurPageEditor,
  clearFocusMore,
  usePageEditorFocused,
  usePageEditorState
} from '@/components/docs/page-editor-state'
import { PageBanner, usePageBannerControl } from '@/components/docs/page-banner'
import {
  Breadcrumb,
  LoadingBody,
  OpenPage,
  PageScreenLayout,
  PanelMessage,
  Presence,
  openPageAnywhere
} from '@/components/docs/page-parts'
import { PageTitleField } from '@/components/docs/page-title-field'
import { NavActionButton } from '@/components/mobile/nav-bar'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { usePermissions } from '@/hooks/use-hachiman'
import { useLatched } from '@/hooks/use-latched'
import { countLabel } from '@/lib/unread-mark'
import { cn } from '@/lib/utils'
import { pageTitle } from '@/services/docs/page-tree'
import { useChannelPages } from '@/services/docs/use-channel-pages'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { navigate, useCurrentView } from '@/stores/navStore'
import { useUnreadStore } from '@/stores/unreadStore'

/**
 * The title field in the nav bar: 16 (iOS zooms into a field under 16), the full width of the
 * title, its text in line with the line under it.
 */
const TITLE_FIELD = '-ml-1 grid-cols-1 text-[16px]'

/** The focus ring of the bar's own buttons, as the kit's 36 buttons (`KIT_ICON_BUTTON`). */
const FOCUS =
  'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus'

/**
 * The full-screen page of a `{ kind: 'page' }` view (M38; docs/ios-mobile-ui-spec.md §2.6, F2),
 * pushed over the chat of its pages channel, with no tab strip. The nav bar: Back, the title
 * (15.5/800; for an editor the inline title field at 16, so iOS does not zoom) over "channel ·
 * guild", who is on the page, then More, or Done while the editor has the focus. Under it the
 * banner of the top-level page (`PageBanner`, contract §12.20 doc_banner), the path and the
 * labels, the touch editor, the foot ("Saved · end-to-end encrypted", the word count) and the
 * floating Chat pill. Back and the pill go to the channel's chat, which clears the open page.
 */
export function PageScreen(): React.JSX.Element | null {
  const view = useCurrentView()
  const page = view.kind === 'page' ? view : null
  // The last page stays while the screen slides out.
  const shown = useLatched(page)
  const channel = useChannelStore((s) => (shown ? s.channels.get(shown.channelId) : undefined))
  const guildName = useGuildStore((s) => (shown ? s.guilds.get(shown.guildId)?.name : undefined))
  const node = useDocsStore((s) =>
    shown ? s.pagesByChannel.get(shown.channelId)?.find((p) => p.id === shown.pageId) : undefined
  )
  const canEdit = has(
    usePermissions(shown?.guildId ?? null, shown?.channelId),
    Permissions.SEND_MESSAGES
  )
  const titleBox = useRef<HTMLSpanElement>(null)
  // A failed rename, for the page it was on.
  const [titleError, setTitleError] = useState<{ pageId: string; text: string } | null>(null)
  if (!shown || !channel) return null

  const back = (): void =>
    navigate({ kind: 'channel', guildId: shown.guildId, channelId: shown.channelId })
  const where = guildName ? `${channel.name ?? ''} · ${guildName}` : (channel.name ?? '')
  const editable = canEdit && node !== undefined
  // The title line is 20 high: a tap anywhere on the full-width line under it also starts the
  // edit, so the band is 36 high (spec §2.10).
  const editTitle = (): void => titleBox.current?.querySelector('input')?.focus()

  return (
    <PushedScreen
      open={page !== null}
      title={
        editable ? (
          <span ref={titleBox} className="contents">
            <PageTitleField
              // A new page is a new field: no draft or save of the page before it.
              key={node.id}
              page={node}
              className={TITLE_FIELD}
              onError={(text) => setTitleError({ pageId: node.id, text })}
            />
          </span>
        ) : (
          <span className={cn('text-[15.5px]', node && node.titleState !== 'ok' && 'italic')}>
            {node ? pageTitle(node) : 'Page'}
          </span>
        )
      }
      subtitle={
        <span className="block truncate text-[12px]" onClick={editable ? editTitle : undefined}>
          <FileText
            aria-hidden
            className="text-feature-page-text mr-1 inline-block size-3 align-[-1.5px]"
          />
          {where}
        </span>
      }
      onBack={back}
      backLabel="Back to the chat"
      action={
        <BarActions
          pageId={shown.pageId}
          page={node}
          channel={channel}
          guildId={shown.guildId}
          where={where}
          onDeleted={back}
        />
      }
      bodyClassName="gap-0 overflow-hidden p-0 pb-(--safe-bottom) in-data-[keyboard=open]:pb-0"
    >
      <PageScreenBody
        channel={channel}
        pageId={shown.pageId}
        canEdit={canEdit}
        titleError={titleError?.pageId === shown.pageId ? titleError.text : null}
        onDismissTitleError={() => setTitleError(null)}
        onBack={back}
      />
    </PushedScreen>
  )
}

/**
 * The right of the nav bar: who is here, then More, or Done while the editor has the focus. More
 * opens the page actions sheet (M41). The sheet stays mounted while Done shows, and its delete
 * confirm outlives the page.
 */
function BarActions({
  pageId,
  page,
  channel,
  guildId,
  where,
  onDeleted
}: {
  pageId: string
  page: PageNode | undefined
  channel: Channel
  guildId: string
  where: string
  onDeleted: () => void
}): React.JSX.Element {
  const editing = usePageEditorFocused()
  const [actions, setActions] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const focusMore = usePageEditorState((s) => s.focusMore)
  // Done, the toolbar's hide and a toolbar sheet go away with the focus they had: the focus moves
  // to More, which takes Done's place.
  useEffect(() => {
    if (editing || !focusMore || !more.current) return
    clearFocusMore()
    more.current.focus()
  }, [editing, focusMore])
  return (
    <>
      <Presence pageId={pageId} variant="screen" />
      {editing ? (
        <DoneButton onDone={() => blurPageEditor({ focusMore: true })} />
      ) : (
        page && (
          <NavActionButton
            ref={more}
            label="More"
            aria-haspopup="dialog"
            aria-expanded={actions}
            onClick={() => setActions(true)}
          >
            <Ellipsis />
          </NavActionButton>
        )
      )}
      <PageActionsSheet
        open={actions}
        onOpenChange={setActions}
        page={page}
        channel={channel}
        guildId={guildId}
        subtitle={where}
        onDeleted={onDeleted}
      />
    </>
  )
}

/**
 * Done (M39, 64 × 36 on the accent tint): blurs the editor, so the keyboard goes down. The press
 * keeps the focus where it is, else the editor's blur would swap Done for More under the finger.
 */
function DoneButton({ onDone }: { onDone: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onDone}
      className={cn(
        'rounded-control bg-accent-tint text-accent-text active:bg-accent-primary/30 inline-flex h-9 min-w-16 shrink-0 items-center justify-center px-3.5 text-[14.5px] leading-[18px] font-extrabold',
        FOCUS
      )}
    >
      Done
    </button>
  )
}

/**
 * The page under the nav bar. The pages of the channel load here too (a pinned page tab can open
 * the screen first), and a page that is gone says so: Back and the pill still lead out. The banner
 * shows from the top-level page; the page tile sits over its lower edge and the path under it.
 */
function PageScreenBody({
  channel,
  pageId,
  canEdit,
  titleError,
  onDismissTitleError,
  onBack
}: {
  channel: Channel
  pageId: string
  canEdit: boolean
  /** A failed rename from the title field in the nav bar. */
  titleError: string | null
  onDismissTitleError: () => void
  onBack: () => void
}): React.JSX.Element {
  const { pages, loaded, failed } = useChannelPages(channel.id)
  const banner = usePageBannerControl(channel.id, pageId, canEdit)
  const open = useCallback((id: string) => openPageAnywhere(id, channel.id), [channel.id])
  const exists = pages.some((p) => p.id === pageId)

  const top = <PageBanner variant="screen" control={banner} />
  const pill = <ChatPill channelId={channel.id} onClick={onBack} />

  if (!loaded || !exists) {
    return (
      <PageScreenLayout overlay={pill}>
        {top}
        {!loaded && failed !== null ? (
          <PanelMessage>Could not load the pages: {failed}</PanelMessage>
        ) : !loaded ? (
          <LoadingBody variant="screen" />
        ) : (
          <PanelMessage>This page was deleted.</PanelMessage>
        )}
      </PageScreenLayout>
    )
  }
  return (
    <OpenPage
      key={pageId}
      variant="screen"
      channelId={channel.id}
      pageId={pageId}
      canEdit={canEdit}
      onOpen={open}
      head={
        <>
          {top}
          <Breadcrumb
            variant="screen"
            channelName={channel.name ?? ''}
            pages={pages}
            pageId={pageId}
            onOpen={open}
            afterTile={banner.view.show === 'image'}
          />
          {titleError !== null && <TitleError text={titleError} onDismiss={onDismissTitleError} />}
        </>
      }
      overlay={pill}
    />
  )
}

/** A failed rename from the nav bar, under the path, until the user closes it or renames again. */
function TitleError({
  text,
  onDismiss
}: {
  text: string
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <p
      role="alert"
      className="text-feature-danger-text flex shrink-0 items-start gap-2 px-5 pt-4 text-xs"
    >
      <span className="min-w-0 flex-1">{text}</span>
      <button
        type="button"
        onClick={onDismiss}
        className={cn(
          'text-text-tertiary active:text-text-primary relative shrink-0 font-semibold after:absolute after:-inset-3',
          FOCUS
        )}
      >
        Dismiss
      </button>
    </p>
  )
}

/**
 * Back to the chat (M38): a 40 pill over the bottom right of the page with the raw unread count
 * of the channel ("3 new"). The chat under the screen does not mark messages read (A3), so the
 * count grows while the page is open.
 */
function ChatPill({
  channelId,
  onClick
}: {
  channelId: string
  onClick: () => void
}): React.JSX.Element {
  const unread = useUnreadStore((s) => s.byChannel.get(channelId)?.unread ?? 0)
  const count = countLabel(unread)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={unread > 0 ? `Back to the chat, ${count} new` : 'Back to the chat'}
      className={cn(
        'bg-surface-raised border-line-sheet text-text-primary absolute right-4 bottom-3.5 z-10 inline-flex h-10 items-center gap-[7px] rounded-full border pr-3.5 pl-3 text-[14px] leading-[18px] font-extrabold shadow-(--shadow-soft) active:brightness-110',
        FOCUS
      )}
    >
      <MessagesSquare aria-hidden className="size-[17px] shrink-0" />
      Chat
      {unread > 0 && (
        <span
          aria-hidden
          className="bg-accent-primary text-text-on-accent inline-flex h-5 items-center rounded-full px-[7px] text-[11.5px] font-extrabold tabular-nums"
        >
          {count} new
        </span>
      )}
    </button>
  )
}
