'use client'

/**
 * Live per-island metrics, polled from `/api/admin/islands/metrics`. Rendered
 * INSIDE each island Card (the parent RSC passes the islandId in).
 *
 * Design split:
 *   - Durable data (island row, vServer table, fill %) is rendered by the
 *     parent Server Component (`page.tsx`) — it doesn't change between polls.
 *   - This Client Component owns the polling + the live readouts only. A
 *     single store-of-truth fetch is hoisted into `LiveMetricsProvider` so we
 *     don't fan out N requests when the page has many islands.
 *
 * Stale threshold: 15s — matches the publisher TTL
 * (`PublishInterval * StalenessMultiplier`, default 5s * 3) from
 * `apps/hachiman-server/ISLAND-METRICS.md`. A reading older than this is
 * effectively impossible (Redis would have evicted the key) but we still
 * label it "stale" defensively in case the publisher's clock skews.
 *
 * Poll cadence: 7s — slightly slower than the 5s publish tick so we don't
 * race the writer. If this view ever becomes a bottleneck, replace polling
 * with SSE / WebSocket push from a background subscriber.
 */
import { createContext, useContext, useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 7_000
/** Matches the publisher TTL (default 15s); see ISLAND-METRICS.md. */
const STALE_THRESHOLD_MS = 15_000

interface LiveReading {
  islandId: string
  activeUsers: number
  cpuPct: number
  bandwidthPct: number
  publishedAt: number
}

interface MetricsResponse {
  redisConfigured: boolean
  fetchedAt: number
  readings: LiveReading[]
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: MetricsResponse }

interface LiveContextValue {
  state: LoadState
}

const LiveMetricsContext = createContext<LiveContextValue | null>(null)

/**
 * Polling root. Place ONCE on the page; each island row consumes the result
 * via `IslandLiveMetricsRow`. Hoisting the fetch here means one HTTP request
 * per tick regardless of island count.
 */
export function LiveMetricsProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()

    async function poll(): Promise<void> {
      try {
        const res = await fetch('/api/admin/islands/metrics', {
          cache: 'no-store',
          signal: ac.signal,
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const body = (await res.json()) as MetricsResponse
        if (cancelled) return
        setState({ status: 'ready', data: body })
      } catch (err) {
        if (cancelled) return
        // AbortError fires during unmount — that's a normal teardown, not an
        // error worth surfacing in the banner.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    void poll()
    const id = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      ac.abort()
      clearInterval(id)
    }
  }, [])

  return (
    <LiveMetricsContext.Provider value={{ state }}>
      {children}
    </LiveMetricsContext.Provider>
  )
}

/**
 * A non-fatal page-level banner that appears WHEN:
 *   - Redis is unset on the Oracle side (per-island readouts will all say
 *     "no fresh data"), OR
 *   - the polling fetch is failing (network down, admin gate flapped, etc).
 *
 * Silent on the happy path so it doesn't clutter the dashboard.
 */
export function LiveMetricsBanner(): React.JSX.Element | null {
  const ctx = useContext(LiveMetricsContext)
  if (!ctx) return null
  const { state } = ctx

  if (state.status === 'error') {
    return (
      <div
        role="status"
        className="rounded-md border border-amber-500/40 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
      >
        Live metrics unavailable: {state.error}. Showing durable data only.
      </div>
    )
  }
  if (state.status === 'ready' && !state.data.redisConfigured) {
    return (
      <div
        role="status"
        className="rounded-md border border-amber-500/40 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
      >
        Live metrics unavailable:{' '}
        <code className="font-mono text-xs">REDIS_URL</code> is not set on the
        Oracle process. Showing durable data only.
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Per-island row
// ---------------------------------------------------------------------------

/** Color-code utilisation. Green &lt;50%, yellow 50-80%, red &ge;80%. */
function utilisationTone(frac: number): string {
  if (frac >= 0.8) return 'text-destructive'
  if (frac >= 0.5) return 'text-amber-600 dark:text-amber-500'
  return 'text-emerald-600 dark:text-emerald-500'
}

const formatPct = (frac: number): string => `${Math.round(frac * 100)}%`

function formatAge(ms: number): string {
  if (ms < 1_000) return 'just now'
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}

/**
 * Render the live metrics for one island. Subscribes to the polling root.
 *
 * Distinguishes THREE states explicitly — an operator must be able to tell
 * "fresh 0 users" from "no publisher", which is the entire reason this view
 * exists:
 *   1. loading        — first poll hasn't returned yet
 *   2. no fresh data  — reading absent (Redis TTL-expired, never published,
 *                       or Redis unset entirely)
 *   3. fresh reading  — render counts + tones + age
 *
 * The visual treatment of (2) is deliberately NOT "0 users, 0% CPU" — those
 * are real values for an alive-but-idle island and the operator needs to
 * tell them apart.
 */
export function IslandLiveMetricsRow({
  islandId,
}: {
  islandId: string
}): React.JSX.Element {
  const ctx = useContext(LiveMetricsContext)
  // ctx is null only if this is rendered outside the provider, which would
  // be a programmer error — fall back to a placeholder rather than crash.
  if (!ctx) return <LiveMetricsPlaceholder label="not initialised" />

  const { state } = ctx
  if (state.status === 'loading') {
    return <LiveMetricsPlaceholder label="loading…" />
  }
  if (state.status === 'error') {
    // Banner already explains the error; the per-island row stays terse.
    return <LiveMetricsPlaceholder label="unavailable" />
  }

  const { data } = state
  const reading = data.readings.find((r) => r.islandId === islandId)

  if (!reading) {
    // Redis configured but THIS island has nothing fresh — distinct from
    // both "loading" and "0 users". Keep the indicator distinct.
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Live</span>
          <span className="font-medium text-muted-foreground italic">
            no fresh data
          </span>
        </span>
        <span className="text-muted-foreground opacity-70">
          publisher not running, or its TTL expired
        </span>
      </div>
    )
  }

  const age = Math.max(0, data.fetchedAt - reading.publishedAt)
  const stale = age > STALE_THRESHOLD_MS

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Users</span>
        <span className="font-mono font-medium tabular-nums">
          {reading.activeUsers}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">CPU</span>
        <span className={`font-mono font-medium ${utilisationTone(reading.cpuPct)}`}>
          {formatPct(reading.cpuPct)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Bandwidth</span>
        <span
          className={`font-mono font-medium ${utilisationTone(reading.bandwidthPct)}`}
        >
          {formatPct(reading.bandwidthPct)}
        </span>
      </span>
      <span
        className="text-muted-foreground"
        title={new Date(reading.publishedAt).toISOString()}
      >
        {stale ? (
          <span className="text-amber-600 dark:text-amber-500">
            stale ({formatAge(age)})
          </span>
        ) : (
          <>updated {formatAge(age)}</>
        )}
      </span>
    </div>
  )
}

function LiveMetricsPlaceholder({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Live</span>
        <span className="font-medium text-muted-foreground italic">{label}</span>
      </span>
    </div>
  )
}
