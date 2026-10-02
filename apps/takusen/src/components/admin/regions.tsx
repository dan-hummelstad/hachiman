'use client'

import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import type { AdminRegion } from '@/lib/admin'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { adminFetch, ConfirmAction, errorText, ListFrame, useAdminData } from './kit'

export function AdminRegionsView(): React.JSX.Element {
  const { data, error, reload } = useAdminData<AdminRegion[]>('/regions')
  const [editing, setEditing] = useState<AdminRegion | 'new' | null>(null)
  const regions = data ?? []

  return (
    <div className="flex flex-col gap-4">
      <Button className="self-start" onClick={() => setEditing('new')}>
        Add region
      </Button>
      <ListFrame
        error={error}
        empty="No regions. Add one so guilds can pick where their voice runs."
        isEmpty={regions.length === 0}
        loading={data === null && !error}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Region</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Probe</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {regions.map((r) => (
              <TableRow key={r.code}>
                <TableCell className="font-medium">{r.displayName}</TableCell>
                <TableCell className="font-mono text-[13px]">{r.code}</TableCell>
                <TableCell className="font-mono text-[13px] text-muted-foreground">
                  {r.probeHost ? `${r.probeHost}:${r.probePort}` : '—'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  {r.lat !== null && r.lon !== null ? `${r.lat}, ${r.lon}` : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <ConfirmAction
                      destructive
                      label="Delete"
                      title={`Delete ${r.displayName}?`}
                      body="Guilds that use this region switch to automatic placement."
                      confirmLabel="Delete region"
                      done="Region deleted."
                      action={() =>
                        adminFetch(`/regions/${encodeURIComponent(r.code)}`, { method: 'DELETE' })
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
      <RegionDialog
        region={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          reload()
        }}
      />
    </div>
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
      <DialogContent>
        {region !== null && (
          <RegionForm
            region={region}
            busy={busy}
            setBusy={setBusy}
            onCancel={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** An empty field means "not set" (null); numbers are parsed here, the API validates ranges. */
const optNumber = (v: FormDataEntryValue | null): number | null =>
  v === null || String(v).trim() === '' ? null : Number(v)

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
    const probeHost = String(f.get('probeHost') ?? '').trim()
    const probePort = optNumber(f.get('probePort'))
    const fields = {
      displayName: String(f.get('displayName') ?? ''),
      lat: optNumber(f.get('lat')),
      lon: optNumber(f.get('lon')),
      probeHost: probeHost || null,
      ...(probePort !== null ? { probePort } : {}),
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
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <Field id="region-name" label="Name">
          <Input id="region-name" name="displayName" required defaultValue={r?.displayName} />
        </Field>
        <Field id="region-code" label="Code" hint={isNew ? 'Lowercase, e.g. eu-west.' : 'The code cannot change.'}>
          <Input
            id="region-code"
            name="code"
            required={isNew}
            disabled={!isNew}
            defaultValue={r?.code}
            className="font-mono"
          />
        </Field>
        <Field id="region-probe-host" label="Probe host" hint="Clients measure latency to it.">
          <Input id="region-probe-host" name="probeHost" defaultValue={r?.probeHost ?? ''} />
        </Field>
        <Field id="region-probe-port" label="Probe port">
          <Input
            id="region-probe-port"
            name="probePort"
            type="number"
            min={1}
            max={65535}
            defaultValue={r?.probePort}
          />
        </Field>
        <Field id="region-lat" label="Latitude">
          <Input id="region-lat" name="lat" type="number" step="any" defaultValue={r?.lat ?? ''} />
        </Field>
        <Field id="region-lon" label="Longitude">
          <Input id="region-lon" name="lon" type="number" step="any" defaultValue={r?.lon ?? ''} />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {isNew ? 'Add region' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}
