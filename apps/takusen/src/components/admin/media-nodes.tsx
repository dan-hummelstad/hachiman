'use client'

import { CopyIcon, PlayIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import type { AdminMediaNode } from '@/lib/admin'
import { StatusTag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/card'
import { Chip } from '@/components/ui/chip'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { adminFetch, errorText, formatDateTime, useAdminData } from './kit'
import {
  ConfirmDialog,
  ListState,
  matchesQuery,
  Meter,
  PageHead,
  QueryChip,
  RowMenu,
  timeAgo,
  useListQuery,
} from './kit-b'

type Filter = 'all' | 'healthy' | 'attention'

/** Heartbeats are a few seconds apart; refresh so "3 s ago" and Stale stay true. */
const REFRESH_MS = 10_000

const needsAttention = (n: AdminMediaNode): boolean => n.stale || n.adminDrain || n.status !== 'active'
const isDraining = (n: AdminMediaNode): boolean => !n.stale && (n.adminDrain || n.status === 'draining')

function NodeStatus({ node }: { node: AdminMediaNode }): React.JSX.Element {
  if (node.stale) return <StatusTag tone="warning">Stale</StatusTag>
  if (isDraining(node)) return <StatusTag tone="info">Draining</StatusTag>
  if (node.status === 'active') return <StatusTag tone="success">Healthy</StatusTag>
  return <StatusTag tone="neutral" className="capitalize">{node.status}</StatusTag>
}

const nodePath = (n: AdminMediaNode): string => `/media-nodes/${encodeURIComponent(n.nodeId)}`

export function AdminMediaNodesView(): React.JSX.Element {
  const { data, error, reload } = useAdminData<AdminMediaNode[]>('/media-nodes')
  const { query, clear } = useListQuery()
  const [filter, setFilter] = useState<Filter>('all')
  const [now, setNow] = useState(() => Date.now())
  const [removing, setRemoving] = useState<AdminMediaNode | null>(null)
  const router = useRouter()

  useEffect(() => {
    const t = setInterval(() => {
      reload()
      setNow(Date.now())
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [reload])

  const matching = (data ?? []).filter((n) => matchesQuery(query, n.nodeId, n.region, n.signalingUrl))
  const attention = matching.filter(needsAttention).length
  const nodes = matching.filter((n) =>
    filter === 'all' ? true : filter === 'attention' ? needsAttention(n) : !needsAttention(n),
  )

  const setDrain = async (n: AdminMediaNode, drain: boolean): Promise<void> => {
    try {
      await adminFetch(nodePath(n), {
        method: 'PATCH',
        body: JSON.stringify({ status: drain ? 'draining' : 'active' }),
      })
      reload()
      toast.success(
        drain ? `${n.nodeId} is draining. Calls on it continue until they end.` : `${n.nodeId} takes new calls again.`,
        drain ? { action: { label: 'Undo', onClick: () => void setDrain(n, false) } } : undefined,
      )
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  return (
    <>
      <PageHead
        title="Media nodes"
        description="Registered SFU nodes, their load and last heartbeat. Drain a node before you stop it."
        actions={
          <>
            {query && <QueryChip query={query} onClear={clear} />}
            <Chip selected={filter === 'all'} count={matching.length} onClick={() => setFilter('all')}>
              All
            </Chip>
            <Chip
              selected={filter === 'healthy'}
              count={matching.length - attention}
              onClick={() => setFilter('healthy')}
            >
              Healthy
            </Chip>
            <Chip selected={filter === 'attention'} count={attention} onClick={() => setFilter('attention')}>
              Needs attention
            </Chip>
          </>
        }
      />
      <ListState
        error={error}
        loading={data === null && !error}
        empty={
          nodes.length > 0
            ? null
            : data?.length
              ? 'No node matches this filter.'
              : 'No media nodes have registered yet. A hachiman-media node registers itself when it starts.'
        }
      >
        <Table className="table-fixed min-w-[960px]">
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead className="w-[136px]">Region</TableHead>
              <TableHead className="w-[132px]">Status</TableHead>
              <TableHead className="w-[146px]">Sessions</TableHead>
              <TableHead className="w-[136px]">CPU</TableHead>
              <TableHead className="w-[126px]">Heartbeat</TableHead>
              <TableHead className="w-[116px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((n) => (
              <TableRow key={n.nodeId} className="[&>td]:h-[62px]">
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[13.5px] font-semibold text-text-primary">
                        {n.nodeId}
                      </span>
                      <span className="text-[11.5px] font-bold text-text-disabled">{n.version}</span>
                    </div>
                    <span className="truncate font-mono text-[11.5px] text-text-tertiary" title={n.signalingUrl}>
                      {n.signalingUrl}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-[12.5px] text-text-secondary">{n.region}</TableCell>
                <TableCell>
                  <NodeStatus node={n} />
                </TableCell>
                <TableCell>
                  <Meter
                    label={`${n.activeSessions} / ${n.maxSessions}`}
                    fraction={n.maxSessions > 0 ? n.activeSessions / n.maxSessions : 0}
                    tone="voice"
                    muted={n.stale}
                  />
                </TableCell>
                <TableCell>
                  <Meter
                    label={`${Math.round(n.cpuFraction * 100)}%`}
                    fraction={n.cpuFraction}
                    tone="thread"
                    muted={n.stale}
                  />
                </TableCell>
                <TableCell>
                  <span
                    title={formatDateTime(n.lastHeartbeatAt)}
                    className={cn(
                      'inline-flex items-center gap-2.5 text-[13px]',
                      n.stale ? 'font-bold text-feature-event-text' : 'font-medium text-text-tertiary',
                    )}
                  >
                    {n.stale && <TriangleAlertIcon aria-label="Stale" className="size-3.5 shrink-0" />}
                    {timeAgo(n.lastHeartbeatAt, now)}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2.5">
                    {n.adminDrain || isDraining(n) ? (
                      <span className="text-[12.5px] text-text-tertiary tabular-nums">
                        {n.stale ? 'Drained' : `${n.activeSessions} left`}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant={n.stale ? 'primary' : 'secondary'}
                        className="h-[30px]"
                        onClick={() => void setDrain(n, true)}
                      >
                        Drain
                      </Button>
                    )}
                    <RowMenu label={`Actions for ${n.nodeId}`}>
                      {n.adminDrain && (
                        <DropdownMenuItem onSelect={() => void setDrain(n, false)}>
                          <PlayIcon />
                          Resume
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onSelect={() =>
                          void navigator.clipboard.writeText(n.signalingUrl).then(
                            () => toast.success('Signalling URL copied.'),
                            () => toast.error('Could not copy to the clipboard.'),
                          )
                        }
                      >
                        <CopyIcon />
                        Copy signalling URL
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(n)}>
                        <Trash2Icon />
                        Remove node
                      </DropdownMenuItem>
                    </RowMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListState>
      <Panel>
        <PanelHeader title="Add a node" meta="nodes register themselves" as="h2" />
        <p className="max-w-[640px] p-[18px] text-[13.5px] leading-[1.5] text-text-secondary">
          Start <code className="font-mono text-[13px] text-text-primary">hachiman-media</code> with{' '}
          <code className="font-mono text-[13px] text-text-primary">MEDIA_NODE_ID</code> and{' '}
          <code className="font-mono text-[13px] text-text-primary">MEDIA_REGION</code> in its environment. It
          registers over this deployment&apos;s management gRPC and shows up here with its first heartbeat.
        </p>
      </Panel>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.nodeId ?? 'node'}?`}
        body="Deletes the registration. A node that is still running registers again at its next heartbeat, so stop it first."
        confirmLabel="Remove node"
        done="Node removed."
        destructive
        action={() => adminFetch(nodePath(removing!), { method: 'DELETE' })}
        onDone={() => {
          reload()
          // The sidebar badge counts nodes on the server.
          router.refresh()
        }}
      />
    </>
  )
}
