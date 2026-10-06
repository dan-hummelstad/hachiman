import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Trash2 } from 'lucide-react'
import { Permissions, has, type GatewayEvents, type Invite } from '@hachiman/client'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { InviteOptions } from '@/components/settings/invite-options'
import { formatExpiry, sortInvites } from '@/components/settings/invites'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import { useInviteCreation } from '@/components/settings/use-invite-creation'
import { useAction } from '@/hooks/use-action'
import { usePermissions } from '@/hooks/use-hachiman'
import { displayName } from '@/lib/model'
import { errMsg } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { copyInviteLink, createInvite } from '@/services/InviteService'
import { useGuildStore } from '@/stores/guildStore'

/**
 * Create (CREATE_INSTANT_INVITE) + list/revoke (MANAGE_GUILD). The tab keeps its own local list
 * from GET /guilds/:id/invites, permanent invites first. INVITE_DELETE removes a revoked invite.
 * The link of an invite with history has a key that only its creator saw once, so the list cannot
 * copy it (§12.11.4).
 */
export function GuildInvitesTab({ guildId }: { guildId: string }): React.JSX.Element {
  const perms = usePermissions(guildId)
  const canList = has(perms, Permissions.MANAGE_GUILD)
  const canCreate = has(perms, Permissions.CREATE_INSTANT_INVITE)
  const isAdmin = has(perms, Permissions.ADMINISTRATOR)
  const members = useGuildStore((s) => s.members.get(guildId))
  const [invites, setInvites] = useState<Invite[]>([])
  const sorted = useMemo(() => sortInvites(invites), [invites])
  const [copied, setCopied] = useState<string | null>(null)
  const { run, busy, error, setError } = useAction()

  const copy = (code: string): void => {
    copyInviteLink(code).then(
      () => setCopied(code),
      (e: unknown) => setError(errMsg(e))
    )
  }

  const added = (inv: Invite): void => {
    setInvites((cur) => [inv, ...cur])
    copy(inv.code)
  }

  const { options, setOptions, create, confirm } = useInviteCreation({
    isAdmin,
    run,
    what: 'create an invite',
    make: (o, acknowledgedPermanent) => createInvite(guildId, o, acknowledgedPermanent),
    onCreated: added
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

  return (
    <div className="grid gap-8">
      {canCreate && (
        <section>
          <SectionHeading>New invite link</SectionHeading>
          <div className="flex flex-wrap items-end gap-3">
            <InviteOptions value={options} onChange={setOptions} isAdmin={isAdmin} />
            <Button className="h-9" disabled={busy} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create and copy link'}
            </Button>
          </div>
          <PermanentInviteConfirm {...confirm} />
        </section>
      )}
      <ErrorText>{error}</ErrorText>
      <section>
        <SectionHeading>Active invites</SectionHeading>
        {invites.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {canList ? 'No active invites.' : 'Links you create appear here.'}
          </p>
        ) : (
          <table className="w-full border-y text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr className="border-b">
                <th className="px-2 py-1.5 font-semibold">Code</th>
                <th className="font-semibold">Created by</th>
                <th className="font-semibold">Uses</th>
                <th className="font-semibold">Expires</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((inv) => (
                <tr key={inv.code} className="hover:bg-accent/50 border-b last:border-b-0">
                  <td className="px-2 py-1.5 font-mono text-[13px]">
                    {inv.code}
                    {inv.hasHistory && (
                      <span
                        className="border-primary text-primary ml-2 border px-1 font-sans text-xs font-semibold"
                        title="The link includes history. Only its creator saw the full link."
                      >
                        History
                      </span>
                    )}
                  </td>
                  <td className="max-w-40 truncate">{displayName(members?.get(inv.createdBy))}</td>
                  <td className="tabular-nums">
                    {inv.uses}
                    {inv.maxUses ? ` / ${inv.maxUses}` : ''}
                  </td>
                  <td
                    className="text-muted-foreground tabular-nums"
                    title={inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : undefined}
                  >
                    {inv.expiresAt === null ? (
                      <span className="border-destructive text-destructive border px-1 text-xs font-semibold">
                        Permanent
                      </span>
                    ) : (
                      formatExpiry(inv.expiresAt)
                    )}
                  </td>
                  <td className="py-1">
                    <span className="flex justify-end gap-1">
                      {!inv.hasHistory && (
                        <IconButton
                          label={`${copied === inv.code ? 'Copied' : 'Copy'} link for ${inv.code}`}
                          onClick={() => copy(inv.code)}
                        >
                          {copied === inv.code ? <Check className="text-online" /> : <Copy />}
                        </IconButton>
                      )}
                      {canList && (
                        <IconButton
                          tone="danger"
                          label={`Revoke ${inv.code}`}
                          onClick={() => void revoke(inv.code)}
                        >
                          <Trash2 />
                        </IconButton>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
