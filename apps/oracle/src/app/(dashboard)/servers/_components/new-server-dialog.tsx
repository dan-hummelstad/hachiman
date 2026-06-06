'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useForm, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  ChevronLeftIcon,
  CloudIcon,
  CopyIcon,
  GaugeIcon,
  KeyRoundIcon,
  PlusIcon,
  ServerIcon,
  SparklesIcon,
} from 'lucide-react'
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
import { createServerSchema } from '@/lib/server-schemas'

// Radix Select can't use "" as a value; this sentinel represents "no region"
// in the Select and is mapped to null in the field value (so it never reaches
// the zod resolver, which would reject the underscores).
const NO_REGION = '__none__'

// Two paths, mirroring the client app's AddServerDialog choose-then-branch
// pattern (apps/hachiman/src/components/add-server-dialog.tsx): a `choose`
// step picks the hosting model, then we render the matching form.
type Step = 'choose' | 'self-hosted' | 'managed'

// Per-branch schemas reused for per-form `zodResolver` instances. The shared
// `createServerSchema` is a discriminated union; useForm needs a single
// concrete object shape per branch so field names + error paths line up with
// the inputs each branch actually renders.
const createServerSchemaOptions = createServerSchema.options
const selfHostedSchema = createServerSchemaOptions[0]
const managedSchema = createServerSchemaOptions[1]

