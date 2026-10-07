import { useMemo, useState } from 'react'
import { Check, Copy, Link2, UserPlus } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { Permissions, has, type Channel } from '@hachiman/client'
import { Warning } from '@/components/security/screen-window'
import { Button } from '@/components/ui/button'
import { ErrorText, Field } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { InviteHistoryOption } from '@/components/settings/invite-history-option'
import { InviteOptions } from '@/components/settings/invite-options'
import { inviteExpiryChoices, inviteScope } from '@/components/settings/invites'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import { useInviteCreation } from '@/components/settings/use-invite-creation'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { errMsg } from '@/lib/utils'
import {
  copyInviteLink,
  createHistoryInvite,
  createInvite,
  inviteUrl,
  type InviteOptionsValue
} from '@/services/InviteService'
import { useChannelStore } from '@/stores/channelStore'
import { useDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'

const optionsTag = (o: InviteOptionsValue, history: boolean): string =>
  `${o.expiry}:${o.maxUses}:${history}`

const NO_CHANNELS: Channel[] = []

/**
 * A created link. `tag`: the options it was made for (`optionsTag`). `key`: the seed of an invite
 * with history, only in this state (§12.17).
 */
interface Created {
  tag: string
  code: string
  key: string | null
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
  const [includeHistory, setIncludeHistory] = useState(false)
  // Tagged (`Created.tag`) with the options it was made for, so it hides when they change.
  const [created, setCreated] = useState<Created | null>(null)
  const { run, busy, error, setError, clearError } = useAction()
  const {
    copied,
    copy: copyLink,
    reset: resetCopied
  } = useCopy({
    resetMs: null,
    onError: (e) => setError(errMsg(e))
  })

  const scope = useMemo(
    () => (guild && roles ? inviteScope(guild, roles, channels.values()) : NO_CHANNELS),
    [guild, roles, channels]
  )
  // The user can lose ADMINISTRATOR, and the last channel can leave the scope, while it is open.
  const history = isAdmin && includeHistory && scope.length > 0

  const { options, setOptions, create, confirm } = useInviteCreation({
    isAdmin,
    run,
    what: 'create an invite link',
    make: async (o, acknowledgedPermanent): Promise<Created> => {
      if (!history) {
        const inv = await createInvite(guildId, o, acknowledgedPermanent)
        return {
          tag: optionsTag(o, history),
          code: inv.code,
          key: null,
          scope: [],
          noOwnHistory: false
        }
      }
      const made = await createHistoryInvite(
        guildId,
        o,
        scope.map((c) => c.id),
        acknowledgedPermanent
      )
      // The signed scope is a subset of the input, in byte order: show it in sidebar order.
      const signed = new Set(made.channelIds)
      return {
        tag: optionsTag(o, history),
        code: made.invite.code,
        key: made.key,
        scope: scope.filter((c) => signed.has(c.id)).map((c) => `#${c.name ?? c.id}`),
        noOwnHistory: made.groups === 0
      }
    },
    onCreated: (c) => {
      setCreated(c)
      resetCopied()
    }
  })

  const tag = optionsTag(options, history)
  const shown = created?.tag === tag ? created : null
  const link = shown ? inviteUrl(shown.code, shown.key) : ''

  const copy = (): void => {
    if (!shown) return
    clearError()
    copyLink(() => copyInviteLink(shown.code, shown.key))
  }

  const expiryLabel =
    inviteExpiryChoices(isAdmin).find((o) => o.seconds === options.expiry)?.label ?? ''
  const expiryHint =
    options.expiry === 0
      ? 'This link never expires. Revoke it in Guild settings when you do not need it.'
      : `This link expires after ${expiryLabel.replace(/^1 /, 'one ')} and can be used ${
          options.maxUses === 0
            ? 'any number of times'
            : options.maxUses === 1
              ? 'once'
              : `${options.maxUses} times`
        }.`

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={guild?.name ? `Invite people to ${guild.name}` : 'Invite people'}
      icon={<UserPlus />}
      actions={
        <Button variant="secondary" onClick={close}>
          Done
        </Button>
      }
    >
      {!canCreate ? (
        <p className="text-text-secondary text-sm">
          You don’t have permission to create invites here. Ask a guild admin for a link.
        </p>
      ) : (
        <>
          <p className="text-text-secondary -mb-1 text-sm">
            Send this link to anyone you want to join.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <InviteOptions
              value={options}
              isAdmin={isAdmin}
              onChange={(o) => {
                setOptions(o)
                resetCopied()
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
                resetCopied()
              }}
            />
          )}
          <Field
            id="invite-link"
            label="Invite link"
            hint={
              shown?.key
                ? `${expiryHint} It includes the history of ${shown.scope.join(', ')}. Copy it now: this window does not show it again.`
                : expiryHint
            }
          >
            <div className="rounded-control border-line-strong bg-surface-sunken focus-within:border-accent-primary flex h-10 items-center gap-2 border pr-1 pl-3">
              <Link2 aria-hidden className="text-text-tertiary size-4 shrink-0" />
              <input
                id="invite-link"
                readOnly
                value={link}
                placeholder="Create a link to share it"
                onFocus={(e) => e.currentTarget.select()}
                className="placeholder:text-text-tertiary min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none"
              />
              {shown ? (
                <Button className="w-28" onClick={copy}>
                  {copied !== null ? <Check /> : <Copy />}
                  {copied !== null ? 'Copied' : 'Copy link'}
                </Button>
              ) : (
                <Button className="w-28" disabled={busy} onClick={() => void create()}>
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
            <p className="text-meta text-text-tertiary">
              This invite does not include message history. The new member sees pages, and the
              history of the channels that they can see, only when a member shares it.
            </p>
          )}
          <ErrorText>{error}</ErrorText>
          <PermanentInviteConfirm
            {...confirm}
            scope={history ? scope.map((c) => `#${c.name ?? c.id}`) : null}
          />
        </>
      )}
    </ModalWindow>
  )
}
