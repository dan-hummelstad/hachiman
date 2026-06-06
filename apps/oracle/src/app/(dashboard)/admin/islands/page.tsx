import { ServerIcon, ServerOffIcon } from 'lucide-react'

import { requireUser } from '@/lib/auth-helpers'
import { getIslandsOverview, type PlacedVServerView } from '@/lib/islands'
import { ISLAND_LOAD_WEIGHTS } from '@/lib/scheduler'
import { listRegions } from '@/lib/servers'
import type { Island, IslandStatus, VirtualServerStatus } from '@/db/schema'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { AddIslandDialog } from './_components/add-island-dialog'
import {
  IslandLiveMetricsRow,
  LiveMetricsBanner,
  LiveMetricsProvider,
} from './_components/island-live-metrics'
import { PlaceNowButton } from './_components/place-now-button'

export const dynamic = 'force-dynamic'

// Map lifecycle/status enums to a Badge variant. Lifecycle "active" = the happy
// path; transient states (provisioning/starting/cooling/draining) are muted;
// terminal-bad (down) is destructive.
function islandStatusVariant(
  status: IslandStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'active':
      return 'default'
    case 'draining':
      return 'secondary'
    case 'down':
      return 'destructive'
    case 'provisioning':
      return 'outline'
  }
}

function vServerStatusVariant(
  status: VirtualServerStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'active':
      return 'default'
    case 'starting':
    case 'cooling':
      return 'secondary'
    case 'inactive':
      return 'outline'
  }
}

// The scheduler's vServer-fill term: how full an island is, as a [0,1] fraction
// of its hard cap (`placedCount / maxVservers`). This is the DURABLE half of the
// scheduler's load score (`scheduler.ts`) — the only part computable here. The
// CPU + bandwidth terms are LIVE (Redis) and rendered by the polling client
// component (`_components/island-live-metrics.tsx`).
function fillFraction(placedCount: number, maxVservers: number): number {
  if (maxVservers <= 0) return 1
  const frac = placedCount / maxVservers
  return frac < 0 ? 0 : frac > 1 ? 1 : frac
}

const formatPct = (frac: number): string => `${Math.round(frac * 100)}%`

// Tone the fill readout by how close the island is to its cap, so a nearly-full
// island stands out. At/over cap = destructive (the scheduler drops it).
function fillTone(island: Island, placedCount: number): string {
  if (placedCount >= island.maxVservers) return 'text-destructive'
  const frac = fillFraction(placedCount, island.maxVservers)
  return frac >= 0.8 ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground'
}

