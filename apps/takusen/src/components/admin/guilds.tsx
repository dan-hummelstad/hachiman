'use client'

import { AudioLinesIcon, CastleIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'

import { EntityAvatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Tag } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fileUrl } from '@/lib/file-url'
import type { AdminGuild, AdminGuildDetail, AdminInvite } from '@/lib/admin'
import { adminFetch, useAdminData, useCursorPages } from '@/components/admin/data'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { formatDate, formatRelative, plural } from '@/lib/format'
import { ErrorBanner, IdentityCell, ListFrame, Pagination, useSearchParamState } from './kit'

const PAGE_SIZE = 50

/**
 * F3: guilds as master and detail. The search (`?query=`) lives in the page head; the selected
 * guild is `?guild=` so a link opens it. Delete lives only in the detail's danger zone, behind
 * the typed-name confirmation (F7).
 */
export function AdminGuildsView({ total }: { total: number }): React.JSX.Element {
  const router = useRouter()
  const [query] = useSearchParamState('query')
  const [selected, setSelected] = useSearchParamState('guild')
  const list = useCursorPages<AdminGuild>('/guilds', { query, limit: PAGE_SIZE })

  const deleted = (): void => {
    setSelected(null)
    list.reload()
    router.refresh()
  }

  return (
    <div className="flex flex-col items-start gap-5 xl:flex-row">
      <div className="w-full min-w-0 flex-1">
        <ListFrame
          error={list.error}
          onRetry={list.reload}
          empty={query ? `No guilds match “${query}”.` : 'No guilds yet.'}
          emptyIcon={CastleIcon}
          isEmpty={list.items.length === 0}
          loading={list.loading}
          footer={
            <Pagination
              summary={list.items.length > 0 && !query && list.hasNext ? `${total} guilds` : null}
              page={list.page}
              hasPrev={list.hasPrev}
              hasNext={list.hasNext}
              onPrev={list.prev}
              onNext={list.next}
            />
          }
        >
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Guild</TableHead>
                <TableHead className="w-[186px] max-md:hidden">Owner</TableHead>
                <TableHead className="w-[96px] text-right">Members</TableHead>
                <TableHead className="w-[146px] max-sm:hidden">Region</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.items.map((g) => {
                const isSelected = g.id === selected
                return (
                  <TableRow
                    key={g.id}
                    data-state={isSelected ? 'selected' : undefined}
                    aria-selected={isSelected}
                    className="cursor-pointer data-[state=selected]:[&>td]:bg-gold-tint"
                    onClick={() => setSelected(isSelected ? null : g.id)}
                  >
                    <TableCell className="h-[60px]">
                      <IdentityCell
                        avatar={<EntityAvatar src={fileUrl(g.icon)} name={g.name} size={34} />}
                        name={
                          // The row is the click target; the button gives keyboard and screen reader access.
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            className="rounded-check text-left font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelected(isSelected ? null : g.id)
                            }}
                          >
                            {g.name}
                          </button>
                        }
                        sub={plural(g.channelCount, 'channel')}
                      />
                    </TableCell>
                    <TableCell className="max-md:hidden">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <EntityAvatar src={fileUrl(g.owner.avatar)} name={g.owner.displayName} email={g.owner.email} size={24} />
                        <span className="truncate font-semibold text-text-secondary">{g.owner.displayName}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{g.memberCount}</TableCell>
                    <TableCell className="max-sm:hidden">
                      <RegionCell region={g.region} />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </ListFrame>
      </div>
      {selected && (
        <GuildDetail key={selected} id={selected} onClose={() => setSelected(null)} onDeleted={deleted} />
      )}
    </div>
  )
}

function RegionCell({ region }: { region: string | null }): React.JSX.Element {
  if (!region) return <span className="text-[13px] text-text-tertiary">Automatic</span>
  return (
    <span className="flex items-center gap-2.5">
      <AudioLinesIcon aria-hidden className="size-3.5 text-feature-voice-text" />
      <span className="font-mono text-[12.5px] text-text-secondary">{region}</span>
    </span>
  )
}

function GuildDetail({
  id,
  onClose,
  onDeleted,
}: {
  id: string
  onClose: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const { data: g, error, reload } = useAdminData<AdminGuildDetail>(`/guilds/${id}`)
  const { ask, dialog } = useConfirm()

  return (
    <aside
      aria-label={g ? `Guild ${g.name}` : 'Guild'}
      className="flex w-full shrink-0 flex-col border border-line-hairline bg-surface-panel xl:sticky xl:top-0 xl:w-[380px]"
    >
      <div className="flex items-center gap-3.5 border-b border-line-hairline p-[18px]">
        {g ? (
          <EntityAvatar src={fileUrl(g.icon)} name={g.name} size={48} />
        ) : (
          <span className="size-12 shrink-0 animate-pulse rounded-full bg-surface-raised" />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h2 className="truncate text-lg leading-6 font-extrabold">{g?.name ?? '…'}</h2>
          {g && <p className="text-[12.5px] text-text-tertiary">Created {formatDate(g.createdAt)}</p>}
        </div>
        <Button variant="quiet" size="icon" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {error && (
        <div className="p-[18px]">
          <ErrorBanner message={error} onRetry={reload} />
        </div>
      )}
      {g && (
        <div className="flex flex-col gap-[18px] p-[18px]">
          <IdentityCell
            avatar={<EntityAvatar src={fileUrl(g.owner.avatar)} name={g.owner.displayName} email={g.owner.email} size={30} />}
            name={g.owner.displayName}
            sub={`Owner · ${g.owner.email}`}
          />
          <dl className="grid h-[70px] grid-cols-4 divide-x divide-line-hairline border border-line-hairline bg-surface-raised">
            {(
              [
                ['members', g.memberCount],
                ['online', g.onlineCount],
                ['channels', g.channelCount],
                ['pages', g.pageCount],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="flex flex-col-reverse items-center justify-center gap-0.5">
                <dt className="text-[11.5px] text-text-tertiary">{label}</dt>
                <dd className="text-lg leading-6 font-extrabold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
          <section className="flex flex-col gap-2">
            <h3 className="section-label">Active invites</h3>
            {g.invites.length === 0 ? (
              <p className="py-1 text-[13px] text-text-tertiary">No usable invites.</p>
            ) : (
              <ul className="flex flex-col">
                {g.invites.map((inv) => (
                  <InviteRow
                    key={inv.code}
                    invite={inv}
                    onRevoke={() =>
                      ask({
                        title: `Revoke ${inv.code}?`,
                        body: 'The link stops working at once. People who already joined stay in the guild.',
                        confirmLabel: 'Revoke invite',
                        destructive: true,
                        done: 'Invite revoked.',
                        action: () =>
                          adminFetch(`/guilds/${g.id}/invites/${encodeURIComponent(inv.code)}`, { method: 'DELETE' }),
                        onDone: reload,
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-2.5 border-t border-line-hairline pt-3.5">
            <h3 className="section-label text-feature-danger-text">Danger zone</h3>
            <p className="text-[13px] leading-5 text-text-secondary">
              Deleting removes the guild, its channels and pages for {everyone(g.memberCount)}. There is no undo.
            </p>
            <Button
              variant="danger-soft"
              className="h-[38px] w-full"
              onClick={() =>
                ask({
                  title: `Delete ${g.name}?`,
                  titleIcon: <EntityAvatar src={fileUrl(g.icon)} name={g.name} size={28} />,
                  body: `This removes ${g.name}, its ${plural(g.channelCount, 'channel')} and ${plural(g.pageCount, 'page')} for ${everyone(g.memberCount)}. Messages are end-to-end encrypted, so nobody can export them first. There is no undo.`,
                  typeToConfirm: g.name,
                  typeIcon: CastleIcon,
                  confirmLabel: 'Delete guild',
                  confirmIcon: Trash2Icon,
                  destructive: true,
                  done: `${g.name} is deleted.`,
                  action: () => adminFetch(`/guilds/${g.id}`, { method: 'DELETE' }),
                  onDone: onDeleted,
                })
              }
            >
              <Trash2Icon aria-hidden />
              Delete guild…
            </Button>
          </section>
        </div>
      )}
      {dialog}
    </aside>
  )
}

function InviteRow({ invite: inv, onRevoke }: { invite: AdminInvite; onRevoke: () => void }): React.JSX.Element {
  const uses = inv.maxUses ? `${inv.uses} / ${plural(inv.maxUses, 'use')}` : plural(inv.uses, 'use')
  return (
    <li className="flex items-center gap-2.5 py-2">
      <span className="font-mono text-[13px] font-semibold tracking-[1px] text-text-primary">{inv.code}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-tertiary">
        {uses} · {expiry(inv.expiresAt)}
      </span>
      {inv.hasHistory && <Tag tone="hachiman">History</Tag>}
      <Button variant="quiet" size="sm" className="h-7 text-feature-danger-text hover:text-feature-danger-text" onClick={onRevoke}>
        Revoke
      </Button>
    </li>
  )
}

/** "all 12 members", "its only member" */
function everyone(members: number): string {
  return members === 1 ? 'its only member' : `all ${members} members`
}

function expiry(iso: string | null): string {
  return iso ? `expires ${formatRelative(iso)}` : 'never expires'
}
