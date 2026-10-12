import { Check, Copy, Hourglass, Link2, Trash2 } from 'lucide-react'
import { useCopy } from '@/hooks/use-copy'
import { UserAvatar } from '@/components/shell/user-avatar'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { GuildInvitesMobile } from '@/components/settings/guild-invites-mobile'
import { InviteHistoryOption } from '@/components/settings/invite-history-option'
import { InviteOptions } from '@/components/settings/invite-options'
import { INVITE_SOON_MS, isUsedUp } from '@/components/settings/invites'
import {
  useGuildInvites,
  useInviteCreateForm,
  useInvitePermissions
} from '@/components/settings/use-guild-invites'
import { formatExpiry } from '@/lib/time-format'
import { PermanentInviteConfirm } from '@/components/settings/permanent-invite-confirm'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { displayName } from '@/lib/model'
import { cn, errMsg } from '@/lib/utils'
import { copyInviteLink } from '@/services/InviteService'
import { useGuildStore } from '@/stores/guildStore'

const GRID =
  'grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_4.5rem_minmax(0,1fr)_4.5rem] gap-3 px-4'

/**
 * Guild settings → Invites (G4): the create bar (CREATE_INSTANT_INVITE; an administrator can
 * include history, §12.11.4) and the list (MANAGE_GUILD), permanent invites first. INVITE_DELETE
 * removes a revoked invite. The link of an invite with history has a key that only its creator saw
 * once, so the list cannot copy it. The key of a new one goes to the clipboard and nowhere else.
 * The phone screen (M55) is `GuildInvitesMobile`.
 */
export function GuildInvitesTab({ guildId }: { guildId: string }): React.JSX.Element {
  return useLayout() === 'mobile' ? (
    <GuildInvitesMobile guildId={guildId} />
  ) : (
    <GuildInvitesTable guildId={guildId} />
  )
}

function GuildInvitesTable({ guildId }: { guildId: string }): React.JSX.Element {
  const { canList, canCreate, isAdmin } = useInvitePermissions(guildId)
  const members = useGuildStore((s) => s.members.get(guildId))
  const { run, busy, error, setError } = useAction()
  const { invites, now, add, revoke: revokeInvite } = useGuildInvites(guildId, canList, setError)
  const { copied, copy: copyLink } = useCopy({ onError: (e) => setError(errMsg(e)) })

  const copy = (code: string, key: string | null = null): void =>
    copyLink(() => copyInviteLink(code, key), code)

  const { options, setOptions, create, confirm, scope, history, setHistory } = useInviteCreateForm({
    guildId,
    isAdmin,
    run,
    copyInTap: false,
    onCreated: ({ invite, key }) => {
      add(invite)
      copy(invite.code, key)
    }
  })

  const revoke = async (code: string): Promise<void> => {
    await run(`revoke ${code}`, () => revokeInvite(code))
  }

  const active = invites.filter((i) => !isUsedUp(i)).length

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
                <InviteHistoryOption checked={history} scope={scope} onChange={setHistory} />
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
            {invites.map((inv) => {
              const spent = isUsedUp(inv)
              const left = inv.expiresAt ? new Date(inv.expiresAt).getTime() - now : null
              const soon = !spent && left !== null && left < INVITE_SOON_MS
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
