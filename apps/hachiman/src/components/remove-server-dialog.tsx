/**
 * RemoveServerDialog — confirms a server removal with two phases:
 *
 *   1. confirm   — "Remove server X? This will also deregister your account."
 *   2. warning   — shown if the server-side deregister fails, telling the
 *                  user their account will still exist on the server. They
 *                  can then choose to wipe the local record anyway, or back
 *                  out.
 *
 * Deregister is skipped (no warning) when:
 *   - we're not connected (nothing to send),
 *   - the current session is anonymous (`userId === undefined`),
 *   - the current session is SuperUser (`userId === 0`) — SuperUser isn't a
 *     normal registered-user row, so deregistering doesn't apply.
 */
import { AlertTriangleIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { connectionManager, serversService } from '@/services/ServersService'

interface RemoveServerDialogProps {
  serverId: string | null
  onClose: () => void
}

type Phase =
  | { kind: 'confirm' }
  | { kind: 'deregistering' }
  | { kind: 'removing' }
  | { kind: 'warning'; error: string }

export function RemoveServerDialog(props: RemoveServerDialogProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'confirm' })
  const serverId = props.serverId

  // Reset whenever a new target server is selected (or the dialog reopens).
  useEffect(() => {
    if (serverId !== null) setPhase({ kind: 'confirm' })
  }, [serverId])

  const performLocalRemove = async (): Promise<void> => {
    if (!serverId) return
    setPhase({ kind: 'removing' })
    try {
      await serversService.removeServer(serverId)
      props.onClose()
    } catch (err) {
      setPhase({
        kind: 'warning',
        error: err instanceof Error ? err.message : 'Failed to remove server locally.'
      })
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!serverId) return
    const service = connectionManager.get(serverId)
    const userId = service?.currentUser?.userId
    const shouldDeregister = service?.isConnected() === true && userId !== undefined && userId !== 0

    if (shouldDeregister) {
      setPhase({ kind: 'deregistering' })
      try {
        await service!.deregisterUser(userId!)
      } catch (err) {
        setPhase({
          kind: 'warning',
          error: err instanceof Error ? err.message : 'Server rejected the request.'
        })
        return
      }
    }

    await performLocalRemove()
  }

  const busy = phase.kind === 'deregistering' || phase.kind === 'removing'

  return (
    <Dialog
      open={serverId !== null}
      onOpenChange={(next) => {
        if (!next && !busy) props.onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        {phase.kind === 'warning' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangleIcon className="text-destructive size-5" />
                Account not removed from server
              </DialogTitle>
              <DialogDescription>
                The server didn&apos;t complete the deregistration request:
              </DialogDescription>
            </DialogHeader>
            <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 font-mono text-xs">
              {phase.error}
            </p>
            <p className="text-muted-foreground text-sm">
              Your registered account on <code className="font-mono">{serverId}</code> will still
              exist. Removing here only deletes the local record on this device.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={props.onClose}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void performLocalRemove()}>
                Remove locally anyway
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Remove server</DialogTitle>
              <DialogDescription>
                This deregisters your account from <code className="font-mono">{serverId}</code> and
                removes the server from this device. This can&apos;t be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={props.onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void handleConfirm()} disabled={busy}>
                {phase.kind === 'deregistering'
                  ? 'Deregistering…'
                  : phase.kind === 'removing'
                    ? 'Removing…'
                    : 'Remove'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
