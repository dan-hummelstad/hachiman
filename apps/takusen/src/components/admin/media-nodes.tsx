'use client'

import { CopyIcon, PlayIcon, ServerIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import type { AdminMediaNode } from '@/lib/admin'
import { StatusTag } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel, PanelHeader } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { adminFetch, errorText, useAdminData } from '@/components/admin/data'
import { Meter } from '@/components/ui/meter'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  FilterChips,
  ListFrame,
  matchesQuery,
  PageHead,
  QueryChip,
  RowMenu,
  useSearchParamState,
  type RowMenuItem,
} from './kit'

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

/** The value as text over a 96×6 bar; a stale node's numbers are old, so they go grey. */
function LoadCell({
  label,
  value,
  max,
  tone,
  muted,
}: {
  label: string
  value: number
  max: number
  tone: 'voice' | 'info'
  muted: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[5px]">
      <span
        className={cn('text-[13px] leading-4 font-bold tabular-nums', muted ? 'text-text-tertiary' : 'text-text-primary')}
      >
        {label}
      </span>
      <Meter value={value} max={max} tone={tone} label={label} className="h-1.5 w-24" />
    </div>
  )
}

export function AdminMediaNodesView(): React.JSX.Element {
  const { data, error, reload } = useAdminData<AdminMediaNode[]>('/media-nodes')
  const [query] = useSearchParamState('query')
  const [filter, setFilter] = useState<Filter>('all')
  const [now, setNow] = useState(() => Date.now())
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

  const nodeActions = (n: AdminMediaNode): RowMenuItem[] => [
    ...(n.adminDrain ? [{ label: 'Resume', icon: PlayIcon, onSelect: () => void setDrain(n, false) }] : []),
    {
      label: 'Copy signalling URL',
      icon: CopyIcon,
      onSelect: () =>
        void navigator.clipboard.writeText(n.signalingUrl).then(
          () => toast.success('Signalling URL copied.'),
          () => toast.error('Could not copy to the clipboard.'),
        ),
    },
    {
      label: 'Remove node',
      icon: Trash2Icon,
      destructive: true,
      confirm: {
        title: `Remove ${n.nodeId}?`,
        body: 'Deletes the registration. A node that is still running registers again at its next heartbeat, so stop it first.',
        confirmLabel: 'Remove node',
        done: 'Node removed.',
        destructive: true,
        action: () => adminFetch(nodePath(n), { method: 'DELETE' }),
        onDone: () => {
          reload()
          // The sidebar badge counts nodes on the server.
          router.refresh()
        },
      },
    },
  ]

  return (
    <>
      <PageHead
        title="Media nodes"
        description="Registered SFU nodes, their load and last heartbeat. Drain a node before you stop it."
        actions={
          <>
            <QueryChip />
            <FilterChips
              label="Filter media nodes"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: matching.length },
                { value: 'healthy', label: 'Healthy', count: matching.length - attention },
                { value: 'attention', label: 'Needs attention', count: attention },
              ]}
            />
          </>
        }
      />
      <ListFrame
        error={error}
        onRetry={reload}
        // Not `loading` from useAdminData: the 10 s refresh would dim the table each time.
        loading={data === null && !error}
        isEmpty={nodes.length === 0}
        empty={data?.length ? 'No node matches this filter.' : 'No media nodes have registered yet.'}
        emptyBody={data?.length ? undefined : 'A hachiman-media node registers itself when it starts.'}
        emptyIcon={ServerIcon}
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
                  <LoadCell
                    label={`${n.activeSessions} / ${n.maxSessions}`}
                    value={n.activeSessions}
                    max={n.maxSessions}
                    tone="voice"
                    muted={n.stale}
                  />
                </TableCell>
                <TableCell>
                  <LoadCell
                    label={`${Math.round(n.cpuFraction * 100)}%`}
                    value={n.cpuFraction}
                    max={1}
                    tone="info"
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
                    {formatRelative(n.lastHeartbeatAt, now)}
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
                    <RowMenu label={`Actions for ${n.nodeId}`} items={nodeActions(n)} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListFrame>
      <Panel>
        <PanelHeader title="Add a node" meta="nodes register themselves" as="h2" />
        <p className="max-w-[640px] p-[18px] text-[13.5px] leading-[1.5] text-text-secondary">
          Start <code className="font-mono text-[13px] text-text-primary">hachiman-media</code> with{' '}
          <code className="font-mono text-[13px] text-text-primary">MEDIA_NODE_ID</code> and{' '}
          <code className="font-mono text-[13px] text-text-primary">MEDIA_REGION</code> in its environment. It
          registers over this deployment&apos;s management gRPC and shows up here with its first heartbeat.
        </p>
      </Panel>
    </>
  )
}
