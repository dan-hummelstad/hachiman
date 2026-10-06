import { useState } from 'react'
import { Permissions, has } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { InviteOptions } from '@/components/settings/invite-options'
import { inviteExpiryChoices, isInviteExpiryChoice } from '@/components/settings/invites'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { errMsg } from '@/lib/utils'
import {
  copyInviteLink,
  createInvite,
  DEFAULT_INVITE_OPTIONS,
  inviteUrl,
  type InviteOptionsValue
} from '@/services/InviteService'
import { useDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

const optionsKey = (o: InviteOptionsValue): string => `${o.expiry}:${o.maxUses}`

/**
 * "Invite people": pick expiry / max uses, then "Create link" makes one server-side invite.
 * Nothing is created just by opening the window or changing an option; a changed option hides the
 * old link until the user creates a new one. A permanent invite (administrators only) first needs
 * the user to accept a warning.
 */
export function InviteDialog(): React.JSX.Element {
  const {
    dialog: { guildId },
    open,
    close
  } = useDialog('invite')
  const guildName = useGuildStore((s) => s.guilds.get(guildId)?.name)
  const perms = usePermissions(guildId)
  const canCreate = has(perms, Permissions.CREATE_INSTANT_INVITE)
  const isAdmin = has(perms, Permissions.ADMINISTRATOR)
  const [options, setOptions] = useState(DEFAULT_INVITE_OPTIONS)
  // Tagged with the options it was made for, so it hides when they change.
  const [created, setCreated] = useState<{ key: string; code: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmingPermanent, setConfirmingPermanent] = useState(false)
  const { run, busy, error, setError, clearError } = useAction()

  // The user can lose ADMINISTRATOR while the window is open: fall back to a choice they still have.
  if (!isInviteExpiryChoice(options.expiry, isAdmin)) {
    setOptions({ ...options, expiry: DEFAULT_INVITE_OPTIONS.expiry })
    setConfirmingPermanent(false)
  }

  const key = optionsKey(options)
  const code = created?.key === key ? created.code : null
  const link = code ? inviteUrl(code) : ''

  const create = async (): Promise<void> => {
    if (options.expiry === 0) {
      setConfirmingPermanent(true)
      return
    }
    const inv = await run('create an invite link', () => createInvite(guildId, options))
    if (!inv.ok) return
    setCreated({ key, code: inv.value.code })
    setCopied(false)
  }

  const createPermanent = async (): Promise<void> => {
    const inv = await createInvite(guildId, options, true)
    setCreated({ key, code: inv.code })
    setCopied(false)
  }

  const copy = (): void => {
    if (!code) return
    clearError()
    copyInviteLink(code).then(
      () => setCopied(true),
      (e: unknown) => setError(errMsg(e))
    )
  }

  const expiryLabel =
    inviteExpiryChoices(isAdmin).find((o) => o.seconds === options.expiry)?.label ?? ''

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={guildName ? `Invite people to ${guildName}` : 'Invite people'}
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
          <Field
            id="invite-link"
            label="Invite link"
            hint={
              options.expiry === 0
                ? 'This link never expires. Revoke it in Guild settings when you do not need it.'
                : `This link expires after ${expiryLabel.replace(/^1 /, 'one ')}.`
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
              {code ? (
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
          <ErrorText>{error}</ErrorText>
          <PermanentInviteConfirm
            open={confirmingPermanent}
            onClose={() => setConfirmingPermanent(false)}
            onConfirm={createPermanent}
          />
        </>
      )}
    </ModalWindow>
  )
}
