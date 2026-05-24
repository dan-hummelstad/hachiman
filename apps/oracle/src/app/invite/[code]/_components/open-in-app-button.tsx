'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

interface OpenInAppButtonProps {
  code: string
  className?: string
}

export function OpenInAppButton({ code, className }: OpenInAppButtonProps): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onClick = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(code)}/redeem`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `Redeem failed (${res.status})`)
      }
      const body = (await res.json()) as { joinUri: string }
      window.location.href = body.joinUri
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPending(false)
    }
  }

  return (
    <div className={className}>
      <Button onClick={() => void onClick()} disabled={pending} className="w-full">
        {pending ? 'Opening…' : 'Open in App'}
      </Button>
      {error ? <p className="text-destructive mt-2 text-xs">{error}</p> : null}
    </div>
  )
}
