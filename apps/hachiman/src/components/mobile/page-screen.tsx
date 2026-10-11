import { useCallback, useEffect, useRef } from 'react'
import { Check, Copy, Ellipsis, FileText, Link2, MessagesSquare } from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { blurPageEditor, usePageEditorFocused } from '@/components/docs/page-editor-state'
import { PageHero } from '@/components/docs/page-hero'
import { pageLinkMarkdown } from '@/components/docs/page-links'
import {
  Breadcrumb,
  LoadingBody,
  OpenPage,
  PageScreenLayout,
  PanelMessage,
  Presence,
  openPageAnywhere
} from '@/components/docs/page-parts'
import { NavActionButton } from '@/components/mobile/nav-bar'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { useGuildTint } from '@/components/shell/use-guild-tint'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useCopy } from '@/hooks/use-copy'
import { usePermissions } from '@/hooks/use-hachiman'
import { useLatched } from '@/hooks/use-latched'
import { countLabel } from '@/lib/unread-mark'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { pageTitle } from '@/services/docs/page-tree'
import { useChannelPages } from '@/services/docs/use-channel-pages'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore, type PageNode } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { navigate, useCurrentView } from '@/stores/navStore'
import { useUnreadStore } from '@/stores/unreadStore'

/** The focus ring of the bar's own buttons, as the kit's 36 buttons (`KIT_ICON_BUTTON`). */
const FOCUS =
  'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus'

/**
 * The full-screen page of a `{ kind: 'page' }` view (M38; docs/ios-mobile-ui-spec.md §2.6, F2),
 * pushed over the chat of its pages channel, with no tab strip. The nav bar: Back, the title
 * (15.5/800) over "channel · guild", who is on the page, then More, or Done while the editor has
 * the focus. Under it the computed hero, the path and the labels, the touch editor, the foot
 * ("Saved · end-to-end encrypted", the word count) and the floating Chat pill. Back and the pill
 * go to the channel's chat, which clears the open page.
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
  if (!shown || !channel) return null

  const back = (): void =>
    navigate({ kind: 'channel', guildId: shown.guildId, channelId: shown.channelId })
  const where = guildName ? `${channel.name ?? ''} · ${guildName}` : (channel.name ?? '')

  return (
    <PushedScreen
      open={page !== null}
      title={
        <span className={cn('text-[15.5px]', node && node.titleState !== 'ok' && 'italic')}>
          {node ? pageTitle(node) : 'Page'}
        </span>
      }
      subtitle={
        <span className="text-[12px]">
          <FileText
            aria-hidden
            className="text-feature-page-text mr-1 inline-block size-3 align-[-1.5px]"
          />
          {where}
        </span>
      }
      onBack={back}
      backLabel="Back to the chat"
      action={<BarActions pageId={shown.pageId} page={node} />}
      bodyClassName="gap-0 overflow-hidden p-0 pb-(--safe-bottom) in-data-[keyboard=open]:pb-0"
    >
      <PageScreenBody
        channel={channel}
        guildId={shown.guildId}
        pageId={shown.pageId}
        onBack={back}
      />
    </PushedScreen>
  )
}

/** The right of the nav bar: who is here, then More, or Done while the editor has the focus. */
function BarActions({
  pageId,
  page
}: {
  pageId: string
  page: PageNode | undefined
}): React.JSX.Element {
  const editing = usePageEditorFocused()
  const more = useRef<HTMLButtonElement>(null)
  const doneTapped = useRef(false)
  // Done goes away with the focus it had: the focus moves to More, which takes its place.
  useEffect(() => {
    if (editing || !doneTapped.current) return
    doneTapped.current = false
    more.current?.focus()
  }, [editing])
  return (
    <>
      <Presence pageId={pageId} variant="screen" />
      {editing ? (
        <DoneButton
          onDone={() => {
            doneTapped.current = true
            blurPageEditor()
          }}
        />
      ) : (
        page && <MoreMenu page={page} triggerRef={more} />
      )}
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

/** The page's actions (a sheet on the phone): copy a link to the page, copy it as markdown. */
function MoreMenu({
  page,
  triggerRef
}: {
  page: PageNode
  triggerRef: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const { copied, copy } = useCopy()
  const copyLink = (): void => copy(pageLinkMarkdown(page))
  const copyMarkdown = (): void => {
    const md = docsService.copyMarkdown(page.id)
    if (md !== null) copy(md)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <NavActionButton ref={triggerRef} label={copied !== null ? 'Copied' : 'More'}>
          {copied !== null ? <Check /> : <Ellipsis />}
        </NavActionButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyLink}>
          <Link2 />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={copyMarkdown}>
          <Copy />
          Copy as markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The page under the nav bar. The pages of the channel load here too (a pinned page tab can open
 * the screen first), and a page that is gone says so: Back and the pill still lead out.
 */
function PageScreenBody({
  channel,
  guildId,
  pageId,
  onBack
}: {
  channel: Channel
  guildId: string
  pageId: string
  onBack: () => void
}): React.JSX.Element {
  const { pages, loaded, failed } = useChannelPages(channel.id)
  const canEdit = has(usePermissions(channel.guildId, channel.id), Permissions.SEND_MESSAGES)
  const tint = useGuildTint(guildId).window
  const open = useCallback((id: string) => openPageAnywhere(id, channel.id), [channel.id])
  const exists = pages.some((p) => p.id === pageId)

  const hero = <PageHero pageId={pageId} tint={tint} />
  const pill = <ChatPill channelId={channel.id} onClick={onBack} />

  if (!loaded || !exists) {
    return (
      <PageScreenLayout overlay={pill}>
        {hero}
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
          {hero}
          <Breadcrumb
            variant="screen"
            channelName={channel.name ?? ''}
            pages={pages}
            pageId={pageId}
            onOpen={open}
          />
        </>
      }
      overlay={pill}
    />
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
