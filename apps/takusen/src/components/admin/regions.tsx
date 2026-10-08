'use client'

import { GlobeIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import type { AdminMediaNode, AdminRegion } from '@/lib/admin'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  adminFetch,
  Dot,
  errorText,
  ListFrame,
  matchesQuery,
  PageHead,
  plural,
  QueryChip,
  RowMenu,
  useAdminData,
  useSearchParamState,
} from './kit'

/** regions.probe_port's default: a probe host without a port probes 443. */
const DEFAULT_PROBE_PORT = 443
const MAX_DOTS = 8

/** Same colours as the node status tags: healthy green, draining blue, stale amber. */
function nodeTone(n: AdminMediaNode): 'warning' | 'info' | 'online' | 'offline' {
  if (n.stale) return 'warning'
  if (n.adminDrain || n.status === 'draining') return 'info'
  return n.status === 'active' ? 'online' : 'offline'
}

function RegionNodes({ nodes }: { nodes: AdminMediaNode[] }): React.JSX.Element {
  if (nodes.length === 0) return <span className="text-[13.5px] text-text-tertiary">No nodes</span>
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="inline-flex items-center gap-1" aria-hidden>
        {nodes.slice(0, MAX_DOTS).map((n) => (
          <Dot key={n.nodeId} tone={nodeTone(n)} title={n.nodeId} className="size-2" />
        ))}
      </span>
      <span className="text-[13.5px] text-text-secondary">{plural(nodes.length, 'node', 'nodes')}</span>
    </span>
  )
}

export function AdminRegionsView(): React.JSX.Element {
  const { data, error, reload } = useAdminData<AdminRegion[]>('/regions')
  // Only for the node dots; the region list works without it.
  const nodesData = useAdminData<AdminMediaNode[]>('/media-nodes').data
  const [query] = useSearchParamState('query')
  const [editing, setEditing] = useState<AdminRegion | 'new' | null>(null)
  const router = useRouter()
  // The sidebar badge counts regions on the server.
  const changed = (): void => {
    reload()
    router.refresh()
  }

  const regions = (data ?? []).filter((r) => matchesQuery(query, r.code, r.displayName, r.probeHost))
  const nodesOf = (code: string): AdminMediaNode[] => (nodesData ?? []).filter((n) => n.region === code)

  return (
    <>
      <PageHead
        title="Regions"
        description="Voice regions guilds can choose. Media nodes register into one of these."
        actions={
          <>
            <QueryChip />
            <Button className="h-[38px]" onClick={() => setEditing('new')}>
              <PlusIcon />
              Add region
            </Button>
          </>
        }
      />
      <ListFrame
        error={error}
        onRetry={reload}
        loading={data === null && !error}
        isEmpty={regions.length === 0}
        empty={data?.length ? 'No region matches this filter.' : 'No regions.'}
        emptyBody={data?.length ? undefined : 'Add one so guilds can pick where their voice runs.'}
        emptyIcon={GlobeIcon}
      >
        <Table className="table-fixed min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>Region</TableHead>
              <TableHead className="w-[286px]">Probe</TableHead>
              <TableHead className="w-[186px]">Location</TableHead>
              <TableHead className="w-[136px]">Nodes</TableHead>
              <TableHead className="w-[86px] text-right">Guilds</TableHead>
              <TableHead className="w-[126px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {regions.map((r) => (
              <TableRow key={r.code} className="[&>td]:h-[62px]">
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate text-[14.5px] font-extrabold text-text-primary">{r.displayName}</span>
                    <span className="font-mono text-xs text-text-tertiary">{r.code}</span>
                  </div>
                </TableCell>
                <TableCell className="truncate font-mono text-[12.5px] text-text-secondary">
                  {r.probeHost ? `${r.probeHost}:${r.probePort}` : <span className="text-text-disabled">—</span>}
                </TableCell>
                <TableCell className="font-mono text-[12.5px] text-text-tertiary tabular-nums">
                  {r.lat !== null && r.lon !== null ? `${r.lat}, ${r.lon}` : <span className="text-text-disabled">—</span>}
                </TableCell>
                <TableCell>
                  <RegionNodes nodes={nodesOf(r.code)} />
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right text-sm font-bold tabular-nums',
                    r.guildCount === 0 ? 'text-text-tertiary' : 'text-text-primary',
                  )}
                >
                  {r.guildCount}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2.5">
                    <Button variant="secondary" size="sm" className="h-[30px]" onClick={() => setEditing(r)}>
                      <PencilIcon />
                      Edit
                    </Button>
                    <RowMenu
                      label={`Actions for ${r.displayName}`}
                      items={[
                        {
                          label: 'Delete region',
                          icon: Trash2Icon,
                          destructive: true,
                          confirm: {
                            title: `Delete ${r.displayName}?`,
                            body:
                              r.guildCount > 0
                                ? `${plural(r.guildCount, 'guild uses', 'guilds use')} this region. They switch to automatic placement.`
                                : 'No guild uses this region. This cannot be undone.',
                            confirmLabel: 'Delete region',
                            done: 'Region deleted.',
                            destructive: true,
                            action: () => adminFetch(`/regions/${encodeURIComponent(r.code)}`, { method: 'DELETE' }),
                            onDone: changed,
                          },
                        },
                      ]}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListFrame>
      <RegionDialog
        region={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          changed()
        }}
      />
    </>
  )
}

