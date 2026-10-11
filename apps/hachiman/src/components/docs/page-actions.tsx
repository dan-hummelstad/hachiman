import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpToLine,
  Check,
  ChevronLeft,
  FileDown,
  FileText,
  FolderInput,
  Link,
  Pin,
  PinOff,
  Trash2,
  UserPlus
} from 'lucide-react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { pageLinkMarkdown } from '@/components/docs/page-links'
import {
  bannersLost,
  moveUnder,
  pageMoveTargets,
  type PageMoveTarget
} from '@/components/docs/page-move'
import { PageDeleteConfirm } from '@/components/docs/page-tree-actions'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import { Sheet, SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { useCopy } from '@/hooks/use-copy'
import { usePermissions } from '@/hooks/use-hachiman'
import { useLatched } from '@/hooks/use-latched'
import { captureOpener, restoreFocus } from '@/lib/focus-opener'
import { cn } from '@/lib/utils'
import { docsService } from '@/services/docs/DocsService'
import { pageTitle, subtreeIds } from '@/services/docs/page-tree'
import { usePlatform } from '@/shared/PlatformContext'
import { openDialog } from '@/stores/dialogStore'
import { findPage, useDocsStore, type PageNode } from '@/stores/docsStore'
import { pinTab, unpinTab, useIsPinned, type TabTarget } from '@/stores/tabsStore'

const EMPTY_PAGES: PageNode[] = []

/** A quick action tile (M41): 66 high, radius 10, icon 20 over a 13/700 label. */
const TILE =
  'rounded-option flex h-[66px] min-w-0 flex-1 flex-col items-center justify-center gap-1.5 border px-1.5 text-[13px] leading-4 font-bold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus [&_svg]:size-5 [&_svg]:shrink-0'
const TILE_TONE = {
  off: 'bg-surface-hover border-line-hairline text-text-primary active:bg-surface-selected',
  on: 'bg-accent-tint border-accent-primary/50 text-accent-text active:bg-accent-primary/30'
} as const

/** A title as the sheet shows it: italic while it does not decrypt. */
function TitleText({ page }: { page: PageNode }): React.JSX.Element {
  return (
    <span className={cn('block truncate', page.titleState !== 'ok' && 'italic')}>
      {pageTitle(page)}
    </span>
  )
}

/**
 * The page actions sheet (M41), from More on the page screen: the quick tiles Pin to tabs (lit
 * while pinned), Copy link and Invite (with CREATE_INSTANT_INVITE), then Move to… (a parent in the
 * same channel), Pin channel to tabs (or Unpin, for the page's pages channel), Export (copies the
 * markdown) and Delete page. Move and Delete need SEND_MESSAGES, as every page edit. The delete
 * confirm names the sub-pages that go with the page; after the delete, `onDeleted` leads back to
 * the chat.
 *
 * Export does not open the share sheet: `IPlatformService.share` needs an http(s) `url`, and a
 * page has none (spec section 5). History, comments, duplicate, lock, a move to another channel,
 * PDF and trash do not exist yet, so the sheet leaves them out.
 */
export function PageActionsSheet({
  open,
  onOpenChange,
  page,
  channel,
  guildId,
  subtitle,
  onDeleted
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The page; undefined once it is gone (an open delete confirm stays until it closes). */
  page: PageNode | undefined
  channel: Channel
  guildId: string
  /** "channel · guild" under the title. */
  subtitle: string
  /** The page was deleted here: back to the chat. */
  onDeleted: () => void
}): React.JSX.Element | null {
  const shown = useLatched(page)
  const platform = usePlatform()
  const pages = useDocsStore((s) => s.pagesByChannel.get(channel.id) ?? EMPTY_PAGES)
  const [deleting, setDeleting] = useState(false)
  /** A tile or row opened another surface, which takes the focus: the sheet does not take it back. */
  const handedOff = useRef(false)
  /** The Delete row: after a cancel the focus goes back along the sheet's opener (More). */
  const deleteOpener = useRef<HTMLElement | null>(null)
  if (!shown) return null

  const handOff = (): void => {
    handedOff.current = true
    onOpenChange(false)
  }
  const startDelete = (): void => {
    deleteOpener.current = captureOpener()
    handOff()
    setDeleting(true)
    platform.haptic('warning')
  }
  const endDelete = (): void => {
    setDeleting(false)
    if (!findPage(shown.id)) {
      onDeleted()
      return
    }
    const el = deleteOpener.current
    deleteOpener.current = null
    // After the confirm's focus trap has let go.
    requestAnimationFrame(() => restoreFocus(el))
  }

  return (
    <>
      <Sheet open={open && page !== undefined} onOpenChange={onOpenChange}>
        <SheetContent
          onCloseAutoFocus={(e) => {
            if (!handedOff.current) return
            handedOff.current = false
            e.preventDefault()
          }}
        >
          <ActionSteps
            page={shown}
            pages={pages}
            channel={channel}
            guildId={guildId}
            subtitle={subtitle}
            onClose={() => onOpenChange(false)}
            onInvite={() => {
              handOff()
              openDialog({ kind: 'invite', guildId })
            }}
            onDelete={startDelete}
          />
        </SheetContent>
      </Sheet>
      <PageDeleteConfirm pages={pages} page={deleting ? shown : null} onClose={endDelete} />
    </>
  )
}

interface StepProps {
  page: PageNode
  pages: readonly PageNode[]
  channel: Channel
  guildId: string
  subtitle: string
  onClose: () => void
  onInvite: () => void
  onDelete: () => void
}

/**
 * The actions, or the places of Move to… in the same sheet. A new open starts on the actions. A
 * step swap unmounts the row that had the focus, so each step places the focus itself: Move to…
 * on its first place, Back on the Move to… row.
 */
function ActionSteps(props: StepProps): React.JSX.Element {
  const [step, setStep] = useState<'actions' | 'move' | 'back'>('actions')
  return step === 'move' ? (
    <MoveStep
      page={props.page}
      pages={props.pages}
      channelName={props.channel.name ?? ''}
      onBack={() => setStep('back')}
      onMoved={props.onClose}
    />
  ) : (
    <ActionsStep {...props} returnTo={step === 'back'} onMove={() => setStep('move')} />
  )
}

function ActionsStep({
  page,
  pages,
  channel,
  guildId,
  subtitle,
  onInvite,
  onDelete,
  onMove,
  returnTo
}: StepProps & {
  onMove: () => void
  /** Back from Move to…: the focus goes to the Move to… row. */
  returnTo: boolean
}): React.JSX.Element {
  const platform = usePlatform()
  const moveRow = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (returnTo) moveRow.current?.focus({ preventScroll: true })
  }, [returnTo])
  const perms = usePermissions(guildId, channel.id)
  const canEdit = has(perms, Permissions.SEND_MESSAGES)
  const canInvite = has(perms, Permissions.CREATE_INSTANT_INVITE)
  const tab: TabTarget = { kind: 'page', id: channel.id, guildId, pageId: page.id }
  const pinned = useIsPinned(tab)
  const channelTab: TabTarget = { kind: 'channel', id: channel.id, guildId }
  const channelPinned = useIsPinned(channelTab)
  const success = useCallback(() => platform.haptic('success'), [platform])
  const link = useCopy({ onCopied: success })
  const markdown = useCopy({ onCopied: success })
  const canMove = useMemo(
    () => pageMoveTargets(pages, page.id).some((t) => !t.current),
    [pages, page.id]
  )
  const below = useMemo(() => subtreeIds(pages, page.id).size - 1, [pages, page.id])

  const toggle = (target: TabTarget, on: boolean): void => {
    if (on) {
      unpinTab(target)
      platform.haptic('light')
    } else {
      pinTab(target)
      platform.haptic('success')
    }
  }
  // The page goes to markdown in the tap, so the clipboard write stays inside it (WebKit).
  const exportMarkdown = (): void =>
    markdown.copy(() => {
      const md = docsService.copyMarkdown(page.id)
      return md === null
        ? Promise.reject(new Error('the page has not loaded yet'))
        : navigator.clipboard.writeText(md)
    })
  const status =
    link.copied !== null
      ? 'Link copied'
      : markdown.copied !== null
        ? 'Markdown copied'
        : link.failed || markdown.failed
          ? 'Could not copy'
          : ''

  return (
    <>
      <SheetHeader
        icon={<FileText />}
        feature="page"
        title={<TitleText page={page} />}
        subtitle={<span className="block truncate">{subtitle}</span>}
      />
      <SheetBody className="gap-3.5">
        <div role="group" aria-label="Quick actions" className="flex shrink-0 gap-2">
          {/* A toggle keeps one name: the state is only in `aria-pressed`. */}
          <button
            type="button"
            aria-label="Pin to tabs"
            aria-pressed={pinned}
            onClick={() => toggle(tab, pinned)}
            className={cn(TILE, TILE_TONE[pinned ? 'on' : 'off'])}
          >
            <Pin aria-hidden />
            <span aria-hidden className="max-w-full truncate">
              {pinned ? 'Pinned to tabs' : 'Pin to tabs'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => link.copy(pageLinkMarkdown(page))}
            className={cn(TILE, TILE_TONE.off)}
          >
            {link.copied !== null ? <Check aria-hidden /> : <Link aria-hidden />}
            <span className="max-w-full truncate">
              {link.copied !== null ? 'Copied' : 'Copy link'}
            </span>
          </button>
          {canInvite && (
            <button type="button" onClick={onInvite} className={cn(TILE, TILE_TONE.off)}>
              <UserPlus aria-hidden />
              <span className="max-w-full truncate">Invite</span>
            </button>
          )}
        </div>
        <ListGroup>
          {canEdit && (
            <ListRow
              icon={<FolderInput />}
              tile="neutral"
              label="Move to…"
              detail={
                canMove ? 'Under another page of this channel' : 'No other place in this channel'
              }
              disabled={!canMove}
              onClick={onMove}
              buttonRef={moveRow}
            />
          )}
          <ListRow
            icon={channelPinned ? <PinOff /> : <Pin />}
            tile="page"
            label={channelPinned ? 'Unpin channel from tabs' : 'Pin channel to tabs'}
            detail={`#${channel.name ?? ''}`}
            chevron={false}
            onClick={() => toggle(channelTab, channelPinned)}
          />
          <ListRow
            icon={<FileDown />}
            tile="voice"
            label="Export"
            detail="Copies it as markdown, decrypted on this device"
            value={markdown.copied !== null ? 'Copied' : markdown.failed ? 'Not copied' : undefined}
            chevron={false}
            onClick={exportMarkdown}
          />
        </ListGroup>
        {canEdit && (
          <ListGroup>
            <ListRow
              icon={<Trash2 />}
              tone="danger"
              label="Delete page"
              detail={
                below > 0
                  ? `With its ${below} sub-page${below > 1 ? 's' : ''}. This cannot be undone.`
                  : 'This cannot be undone.'
              }
              onClick={onDelete}
            />
          </ListGroup>
        )}
        <p className="sr-only" aria-live="polite">
          {status}
        </p>
      </SheetBody>
    </>
  )
}

