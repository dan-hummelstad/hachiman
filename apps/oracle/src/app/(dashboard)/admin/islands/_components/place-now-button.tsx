'use client'

/**
 * "Place now" admin action for an unplaced virtual server.
 *
 * One-click trigger for the bin-packer (see
 * /api/admin/virtual-servers/[id]/place) until a background reconciler or
 * island-create hook lands. Surfaces three explicit outcomes inline so
 * the operator can debug WHY a placement didn't happen without diving
 * into server logs:
 *
 *   - Placed onto <island>   — green; refresh kicks RSC to re-fetch.
 *   - No capacity            — every active island in the region is at
 *                              its `maxVservers` cap or there are none.
 *                              Common reason in dev: vServer has no
 *                              region set, so the candidate set is
 *                              empty (the scheduler treats that as
 *                              no-capacity, not an error).
 *   - <HTTP error message>   — e.g. 409 if the vServer isn't `inactive`,
 *                              or 404 if it was deleted between render
 *                              and click.
 */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { SparklesIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'

interface PlaceNowResultBody {
  result: {
    chosen: string | null
    reason: 'no-capacity' | null
  }
}

interface PlaceNowButtonProps {
  vserverId: string
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'placed'; islandId: string }
  | { kind: 'no-capacity' }
  | { kind: 'error'; message: string }

export function PlaceNowButton({ vserverId }: PlaceNowButtonProps): React.JSX.Element {
  const router = useRouter()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const onClick = async (): Promise<void> => {
    setStatus({ kind: 'submitting' })
    try {
      const res = await fetch(
        `/api/admin/virtual-servers/${encodeURIComponent(vserverId)}/place`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null
        setStatus({
          kind: 'error',
          message: body?.message ?? body?.error ?? `Request failed (${res.status})`,
        })
        return
      }
      const body = (await res.json()) as PlaceNowResultBody
      if (body.result.chosen) {
        setStatus({ kind: 'placed', islandId: body.result.chosen })
        // The page is a Server Component; refresh so the placed vServer
        // moves from the unplaced table onto its new island card.
        router.refresh()
      } else {
        setStatus({ kind: 'no-capacity' })
      }
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to place vServer.',
      })
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => void onClick()}
        disabled={status.kind === 'submitting'}
      >
        <SparklesIcon className="size-3.5" />
        {status.kind === 'submitting' ? 'Placing…' : 'Place now'}
      </Button>
      {status.kind === 'placed' && (
        <span className="text-muted-foreground text-xs">
          Placed onto{' '}
          <span className="font-mono">{status.islandId.slice(0, 8)}</span>
        </span>
      )}
      {status.kind === 'no-capacity' && (
        <span className="text-amber-600 text-xs dark:text-amber-500">
          No capacity (no eligible island; check region + status)
        </span>
      )}
      {status.kind === 'error' && (
        <span className="text-destructive text-xs" role="alert">
          {status.message}
        </span>
      )}
    </div>
  )
}
