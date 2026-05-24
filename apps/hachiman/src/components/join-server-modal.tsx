/**
 * JoinServerModal — shown when a takusen://join… deep link arrives.
 *
 * Renders the server preview (name, host:port, verified-at), surfaces the
 * HMAC verification outcome ("verified" vs "could not verify signature"), and
 * lets the user confirm a connect. On confirm, calls into ServersService —
 * specifically Agent C's `addAndConnect` if available, otherwise falls back
 * to the existing `addServer` path so the flow still works end-to-end.
 */
import { useState } from 'react'
import { ShieldCheckIcon, ShieldOffIcon, AlertTriangleIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { serversService } from '@/services/ServersService'
import type { SignedJoinPayload } from '@/services/JoinUriService'
import { useUserStore } from '@/stores/userStore'

export interface JoinServerModalProps {
  /** Parsed payload from a takusen:// URI or browser /join hash. */
  payload: SignedJoinPayload | null
  /** Whether the HMAC signature matched. False => warn the user. */
  verified: boolean
  /** True while the modal should be visible. Driven by App. */
  open: boolean
  onClose: () => void
}

type Phase = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'error'; message: string }

function formatVerifiedDate(iso: string | null): string {
  if (!iso) return 'not verified'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'not verified'
  return `verified ${d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })}`
}

/**
 * Bridge into ServersService. Agent C is adding `addAndConnect({host, port,
 * name, serverId?, ...})`; until that lands we fall back to the existing
 * `addServer(url, port, username)` path. The conditional check is intentional
 * — once Agent C's signature is merged this branch will take over with no
 * call-site change.
 */
async function callAddAndConnect(opts: {
  host: string
  port: number
  name: string
  username: string
}): Promise<void> {
  // Narrow runtime probe — Agent C may attach `addAndConnect` to the existing
  // singleton. Cast away the IServersService type since the canonical
  // interface doesn't include it yet.
  const svc = serversService as unknown as {
    addAndConnect?: (opts: {
      host: string
      port: number
      name: string
      serverId?: string
      username?: string
    }) => Promise<void>
    addServer: (url: string, port: string, username: string) => Promise<void>
  }
  if (typeof svc.addAndConnect === 'function') {
    await svc.addAndConnect({
      host: opts.host,
      port: opts.port,
      name: opts.name,
      username: opts.username
    })
    return
  }
  // TODO(agent-c): remove once `addAndConnect` is exported by ServersService.
  // The fallback preserves the deep-link flow against the existing
  // `addServer(url, port, username)` signature, but doesn't pass the
  // `name` / `serverId` Agent C plans to use for display + Oracle sync.
  console.warn(
    '[JoinServerModal] ServersService.addAndConnect not found; falling back to addServer.'
  )
  await svc.addServer(opts.host, String(opts.port), opts.username)
}

export function JoinServerModal(props: JoinServerModalProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const username = useUserStore((s) => s.username)

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setPhase({ kind: 'idle' })
      props.onClose()
    }
  }

  const onJoin = async (): Promise<void> => {
    if (!props.payload) return
    setPhase({ kind: 'connecting' })
    try {
      await callAddAndConnect({
        host: props.payload.host,
        port: props.payload.port,
        name: props.payload.name,
        username: username || 'HachimanUser'
      })
      setPhase({ kind: 'idle' })
      props.onClose()
    } catch (err) {
      setPhase({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to connect'
      })
    }
  }

  const payload = props.payload
  // Render-time: we accept `payload === null` so the parent can mount the
  // modal eagerly and only flip `open` when a deep link arrives.
  const verifiedLabel = payload ? formatVerifiedDate(payload.verifiedAt) : ''

  return (
    <Dialog open={props.open && payload !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            Join {payload?.name ?? 'server'}
            {props.verified ? (
              <span className="text-primary inline-flex items-center gap-1 text-xs font-medium">
                <ShieldCheckIcon className="size-3.5" /> Verified signature
              </span>
            ) : (
              <span className="text-destructive inline-flex items-center gap-1 text-xs font-medium">
                <ShieldOffIcon className="size-3.5" /> Unverified
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {payload ? (
              <>
                You&apos;re about to join <strong>{payload.name}</strong> at{' '}
                <code className="font-mono">
                  {payload.host}:{payload.port}
                </code>{' '}
                — {verifiedLabel}.
              </>
            ) : (
              <>No invite payload.</>
            )}
          </DialogDescription>
        </DialogHeader>
        {!props.verified ? (
          <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              We couldn&apos;t verify the invite signature. Only proceed if you trust the source of
              this link.
            </span>
          </div>
        ) : null}
        {phase.kind === 'error' ? (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            {phase.message}
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={phase.kind === 'connecting'}>
              Cancel
            </Button>
          </DialogClose>
          <Button disabled={!payload || phase.kind === 'connecting'} onClick={() => void onJoin()}>
            {phase.kind === 'connecting' ? 'Connecting…' : 'Join server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
