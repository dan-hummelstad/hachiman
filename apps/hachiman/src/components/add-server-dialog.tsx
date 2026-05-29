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
import { ChevronLeftIcon, GlobeIcon, LinkIcon, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { parseTakusenUri, type JoinUriParseResult } from '@/services/JoinUriService'
import { useOracleStore } from '@/stores/oracleStore'

export type AddServerSubmission =
  | {
      kind: 'manual'
      url: string
      port: string
      username: string
      password?: string
    }
  | {
      kind: 'oracle'
      url: string
      port: string
    }
  | {
      kind: 'join'
      host: string
      port: number
      name: string
      verified: boolean
    }

interface AddServerDialogProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (submission: AddServerSubmission) => Promise<void>
}

type Step = 'choose' | 'join' | 'ip'

const SUPERUSER_NAME = 'SuperUser'

function isSuperUsername(name: string): boolean {
  return name.trim().toLowerCase() === SUPERUSER_NAME.toLowerCase()
}

export function AddServerDialog(props: AddServerDialogProps): React.JSX.Element {
  const oracleSession = useOracleStore((s) => s.session)
  const oracleHandle = oracleSession?.user.handle ?? null
  const oracleSignedIn = oracleSession !== null

  const [step, setStep] = useState<Step>('choose')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // IP-step state
  const [serverUrl, setServerUrl] = useState('localhost')
  const [serverPort, setServerPort] = useState('64738')
  const [usernameInput, setUsernameInput] = useState('')
  const [password, setPassword] = useState('')

  // Join-step state
  const [joinUri, setJoinUri] = useState('')
  const [joinPreview, setJoinPreview] = useState<JoinUriParseResult | null>(null)
  const [joinParseInFlight, setJoinParseInFlight] = useState(false)

  // Reset every time the dialog is reopened so a previous attempt's data
  // doesn't leak into a fresh flow.
  useEffect(() => {
    if (!props.isOpen) return
    setStep('choose')
    setSubmitting(false)
    setError(null)
    setServerUrl('localhost')
    setServerPort('64738')
    setUsernameInput(oracleHandle ?? 'HachimanUser')
    setPassword('')
    setJoinUri('')
    setJoinPreview(null)
  }, [props.isOpen, oracleHandle])

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

  const superUserMode = useMemo(() => isSuperUsername(usernameInput), [usernameInput])

  const handleOpenChange = (next: boolean): void => {
    if (!next && !submitting) props.onClose()
  }

  const handleManualSubmit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await props.onSubmit({
        kind: 'manual',
        url: serverUrl,
        port: serverPort,
        username: usernameInput.trim() || 'HachimanUser',
        ...(superUserMode ? { password } : {})
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect')
    } finally {
      setSubmitting(false)
    }
  }

  const handleOracleSubmit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await props.onSubmit({ kind: 'oracle', url: serverUrl, port: serverPort })
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
        verified: joinPreview.verified
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
                How are you joining? Paste a Takusen invite link, or type a server&apos;s address.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <button
                type="button"
                onClick={() => setStep('join')}
                className="border-border hover:bg-accent flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors"
              >
                <LinkIcon className="text-primary size-5 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-medium">I have a join code</span>
                  <span className="text-muted-foreground text-xs">
                    Paste a <code className="font-mono">takusen://join…</code> link from a friend
                  </span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setStep('ip')}
                className="border-border hover:bg-accent flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors"
              >
                <GlobeIcon className="text-primary size-5 shrink-0" />
                <div className="flex flex-col">
                  <span className="font-medium">I have an IP address</span>
                  <span className="text-muted-foreground text-xs">
                    Type the host and port directly — self-hosted servers
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
                Takusen invite links start with <code className="font-mono">takusen://join</code>.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-1">
              <Label htmlFor="join-uri">Invite link</Label>
              <Input
                id="join-uri"
                value={joinUri}
                onChange={(e) => setJoinUri(e.target.value)}
                placeholder="takusen://join#..."
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
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={submitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                disabled={!joinPreview?.ok || submitting || joinParseInFlight}
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
                Connect by address
              </DialogTitle>
              <DialogDescription>
                Use this for self-hosted servers. To sign in as the built-in admin, type{' '}
                <strong>SuperUser</strong> as the username.
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
                <Input
                  id="server-username"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder={oracleHandle ?? 'HachimanUser'}
                />
              </div>
              {superUserMode && (
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
                    Not stored on this device — you&apos;ll be asked again next time.
                  </p>
                </div>
              )}
              {error ? <div className="text-destructive text-sm">{error}</div> : null}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
              <Button
                type="button"
                variant="secondary"
                disabled={!oracleSignedIn || submitting}
                onClick={() => void handleOracleSubmit()}
                title={
                  oracleSignedIn
                    ? 'Connect using your Oracle identity (ignores the username above)'
                    : 'Sign in to Oracle to enable this'
                }
              >
                Join with Oracle
              </Button>
              <div className="flex justify-end gap-2">
                <DialogClose asChild>
                  <Button variant="outline" disabled={submitting}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  disabled={
                    !serverUrl ||
                    !serverPort ||
                    !usernameInput.trim() ||
                    (superUserMode && !password) ||
                    submitting
                  }
                  onClick={() => void handleManualSubmit()}
                >
                  {submitting ? 'Connecting…' : 'Connect'}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
