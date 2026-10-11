import { useEffect, useId, useState } from 'react'
import { Check, Copy, History, Hourglass, Link2, Share, Trash2 } from 'lucide-react'
import type { Invite, Member } from '@hachiman/client'
import { DockedFoot } from '@/components/mobile/foot'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import { Sheet, SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import { InviteOptions } from '@/components/settings/invite-options'
import {
  countActiveInvites,
  inviteExpiryState,
  inviteUsesLabel,
  type InviteExpiryState
} from '@/components/settings/invites'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import {
  useGuildInvites,
  useInviteCreateForm,
  useInvitePermissions,
  type CreatedInvite
} from '@/components/settings/use-guild-invites'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorText } from '@/components/ui/field'
import { useAction } from '@/hooks/use-action'
import { useCopy } from '@/hooks/use-copy'
import { useLatched } from '@/hooks/use-latched'
import { displayName } from '@/lib/model'
import { formatExpiry } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { copyInviteLink, inviteUrl } from '@/services/InviteService'
import { usePlatform } from '@/shared/PlatformContext'
import { useGuildStore } from '@/stores/guildStore'

/** The slide out of a sheet (250) and a margin: then the shown link leaves memory. */
const SHEET_OUT_MS = 400

/** The 40 action buttons of a row (M55): r8, the hover fill, icon 17. */
const ACTION =
  'rounded-control bg-surface-hover active:bg-surface-selected flex size-10 shrink-0 items-center justify-center outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus disabled:opacity-40 data-[state=open]:bg-feature-danger/15 [&_svg]:size-[17px]'

/** A new invite with history whose link did not reach the clipboard. */
interface ShownLink {
  code: string
  /** The seed of the history (§12.17): only in this state and in the link. */
  key: string
  /** The `#names` of the channels whose history the link opens. */
  scope: string[]
}

/** The copy that the create tap started did not reach the clipboard. */
class LinkNotCopied extends Error {
  readonly made: CreatedInvite
  constructor(made: CreatedInvite) {
    super('The new invite link did not reach the clipboard.')
    this.made = made
  }
}

/**
 * M55: guild settings → Invites on the phone. The list (MANAGE_GUILD): one row per invite with its
 * code, the History and Permanent chips, Copy (not for an invite with history: its key is gone)
 * and Delete (with a confirm, M50), and a meta line (creator, uses, expiry; gold when it is close,
 * grey once used up or expired). The create bar docks at the foot of the screen, on the panel
 * colour. "Create and copy link" starts the copy inside the tap (`copyLinkFromTap`). When the
 * link of an invite with history does not reach the clipboard, a sheet shows it once.
 */