/** Add (`region === 'new'`) or edit one region. The content remounts per open, so the form starts fresh. */
function RegionDialog({
  region,
  onClose,
  onSaved,
}: {
  region: AdminRegion | 'new' | null
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  // Lifted from the form so the window cannot close while a save is in flight.
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={region !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        {region !== null && (
          <RegionForm region={region} busy={busy} setBusy={setBusy} onCancel={onClose} onSaved={onSaved} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** An empty field means "not set" (null); numbers are parsed here, the API validates ranges. */
const optNumber = (v: FormDataEntryValue | null): number | null =>
  v === null || String(v).trim() === '' ? null : Number(v)

/** "host" or "host:port" from the one probe field; an IPv6 literal needs brackets for a port. */
function parseProbe(value: string): { probeHost: string | null; probePort?: number } {
  const v = value.trim()
  if (!v) return { probeHost: null }
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(v)
  return m ? { probeHost: m[1], probePort: Number(m[2]) } : { probeHost: v, probePort: DEFAULT_PROBE_PORT }
}

function RegionForm({
  region,
  busy,
  setBusy,
  onCancel,
  onSaved,
}: {
  region: AdminRegion | 'new'
  busy: boolean
  setBusy: (busy: boolean) => void
  onCancel: () => void
  onSaved: () => void
}): React.JSX.Element {
  const isNew = region === 'new'
  const r = isNew ? null : region
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const fields = {
      displayName: String(f.get('displayName') ?? ''),
      lat: optNumber(f.get('lat')),
      lon: optNumber(f.get('lon')),
      ...parseProbe(String(f.get('probe') ?? '')),
    }
    setBusy(true)
    setError(null)
    try {
      await (isNew
        ? adminFetch('/regions', {
            method: 'POST',
            body: JSON.stringify({ code: String(f.get('code') ?? ''), ...fields }),
          })
        : adminFetch(`/regions/${encodeURIComponent(r!.code)}`, {
            method: 'PATCH',
            body: JSON.stringify(fields),
          }))
      toast.success(isNew ? 'Region added.' : 'Region saved.')
      onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{isNew ? 'Add region' : `Edit ${r!.displayName}`}</DialogTitle>
      </DialogHeader>
      <Field id="region-name" label="Name">
        <Input id="region-name" name="displayName" required autoFocus defaultValue={r?.displayName} />
      </Field>
      <div className="grid items-start gap-3 sm:grid-cols-[170px_1fr]">
        <Field id="region-code" label="Code" hint={isNew ? 'Guilds and nodes use this.' : 'The code cannot change.'}>
          <Input
            id="region-code"
            name="code"
            required={isNew}
            disabled={!isNew}
            defaultValue={r?.code}
            placeholder="sa-east"
            aria-describedby="region-code-hint"
            className="font-mono text-sm"
          />
        </Field>
        <Field id="region-probe" label="Probe host" hint="The desktop app measures latency to it.">
          <Input
            id="region-probe"
            name="probe"
            defaultValue={r?.probeHost ? `${r.probeHost}:${r.probePort}` : ''}
            placeholder="host:443"
            aria-describedby="region-probe-hint"
            className="font-mono text-[13px]"
          />
        </Field>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field id="region-lat" label="Latitude">
          <Input
            id="region-lat"
            name="lat"
            type="number"
            step="any"
            min={-90}
            max={90}
            defaultValue={r?.lat ?? ''}
            className="font-mono text-sm"
          />
        </Field>
        <Field id="region-lon" label="Longitude">
          <Input
            id="region-lon"
            name="lon"
            type="number"
            step="any"
            min={-180}
            max={180}
            defaultValue={r?.lon ?? ''}
            className="font-mono text-sm"
          />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-[13px] font-semibold text-feature-danger-text">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {isNew ? <PlusIcon /> : null}
          {isNew ? 'Add region' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}
