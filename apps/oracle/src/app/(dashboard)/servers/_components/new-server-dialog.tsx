'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CopyIcon, GaugeIcon, KeyRoundIcon, PlusIcon, SparklesIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { createServerSchema, type CreateServerInput } from '@/lib/server-schemas'

// Radix Select can't use "" as a value; this sentinel represents "no region"
// in the Select and is mapped to null in the field value (so it never reaches
// the zod resolver, which would reject the underscores).
const NO_REGION = '__none__'

type FormValues = Omit<CreateServerInput, 'ownerUserId'>

interface CreatedSecret {
  oidcClientId: string
  oidcClientSecret: string
}

export interface RegionOption {
  code: string
  displayName: string
}

// Shape returned by POST /api/servers/recommend-region (see placement.ts).
interface RecommendResponse {
  recommended: string | null
  ranking: { code: string; rttMs: number; loadScore: number | null }[]
  unmeasured: string[]
}

interface RegionLatencyState {
  /** code -> measured RTT in ms (only present for regions that were probed). */
  rttByCode: Map<string, number>
  /** The endpoint's recommended region code, or null when there's no signal. */
  recommended: string | null
  loading: boolean
}

const EMPTY_RTT = new Map<string, number>()

/**
 * Ask Oracle to rank regions by latency. The browser cannot open raw TCP/UDP
 * sockets, so it has no per-region RTT to send today — we POST an empty
 * measurement set, which makes the endpoint report every region as unmeasured
 * and `recommended: null`. That keeps the UI HONEST: we surface a real
 * recommendation + real latencies the moment a client-side probe source is
 * wired (e.g. the Node host's TCP prober relaying RTTs, or a per-region probe
 * endpoint), and until then we show "not measured" rather than a fake number.
 *
 * TODO(placement): feed real client-measured RTTs here once the host app can
 * probe regions (pkgs/hachiman-node `probeRegionsRtt`) — see PLACEMENT-DESIGN.md.
 */
function useRegionLatency(open: boolean): RegionLatencyState {
  const [state, setState] = useState<RegionLatencyState>({
    rttByCode: EMPTY_RTT,
    recommended: null,
    loading: false,
  })

  const fetchRecommendation = useCallback(async (signal: AbortSignal) => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const res = await fetch('/api/servers/recommend-region', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // No client-measured RTTs available in the browser yet (see above).
        body: JSON.stringify({ measurements: [] }),
        signal,
      })
      if (!res.ok) {
        setState({ rttByCode: EMPTY_RTT, recommended: null, loading: false })
        return
      }
      const body = (await res.json()) as RecommendResponse
      const rttByCode = new Map<string, number>()
      for (const r of body.ranking) rttByCode.set(r.code, r.rttMs)
      setState({ rttByCode, recommended: body.recommended, loading: false })
    } catch (err) {
      if (signal.aborted) return
      setState({ rttByCode: EMPTY_RTT, recommended: null, loading: false })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void fetchRecommendation(controller.signal)
    return () => controller.abort()
  }, [open, fetchRecommendation])

  return state
}

export function NewServerDialog({
  trigger,
  regions = [],
}: {
  trigger?: ReactNode
  regions?: RegionOption[]
}): React.JSX.Element {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedSecret | null>(null)
  const latency = useRegionLatency(open && !created)

  const form = useForm<FormValues>({
    resolver: zodResolver(createServerSchema),
    defaultValues: {
      name: '',
      slug: '',
      host: '',
      port: 64738,
      description: '',
      region: null,
    },
  })

  async function onSubmit(values: FormValues): Promise<void> {
    setServerError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        if (body?.error === 'SlugTaken') {
          form.setError('slug', { message: 'This slug is already taken' })
          return
        }
        if (body?.error === 'ValidationError') {
          setServerError('Some fields are invalid. Please check and try again.')
          return
        }
        setServerError(body?.error ?? `Request failed (${res.status})`)
        return
      }
      const body = await res.json()
      setCreated({
        oidcClientId: body.oidcClientId,
        oidcClientSecret: body.oidcClientSecret,
      })
      toast.success('Server registered')
      router.refresh()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSubmitting(false)
    }
  }

  function reset(): void {
    setCreated(null)
    setServerError(null)
    form.reset()
  }

  async function copySecret(): Promise<void> {
    if (!created) return
    await navigator.clipboard.writeText(created.oidcClientSecret)
    toast.success('Secret copied to clipboard')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <PlusIcon /> New server
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your OIDC client secret</DialogTitle>
              <DialogDescription>
                This secret will not be shown again. Store it somewhere safe — your
                Mumble server needs it to verify users through Takusen.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Client ID
                </span>
                <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">
                  {created.oidcClientId}
                </code>
              </div>
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Client secret
                </span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-hidden rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
                    {created.oidcClientSecret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={copySecret}
                    aria-label="Copy secret"
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  setOpen(false)
                  reset()
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
              <DialogHeader>
                <DialogTitle>Register a Mumble server</DialogTitle>
                <DialogDescription>
                  After registration you&apos;ll need to verify the host&apos;s domain
                  via DNS before it appears in the public directory.
                </DialogDescription>
              </DialogHeader>

              {serverError ? (
                <Alert variant="destructive">
                  <KeyRoundIcon />
                  <AlertTitle>Couldn&apos;t register</AlertTitle>
                  <AlertDescription>{serverError}</AlertDescription>
                </Alert>
              ) : null}

              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="My Mumble Server" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug</FormLabel>
                    <FormControl>
                      <Input placeholder="my-mumble-server" {...field} />
                    </FormControl>
                    <FormDescription>
                      Used in URLs like <code>takusen.app/servers/{field.value || 'slug'}</code>.
                      Lowercase, 3-32 chars, kebab-case.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="host"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Host</FormLabel>
                    <FormControl>
                      <Input placeholder="mumble.example.com" {...field} />
                    </FormControl>
                    <FormDescription>
                      DNS name where your Mumble server is reachable.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={65535}
                        value={field.value ?? 64738}
                        onChange={(e) => field.onChange(Number.parseInt(e.target.value, 10))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Region (optional)</FormLabel>
                    <Select
                      value={field.value ?? NO_REGION}
                      onValueChange={(value) =>
                        field.onChange(value === NO_REGION ? null : value)
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="No region" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_REGION}>No region</SelectItem>
                        {regions.map((r) => {
                          const rtt = latency.rttByCode.get(r.code)
                          const isRecommended = latency.recommended === r.code
                          return (
                            <SelectItem key={r.code} value={r.code}>
                              <span className="flex w-full items-center justify-between gap-2">
                                <span className="flex items-center gap-1.5">
                                  {r.displayName}
                                  {isRecommended ? (
                                    <span className="inline-flex items-center gap-1 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                      <SparklesIcon className="size-3" /> Recommended
                                    </span>
                                  ) : null}
                                </span>
                                <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground tabular-nums">
                                  <GaugeIcon className="size-3" />
                                  {typeof rtt === 'number' ? `${Math.round(rtt)} ms` : '—'}
                                </span>
                              </span>
                            </SelectItem>
                          )
                        })}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Voice region this server is homed in. You can change it later.{' '}
                      {latency.loading
                        ? 'Measuring latency…'
                        : latency.recommended === null
                          ? 'Latency probing isn’t wired in this browser yet, so no region is measured — pick the one nearest your users.'
                          : 'Latencies are measured from your network; “Recommended” is the lowest.'}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="What is this server for?"
                        value={field.value ?? ''}
                        onChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Registering…' : 'Register server'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  )
}