export function GuildInvitesMobile({ guildId }: { guildId: string }): React.JSX.Element {
  const { canList, canCreate, isAdmin } = useInvitePermissions(guildId)
  const members = useGuildStore((s) => s.members.get(guildId))
  const platform = usePlatform()
  const { run, busy, error, setError, clearError } = useAction()
  const { invites, now, add, revoke } = useGuildInvites(guildId, canList, setError)
  const { copied, copy } = useCopy({
    onCopied: () => platform.haptic('success'),
    onError: (e) => {
      if (!(e instanceof LinkNotCopied)) {
        setError('Could not copy the link. Try again.')
      } else if (e.made.key !== null) {
        setShown({ code: e.made.invite.code, key: e.made.key, scope: e.made.scope })
        setLinkOpen(true)
      } else {
        setError('The invite is ready, but its link did not reach the clipboard. Tap its Copy.')
      }
    }
  })
  const [deleting, setDeleting] = useState<Invite | null>(null)
  // The code stays in the window while it fades out.
  const deleted = useLatched(deleting)
  const [shown, setShown] = useState<ShownLink | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const labelId = useId()

  // The key of a shown link stays in memory only while its sheet shows.
  useEffect(() => {
    if (linkOpen || shown === null) return
    const t = setTimeout(() => setShown(null), SHEET_OUT_MS)
    return () => clearTimeout(t)
  }, [linkOpen, shown])

  const onCreated = (made: CreatedInvite): void => {
    add(made.invite)
    const started = made.copied
    if (!started) return
    copy(
      () =>
        started.then((ok) => {
          if (!ok) throw new LinkNotCopied(made)
        }),
      made.invite.code
    )
  }

  const form = useInviteCreateForm({ guildId, isAdmin, run, copyInTap: true, onCreated })

  // The write starts here, inside the tap.
  const copyRow = (code: string): void => {
    clearError()
    copy(() => copyInviteLink(code), code)
  }

  const active = countActiveInvites(invites, now)

  return (
    <div ref={setRoot} className="flex flex-col gap-3">
      <section aria-labelledby={labelId} className="flex flex-col gap-3">
        <SectionLabel id={labelId}>
          All invites{invites.length > 0 && ` · ${active} active`}
        </SectionLabel>
        {invites.length === 0 ? (
          <p className="text-text-tertiary px-1 text-[14px] leading-5 font-medium">
            {canList ? 'No active invites.' : 'Links you create appear here.'}
          </p>
        ) : (
          <ListGroup role="list" aria-label="Invites">
            {invites.map((inv) => (
              <InviteRow
                key={inv.code}
                invite={inv}
                state={inviteExpiryState(inv, now)}
                now={now}
                creator={members?.get(inv.createdBy)}
                copied={copied === inv.code}
                canDelete={canList}
                deleteOpen={deleting?.code === inv.code}
                onCopy={() => copyRow(inv.code)}
                onDelete={() => setDeleting(inv)}
              />
            ))}
          </ListGroup>
        )}
        <span className="sr-only" aria-live="polite">
          {copied !== null ? 'Link copied' : ''}
        </span>
      </section>
      {/* With the create bar, errors show in it, next to the tap that caused most of them. */}
      {canCreate ? (
        <DockedFoot anchor={root}>
          <InviteCreateBar form={form} isAdmin={isAdmin} busy={busy} error={error} />
        </DockedFoot>
      ) : (
        <ErrorText>{error}</ErrorText>
      )}
      <PermanentInviteConfirm
        {...form.confirm}
        scope={form.history ? form.scope.map((c) => `#${c.name ?? c.id}`) : null}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this invite?"
        description={deleted?.code}
        body={
          deleted?.hasHistory
            ? 'The link stops working at once, and so does the history it opens. People who joined with it stay members.'
            : 'The link stops working at once. People who joined with it stay members.'
        }
        confirmLabel="Delete invite"
        what="delete the invite"
        tone="danger"
        icon={<Trash2 />}
        onConfirm={async () => {
          if (deleting) await revoke(deleting.code)
        }}
      />
      {shown && (
        <InviteLinkSheet
          shown={shown}
          open={linkOpen}
          onOpenChange={setLinkOpen}
          onCopied={() => platform.haptic('success')}
        />
      )}
    </div>
  )
}

/**
 * One invite (M55): padding 10/10/12/14, gap 6. The top line holds the code box (28, mono 14.5)
 * with its chips, then Copy and Delete (40). The meta line: the creator's 18 avatar and name, the
 * uses and the expiry. A used-up or expired invite is grey, and its Copy is off; Delete stays on.
 * `deleteOpen` marks the row and its Delete while the confirm is open.
 */
