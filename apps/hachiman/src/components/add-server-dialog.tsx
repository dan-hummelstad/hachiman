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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ChevronLeftIcon,
  LockIcon,
  ShieldCheck,
  ShieldCheckIcon,
  ShieldOffIcon,
  TicketIcon
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { OracleSignInDialog } from '@/components/oracle-signin-dialog'
import { parseTakusenUri, type JoinUriParseResult } from '@/services/JoinUriService'
import { useOracleStore } from '@/stores/oracleStore'

/**
 * Result of a successful add-server flow. The dialog now only emits two
 * shapes — Oracle-authenticated invite joins, and self-hosted SuperUser. The
 * legacy `kind: 'oracle'` (free-form host with Oracle auth) and `kind:
 * 'manual'` (anonymous host + username) variants are gone.
 */
export type AddServerSubmission =
  | {
      /** Self-hosted SuperUser. Username is implicitly "SuperUser". */
      kind: 'superuser'
      url: string
      port: string
      password: string
    }
  | {
      kind: 'join'
      host: string
      port: number
      name: string
      verified: boolean
      /** Oracle UUID, copied from the signed join payload. */
      serverId: string
    }

interface AddServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (submission: AddServerSubmission) => Promise<void>
}

type Step = 'choose' | 'join' | 'ip'

/**
 * Inline "sign in to Takusen" affordance shown inside the join-code step when
 * Oracle is required but missing. Mounts the `OracleSignInDialog` locally so
 * the parent dialog stays open while the sign-in handshake happens in the
 * system browser.
 */
function OracleSignInGate(props: { reason: string }): React.JSX.Element {
  const [signInOpen, setSignInOpen] = useState(false)
  return (
    <>
      <div className="bg-muted/40 flex flex-col gap-3 rounded-md border p-4">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-blue-500" aria-hidden />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Sign in to Takusen first</span>
            <p className="text-muted-foreground text-xs">{props.reason}</p>
          </div>
        </div>
        <Button size="sm" className="self-start" type="button" onClick={() => setSignInOpen(true)}>
          Sign in to Takusen
        </Button>
      </div>
      <OracleSignInDialog isOpen={signInOpen} onClose={() => setSignInOpen(false)} />
    </>
  )
}

