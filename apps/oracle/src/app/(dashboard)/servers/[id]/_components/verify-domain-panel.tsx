'use client'

import { useState } from 'react'
import { CheckCircle2Icon, CopyIcon, GlobeIcon, RefreshCwIcon } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface VerificationInfo {
  txtRecord: string
  txtValue: string
  verifiedAt: string | null
  lastCheckedAt: string | null
}

interface Props {
  serverId: string
  host: string
  initialVerification: VerificationInfo | null
}

export function VerifyDomainPanel({
  serverId,
  host,
  initialVerification,
}: Props): React.JSX.Element {
  const [verification, setVerification] = useState<VerificationInfo | null>(
    initialVerification,
  )
  const [records, setRecords] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [checking, setChecking] = useState(false)

  async function startVerification(): Promise<void> {
    setStarting(true)
    setError(null)
    try {
      const res = await fetch(`/api/servers/${serverId}/verify`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      const body = await res.json()
      setVerification({
        txtRecord: body.txtRecord,
        txtValue: body.txtValue,
        verifiedAt: body.verifiedAt,
        lastCheckedAt: body.lastCheckedAt,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setStarting(false)
    }
  }

  async function checkNow(): Promise<void> {
    setChecking(true)
    setError(null)
    try {
      const res = await fetch(`/api/servers/${serverId}/verify/check`, {
        method: 'POST',
      })
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      setRecords(body.records ?? [])
      if (body.verified) {
        toast.success('Domain verified')
        setVerification((prev) =>
          prev
            ? {
                ...prev,
                verifiedAt: prev.verifiedAt ?? new Date().toISOString(),
                lastCheckedAt: body.lastCheckedAt,
              }
            : prev,
        )
      } else {
        toast.error(body.error ?? 'Token not found in DNS yet')
        setVerification((prev) =>
          prev ? { ...prev, lastCheckedAt: body.lastCheckedAt } : prev,
        )
        if (body.error) setError(body.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setChecking(false)
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
          <GlobeIcon className="size-4" /> Domain verification
        </CardTitle>
        <CardDescription>
          Publish a TXT record so we can confirm you control{' '}
          <span className="font-mono text-foreground">{host}</span>. Until then your
          server stays hidden from public search.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {verification?.verifiedAt ? (
          <Alert>
            <CheckCircle2Icon />
            <AlertTitle>Verified</AlertTitle>
            <AlertDescription>
              This domain was verified at{' '}
              {new Date(verification.verifiedAt).toLocaleString()}.
            </AlertDescription>
          </Alert>
        ) : null}

        {!verification ? (
          <Button onClick={startVerification} disabled={starting}>
            {starting ? 'Starting…' : 'Start verification'}
          </Button>
        ) : (
          <>
            <div className="grid gap-3 rounded-lg border bg-card p-4">
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Record name
                </span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
                    {verification.txtRecord}
                  </code>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => copy(verification.txtRecord, 'Record name')}
                    aria-label="Copy record name"
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Record type
                </span>
                <code className="rounded-md bg-muted px-3 py-2 font-mono text-sm">TXT</code>
              </div>
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Record value
                </span>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
                    {verification.txtValue}
                  </code>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => copy(verification.txtValue, 'Token')}
                    aria-label="Copy token"
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={checkNow} disabled={checking}>
                <RefreshCwIcon /> {checking ? 'Checking…' : 'Check now'}
              </Button>
              {verification.lastCheckedAt ? (
                <span className="text-xs text-muted-foreground">
                  Last checked {new Date(verification.lastCheckedAt).toLocaleString()}
                </span>
              ) : null}
              {verification.verifiedAt ? (
                <Badge variant="secondary">Verified</Badge>
              ) : (
                <Badge variant="outline">Pending</Badge>
              )}
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertTitle>DNS lookup failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {records && records.length > 0 ? (
              <div className="grid gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  TXT records we found
                </span>
                <ul className="grid gap-1">
                  {records.map((r) => (
                    <li
                      key={r}
                      className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all"
                    >
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
