'use client'

import {
  AppWindowIcon,
  CastleIcon,
  EarthIcon,
  HourglassIcon,
  LogOutIcon,
  MailQuestionIcon,
  ServerIcon,
  TriangleAlertIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { StatusTag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader, PanelList } from '@/components/ui/card'
import type { AdminMediaNode, AdminOverview, AdminUser, Page } from '@/lib/admin'
import { cn } from '@/lib/utils'
import {
  adminFetch,
  ConfirmAction,
  EntityAvatar,
  ErrorBanner,
  errorText,
  formatBytes,
  formatDay,
  formatRelative,
  IdentityCell,
  Meter,
  plural,
  useAdminData,
} from './kit'

/**
 * F1: the state of the deployment. Five counts, what needs attention with the fix one click
 * away, voice load per region, the newest accounts, and the server facts with the
 * sign-everyone-out switch. Problems get colour; healthy numbers stay quiet.
 */
export function AdminOverviewView(): React.JSX.Element {
  const overview = useAdminData<AdminOverview>('/overview')
  const nodes = useAdminData<AdminMediaNode[]>('/media-nodes')
  const recent = useAdminData<Page<AdminUser>>('/users?limit=3')
  const reload = (): void => {
    overview.reload()
    nodes.reload()
  }

  const o = overview.data
  if (overview.error && !o) return <ErrorBanner message={overview.error} onRetry={overview.reload} />
  if (!o) return <OverviewSkeleton />
  const { counts, mediaNodes: m } = o

  return (
    <>
      <div className="grid grid-cols-2 border border-line-hairline bg-surface-panel sm:grid-cols-3 lg:grid-cols-5 [&>*]:border-line-hairline max-lg:[&>*]:border-b lg:[&>*:not(:first-child)]:border-l">
        <Stat
          icon={UsersRoundIcon}
          label="Users"
          value={counts.users}
          note={`+${counts.newUsers7d} this week`}
          tone={counts.newUsers7d > 0 ? 'good' : undefined}
        />
        <Stat icon={CastleIcon} label="Guilds" value={counts.guilds} note={plural(counts.channels, 'channel')} />
        <Stat
          icon={ServerIcon}
          label="Media nodes"
          value={counts.mediaNodes}
          note={nodeNote(m.stale, m.draining, counts.mediaNodes)}
          tone={m.stale + m.draining > 0 ? 'warn' : undefined}
        />
        <Stat
          icon={EarthIcon}
          label="Regions"
          value={counts.regions}
          note={`${o.regionLoad.filter((r) => r.nodes > 0).length} with media nodes`}
        />
        <Stat icon={AppWindowIcon} label="OIDC clients" value={counts.oidcClients} note="read only" />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
        <NeedsAttention nodes={nodes.data} error={nodes.error} unverified={counts.unverifiedUsers} onChange={reload} />
        <Panel>
          <PanelHeader title="Voice sessions by region" meta="live" />
          {o.regionLoad.length === 0 ? (
            <p className="px-[18px] py-4 text-[13px] text-text-tertiary">No regions yet.</p>
          ) : (
            <ul className="flex flex-col gap-3.5 px-[18px] py-4">
              {o.regionLoad.map((r) => (
                <li key={r.region} className="flex flex-col gap-1.5">
                  <div className="flex items-center text-[12.5px]">
                    <span className="flex-1 font-mono text-text-secondary">{r.region}</span>
                    <span className="font-bold text-text-tertiary tabular-nums">
                      {r.sessions} / {r.capacity}
                    </span>
                  </div>
                  <Meter
                    value={r.sessions}
                    max={r.capacity}
                    tone={r.capacity > 0 && r.sessions / r.capacity >= 0.85 ? 'warning' : 'voice'}
                    label={`${r.region} voice sessions`}
                  />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Panel>
          <PanelHeader title="Recently joined" meta="newest first" />
          {recent.error ? (
            <div className="p-1.5">
              <ErrorBanner message={recent.error} onRetry={recent.reload} />
            </div>
          ) : (
            <PanelList>
              {(recent.data?.items ?? []).map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/admin/users?query=${encodeURIComponent(u.email)}`}
                    className="flex h-12 items-center gap-3 rounded-control px-3 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <div className="min-w-0 flex-1">
                      <IdentityCell
                        avatar={<EntityAvatar fileKey={u.avatar} name={u.displayName} email={u.email} size={30} />}
                        name={u.displayName}
                        sub={u.email}
                      />
                    </div>
                    <span className="shrink-0 text-[13px] text-text-tertiary">{formatDay(u.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </PanelList>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Server" meta={`Takusen ${o.server.version}`} />
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 px-[18px] py-4 text-[13.5px]">
            <Fact label="Online now">{o.onlineUsers}</Fact>
            <Fact label="Messages">{o.counts.messages}</Fact>
            <Fact label="Uploads">
              {o.counts.uploads} · {formatBytes(o.counts.uploadBytes)}
            </Fact>
            <Fact label="Max upload">{formatBytes(o.server.maxUploadBytes)}</Fact>
            <Fact label="Node.js" mono>
              {o.server.nodeVersion}
            </Fact>
            <Fact label="Uptime">{uptime(o.server.uptimeSeconds)}</Fact>
          </dl>
          <div className="mt-auto flex items-center gap-3 border-t border-line-hairline px-[18px] py-3.5">
            <p className="min-w-0 flex-1 text-[13px] text-text-tertiary">
              Ends every dashboard session and app sign-in, yours included.
            </p>
            <ConfirmAction
              destructive
              icon={LogOutIcon}
              label="Sign everyone out…"
              title="Sign everyone out?"
              body="Every user, you included, is signed out of the dashboard and the Hachiman apps. Everyone must sign in again."
              confirmLabel="Sign everyone out"
              done="Everyone is signed out."
              action={() => adminFetch('/sessions/revoke-all', { method: 'POST' })}
              onDone={() => window.location.assign('/login')}
            />
          </div>
        </Panel>
      </div>
    </>
  )
}

function nodeNote(stale: number, draining: number, total: number): string {
  if (total === 0) return 'none registered'
  const parts = [stale > 0 && `${stale} stale`, draining > 0 && `${draining} draining`].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'all healthy'
}

function Stat({
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  icon: LucideIcon
  label: string
  value: number
  note: string
  tone?: 'good' | 'warn'
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 px-5 py-[18px]">
      <span className="flex items-center gap-2 text-[13px] font-bold text-text-tertiary">
        <Icon aria-hidden className="size-[15px]" />
        {label}
      </span>
      <span className="text-[30px] leading-9 font-extrabold tracking-[-0.5px] text-text-primary tabular-nums">
        {value}
      </span>
      <span
        className={cn(
          'text-[12.5px] font-semibold',
          tone === 'good' ? 'text-feature-voice-text' : tone === 'warn' ? 'text-feature-event-text' : 'text-text-tertiary',
        )}
      >
        {note}
      </span>
    </div>
  )
}

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-text-tertiary">{label}</dt>
      <dd className={cn('text-text-secondary tabular-nums', mono && 'font-mono text-[12.5px]')}>{children}</dd>
    </>
  )
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

interface AttentionItem {
  key: string
  icon: LucideIcon
  iconClass: string
  title: ReactNode
  mono?: boolean
  status?: ReactNode
  meta: string
  action: ReactNode
}

function NeedsAttention({
  nodes,
  error,
  unverified,
  onChange,
}: {
  nodes: AdminMediaNode[] | null
  error: string | null
  unverified: number
  onChange: () => void
}): React.JSX.Element {
  const items: AttentionItem[] = []
  for (const n of nodes ?? []) {
    const view = (
      <Button variant="secondary" size="sm" asChild>
        <Link href={`/admin/media-nodes?query=${encodeURIComponent(n.nodeId)}`}>View</Link>
      </Button>
    )
    if (n.stale) {
      items.push({
        key: n.nodeId,
        icon: TriangleAlertIcon,
        iconClass: 'text-feature-event-text',
        title: `${n.nodeId} stopped sending heartbeats`,
        mono: true,
        status: <StatusTag tone="warning">Stale</StatusTag>,
        meta: `Last seen ${formatRelative(n.lastHeartbeatAt)}. Placement skips it until it reports again.`,
        action: n.adminDrain ? view : <DrainButton node={n} onDone={onChange} />,
      })
    } else if (n.status === 'draining') {
      items.push({
        key: n.nodeId,
        icon: HourglassIcon,
        iconClass: 'text-feature-thread-text',
        title: `${n.nodeId} is draining`,
        mono: true,
        status: <StatusTag tone="info">Draining</StatusTag>,
        meta: `${plural(n.activeSessions, 'session')} left. Safe to stop when it reaches zero.`,
        action: view,
      })
    }
  }
  if (unverified > 0) {
    items.push({
      key: 'unverified',
      icon: MailQuestionIcon,
      iconClass: 'text-text-secondary',
      title: `${plural(unverified, 'account')} ${unverified === 1 ? "hasn't" : "haven't"} verified their email`,
      meta: 'They can sign in, but their email address is not confirmed.',
      action: (
        <Button variant="secondary" size="sm" asChild>
          <Link href="/admin/users?filter=unverified">Review</Link>
        </Button>
      ),
    })
  }

  return (
    <Panel>
      <PanelHeader title="Needs attention" meta={nodes ? plural(items.length, 'item') : undefined} />
      {error && (
        <div className="p-1.5">
          <ErrorBanner message={error} />
        </div>
      )}
      {nodes && items.length === 0 ? (
        <p className="px-[18px] py-4 text-[13.5px] text-text-tertiary">Nothing needs attention. Every node reports in.</p>
      ) : (
        <PanelList>
          {items.map((i) => (
            <li key={i.key} className="flex items-center gap-3.5 rounded-control p-3 hover:bg-surface-hover">
              <span className="flex size-[38px] shrink-0 items-center justify-center border border-line-hairline bg-surface-raised">
                <i.icon aria-hidden className={cn('size-[18px]', i.iconClass)} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'text-text-primary',
                      i.mono ? 'font-mono text-[13.5px] font-semibold' : 'text-sm font-bold',
                    )}
                  >
                    {i.title}
                  </span>
                  {i.status}
                </div>
                <span className="text-[13px] text-text-tertiary">{i.meta}</span>
              </div>
              {i.action}
            </li>
          ))}
        </PanelList>
      )}
    </Panel>
  )
}

/** Drain is the safe fix for a stale node, so it runs without a confirmation. */
function DrainButton({ node, onDone }: { node: AdminMediaNode; onDone: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        adminFetch(`/media-nodes/${encodeURIComponent(node.nodeId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'draining' }),
        })
          .then(() => {
            toast.success(`${node.nodeId} is draining.`)
            onDone()
          })
          .catch((err: unknown) => toast.error(errorText(err)))
          .finally(() => setBusy(false))
      }}
    >
      Drain
    </Button>
  )
}

function OverviewSkeleton(): React.JSX.Element {
  return (
    <div aria-busy aria-label="Loading" className="flex flex-col gap-5">
      <div className="h-[118px] animate-pulse border border-line-hairline bg-surface-panel" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="h-56 animate-pulse border border-line-hairline bg-surface-panel" />
        <div className="h-56 animate-pulse border border-line-hairline bg-surface-panel" />
      </div>
    </div>
  )
}
