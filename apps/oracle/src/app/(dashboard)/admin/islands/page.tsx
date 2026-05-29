import { ServerIcon, ServerOffIcon } from 'lucide-react'

import { requireUser } from '@/lib/auth-helpers'
import { getIslandsOverview } from '@/lib/islands'
import { listRegions } from '@/lib/servers'
import type { IslandStatus, VirtualServer, VirtualServerStatus } from '@/db/schema'

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

export default async function IslandsAdminPage(): Promise<React.JSX.Element> {
  // Islands are a platform-operator concern: admin-only.
  await requireUser({ role: 'admin' })

  const [{ islands, unplaced }, regions] = await Promise.all([
    getIslandsOverview(),
    listRegions(),
  ])
  const regionLabel = (code: string): string =>
    regions.find((r) => r.code === code)?.displayName ?? code

  const renderVServerRow = (vs: VirtualServer): React.JSX.Element => (
    <TableRow key={vs.id}>
      <TableCell className="pl-6 font-mono text-xs text-muted-foreground">
        {vs.serverId.slice(0, 8)}
      </TableCell>
      <TableCell>
        <Badge variant={vServerStatusVariant(vs.status)}>{vs.status}</Badge>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">{regionLabel(vs.region)}</TableCell>
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Islands</h1>
        <p className="text-sm text-muted-foreground">
          Managed Murmur host processes and the virtual servers placed on them. Live load
          metrics (users / CPU / bandwidth) are not shown here — they come from the runtime
          layer (Redis) at scheduling time.
        </p>
      </div>

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
        islands.map(({ island, vServers }) => (
          <Card key={island.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ServerIcon className="size-4 text-muted-foreground" />
                  <CardTitle className="font-mono text-base">{island.host}</CardTitle>
                  <Badge variant={islandStatusVariant(island.status)}>{island.status}</Badge>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{regionLabel(island.region)}</span>
                  <span aria-hidden>·</span>
                  <span className="font-mono">gRPC :{island.grpcPort}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {vServers.length}/{island.maxVservers} vServers
                  </span>
                </div>
              </div>
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
        ))
      )}

      {unplaced.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ServerOffIcon className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">Unplaced virtual servers</CardTitle>
            </div>
            <CardDescription>
              Managed virtual servers awaiting placement on an island (the bin-packing
              scheduler has not yet assigned them).
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
                  <TableHead>Murmur ID</TableHead>
                  <TableHead className="pr-6 text-right">Max users</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>{unplaced.map(renderVServerRow)}</TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  )
}
