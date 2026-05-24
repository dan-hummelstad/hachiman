'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LockKeyholeIcon } from 'lucide-react'
import { toast } from 'sonner'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface Props {
  serverId: string
  initialOracleOnly: boolean
}

export function OracleOnlyToggle({
  serverId,
  initialOracleOnly,
}: Props): React.JSX.Element {
  const router = useRouter()
  const [oracleOnly, setOracleOnly] = useState(initialOracleOnly)
  const [pending, setPending] = useState(false)

  async function onToggle(next: boolean): Promise<void> {
    // Optimistic update — flip immediately, roll back on failure.
    setOracleOnly(next)
    setPending(true)
    try {
      const res = await fetch(`/api/servers/${serverId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oracleOnly: next }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      toast.success(next ? 'Oracle-only sign-in enabled' : 'Oracle-only sign-in disabled')
      router.refresh()
    } catch (err) {
      setOracleOnly(!next)
      toast.error(
        err instanceof Error ? err.message : 'Failed to update Oracle-only setting',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LockKeyholeIcon className="size-4" /> Oracle-only sign-in
        </CardTitle>
        <CardDescription>
          When enabled, this server advertises that clients must sign in through
          Takusen — username/password connections are not allowed. The Mumble
          server itself enforces this via its own OracleOnly configuration; this
          flag is what the registry tells clients so they can present the right
          sign-in flow.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <Label htmlFor="oracle-only-switch" className="flex flex-col items-start gap-1">
          <span className="text-sm font-medium">Require Takusen sign-in</span>
          <span className="text-xs font-normal text-muted-foreground">
            {oracleOnly
              ? 'Clients will only show the Sign in with Takusen button.'
              : 'Clients may sign in with either Takusen or a Mumble username + password.'}
          </span>
        </Label>
        <Switch
          id="oracle-only-switch"
          checked={oracleOnly}
          disabled={pending}
          onCheckedChange={onToggle}
          aria-label="Toggle Oracle-only sign-in"
        />
      </CardContent>
    </Card>
  )
}
