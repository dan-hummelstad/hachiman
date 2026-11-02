import { useState } from 'react'
import { Check, Copy, History, Info, Link2, Share, UserPlus } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { Permissions, has, type Channel } from '@hachiman/client'
import { MobileField } from '@/components/mobile/field'
import { ListGroup, ListRow } from '@/components/mobile/list'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Input, useFieldControl } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import {
  InviteHistoryOption,
  InviteHistoryScope
} from '@/components/settings/invite-history-option'
import { InviteOptions } from '@/components/settings/invite-options'
import { inviteExpiryChoices } from '@/components/settings/invites'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import { useInviteCreateForm, type CreatedInvite } from '@/components/settings/use-guild-invites'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { inviteLimitsText } from '@/lib/model'
import { errMsg } from '@/lib/utils'
import { copyInviteLink, inviteUrl, type InviteOptionsValue } from '@/services/InviteService'
import { usePlatform } from '@/shared/PlatformContext'
import { useDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { Callout } from '@/components/ui/callout'

const optionsTag = (o: InviteOptionsValue, history: boolean): string =>
  `${o.expiry}:${o.maxUses}:${history}`

/**
 * A created link. `tag`: the options it was made for (`optionsTag`). `key`: the seed of an invite
 * with history, only in this state (§12.17).
 */
interface Created {
  tag: string
  code: string
  key: string | null
  /** When the link stops working (ISO), null for a permanent one. */
  expiresAt: string | null
  /** When this device made the link (ms): the mobile helper counts the expiry from it. */
  createdAt: number
  /** The channel names of the signed scope of an invite with history. */
  scope: string[]
  /** An invite with history for which this device sent nothing: it holds no group of the scope. */
  noOwnHistory: boolean
}

const toCreated = (made: CreatedInvite, tag: string): Created => ({
  tag,
  code: made.invite.code,
  key: made.key,
  expiresAt: made.invite.expiresAt,
  createdAt: Date.now(),
  scope: made.scope,
  noOwnHistory: made.noOwnHistory
})

/**
 * "Invite people": pick expiry / max uses, then "Create link" makes one server-side invite.
 * Nothing is created just by opening the window or changing an option; a changed option hides the
 * old link until the user creates a new one. A permanent invite (administrators only) first needs
 * the user to accept a warning. An administrator can include history (§12.11.4): the link then
 * holds a key that this window shows once.
 *
 * On the mobile layout (M46) it is a sheet with no Done and the guild name as the subtitle (an
 * invite has no landing channel yet). Its body is `InviteBodyMobile`.
 */
export function InviteDialog(): React.JSX.Element {
  const {
    dialog: { guildId },
    open,
    close
  } = useDialog('invite')
  const mobile = useLayout() === 'mobile'
  const invite = useInviteDialog(guildId)
  const guildName = invite.guildName

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={mobile || !guildName ? 'Invite people' : `Invite people to ${guildName}`}
      description={mobile ? guildName : invite.memberCount ? `${invite.memberCount} members` : undefined}
      icon={<UserPlus />}
      actions={
        mobile ? undefined : (
          <>
            <span className="cap-sm mr-auto flex items-center gap-1.5">
              <Info aria-hidden className="text-text-disabled size-3.5" />
              ANYONE WITH THIS LINK CAN JOIN {guildName?.toUpperCase() ?? 'THE GUILD'}
            </span>
            <Button onClick={close}>Done</Button>
          </>
        )
      }
    >
      {!invite.canCreate ? (
        <p className="text-text-secondary mobile:text-[15px] mobile:leading-[1.5] mobile:font-medium text-sm">
          You don’t have permission to create invites here. Ask a space admin for a link.
        </p>
      ) : (
        <>
          {mobile ? <InviteBodyMobile invite={invite} /> : <InviteBodyDesktop invite={invite} />}
          <PermanentInviteConfirm
            {...invite.confirm}
            scope={invite.history ? invite.scope.map((c) => `#${c.name ?? c.id}`) : null}
          />
        </>
      )}
    </ModalWindow>
  )
}

