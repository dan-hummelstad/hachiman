import { useMemo, useState } from 'react'
import { Permissions, has, type Channel } from '@hachiman/client'
import { Warning } from '@/components/security/screen-window'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { InviteHistoryOption } from '@/components/settings/invite-history-option'
import { InviteOptions } from '@/components/settings/invite-options'
import {
  inviteExpiryChoices,
  inviteScope,
  isInviteExpiryChoice
} from '@/components/settings/invites'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { errMsg } from '@/lib/utils'
import {
  copyInviteLink,
  createHistoryInvite,
  createInvite,
  DEFAULT_INVITE_OPTIONS,
  inviteUrl,
  type InviteOptionsValue
} from '@/services/InviteService'
import { useChannelStore } from '@/stores/channelStore'
import { useDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

const optionsKey = (o: InviteOptionsValue, history: boolean): string =>
  `${o.expiry}:${o.maxUses}:${history}`

const NO_CHANNELS: Channel[] = []

/** A created link. `secret`: the key of an invite with history, only in this state (§12.17). */
interface Created {
  key: string
  code: string
  secret: string | null
  /** The channel names of the signed scope of an invite with history. */
  scope: string[]
  /** An invite with history for which this device sent nothing: it holds no group of the scope. */
  noOwnHistory: boolean
}

/**
 * "Invite people": pick expiry / max uses, then "Create link" makes one server-side invite.
 * Nothing is created just by opening the window or changing an option; a changed option hides the
 * old link until the user creates a new one. A permanent invite (administrators only) first needs
 * the user to accept a warning. An administrator can include history (§12.11.4): the link then
 * holds a key that this window shows once.
 */
export function InviteDialog(): React.JSX.Element {
  const {
    dialog: { guildId },
    open,
    close
  } = useDialog('invite')
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const roles = useGuildStore((s) => s.roles.get(guildId))
  const channels = useChannelStore((s) => s.channels)
  const perms = usePermissions(guildId)
  const canCreate = has(perms, Permissions.CREATE_INSTANT_INVITE)
  const isAdmin = has(perms, Permissions.ADMINISTRATOR)
  const [options, setOptions] = useState(DEFAULT_INVITE_OPTIONS)
  const [includeHistory, setIncludeHistory] = useState(false)
  // Tagged with the options it was made for, so it hides when they change.
  const [created, setCreated] = useState<Created | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmingPermanent, setConfirmingPermanent] = useState(false)
  const { run, busy, error, setError, clearError } = useAction()

  const scope = useMemo(
    () => (guild && roles ? inviteScope(guild, roles, channels.values()) : NO_CHANNELS),
    [guild, roles, channels]
  )
  // The user can lose ADMINISTRATOR, and the last channel can leave the scope, while it is open.
  const history = isAdmin && includeHistory && scope.length > 0

  // The user can lose ADMINISTRATOR while the window is open: fall back to a choice they still have.
  if (!isInviteExpiryChoice(options.expiry, isAdmin)) {
    setOptions({ ...options, expiry: DEFAULT_INVITE_OPTIONS.expiry })
    setConfirmingPermanent(false)
  }

  const key = optionsKey(options, history)
  const shown = created?.key === key ? created : null
  const link = shown ? inviteUrl(shown.code, shown.secret) : ''

  const make = async (acknowledgedPermanent: boolean): Promise<Created> => {
    if (!history) {
      const inv = await createInvite(guildId, options, acknowledgedPermanent)
      return { key, code: inv.code, secret: null, scope: [], noOwnHistory: false }
    }
    const made = await createHistoryInvite(
      guildId,
      options,
      scope.map((c) => c.id),
      acknowledgedPermanent
    )
    // The signed scope is a subset of the input, in byte order: show it in sidebar order.
    const signed = new Set(made.channelIds)
    return {
      key,
      code: made.invite.code,
      secret: made.key,
      scope: scope.filter((c) => signed.has(c.id)).map((c) => `#${c.name ?? c.id}`),
      noOwnHistory: made.groups === 0
    }
  }

  const create = async (): Promise<void> => {
    if (options.expiry === 0) {
      setConfirmingPermanent(true)
      return
    }
    const made = await run('create an invite link', () => make(false))
    if (!made.ok) return
    setCreated(made.value)
    setCopied(false)
  }

  const createPermanent = async (): Promise<void> => {
    setCreated(await make(true))
    setCopied(false)
  }

  const copy = (): void => {
    if (!shown) return
    clearError()
    copyInviteLink(shown.code, shown.secret).then(
      () => setCopied(true),
      (e: unknown) => setError(errMsg(e))
    )
  }

  const expiryLabel =
    inviteExpiryChoices(isAdmin).find((o) => o.seconds === options.expiry)?.label ?? ''
  const expiryHint =
    options.expiry === 0
      ? 'This link never expires. Revoke it in Guild settings when you do not need it.'
      : `This link expires after ${expiryLabel.replace(/^1 /, 'one ')}.`

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={guild?.name ? `Invite people to ${guild.name}` : 'Invite people'}
      description="Send this link to anyone you want to join."
      actions={
        <Button variant="ghost" onClick={close}>
          Done
        </Button>
      }
    >
      {!canCreate ? (
        <p className="text-muted-foreground text-sm">
          You don’t have permission to create invites here. Ask a guild admin for a link.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <InviteOptions
              value={options}
              isAdmin={isAdmin}
              onChange={(o) => {
                setOptions(o)
                setCopied(false)
              }}
            />
          </div>
          {isAdmin && (
            <InviteHistoryOption
              checked={history}
              scope={scope}
              onChange={(on) => {
                setIncludeHistory(on)
                // An invite with history has one use by default (§12.11.4).
                if (on) setOptions({ ...options, maxUses: 1 })
                setCopied(false)
              }}
            />
          )}
          <Field
            id="invite-link"
            label="Invite link"
            hint={
              shown?.secret
                ? `${expiryHint} It includes the history of ${shown.scope.join(', ')}. Copy it now: this window does not show it again.`
                : expiryHint
            }
          >
            <div className="flex">
              <Input
                id="invite-link"
                readOnly
                value={link}
                placeholder="Create a link to share it"
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-[13px]"
              />
              {shown ? (
                <Button className="h-9 w-28 shrink-0" onClick={copy}>
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              ) : (
                <Button className="h-9 w-28 shrink-0" disabled={busy} onClick={() => void create()}>
                  {busy ? 'Creating…' : 'Create link'}
                </Button>
              )}
            </div>
          </Field>
          {shown?.noOwnHistory && (
            <Warning>
              This device has no history of these channels yet (no messages, for example). The link
              gives only the history that other members send when the new member joins.
            </Warning>
          )}
          {!history && (
            <p className="text-muted-foreground text-xs leading-4">
              This invite does not include message history. The new member sees pages, and the
              history of the channels that they can see, only when a member shares it.
            </p>
          )}
          <ErrorText>{error}</ErrorText>
          <PermanentInviteConfirm
            open={confirmingPermanent}
            onClose={() => setConfirmingPermanent(false)}
            onConfirm={createPermanent}
            scope={history ? scope.map((c) => `#${c.name ?? c.id}`) : null}
          />
        </>
      )}
    </ModalWindow>
  )
}
