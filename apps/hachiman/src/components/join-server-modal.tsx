/**
 * JoinServerModal — shown when a takusen://join… deep link arrives.
 *
 * Renders the server preview (name, host:port, verified-at), surfaces the
 * HMAC verification outcome ("verified" vs "could not verify signature"), and
 * lets the user confirm a connect. On confirm, calls
 * `serversService.addAndConnect`, which now requires an active Oracle
 * session — anonymous fallback is gone, so when signed out we surface an
 * inline sign-in prompt instead of pretending we can join.
 */
import { useState } from 'react'
import { AlertTriangleIcon, ShieldCheck, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'

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
import { OracleSignInDialog } from '@/components/oracle-signin-dialog'
import { serversService } from '@/services/ServersService'
import type { SignedJoinPayload } from '@/services/JoinUriService'
import { useOracleStore } from '@/stores/oracleStore'

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

export function JoinServerModal(props: JoinServerModalProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [signInOpen, setSignInOpen] = useState(false)
  const oracleSession = useOracleStore((s) => s.session)
  const oracleSignedIn = oracleSession !== null

  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setPhase({ kind: 'idle' })
      props.onClose()
    }
  }

  const onJoin = async (): Promise<void> => {
    if (!props.payload) return
    // Defensive: shouldn't be reachable because the button is gated on
    // `oracleSignedIn`, but ServersService.addAndConnect throws anyway.
    if (!oracleSession) {
      setPhase({
        kind: 'error',
        message: 'Sign in to Takusen first to join via an invite link.'
      })
      return
    }
    setPhase({ kind: 'connecting' })
    try {
      await serversService.addAndConnect({
        host: props.payload.host,
        port: props.payload.port,
        name: props.payload.name,
        username: oracleSession.user.handle
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
    <>
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
                We couldn&apos;t verify the invite signature. Only proceed if you trust the source
                of this link.
              </span>
            </div>
          ) : null}
          {!oracleSignedIn ? (
            <div className="bg-muted/40 flex flex-col gap-3 rounded-md border p-4">
              <div className="flex items-start gap-2.5">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-blue-500" aria-hidden />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Sign in to Takusen first</span>
                  <p className="text-muted-foreground text-xs">
                    Joining by invite link requires a Takusen identity so the server can recognize
                    you across devices. It&apos;s a one-time sign-in.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                type="button"
                className="self-start"
                onClick={() => setSignInOpen(true)}
              >
                Sign in to Takusen
              </Button>
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
            <Button
              disabled={!payload || !oracleSignedIn || phase.kind === 'connecting'}
              onClick={() => void onJoin()}
            >
              {phase.kind === 'connecting' ? 'Connecting…' : 'Join server'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <OracleSignInDialog isOpen={signInOpen} onClose={() => setSignInOpen(false)} />
    </>
  )
}