function InviteRow({
  invite,
  state,
  now,
  creator,
  copied,
  canDelete,
  deleteOpen,
  onCopy,
  onDelete
}: {
  invite: Invite
  state: InviteExpiryState
  now: number
  creator: Member | undefined
  copied: boolean
  canDelete: boolean
  deleteOpen: boolean
  onCopy: () => void
  onDelete: () => void
}): React.JSX.Element {
  const spent = state === 'usedUp' || state === 'expired'
  const name = displayName(creator)
  return (
    <div
      role="listitem"
      data-lit={deleteOpen || undefined}
      className="data-lit:bg-surface-hover flex flex-col gap-1.5 pt-2.5 pr-2.5 pb-3 pl-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <code
            className={cn(
              'bg-surface-sunken border-line-hairline inline-block h-7 max-w-full truncate border px-2 font-mono text-[14.5px] leading-[26px] font-semibold',
              spent ? 'text-text-tertiary opacity-50' : 'text-text-primary'
            )}
          >
            {invite.code}
          </code>
          {invite.hasHistory && (
            <Chip tone="accent" icon={<History />}>
              History
            </Chip>
          )}
          {state === 'permanent' && <Chip tone="danger">Permanent</Chip>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!invite.hasHistory && (
            <button
              type="button"
              aria-label={`${copied ? 'Copied' : 'Copy'} link for ${invite.code}`}
              disabled={spent}
              onClick={onCopy}
              className={cn(ACTION, 'text-text-secondary')}
            >
              {copied ? <Check className="text-feature-voice-text" /> : <Copy />}
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              aria-label={`Delete invite ${invite.code}`}
              aria-haspopup="dialog"
              data-state={deleteOpen ? 'open' : undefined}
              onClick={onDelete}
              className={cn(ACTION, 'text-feature-danger')}
            >
              <Trash2 />
            </button>
          )}
        </div>
      </div>
      <div
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-[13px] leading-4',
          spent && 'opacity-50'
        )}
      >
        <UserAvatar name={name} avatar={creator?.user.avatar} size={18} />
        <span className="text-text-secondary min-w-0 truncate font-semibold">{name}</span>
        <MetaDot />
        <span className="text-text-secondary shrink-0 font-medium whitespace-nowrap tabular-nums">
          {inviteUsesLabel(invite)}
        </span>
        {state !== 'permanent' && (
          <>
            <MetaDot />
            <Expiry state={state} expiresAt={invite.expiresAt} now={now} />
          </>
        )}
      </div>
    </div>
  )
}

function MetaDot(): React.JSX.Element {
  return (
    <span aria-hidden className="text-text-disabled shrink-0 font-semibold">
      ·
    </span>
  )
}

/** The expiry of the meta line: gold with an hourglass when close, grey once it does not work. */
function Expiry({
  state,
  expiresAt,
  now
}: {
  state: Exclude<InviteExpiryState, 'permanent'>
  expiresAt: string | null
  now: number
}): React.JSX.Element {
  if (state === 'usedUp' || state === 'expired') {
    return (
      <span className="text-text-tertiary shrink-0 font-semibold whitespace-nowrap">
        {state === 'usedUp' ? 'Used up' : 'Expired'}
      </span>
    )
  }
  const text = formatExpiry(expiresAt, now)
  if (state === 'soon') {
    return (
      <span className="text-feature-event-text flex shrink-0 items-center gap-1 font-bold whitespace-nowrap">
        <Hourglass aria-hidden className="size-[13px]" />
        {text}
      </span>
    )
  }
  return <span className="text-text-secondary shrink-0 font-medium whitespace-nowrap">{text}</span>
}

/**
 * The create bar (M55), docked under the panel on the panel colour: padding 14/16/8/16, gap 10.
 * NEW INVITE LINK, the two select boxes, Include history for an administrator, then "Create and
 * copy link". A tall bar (history on, a short screen) scrolls its options inside, so the list
 * keeps room; the error and the primary button stay in view under them.
 */
