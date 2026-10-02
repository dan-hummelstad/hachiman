'use client'

import type { AdminMediaNode } from '@/lib/admin'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { adminFetch, ConfirmAction, formatDateTime, ListFrame, useAdminData } from './kit'

/** Status as shape plus colour (docs/ui-redesign.md §1): filled square only when serving. */
function NodeStatus({ node }: { node: AdminMediaNode }): React.JSX.Element {
  const label = node.stale ? 'stale' : node.adminDrain ? 'draining (admin)' : node.status
  const serving = node.status === 'active' && !node.stale
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0',
          serving ? 'bg-online' : node.stale ? 'border-2 border-dnd' : 'border-2 border-idle',
        )}
      />
      {label}
    </span>
  )
}

export function AdminMediaNodesView(): React.JSX.Element {
  const { data, error, reload } = useAdminData<AdminMediaNode[]>('/media-nodes')
  const nodes = data ?? []
  return (
    <ListFrame
      error={error}
      empty="No media nodes have registered yet. A hachiman-media node registers itself when it starts."
      isEmpty={nodes.length === 0}
      loading={data === null && !error}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Node</TableHead>
            <TableHead>Region</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Sessions</TableHead>
            <TableHead className="text-right">CPU</TableHead>
            <TableHead>Signaling URL</TableHead>
            <TableHead>Last heartbeat</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.map((n) => (
            <TableRow key={n.nodeId}>
              <TableCell className="font-mono text-[13px]">
                {n.nodeId}
                <div className="text-xs text-muted-foreground">{n.version}</div>
              </TableCell>
              <TableCell>{n.region}</TableCell>
              <TableCell>
                <NodeStatus node={n} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {n.activeSessions} / {n.maxSessions}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {Math.round(n.cpuFraction * 100)}%
              </TableCell>
              <TableCell className="font-mono text-[13px]">{n.signalingUrl}</TableCell>
              <TableCell className="text-xs text-muted-foreground tabular-nums">
                {formatDateTime(n.lastHeartbeatAt)}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1.5">
                  {n.adminDrain ? (
                    <ConfirmAction
                      label="Resume"
                      title={`Resume ${n.nodeId}?`}
                      body="New voice sessions can be placed on this node again."
                      confirmLabel="Resume"
                      done="Node resumed."
                      action={() =>
                        adminFetch(`/media-nodes/${encodeURIComponent(n.nodeId)}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ status: 'active' }),
                        })
                      }
                      onDone={reload}
                    />
                  ) : (
                    <ConfirmAction
                      label="Drain"
                      title={`Drain ${n.nodeId}?`}
                      body="No new voice sessions go to this node. Calls on it now continue until they end."
                      confirmLabel="Drain"
                      done="Node draining."
                      action={() =>
                        adminFetch(`/media-nodes/${encodeURIComponent(n.nodeId)}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ status: 'draining' }),
                        })
                      }
                      onDone={reload}
                    />
                  )}
                  <ConfirmAction
                    destructive
                    label="Remove"
                    title={`Remove ${n.nodeId}?`}
                    body="Deletes the registration. A node that is still running registers again at its next heartbeat, so stop it first."
                    confirmLabel="Remove node"
                    done="Node removed."
                    action={() =>
                      adminFetch(`/media-nodes/${encodeURIComponent(n.nodeId)}`, { method: 'DELETE' })
                    }
                    onDone={reload}
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ListFrame>
  )
}