/** What `useInviteDialog` gives both bodies. */
interface InviteDialogState {
  guildName: string | undefined
  memberCount: number
  canCreate: boolean
  isAdmin: boolean
  /** The channels whose history an invite with history gives (`inviteScope`). */
  scope: readonly Channel[]
  /** The invite includes history: asked for, allowed, and with a scope. */
  history: boolean
  options: InviteOptionsValue
  /** The link made for the current options, or null. */
  shown: Created | null
  /** The full link of `shown`, with its key; empty with none. */
  link: string
  busy: boolean
  error: string | null
  copied: boolean
  /** The props of `PermanentInviteConfirm`. */
  confirm: ReturnType<typeof useInviteCreateForm>['confirm']
  create: () => void
  changeOptions: (o: InviteOptionsValue) => void
  changeHistory: (on: boolean) => void
  copy: () => void
  /** Opens the share sheet; undefined with no link or when the host cannot share. */
  share: (() => void) | undefined
}

/**
 * The state of the invite window that both layouts share: the permissions, the history scope, the
 * options, the created link, and the create, copy and share actions.
 */
function useInviteDialog(guildId: string): InviteDialogState {
  const platform = usePlatform()
  const guildName = useGuildStore((s) => s.guilds.get(guildId)?.name)
  const memberCount = useGuildStore((s) => s.members.get(guildId)?.size ?? 0)
  const perms = usePermissions(guildId)
  const canCreate = has(perms, Permissions.CREATE_INSTANT_INVITE)
  const isAdmin = has(perms, Permissions.ADMINISTRATOR)
  // Tagged (`Created.tag`) with the options it was made for, so it hides when they change.
  const [created, setCreated] = useState<Created | null>(null)
  const { run, busy, error, setError, clearError } = useAction()
  const {
    copied,
    copy: copyLink,
    reset: resetCopied
  } = useCopy({
    resetMs: null,
    onCopied: () => platform.haptic('success'),
    onError: (e) => setError(errMsg(e))
  })

  const { options, setOptions, create, confirm, scope, history, setHistory } = useInviteCreateForm({
    guildId,
    isAdmin,
    run,
    copyInTap: false,
    what: 'create an invite link',
    onCreated: (made) => {
      setCreated(toCreated(made, optionsTag(options, history)))
      resetCopied()
    }
  })

  const shown = created?.tag === optionsTag(options, history) ? created : null
  const link = shown ? inviteUrl(shown.code, shown.key) : ''

  // The `#k=` seed of a link with history may go to the share sheet (§12.17). It starts in the tap.
  const share = platform.share
  return {
    guildName,
    memberCount,
    canCreate,
    isAdmin,
    scope,
    history,
    options,
    shown,
    link,
    busy,
    error,
    copied: copied !== null,
    confirm,
    create: (): void => void create(),
    changeOptions: (o: InviteOptionsValue): void => {
      setOptions(o)
      resetCopied()
    },
    changeHistory: (on: boolean): void => {
      setHistory(on)
      resetCopied()
    },
    copy: (): void => {
      if (!shown) return
      clearError()
      copyLink(() => copyInviteLink(shown.code, shown.key))
    },
    share:
      shown && share
        ? (): void => {
            clearError()
            share({ url: link }).catch(() => setError('Could not open the share sheet.'))
          }
        : undefined
  }
}

/** The caution under a created invite with history for which this device sent nothing. */
function NoOwnHistoryNote({ size }: { size: 'default' | 'touch' }): React.JSX.Element {
  return (
    <Callout tone="caution" size={size}>
      This device has no history of these channels yet (no messages, for example). The link gives
      only the history that other members send when the new member joins.
    </Callout>
  )
}