/**
 * Move to… (same channel only): the top level, then the other pages of the channel in tree order,
 * without the page and its sub-pages. A tap moves the page last under the place and closes the
 * sheet. Back returns to the actions. A move under a page removes the banner of a top-level page
 * (contract §4 Pages "Banner"), so for a page with a banner the tap shows a confirm line first.
 */
function MoveStep({
  page,
  pages,
  channelName,
  onBack,
  onMoved
}: {
  page: PageNode
  pages: readonly PageNode[]
  channelName: string
  onBack: () => void
  onMoved: () => void
}): React.JSX.Element {
  const platform = usePlatform()
  const { run, busy, error } = useAction()
  const targets = useMemo(() => pageMoveTargets(pages, page.id), [pages, page.id])
  const byId = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const [top, ...under] = targets
  const body = useRef<HTMLDivElement>(null)
  /** The place that waits for the banner confirm. */
  const [confirming, setConfirming] = useState<{ parentId: string | null } | null>(null)
  /** The confirm line takes the focus on its Cancel: a held Enter must not confirm it. */
  const cancelButton = useRef<HTMLButtonElement>(null)
  // The Move to… row that had the focus is gone: the focus goes to the first place to pick.
  useEffect(() => {
    body.current?.querySelector<HTMLElement>('button:enabled')?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (confirming) cancelButton.current?.focus({ preventScroll: true })
  }, [confirming])

  // The confirm goes: the focus goes back to the places.
  const cancelConfirm = (): void => {
    setConfirming(null)
    body.current?.querySelector<HTMLElement>('button:enabled')?.focus({ preventScroll: true })
  }
  const move = (parentId: string | null, confirmed = false): void => {
    const moves = moveUnder(pages, page.id, parentId)
    if (!confirmed && bannersLost(pages, moves).length > 0) {
      setConfirming({ parentId })
      platform.haptic('warning')
      return
    }
    setConfirming(null)
    void run('move the page', () => docsService.movePages(moves)).then((r) => {
      if (!r.ok) return
      platform.haptic('success')
      onMoved()
    })
  }
  const row = (target: PageMoveTarget): React.JSX.Element => {
    const parentId = target.page?.parentId ?? null
    const parent = parentId !== null ? byId.get(parentId) : undefined
    return (
      <MoveTargetRow
        key={target.parentId ?? ''}
        target={target}
        detail={
          target.page === null
            ? `The top of ${channelName}`
            : parent
              ? `In ${pageTitle(parent)}`
              : undefined
        }
        busy={busy}
        onPick={move}
      />
    )
  }

  return (
    <>
      <SheetHeader
        icon={<FolderInput />}
        feature="page"
        title="Move to…"
        subtitle={<TitleText page={page} />}
      />
      <SheetBody ref={body} className="gap-3.5">
        {top && <ListGroup>{row(top)}</ListGroup>}
        {under.length > 0 && (
          <section aria-label="Under a page" className="flex flex-col gap-1.5">
            <SectionLabel>Under a page</SectionLabel>
            <ListGroup>{under.map(row)}</ListGroup>
          </section>
        )}
        <ErrorText>{error}</ErrorText>
      </SheetBody>
      <SheetFoot>
        {confirming ? (
          <>
            <p role="alert" className="text-text-secondary px-1 pb-1 text-[13.5px] leading-[18px]">
              This removes the banner of <strong className="font-bold">{pageTitle(page)}</strong>.
            </p>
            <Button
              variant="danger"
              size="mobile"
              disabled={busy}
              onClick={() => move(confirming.parentId, true)}
            >
              Move and remove the banner
            </Button>
            <Button ref={cancelButton} variant="quiet" size="mobile" onClick={cancelConfirm}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="quiet" size="mobile" onClick={onBack}>
            <ChevronLeft /> Back
          </Button>
        )}
      </SheetFoot>
    </>
  )
}

/** One place of Move to…: a tap moves the page there. The place it sits now has a check. */
function MoveTargetRow({
  target,
  detail,
  busy,
  onPick
}: {
  target: PageMoveTarget
  detail: string | undefined
  busy: boolean
  onPick: (parentId: string | null) => void
}): React.JSX.Element {
  const label = target.page ? pageTitle(target.page) : 'Top level'
  const icon = target.page ? <FileText /> : <ArrowUpToLine />
  if (target.current)
    return (
      <ListRow
        icon={icon}
        tile="page"
        label={label}
        detail={detail}
        trailing={
          <>
            <Check aria-hidden className="text-accent-text size-[17px] shrink-0" />
            <span className="sr-only">, the page is here now</span>
          </>
        }
      />
    )
  return (
    <ListRow
      icon={icon}
      tile="page"
      label={label}
      detail={detail}
      disabled={busy}
      chevron={false}
      onClick={() => onPick(target.parentId)}
    />
  )
}
