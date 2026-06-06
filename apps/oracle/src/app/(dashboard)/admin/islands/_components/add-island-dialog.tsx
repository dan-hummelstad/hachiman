'use client'

/**
 * Admin "Add Island" dialog.
 *
 * Manually registers an island row in the control-plane DB. The expected
 * usage is "I just stood up a managed Grumble process; tell Oracle about
 * it so the scheduler will consider it." This is intentionally a thin
 * surface over `POST /api/admin/islands` — no health probe of the gRPC
 * endpoint, no auto-status flip. An admin can stamp the row as `active`
 * directly if they're confident the process is up; the safer default is
 * `provisioning` until the future health-poller lands.
 *
 * Self-refreshes the admin page on success via `router.refresh()` so the
 * new island card appears without a manual reload — the page is a Server
 * Component, so RSC's refresh path is the cleanest re-fetch.
 */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { PlusIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface RegionOption {
  code: string
  displayName: string
}

type IslandStatus = 'provisioning' | 'active' | 'draining' | 'down'

const STATUS_OPTIONS: ReadonlyArray<{ value: IslandStatus; label: string; description: string }> = [
  {
    value: 'provisioning',
    label: 'Provisioning',
    description: 'Pod coming up; scheduler will NOT place vServers yet.',
  },
  {
    value: 'active',
    label: 'Active',
    description: 'Healthy; scheduler treats it as a placement candidate.',
  },
  {
    value: 'draining',
    label: 'Draining',
    description: 'No NEW placements; existing vServers stay until migrated.',
  },
  {
    value: 'down',
    label: 'Down',
    description: 'Unhealthy / terminated. Scheduler skips it entirely.',
  },
]

const DEFAULT_GRPC_PORT = 9090
const DEFAULT_MAX_VSERVERS = 50

interface AddIslandDialogProps {
  regions: RegionOption[]
}

export function AddIslandDialog({ regions }: AddIslandDialogProps): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState('')
  const [grpcPort, setGrpcPort] = useState<number>(DEFAULT_GRPC_PORT)
  const [region, setRegion] = useState<string>(regions[0]?.code ?? '')
  const [status, setStatus] = useState<IslandStatus>('provisioning')
  const [maxVservers, setMaxVservers] = useState<number>(DEFAULT_MAX_VSERVERS)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the form when the dialog opens so a previous attempt's text
  // doesn't bleed into the next session.
  const reset = (): void => {
    setHost('')
    setGrpcPort(DEFAULT_GRPC_PORT)
    setRegion(regions[0]?.code ?? '')
    setStatus('provisioning')
    setMaxVservers(DEFAULT_MAX_VSERVERS)
    setSubmitting(false)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const trimmedHost = host.trim()
    if (!trimmedHost) {
      setError('Host is required.')
      return
    }
    if (!region) {
      setError('Region is required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/islands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: trimmedHost, grpcPort, region, status, maxVservers }),
      })
      if (!res.ok) {
        // Try the structured `{ error, message }` shape api-helpers
        // returns; fall back to status text if parsing fails.
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null
        throw new Error(body?.message ?? body?.error ?? `Request failed (${res.status})`)
      }
      // Refresh the RSC page so the new island card shows up immediately.
      router.refresh()
      setOpen(false)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create island.')
    } finally {
      setSubmitting(false)
    }
  }

  const noRegions = regions.length === 0

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon className="size-4" />
          Add island
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(e) => void handleSubmit(e)}>
          <DialogHeader>
            <DialogTitle>Register an island</DialogTitle>
            <DialogDescription>
              Adds a managed Grumble process to the control plane so the bin-packing
              scheduler considers it for vServer placements. The host + gRPC port
              must already be reachable for placements to actually succeed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="island-host">Host</Label>
              <Input
                id="island-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="island-use1-a.dev.invalid"
                disabled={submitting}
                autoFocus
              />
              <p className="text-muted-foreground text-xs">
                Routable DNS name or IP of the island&apos;s Grumble pod.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="island-grpc">gRPC port</Label>
                <Input
                  id="island-grpc"
                  type="number"
                  min={1}
                  max={65535}
                  value={grpcPort}
                  onChange={(e) => setGrpcPort(Number(e.target.value))}
                  disabled={submitting}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="island-max">Max vServers</Label>
                <Input
                  id="island-max"
                  type="number"
                  min={1}
                  max={10_000}
                  value={maxVservers}
                  onChange={(e) => setMaxVservers(Number(e.target.value))}
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="island-region">Region</Label>
              <Select
                value={region}
                onValueChange={setRegion}
                disabled={submitting || noRegions}
              >
                <SelectTrigger id="island-region" className="w-full">
                  <SelectValue placeholder={noRegions ? 'No regions configured' : 'Pick a region'} />
                </SelectTrigger>
                <SelectContent>
                  {regions.map((r) => (
                    <SelectItem key={r.code} value={r.code}>
                      <span className="flex items-center gap-2">
                        <span>{r.displayName}</span>
                        <span className="text-muted-foreground font-mono text-xs">{r.code}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {noRegions && (
                <p className="text-destructive text-xs">
                  No regions in the database. Seed regions first via{' '}
                  <code className="font-mono text-[11px]">pnpm -F @hachiman/oracle db:seed</code>.
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="island-status">Initial status</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as IslandStatus)}
                disabled={submitting}
              >
                <SelectTrigger id="island-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="flex flex-col items-start">
                        <span>{opt.label}</span>
                        <span className="text-muted-foreground text-[11px]">
                          {opt.description}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || noRegions || !host.trim() || !region}>
              {submitting ? 'Adding…' : 'Add island'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