function InviteBodyDesktop({ invite }: { invite: InviteDialogState }): React.JSX.Element {
  const { options, isAdmin, history, shown } = invite
  const expiryLabel =
    inviteExpiryChoices(isAdmin).find((o) => o.seconds === options.expiry)?.label ?? ''
  const expiryHint =
    options.expiry === 0
      ? 'This link never expires. Revoke it in Space settings when you do not need it.'
      : `This link expires after ${expiryLabel.replace(/^1 /, 'one ')} and can be used ${
          options.maxUses === 0
            ? 'any number of times'
            : options.maxUses === 1
              ? 'once'
              : `${options.maxUses} times`
        }.`
  return (
    <>
      <Field
        id="invite-link"
        label="Invite link"
        hint={
          shown?.key
            ? `${expiryHint} It includes the history of ${shown.scope.join(', ')}. Copy it now: this window does not show it again.`
            : expiryHint
        }
      >
        <div className="flex gap-2.5">
          <div className="rounded-control border-line-hairline bg-surface-sunken focus-within:border-line-strong flex h-11 min-w-0 flex-1 items-center gap-2.5 border px-3.5">
            <Link2 aria-hidden className="text-text-disabled size-3.5 shrink-0" />
            <input
              id="invite-link"
              readOnly
              value={invite.link}
              placeholder="Create a link to share it"
              onFocus={(e) => e.currentTarget.select()}
              className="placeholder:text-text-tertiary text-text-secondary min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none"
            />
            {shown && (
              <span className="cap-sm shrink-0 text-[8.5px]">
                CREATED{' '}
                {new Date(shown.createdAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            )}
          </div>
          {shown ? (
            <Button variant="secondary" className="h-[41px] px-4" onClick={invite.copy}>
              {invite.copied ? <Check className="text-text-primary" /> : <Copy />}
              {invite.copied ? 'Copied' : 'Copy link'}
            </Button>
          ) : (
            <Button className="h-[41px] px-4" disabled={invite.busy} onClick={invite.create}>
              {invite.busy ? 'Creating…' : 'Create link'}
            </Button>
          )}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <InviteOptions value={options} isAdmin={isAdmin} onChange={invite.changeOptions} />
      </div>
      {isAdmin && (
        <>
          <div className="bg-line-hairline h-px" />
          <InviteHistoryOption
            checked={history}
            scope={invite.scope}
            onChange={invite.changeHistory}
          />
        </>
      )}
      {shown?.noOwnHistory && <NoOwnHistoryNote size="default" />}
      {!history && (
        <p className="text-meta text-text-tertiary">
          This invite does not include message history. The new member sees pages, and the history
          of the channels that they can see, only when a member shares it.
        </p>
      )}
      <ErrorText>{invite.error}</ErrorText>
    </>
  )
}

/**
 * The mobile body (M46): the two limits as kit selects that stack when they do not fit, the
 * "Include history" row and its scope, and the link field with Create link, then Copy and, where
 * the host can share, Share. Its helper spells out the expiry date. When a copy fails, the whole
 * link shows in a selectable field under it, because the link field shows it shortened.
 */
function InviteBodyMobile({ invite }: { invite: InviteDialogState }): React.JSX.Element {
  const { options, isAdmin, history, shown, scope } = invite
  // Before a link exists, the helper previews the expiry from the time the sheet opened.
  const [openedAt] = useState(Date.now)
  const expiryHint = shown
    ? inviteLimitsText(
        {
          expiresAt: shown.expiresAt === null ? null : Date.parse(shown.expiresAt),
          maxUses: options.maxUses
        },
        shown.createdAt
      )
    : inviteLimitsText(
        {
          expiresAt: options.expiry === 0 ? null : openedAt + options.expiry * 1000,
          maxUses: options.maxUses
        },
        openedAt
      )
  return (
    <>
      <MobileField
        id="invite-link"
        label="Invite link"
        hint={
          shown?.key
            ? `It includes the history of ${shown.scope.join(', ')}. Copy or share it now: this sheet does not show it again.`
            : undefined
        }
        error={invite.error}
      >
        <InviteLinkControl
          link={invite.link}
          hasKey={shown?.key != null}
          busy={invite.busy}
          copied={invite.copied}
          expiryHint={expiryHint}
          onCreate={shown ? undefined : invite.create}
          onCopy={invite.copy}
          onShare={invite.share}
        />
      </MobileField>
      <InviteOptions
        layout="touch"
        value={options}
        isAdmin={isAdmin}
        onChange={invite.changeOptions}
      />
      {isAdmin && (
        <>
          <ListGroup>
            <ListRow
              icon={<History />}
              tile="neutral"
              label="Include history"
              detail={
                scope.length === 0
                  ? 'No text or pages channel is visible to everyone.'
                  : 'Earlier messages and pages of the public channels.'
              }
              disabled={scope.length === 0}
              toggle={{ checked: history, onCheckedChange: invite.changeHistory }}
            />
          </ListGroup>
          {history && <InviteHistoryScope scope={scope} size="touch" />}
        </>
      )}
      {invite.error && shown && (
        <Input
          size="touch"
          readOnly
          aria-label="Invite link"
          value={invite.link}
          onFocus={(e) => e.currentTarget.select()}
          className="font-mono select-all"
        />
      )}
      <span className="sr-only" aria-live="polite">
        {invite.copied ? 'Link copied' : ''}
      </span>
      {shown?.noOwnHistory && <NoOwnHistoryNote size="touch" />}
    </>
  )
}

/**
 * The link card of the mobile sheet (D2): the link (mono 13, the host truncates and the code stays
 * in view), then Create link, or Copy and, with `onShare`, Share, then the expiry line. The link
 * shows without its scheme; the key of a link with history shows as `#k=…`. It is an `<output>`,
 * so the field label names it; it is not a text field, so a tap raises no keyboard.
 */
function InviteLinkControl({
  link,
  hasKey,
  busy,
  copied,
  expiryHint,
  onCreate,
  onCopy,
  onShare
}: {
  link: string
  hasKey: boolean
  busy: boolean
  copied: boolean
  expiryHint: string
  /** Set while there is no link yet. */
  onCreate: (() => void) | undefined
  onCopy: () => void
  onShare: (() => void) | undefined
}): React.JSX.Element {
  const field = useFieldControl()
  // The key (`#k=`) stays out of the text: the code at the end of the path is what people check.
  const base = link.split('#')[0]
  const cut = base.lastIndexOf('/') + 1
  const host = base.slice(0, cut).replace(/^https?:\/\//, '')
  const code = base.slice(cut)
  return (
    <div className="bg-here-tint flex flex-col gap-3 rounded-[16px] p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Link2 aria-hidden className="text-here-text size-[15px] shrink-0" />
        <output
          {...field}
          aria-live="off"
          className="text-here-text flex min-w-0 flex-1 font-mono text-[13px] leading-5"
        >
          {link ? (
            <>
              <span className="truncate">{host}</span>
              <span className="shrink-0">{code}</span>
              {hasKey && <span className="shrink-0 opacity-70">#k=…</span>}
            </>
          ) : (
            <span className="text-text-secondary truncate font-sans text-[14px]">
              Create a link to share it
            </span>
          )}
        </output>
      </div>
      {onCreate ? (
        <Button size="mobile" disabled={busy} onClick={onCreate}>
          {busy ? 'Creating…' : 'Create link'}
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button size="mobile" className="flex-1" onClick={onCopy}>
            {copied ? <Check /> : <Copy className="size-[15px]" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {onShare && (
            <Button
              size="mobile"
              variant="secondary"
              aria-label="Share link"
              className="w-12 px-0"
              onClick={onShare}
            >
              <Share />
            </Button>
          )}
        </div>
      )}
      <span className="cap-sm text-text-tertiary text-[8.5px] tracking-[1px]">
        {expiryHint.toUpperCase()}
      </span>
    </div>
  )
}
