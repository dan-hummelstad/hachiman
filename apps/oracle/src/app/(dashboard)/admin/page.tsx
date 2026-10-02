import { asc } from 'drizzle-orm'

import { DashboardShell } from '@/components/dashboard-shell'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { db } from '@/db/client'
import { mediaNodes } from '@/db/schema'
import { requireUser } from '@/lib/auth-helpers'

export const dynamic = 'force-dynamic'

// Read-only view of the media-node registry (rows written by the gRPC
// RegisterMediaNode / MediaNodeHeartbeat handlers).
export default async function AdminPage(): Promise<React.JSX.Element> {
  await requireUser({ role: 'admin' })
  const nodes = await db
    .select()
    .from(mediaNodes)
    .orderBy(asc(mediaNodes.region), asc(mediaNodes.nodeId))

  return (
    <DashboardShell title="Media nodes" description="Registered SFU nodes and their last heartbeat.">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Node</TableHead>
            <TableHead>Region</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sessions</TableHead>
            <TableHead>Signaling URL</TableHead>
            <TableHead>Last heartbeat</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.map((n) => (
            <TableRow key={n.nodeId}>
              <TableCell className="font-mono text-xs">{n.nodeId}</TableCell>
              <TableCell>{n.region}</TableCell>
              <TableCell>
                <Badge variant={n.status === 'active' ? 'default' : 'secondary'}>{n.status}</Badge>
              </TableCell>
              <TableCell>
                {n.activeSessions} / {n.capacity.max_sessions}
              </TableCell>
              <TableCell className="font-mono text-xs">{n.signalingUrl}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {n.lastHeartbeatAt.toISOString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DashboardShell>
  )
}