export default async function IslandsAdminPage(): Promise<React.JSX.Element> {
  // Islands are a platform-operator concern: admin-only.
  await requireUser({ role: 'admin' })

  const [{ islands, unplaced }, regions] = await Promise.all([
    getIslandsOverview(),
    listRegions(),
  ])
  const regionLabel = (code: string): string =>
    regions.find((r) => r.code === code)?.displayName ?? code

  const renderVServerRow = (vs: PlacedVServerView): React.JSX.Element => (
    <TableRow key={vs.id}>
      <TableCell className="pl-6 font-mono text-xs text-muted-foreground">
        {/* `vs.id` IS the identity id post-refactor — the canonical
            server-id the dashboard surfaces everywhere. */}
        {vs.id.slice(0, 8)}
      </TableCell>
      <TableCell>
        <Badge variant={vServerStatusVariant(vs.status)}>{vs.status}</Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {vs.region === null ? '—' : regionLabel(vs.region)}
      </TableCell>
      <TableCell className="font-mono text-xs">{vs.port}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {vs.murmurId ?? '—'}
      </TableCell>
      <TableCell className="pr-6 text-right text-sm text-muted-foreground">
        {vs.maxUsers}
      </TableCell>
    </TableRow>
  )

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Islands</h1>
          <p className="text-sm text-muted-foreground">
            Managed Murmur host processes and the virtual servers placed on them. Each island
            shows its vServer <span className="font-medium">fill</span> — the durable half of the
            bin-packing scheduler&apos;s load score (placed ÷ {''}
            <code className="font-mono text-xs">maxVservers</code>) — and the LIVE active-users /
            CPU / bandwidth published by the island&apos;s Grumble process (Redis, polled every
            ~7s; see <code className="font-mono text-xs">ISLAND-METRICS.md</code>). CPU and
            bandwidth are stubbed at 0 by the publisher today.
          </p>
        </div>
        {/* Pass only what the dialog actually needs across the RSC/client
            boundary — code + displayName, nothing else. Avoids serialising
            the full region row (lat/lon/probe) into the client bundle. */}
        <AddIslandDialog
          regions={regions.map((r) => ({ code: r.code, displayName: r.displayName }))}
        />
      </div>

      {/* Polling root for the live metrics. Wraps every island card so the
          per-island rows can subscribe to a single shared fetch. The banner is
          silent on the happy path; surfaces when REDIS_URL is unset or the
          poll is failing. */}
      <LiveMetricsProvider>
        <LiveMetricsBanner />

        {islands.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No islands</CardTitle>
              <CardDescription>
                No managed islands have been provisioned yet. Seed dev fixtures with{' '}
                <code className="font-mono text-xs">pnpm -F @hachiman/oracle db:seed</code>.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          islands.map(({ island, vServers }) => {
            const placed = vServers.length
            const fill = fillFraction(placed, island.maxVservers)
            const atCap = placed >= island.maxVservers
            return (
              <Card key={island.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <ServerIcon className="size-4 text-muted-foreground" />
                      <CardTitle className="font-mono text-base">{island.host}</CardTitle>
                      <Badge variant={islandStatusVariant(island.status)}>{island.status}</Badge>
                      {atCap && island.status === 'active' && (
                        <Badge variant="destructive">at capacity</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{regionLabel(island.region)}</span>
                      <span aria-hidden>·</span>
                      <span className="font-mono">gRPC :{island.grpcPort}</span>
                      <span aria-hidden>·</span>
                      <span>
                        {placed}/{island.maxVservers} vServers
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">Fill</span>
                      <span className={`font-mono font-medium ${fillTone(island, placed)}`}>
                        {formatPct(fill)}
                      </span>
                    </span>
                    {/* Visual fill bar — the durable half of the bin-pack load. */}
                    <span
                      className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
                      role="presentation"
                    >
                      <span
                        className={`block h-full rounded-full ${atCap ? 'bg-destructive' : 'bg-foreground/60'}`}
                        style={{ width: `${Math.round(fill * 100)}%` }}
                      />
                    </span>
                    <span className="text-muted-foreground">
                      load contribution{' '}
                      <span className="font-mono">
                        {(fill * ISLAND_LOAD_WEIGHTS.fill).toFixed(2)}
                      </span>{' '}
                      <span className="opacity-70">
                        (fill × {ISLAND_LOAD_WEIGHTS.fill}; + cpu × {ISLAND_LOAD_WEIGHTS.cpu} + bw ×{' '}
                        {ISLAND_LOAD_WEIGHTS.bandwidth} once live)
                      </span>
                    </span>
                  </div>
                  {/* Live half: active users / CPU / bandwidth, polled from
                      /api/admin/islands/metrics. Distinguishes "no fresh data"
                      from "fresh reading of 0" — see the component for the
                      three-state model. */}
                  <IslandLiveMetricsRow islandId={island.id} />
                </CardHeader>
                <CardContent className="px-0">
                  {vServers.length === 0 ? (
                    <p className="px-6 text-sm text-muted-foreground">
                      No virtual servers placed on this island.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-6">Server</TableHead>
                          <TableHead>Lifecycle</TableHead>
                          <TableHead>Region</TableHead>
                          <TableHead>Port</TableHead>
                          <TableHead>Murmur ID</TableHead>
                          <TableHead className="pr-6 text-right">Max users</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>{vServers.map(renderVServerRow)}</TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            )
          })
        )}
      </LiveMetricsProvider>

      {unplaced.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ServerOffIcon className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Unplaced virtual servers</CardTitle>
            </div>
            <CardDescription>
              Managed virtual servers awaiting placement on an island (the bin-packing
              scheduler has not yet assigned them). Use{' '}
              <span className="font-medium">Place now</span> to manually trigger the scheduler
              against the current island set — useful for testing the bin-packer end-to-end
              before a background reconciler is wired up.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Server</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead>Max users</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unplaced.map((vs) => (
                  <TableRow key={vs.id}>
                    <TableCell className="pl-6 font-mono text-xs text-muted-foreground">
                      {vs.id.slice(0, 8)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={vServerStatusVariant(vs.status)}>{vs.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {vs.region === null ? '—' : regionLabel(vs.region)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{vs.port}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{vs.maxUsers}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <div className="flex justify-end">
                        <PlaceNowButton vserverId={vs.id} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  )
}