function InviteCreateBar({
  form,
  isAdmin,
  busy,
  error
}: {
  form: ReturnType<typeof useInviteCreateForm>
  isAdmin: boolean
  busy: boolean
  error: string | null
}): React.JSX.Element {
  const labelId = useId()
  return (
    <section
      aria-labelledby={labelId}
      className="bg-surface-panel border-line-hairline -mx-4 flex max-h-[calc(var(--app-height,100dvh)*0.6)] flex-col gap-2.5 border-t px-4 pt-3.5 pb-[max(16px,calc(8px+var(--safe-bottom,0px)))] in-data-[keyboard=open]:pb-2"
    >
      {/* Edge to edge, so the scroller does not clip the focus rings of the boxes. */}
      <div className="-mx-4 flex min-h-0 flex-col gap-2.5 overflow-y-auto overscroll-contain px-4">
        <SectionLabel id={labelId}>New invite link</SectionLabel>
        <InviteOptions
          layout="boxes"
          value={form.options}
          onChange={form.setOptions}
          isAdmin={isAdmin}
        />
        {isAdmin && (
          <>
            <ListGroup>
              <ListRow
                icon={<History />}
                tile="page"
                label="Include history"
                detail={
                  form.scope.length === 0
                    ? 'No text or pages channel is visible to everyone.'
                    : 'Earlier messages and pages of the public channels.'
                }
                disabled={form.scope.length === 0}
                toggle={{ checked: form.history, onCheckedChange: form.setHistory }}
              />
            </ListGroup>
            {form.history && (
              <Callout tone="caution" size="touch">
                Anyone who gets this link can read the earlier messages and the pages of{' '}
                {form.scope.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ', '}
                    <span className="font-semibold">#{c.name ?? c.id}</span>
                    {c.historyVisibility === 'joined' && ' (joined)'}
                  </span>
                ))}
                .
              </Callout>
            )}
          </>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      <Button size="mobile" disabled={busy} onClick={() => void form.create()}>
        <Copy /> {busy ? 'Creating…' : 'Create and copy link'}
      </Button>
    </section>
  )
}

/**
 * The link of a new invite with history that did not reach the clipboard. It holds the key of the
 * history (§12.11.4), which nothing else keeps, so this sheet shows it once: Copy and, where the
 * host can share, Share. Each starts inside its tap. Until the link was copied or shared, the
 * sheet closes only through its header close, after a confirm (as the recovery key, §6.2).
 */
function InviteLinkSheet({
  shown,
  open,
  onOpenChange,
  onCopied
}: {
  shown: ShownLink
  open: boolean
  onOpenChange: (open: boolean) => void
  onCopied: () => void
}): React.JSX.Element {
  const share = usePlatform().share
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const linkLabelId = useId()
  const safe = copied || shared

  const link = inviteUrl(shown.code, shown.key)

  // Both start inside the tap.
  const copy = (): void => {
    setError(null)
    copyInviteLink(shown.code, shown.key).then(
      () => {
        onCopied()
        setCopied(true)
      },
      () => setError('Could not copy. Press and hold the link to copy it, or share it.')
    )
  }

  const onShare = (): void => {
    if (!share) return
    setError(null)
    share({ url: link }).then(
      (ok) => {
        if (ok) setShared(true)
      },
      () => setError('Could not open the share sheet.')
    )
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next || safe) onOpenChange(next)
          else setConfirmClose(true)
        }}
      >
        <SheetContent dismissible={safe}>
          <SheetHeader
            icon={<Link2 />}
            title="Your invite link"
            subtitle="It includes history. It shows only here."
          />
          <SheetBody>
            <Callout tone="caution" size="touch">
              The link did not reach the clipboard. It holds the key to the history of{' '}
              {shown.scope.join(', ')}. Copy or share it now: you cannot see it again.
            </Callout>
            <div role="group" aria-labelledby={linkLabelId} className="flex flex-col gap-1.5">
              <SectionLabel id={linkLabelId}>Invite link</SectionLabel>
              <p className="rounded-control border-line-strong bg-surface-sunken text-text-primary border px-3.5 py-3 font-mono text-[14px] leading-5 font-medium break-all select-all">
                {link}
              </p>
            </div>
            <span className="sr-only" aria-live="polite">
              {copied ? 'Link copied' : ''}
            </span>
            <ErrorText>{error}</ErrorText>
          </SheetBody>
          <SheetFoot>
            {share && (
              <Button variant="secondary" size="mobile" onClick={onShare}>
                <Share /> Share
              </Button>
            )}
            <Button size="mobile" onClick={copy}>
              {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy link'}
            </Button>
          </SheetFoot>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Close without copying?"
        body="The link cannot be shown again. To share this history later, delete the invite and create a new one."
        confirmLabel="Close"
        what="close"
        tone="danger"
        onConfirm={async () => onOpenChange(false)}
      />
    </>
  )
}
