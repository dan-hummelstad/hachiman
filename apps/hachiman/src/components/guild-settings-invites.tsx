import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Hourglass, Link2, Trash2 } from 'lucide-react'
import { Permissions, has, type Channel, type GatewayEvents, type Invite } from '@hachiman/client'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { InviteHistoryOption } from '@/components/settings/invite-history-option'
import { InviteOptions } from '@/components/settings/invite-options'
import { formatExpiry, inviteScope, sortInvites } from '@/components/settings/invites'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import { useInviteCreation } from '@/components/settings/use-invite-creation'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { displayName } from '@/lib/model'
import { cn, errMsg } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { copyInviteLink, createHistoryInvite, createInvite } from '@/services/InviteService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'

const NO_CHANNELS: Channel[] = []
/** An expiry closer than this shows in gold. */
const SOON_MS = 3 * 86_400_000
const GRID =
  'grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_4.5rem_minmax(0,1fr)_4.5rem] gap-3 px-4'

/**
 * Guild settings → Invites (G4): the create bar (CREATE_INSTANT_INVITE; an administrator can
 * include history, §12.11.4) and the list (MANAGE_GUILD), permanent invites first. INVITE_DELETE
 * removes a revoked invite. The link of an invite with history has a key that only its creator saw
 * once, so the list cannot copy it. The key of a new one goes to the clipboard and nowhere else.
 */