type SelfHostedFormValues = z.infer<typeof selfHostedSchema>
type ManagedFormValues = z.infer<typeof managedSchema>

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
    } catch {
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

/**
 * Region <Select> shared between the two forms. Both branches have a `region`
 * field with the same shape, so we just take a generically-typed `Control`
 * that has `region: string | null | undefined`. The latency hint + the
 * "Recommended" badge are identical on both paths.
 */
type FormWithRegion = { region?: string | null }
function RegionField<TForm extends FormWithRegion>({
  regions,
  latency,
  control,
  helpText,
}: {
  regions: RegionOption[]
  latency: RegionLatencyState
  control: Control<TForm>
  helpText: string
}): React.JSX.Element {
  return (
    <FormField
      // Per-form Control has the right field set; the cast is because
      // `region` is declared as an optional union member of `TForm` and
      // FormField's path-narrowing can't see through the generic.
      control={control as unknown as Control<{ region?: string | null }>}
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
          <FormDescription>{helpText}</FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function regionHelpText(latency: RegionLatencyState): string {
  if (latency.loading) return 'Measuring latency…'
  if (latency.recommended === null) {
    return 'Latency probing isn’t wired in this browser yet, so no region is measured — pick the one nearest your users.'
  }
  return 'Latencies are measured from your network; “Recommended” is the lowest.'
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
  const [step, setStep] = useState<Step>('choose')
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedSecret | null>(null)
  const latency = useRegionLatency(open && !created)

  // Two react-hook-form instances, one per branch of the discriminated union.
  // Each is bound to the matching branch schema so the field set + error
  // paths line up with the inputs each branch actually renders.
  const selfHostedForm = useForm<SelfHostedFormValues>({
    resolver: zodResolver(selfHostedSchema),
    defaultValues: {
      mode: 'self-hosted',
      name: '',
      slug: '',
      host: '',
      port: 64738,
      description: '',
      region: null,
    },
  })

  const managedForm = useForm<ManagedFormValues>({
    resolver: zodResolver(managedSchema),
    defaultValues: {
      mode: 'managed',
      name: '',
      slug: '',
      description: '',
      region: null,
    },
  })

  // Cross-mode draft of the fields both forms share (name/slug/description/
  // region). When the user picks a mode, types some values, hits the back
  // arrow, then picks the other mode, we don't want them to retype the same
  // name + slug. We snapshot common fields off the leaving form into this ref
  // and re-seed them into the destination form when it's still untouched.
  // react-hook-form already preserves *intra-mode* state on its own; this is
  // only for the cross-mode jump.
  const sharedDraftRef = useRef<{
    name?: string
    slug?: string
    description?: string | null
    region?: string | null
  }>({})

  function gotoChoose(from: 'managed' | 'self-hosted'): void {
    const form = from === 'managed' ? managedForm : selfHostedForm
    const v = form.getValues()
    sharedDraftRef.current = {
      name: v.name,
      slug: v.slug,
      description: v.description ?? null,
      region: v.region ?? null,
    }
    setStep('choose')
    setServerError(null)
  }

  function gotoMode(target: 'managed' | 'self-hosted'): void {
    const draft = sharedDraftRef.current
    // useForm returns differently-typed setValue/getValues for each branch
    // (the discriminated union doesn't collapse), so the seed step is
    // duplicated rather than parameterised. Only fill empty fields — never
    // clobber values the user already typed in the destination form.
    if (target === 'managed') {
      const cur = managedForm.getValues()
      if (!cur.name && draft.name) managedForm.setValue('name', draft.name)
      if (!cur.slug && draft.slug) managedForm.setValue('slug', draft.slug)
      if (!cur.description && draft.description)
        managedForm.setValue('description', draft.description)
      if (!cur.region && draft.region) managedForm.setValue('region', draft.region)
    } else {
      const cur = selfHostedForm.getValues()
      if (!cur.name && draft.name) selfHostedForm.setValue('name', draft.name)
      if (!cur.slug && draft.slug) selfHostedForm.setValue('slug', draft.slug)
      if (!cur.description && draft.description)
        selfHostedForm.setValue('description', draft.description)
      if (!cur.region && draft.region) selfHostedForm.setValue('region', draft.region)
    }
    setStep(target)
  }

  async function submit(values: SelfHostedFormValues | ManagedFormValues): Promise<void> {
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
          if (values.mode === 'self-hosted') {
            selfHostedForm.setError('slug', { message: 'This slug is already taken' })
          } else {
            managedForm.setError('slug', { message: 'This slug is already taken' })
          }
          return
        }
        if (body?.error === 'ValidationError') {
          setServerError('Some fields are invalid. Please check and try again.')
          return
        }
        if (
          body?.error === 'ManagedGatewayNotConfigured' ||
          body?.error === 'GrumbleManagementNotConfigured' ||
          body?.error === 'GrumbleManagementUnavailable'
        ) {
          // Surface the operator-facing message verbatim. Each error code
          // names the specific env var / failure mode the operator needs
          // to address, so we forward `body.message` unchanged.
          setServerError(body?.message ?? `Request failed (${res.status})`)
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
    setStep('choose')
    selfHostedForm.reset()
    managedForm.reset()
    sharedDraftRef.current = {}
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
        ) : step === 'choose' ? (
          <>
            <DialogHeader>
              <DialogTitle>Register a Mumble server</DialogTitle>
              <DialogDescription>
                Pick how this server is hosted. You can&apos;t change it later — the
                two paths persist different things in the registry.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <button
                type="button"
                onClick={() => gotoMode('managed')}
                className="border-border hover:bg-accent flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors"
              >
                <CloudIcon className="text-primary size-5 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-medium">Managed by Takusen</span>
                  <span className="text-muted-foreground text-xs">
                    We host it for you. Just a name and a slug — we&apos;ll stamp
                    the host:port from the managed gateway.
                  </span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => gotoMode('self-hosted')}
                className="border-border hover:bg-accent flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors"
              >
                <ServerIcon className="text-primary size-5 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-medium">Self-hosted</span>
                  <span className="text-muted-foreground text-xs">
                    You run the Mumble server. Tell us where it&apos;s reachable
                    and we&apos;ll register it.
                  </span>
                </div>
              </button>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false)
                  reset()
                }}
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : step === 'managed' ? (
          <Form {...managedForm}>
            <form
              onSubmit={managedForm.handleSubmit(submit)}
              className="grid gap-4"
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => gotoChoose('managed')}
                    aria-label="Back"
                    className="size-7"
                    disabled={submitting}
                  >
                    <ChevronLeftIcon className="size-4" />
                  </Button>
                  Register a managed server
                </DialogTitle>
                <DialogDescription>
                  Host and port are stamped from the Takusen managed gateway. You
                  only need a name and a slug.
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
                control={managedForm.control}
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
                control={managedForm.control}
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

              <RegionField
                regions={regions}
                latency={latency}
                control={managedForm.control}
                helpText={regionHelpText(latency)}
              />

              <FormField
                control={managedForm.control}
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
        ) : (
          <Form {...selfHostedForm}>
            <form
              onSubmit={selfHostedForm.handleSubmit(submit)}
              className="grid gap-4"
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => gotoChoose('self-hosted')}
                    aria-label="Back"
                    className="size-7"
                    disabled={submitting}
                  >
                    <ChevronLeftIcon className="size-4" />
                  </Button>
                  Register a self-hosted server
                </DialogTitle>
                <DialogDescription>
                  After registration you&apos;ll need to verify the host&apos;s
                  domain via DNS before it appears in the public directory.
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
                control={selfHostedForm.control}
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
                control={selfHostedForm.control}
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
                control={selfHostedForm.control}
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
                control={selfHostedForm.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={65535}
                        placeholder="64738"
                        // Show "" when undefined so the placeholder is
                        // visible and the user can clear the field without
                        // seeing the "Expected number, received nan" zod
                        // error — empty / NaN inputs collapse to undefined,
                        // which the schema treats as "use server default".
                        value={field.value ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value
                          if (raw === '') {
                            field.onChange(undefined)
                            return
                          }
                          const n = Number.parseInt(raw, 10)
                          field.onChange(Number.isNaN(n) ? undefined : n)
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <RegionField
                regions={regions}
                latency={latency}
                control={selfHostedForm.control}
                helpText={regionHelpText(latency)}
              />

              <FormField
                control={selfHostedForm.control}
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