export function AddServerDialog(props: AddServerDialogProps): React.JSX.Element {
  const oracleSession = useOracleStore((s) => s.session)
  const oracleSignedIn = oracleSession !== null

  const [step, setStep] = useState<Step>('choose')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // IP-step state — username is hardcoded to SuperUser; we only collect the
  // host, port, and password.
  const [serverUrl, setServerUrl] = useState('localhost')
  const [serverPort, setServerPort] = useState('64738')
  const [password, setPassword] = useState('')

  // Join-step state
  const [joinUri, setJoinUri] = useState('')
  const [joinPreview, setJoinPreview] = useState<JoinUriParseResult | null>(null)
  const [joinParseInFlight, setJoinParseInFlight] = useState(false)

  // "I have a join code" was clicked while not signed in to Oracle — gate
  // the click with an inline sign-in prompt instead of silently disabling.
  const [pendingJoinClick, setPendingJoinClick] = useState(false)

  // Reset every time the dialog is reopened so a previous attempt's data
  // doesn't leak into a fresh flow.
  useEffect(() => {
    if (!props.isOpen) return
    setStep('choose')
    setSubmitting(false)
    setError(null)
    setServerUrl('localhost')
    setServerPort('64738')
    setPassword('')
    setJoinUri('')
    setJoinPreview(null)
    setPendingJoinClick(false)
  }, [props.isOpen])

  // If the user signed in (in a side flow) after clicking the join card while
  // signed out, automatically advance them into the join step now that they
  // can use it.
  useEffect(() => {
    if (oracleSignedIn && pendingJoinClick) {
      setStep('join')
      setPendingJoinClick(false)
    }
  }, [oracleSignedIn, pendingJoinClick])

  // Live-parse the pasted takusen:// URI so the user sees the verified state
  // (or a parse error) before they hit Join. Debounced lightly via the
  // microtask-naturally-batched setState.
  useEffect(() => {
    const trimmed = joinUri.trim()
    if (!trimmed) {
      setJoinPreview(null)
      return
    }
    let cancelled = false
    setJoinParseInFlight(true)
    void parseTakusenUri(trimmed).then((res) => {
      if (cancelled) return
      setJoinPreview(res)
      setJoinParseInFlight(false)
    })
    return () => {
      cancelled = true
    }
  }, [joinUri])

  const handleOpenChange = (next: boolean): void => {
    if (!next && !submitting) props.onClose()
  }

  const handleJoinCardClick = (): void => {
    // Oracle is required to mint a per-server token for invite-link joins;
    // without it the join step itself surfaces a sign-in prompt rather than
    // gating the click silently.
    if (!oracleSignedIn) setPendingJoinClick(true)
    setStep('join')
  }

  const handleSuperUserSubmit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await props.onSubmit({
        kind: 'superuser',
        url: serverUrl,
        port: serverPort,
        password
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect')
    } finally {
      setSubmitting(false)
    }
  }

  const handleJoinSubmit = async (): Promise<void> => {
    if (!joinPreview?.ok) return
    setSubmitting(true)
    setError(null)
    try {
      await props.onSubmit({
        kind: 'join',
        host: joinPreview.payload.host,
        port: joinPreview.payload.port,
        name: joinPreview.payload.name,
        verified: joinPreview.verified,
        serverId: joinPreview.payload.serverId
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        {step === 'choose' && (
          <>
            <DialogHeader>
              <DialogTitle>Add Server</DialogTitle>
              <DialogDescription>
                Most people should use a Takusen invite link. The SuperUser path is for admins of
                self-hosted servers only.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <button
                type="button"
                onClick={handleJoinCardClick}
                className="border-border hover:bg-accent flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors"
              >
                <TicketIcon className="text-primary size-5 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-medium">I have a join code</span>
                  <span className="text-muted-foreground text-xs">
                    Paste an invite link from a friend — short (https://…/i/&lt;code&gt;) or signed
                    (https://…/join#…). Requires Takusen sign-in.
                  </span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setStep('ip')}
                className="border-border hover:bg-accent/60 flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left opacity-90 transition-colors"
              >
                <LockIcon className="text-muted-foreground size-5 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-medium">
                    Self-hosted SuperUser{' '}
                    <span className="text-muted-foreground text-[10px] font-normal uppercase">
                      Advanced
                    </span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Sign in as the built-in admin of a Mumble server you run yourself — requires the
                    SuperUser password.
                  </span>
                </div>
              </button>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
            </DialogFooter>
          </>
        )}

        {step === 'join' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setStep('choose')}
                  aria-label="Back"
                  className="size-7"
                  disabled={submitting}
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                Paste your join code
              </DialogTitle>
              <DialogDescription>
                Paste the invite link — short (
                <code className="font-mono">https://&hellip;/i/&lt;code&gt;</code>) or signed (
                <code className="font-mono">https://&hellip;/join#&hellip;</code>). Legacy{' '}
                <code className="font-mono">takusen://join</code> links also work.
              </DialogDescription>
            </DialogHeader>
            {!oracleSignedIn ? (
              <div className="grid gap-3 py-1">
                <OracleSignInGate reason="Joining by invite link requires a Takusen identity so the server can recognize you across devices. It's a one-time sign-in." />
              </div>
            ) : (
              <div className="grid gap-3 py-1">
                <Label htmlFor="join-uri">Invite link</Label>
                <Input
                  id="join-uri"
                  value={joinUri}
                  onChange={(e) => setJoinUri(e.target.value)}
                  placeholder="https://…/i/<code>"
                  autoFocus
                />
                {joinPreview?.ok === false ? (
                  <div className="text-destructive text-sm">{joinPreview.reason}</div>
                ) : null}
                {joinPreview?.ok === true ? (
                  <div className="bg-muted rounded-md px-3 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <strong>{joinPreview.payload.name}</strong>
                      {joinPreview.verified ? (
                        <span className="text-primary inline-flex items-center gap-1 text-xs">
                          <ShieldCheckIcon className="size-3.5" /> Verified
                        </span>
                      ) : (
                        <span className="text-destructive inline-flex items-center gap-1 text-xs">
                          <ShieldOffIcon className="size-3.5" /> Unverified
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground font-mono text-xs">
                      {joinPreview.payload.host}:{joinPreview.payload.port}
                    </div>
                  </div>
                ) : null}
                {error ? <div className="text-destructive text-sm">{error}</div> : null}
              </div>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={submitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                disabled={!oracleSignedIn || !joinPreview?.ok || submitting || joinParseInFlight}
                onClick={() => void handleJoinSubmit()}
              >
                {submitting ? 'Connecting…' : 'Join server'}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'ip' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setStep('choose')}
                  aria-label="Back"
                  className="size-7"
                  disabled={submitting}
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <LockIcon className="size-4" />
                Self-hosted SuperUser
              </DialogTitle>
              <DialogDescription>
                Connect to a Mumble server you administer as the built-in <strong>SuperUser</strong>{' '}
                account. This is a Mumble-specific admin path — managed Takusen servers don&apos;t
                accept it; use a join link or Takusen sign-in for those.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-1">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="server-address">Server Address</Label>
                  <Input
                    id="server-address"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="server-port">Port</Label>
                  <Input
                    id="server-port"
                    value={serverPort}
                    onChange={(e) => setServerPort(e.target.value)}
                    className="w-24"
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="server-username">Username</Label>
                <Input id="server-username" value="SuperUser" disabled readOnly />
                <p className="text-muted-foreground text-xs">
                  Fixed to the Mumble admin account. Regular users join via a Takusen invite link.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="server-password">SuperUser password</Label>
                <Input
                  id="server-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
                <p className="text-muted-foreground text-xs">
                  Not stored on this device — you&apos;ll be asked again on every reconnect.
                </p>
              </div>
              {error ? <div className="text-destructive text-sm">{error}</div> : null}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={submitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                disabled={!serverUrl || !serverPort || !password || submitting}
                onClick={() => void handleSuperUserSubmit()}
              >
                {submitting ? 'Connecting…' : 'Connect as SuperUser'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