export function GuildInvitesTab({ guildId }: { guildId: string }): React.JSX.Element {
  const perms = usePermissions(guildId)
  const canList = has(perms, Permissions.MANAGE_GUILD)
  const canCreate = has(perms, Permissions.CREATE_INSTANT_INVITE)
  const isAdmin = has(perms, Permissions.ADMINISTRATOR)
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const roles = useGuildStore((s) => s.roles.get(guildId))
  const members = useGuildStore((s) => s.members.get(guildId))
  const channels = useChannelStore((s) => s.channels)
  const [invites, setInvites] = useState<Invite[]>([])
  const sorted = useMemo(() => sortInvites(invites), [invites])
  const [copied, setCopied] = useState<string | null>(null)
  const [now] = useState(Date.now)
  const [includeHistory, setIncludeHistory] = useState(false)
  const { run, busy, error, setError } = useAction()

  const scope = useMemo(
    () => (guild && roles ? inviteScope(guild, roles, channels.values()) : NO_CHANNELS),
    [guild, roles, channels]
  )
  // The user can lose ADMINISTRATOR, and the last channel can leave the scope, while it is open.
  const history = isAdmin && includeHistory && scope.length > 0

  const copy = (code: string, key: string | null = null): void => {
    copyInviteLink(code, key).then(
      () => setCopied(code),
      (e: unknown) => setError(errMsg(e))
    )
  }

  const { options, setOptions, create, confirm } = useInviteCreation({
    isAdmin,
    run,
    what: 'create an invite',
    make: async (o, acknowledgedPermanent): Promise<{ invite: Invite; key: string | null }> => {
      if (!history)
        return { invite: await createInvite(guildId, o, acknowledgedPermanent), key: null }
      const made = await createHistoryInvite(
        guildId,
        o,
        scope.map((c) => c.id),
        acknowledgedPermanent
      )
      return { invite: made.invite, key: made.key }
    },
    onCreated: ({ invite, key }) => {
      setInvites((cur) => [invite, ...cur])
      copy(invite.code, key)
    }
  })

  useEffect(() => {
    if (!canList) return
    hachiman.rest
      .getInvites(guildId)
      .then(setInvites)
      .catch((e) => setError(`Could not load invites: ${errMsg(e)}. Reopen settings to retry.`))
  }, [guildId, canList, setError])

  useEffect(() => {
    const onDelete = (d: GatewayEvents['INVITE_DELETE']): void => {
      if (d.guildId === guildId) setInvites((cur) => cur.filter((i) => i.code !== d.code))
    }
    hachiman.on('INVITE_DELETE', onDelete)
    return () => {
      hachiman.off('INVITE_DELETE', onDelete)
    }
  }, [guildId])

  const revoke = async (code: string): Promise<void> => {
    const revoked = await run(`revoke ${code}`, () => hachiman.rest.deleteInvite(code))
    if (revoked.ok) setInvites((cur) => cur.filter((i) => i.code !== code))
  }

  const usedUp = (inv: Invite): boolean => !!inv.maxUses && inv.uses >= inv.maxUses
  const active = invites.filter((i) => !usedUp(i)).length

  return (
    <div className="grid gap-6">
      {canCreate && (
        <section>
          <SectionHeading>New invite link</SectionHeading>
          <div className="bg-surface-panel border-line-hairline grid gap-3 border p-4">
            <div className="flex flex-wrap items-end gap-3 [&_[data-slot=native-select-wrapper]]:w-44">
              <InviteOptions value={options} onChange={setOptions} isAdmin={isAdmin} />
              <Button size="lg" className="ml-auto" disabled={busy} onClick={() => void create()}>
                <Link2 /> {busy ? 'Creating…' : 'Create and copy link'}
              </Button>
            </div>
            {isAdmin && (
              <div className="border-line-hairline border-t pt-3">
                <InviteHistoryOption
                  checked={history}
                  scope={scope}
                  onChange={(on) => {
                    setIncludeHistory(on)
                    // An invite with history has one use by default (§12.11.4).
                    if (on) setOptions({ ...options, maxUses: 1 })
                  }}
                />
              </div>
            )}
          </div>
          <PermanentInviteConfirm {...confirm} />
        </section>
      )}
      <ErrorText>{error}</ErrorText>
      <section>
        <SectionHeading>All invites{invites.length > 0 && ` · ${active} active`}</SectionHeading>
        {invites.length === 0 ? (
          <p className="text-text-tertiary text-sm">
            {canList ? 'No active invites.' : 'Links you create appear here.'}
          </p>
        ) : (
          <div
            role="table"
            aria-label="Invites"
            className="bg-surface-panel border-line-hairline border text-sm"
          >
            <div
              role="row"
              className={`section-label bg-surface-raised/60 border-line-hairline border-b py-2.5 ${GRID}`}
            >
              <span role="columnheader">Code</span>
              <span role="columnheader">Created by</span>
              <span role="columnheader">Uses</span>
              <span role="columnheader">Expires</span>
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
            {sorted.map((inv) => {
              const spent = usedUp(inv)
              const left = inv.expiresAt ? new Date(inv.expiresAt).getTime() - now : null
              const soon = !spent && left !== null && left < SOON_MS
              const creator = members?.get(inv.createdBy)
              const creatorName = displayName(creator)
              return (
                <div
                  key={inv.code}
                  role="row"
                  className={cn(
                    'hover:bg-surface-hover items-center py-2',
                    GRID,
                    spent && 'text-text-tertiary'
                  )}
                >
                  <span role="cell" className="flex min-w-0 items-center gap-2">
                    <code
                      className={cn(
                        'rounded-check bg-surface-sunken truncate px-2 py-1 font-mono text-[13px] font-semibold',
                        spent && 'opacity-60'
                      )}
                    >
                      {inv.code}
                    </code>
                    {inv.hasHistory && (
                      <span
                        className="bg-accent-tint text-accent-text shrink-0 px-1.5 text-[10.5px] leading-4 font-bold"
                        title="The link includes history. Only its creator saw the full link."
                      >
                        History
                      </span>
                    )}
                  </span>
                  <span role="cell" className="flex min-w-0 items-center gap-2">
                    <UserAvatar
                      name={creatorName}
                      avatar={creator?.user.avatar}
                      size={24}
                      className={spent ? 'opacity-60' : undefined}
                    />
                    <span className="truncate">{creatorName}</span>
                  </span>
                  <span role="cell" className="tabular-nums">
                    {inv.uses}
                    {inv.maxUses ? ` / ${inv.maxUses}` : ''}
                  </span>
                  <span
                    role="cell"
                    className={cn(
                      'flex items-center gap-1.5 tabular-nums',
                      soon && 'text-feature-event-text font-semibold'
                    )}
                    title={inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : undefined}
                  >
                    {spent ? (
                      'Used up'
                    ) : inv.expiresAt === null ? (
                      <span className="bg-feature-danger/15 text-feature-danger-text px-1.5 text-[10.5px] leading-4 font-bold">
                        Permanent
                      </span>
                    ) : (
                      <>
                        {soon && <Hourglass aria-hidden className="size-3.5" />}
                        {formatExpiry(inv.expiresAt)}
                      </>
                    )}
                  </span>
                  <span role="cell" className="flex justify-end gap-1">
                    {!inv.hasHistory && (
                      <IconButton
                        label={`${copied === inv.code ? 'Copied' : 'Copy'} link for ${inv.code}`}
                        className="rounded-control bg-surface-raised size-7"
                        disabled={spent}
                        onClick={() => copy(inv.code)}
                      >
                        {copied === inv.code ? (
                          <Check className="text-feature-voice-text" />
                        ) : (
                          <Copy />
                        )}
                      </IconButton>
                    )}
                    {canList && (
                      <IconButton
                        tone="danger"
                        label={`Revoke ${inv.code}`}
                        className="rounded-control bg-surface-raised text-feature-danger-text size-7"
                        onClick={() => void revoke(inv.code)}
                      >
                        <Trash2 />
                      </IconButton>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
