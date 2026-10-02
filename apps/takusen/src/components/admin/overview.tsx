'use client'

import type { AdminOverview } from '@/lib/admin'
import { DashboardSection } from '@/components/dashboard-shell'
import { adminFetch, ConfirmAction, formatBytes, useAdminData } from './kit'

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** One figure in the stat grid: a big tabular number over a muted label. */
function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="flex flex-col gap-0.5 bg-card px-4 py-3">
      <span className="text-xl leading-7 font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">
        {label}
        {note && <span className="text-muted-foreground/80"> · {note}</span>}
      </span>
    </div>
  )
}

export function AdminOverviewView(): React.JSX.Element {
  const { data, error } = useAdminData<AdminOverview>('/overview')
  if (error) {
    return (
      <p role="alert" className="border border-destructive px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    )
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const { counts, mediaNodes: m, server } = data
  return (
    <>
      <DashboardSection title="Deployment">
        <div className="grid grid-cols-2 gap-px border bg-border sm:grid-cols-4">
          <Stat label="Users" value={counts.users} note={`${counts.admins} admin`} />
          <Stat label="Online now" value={data.onlineUsers} />
          <Stat label="Guilds" value={counts.guilds} />
          <Stat label="Channels" value={counts.channels} />
          <Stat label="Messages" value={counts.messages} />
          <Stat label="Uploads" value={counts.uploads} note={formatBytes(counts.uploadBytes)} />
          <Stat label="Voice sessions" value={m.sessions} note={`of ${m.capacity}`} />
          <Stat
            label="Media nodes"
            value={`${m.active} / ${m.total}`}
            note={m.stale > 0 ? `${m.stale} stale` : m.draining > 0 ? `${m.draining} draining` : undefined}
          />
        </div>
      </DashboardSection>
      <DashboardSection title="Server">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Takusen</dt>
          <dd className="font-mono text-[13px]">{server.version}</dd>
          <dt className="text-muted-foreground">Node.js</dt>
          <dd className="font-mono text-[13px]">{server.nodeVersion}</dd>
          <dt className="text-muted-foreground">Uptime</dt>
          <dd className="tabular-nums">{uptime(server.uptimeSeconds)}</dd>
          <dt className="text-muted-foreground">Max upload</dt>
          <dd className="tabular-nums">{formatBytes(server.maxUploadBytes)}</dd>
        </dl>
      </DashboardSection>
      <DashboardSection
        title="Sign everyone out"
        description="Ends every dashboard session and every app sign-in, yours included. Everyone must sign in again."
      >
        <div>
          <ConfirmAction
            destructive
            size="default"
            label="Sign everyone out"
            title="Sign everyone out?"
            body="Every user, you included, is signed out of the dashboard and the Hachiman apps."
            confirmLabel="Sign everyone out"
            done="Everyone is signed out."
            action={() => adminFetch('/sessions/revoke-all', { method: 'POST' })}
            onDone={() => window.location.assign('/login')}
          />
        </div>
      </DashboardSection>
    </>
  )
}
