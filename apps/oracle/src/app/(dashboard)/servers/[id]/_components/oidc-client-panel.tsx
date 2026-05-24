'use client'

import { useState } from 'react'
import { CopyIcon, KeyRoundIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface OidcClientInfo {
  clientId: string
  redirectUris: string[]
  scopes: string[]
}

interface Props {
  serverId: string
  initialClient: OidcClientInfo | null
}

export function OidcClientPanel({
  serverId,
  initialClient,
}: Props): React.JSX.Element {
  if (!initialClient) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>OIDC client missing</CardTitle>
          <CardDescription>
            No OIDC client was found for this server. This is unexpected — please
            contact support.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return <OidcClientBody serverId={serverId} initialClient={initialClient} />
}

interface BodyProps {
  serverId: string
  initialClient: OidcClientInfo
}

function OidcClientBody({ serverId, initialClient }: BodyProps): React.JSX.Element {
  const [client, setClient] = useState<OidcClientInfo>(initialClient)
  const [redirectInput, setRedirectInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [regenSecret, setRegenSecret] = useState<string | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)
  const [regenSubmitting, setRegenSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function saveUris(next: string[]): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/servers/${serverId}/oidc`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirectUris: next }),
      })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      setClient(body.client)
      toast.success('Redirect URIs saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      toast.error('Failed to save redirect URIs')
    } finally {
      setSaving(false)
    }
  }

  async function addRedirect(): Promise<void> {
    const trimmed = redirectInput.trim()
    if (!trimmed) return
    try {
      new URL(trimmed)
    } catch {
      toast.error('Not a valid URL')
      return
    }
    if (client.redirectUris.includes(trimmed)) {
      toast.error('Already added')
      return
    }
    const next = [...client.redirectUris, trimmed]
    await saveUris(next)
    setRedirectInput('')
  }

  async function removeRedirect(uri: string): Promise<void> {
    const next = client.redirectUris.filter((u) => u !== uri)
    await saveUris(next)
  }

  async function regenerate(): Promise<void> {
    setRegenSubmitting(true)
    try {
      const res = await fetch(`/api/servers/${serverId}/oidc`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        toast.error('Failed to regenerate secret')
        return
      }
      setRegenSecret(body.secret)
      setClient(body.client)
      toast.success('New secret generated')
    } finally {
      setRegenSubmitting(false)
    }
  }

  async function copy(value: string, label: string): Promise<void> {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} copied`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRoundIcon className="size-4" /> OIDC client
        </CardTitle>
        <CardDescription>
          Your Mumble server uses these credentials to authenticate users through
          Takusen.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-1">
          <Label>Client ID</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
              {client.clientId}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy client id"
              onClick={() => copy(client.clientId, 'Client ID')}
            >
              <CopyIcon />
            </Button>
          </div>
        </div>

        <div className="grid gap-2">
          <Label>Redirect URIs</Label>
          {client.redirectUris.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No redirect URIs registered. Add at least one before configuring your
              Mumble server.
            </p>
          ) : (
            <ul className="grid gap-2">
              {client.redirectUris.map((uri) => (
                <li
                  key={uri}
                  className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                >
                  <code className="flex-1 truncate font-mono text-sm">{uri}</code>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove"
                    onClick={() => removeRedirect(uri)}
                    disabled={saving}
                  >
                    <TrashIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Input
              type="url"
              placeholder="https://mumble.example.com/auth/callback"
              value={redirectInput}
              onChange={(e) => setRedirectInput(e.target.value)}
            />
            <Button onClick={addRedirect} disabled={saving || redirectInput === ''}>
              <PlusIcon /> Add
            </Button>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t save</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className="grid gap-2 border-t pt-6">
          <Label>Client secret</Label>
          <p className="text-sm text-muted-foreground">
            Regenerating invalidates the old secret immediately. Your Mumble server
            will stop authenticating until the new secret is rolled out.
          </p>
          <Dialog
            open={regenOpen}
            onOpenChange={(next) => {
              if (!next) setRegenSecret(null)
              setRegenOpen(next)
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" className="w-fit">
                Regenerate secret
              </Button>
            </DialogTrigger>
            <DialogContent>
              {regenSecret ? (
                <>
                  <DialogHeader>
                    <DialogTitle>Save your new client secret</DialogTitle>
                    <DialogDescription>
                      This will not be shown again. Update your Mumble server&apos;s
                      configuration with the value below.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 overflow-hidden rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
                      {regenSecret}
                    </code>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Copy secret"
                      onClick={() => copy(regenSecret, 'Secret')}
                    >
                      <CopyIcon />
                    </Button>
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={() => {
                        setRegenSecret(null)
                        setRegenOpen(false)
                      }}
                    >
                      Done
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                <>
                  <DialogHeader>
                    <DialogTitle>Regenerate client secret?</DialogTitle>
                    <DialogDescription>
                      The current secret will stop working immediately.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      variant="destructive"
                      onClick={regenerate}
                      disabled={regenSubmitting}
                    >
                      {regenSubmitting ? 'Regenerating…' : 'Yes, regenerate'}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid gap-1 border-t pt-6">
          <Label>Allowed scopes</Label>
          <div className="flex flex-wrap gap-2">
            {client.scopes.map((s) => (
              <code
                key={s}
                className="rounded-md bg-muted px-2 py-1 font-mono text-xs"
              >
                {s}
              </code>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
