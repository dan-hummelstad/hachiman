import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { friendly } from '@/components/security/errors'
import { RecoveryKeyReveal } from '@/components/security/recovery-key-view'
import { StepFrame, Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog, useDialog } from '@/stores/dialogStore'

/**
 * Make a new recovery key (§12.11.3 "A recovery key rotation"): the Worker uploads all backups
 * again under the new key and deletes the old ones. The old key stops working.
 */
export function RotateRecoveryKey({
  onDone,
  onShowingKey
}: {
  onDone?: () => void
  /** True while the new key shows. */
  onShowingKey?: (showing: boolean) => void
}): React.JSX.Element {
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  const configured = useCryptoStore((s) => s.status?.recoveryConfigured ?? false)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const { run, busy, error } = useAction()

  if (recoveryKey)
    return (
      <RecoveryKeyReveal
        recoveryKey={recoveryKey}
        doneLabel="Done"
        onDone={() => {
          setRecoveryKey(null)
          onShowingKey?.(false)
          onDone?.()
        }}
      />
    )

  const rotate = async (): Promise<void> => {
    const r = await run('make a new recovery key', () =>
      friendly(cryptoService.client().rotateRecoveryKey())
    )
    if (!r.ok) return
    onShowingKey?.(true)
    setRecoveryKey(r.value.recoveryKey)
  }

  return (
    <StepFrame
      icon={<KeyRound />}
      feature="event"
      title="Make a new recovery key"
      subtitle={configured ? 'Replaces the key you have now' : 'Your account has none yet'}
      footer={
        <>
          {onDone && (
            <Button variant="quiet" disabled={busy} onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button disabled={!primary || busy} onClick={() => void rotate()}>
            <KeyRound /> {busy ? 'Making the key…' : 'Make a new recovery key'}
          </Button>
        </>
      }
    >
      <p>
        {configured
          ? 'Your account has a recovery key. With it, you can use your messages on a new device when no other device is signed in.'
          : 'Your account has no recovery key. If you lose all of your devices, you cannot read your messages again.'}
      </p>
      <Warning>
        A new recovery key replaces the old one. The old key stops working, and Hachiman encrypts
        your backups again with the new key.
      </Warning>
      {!primary && (
        <p className="text-meta text-text-tertiary">
          Only a device with your security key can make a recovery key: your first device, or a
          device that you restored with the recovery key.
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </StepFrame>
  )
}

/** Dialog kind 'recoveryKey'. */
export function RecoveryKeyDialog(): React.JSX.Element {
  const { open, close } = useDialog('recoveryKey')
  // While a new key shows, the window closes only through the "I saved" confirmation.
  const [showing, setShowing] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !showing && close()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[520px]">
        <RotateRecoveryKey onShowingKey={setShowing} onDone={close} />
      </DialogContent>
    </Dialog>
  )
}

/**
 * User settings → Recovery key. The rotation runs in the 'recoveryKey' dialog, which cannot close
 * while the new key shows (the old key no longer works then).
 */
export function RecoverySection(): React.JSX.Element {
  const configured = useCryptoStore((s) => s.status?.recoveryConfigured ?? false)
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  return (
    <div className="grid gap-4">
      <p className="text-sm">
        {configured
          ? 'Your account has a recovery key. Keep it in a safe place. With it, you can use your messages on a new device when no other device is signed in.'
          : 'Your account has no recovery key. If you lose all of your devices, you cannot read your messages again.'}
      </p>
      <Warning tone="danger">
        Anyone with your recovery key can read all of your encrypted history.
      </Warning>
      <p className="text-muted-foreground text-xs leading-4">
        Make a new key when you lost the old one, or when someone else could have seen it.
        {primary ? '' : ' Only a device with your security key can do this.'}
      </p>
      <div>
        <Button
          variant="outline"
          disabled={!primary}
          onClick={() => openDialog({ kind: 'recoveryKey' })}
        >
          <KeyRound /> Make a new recovery key
        </Button>
      </div>
    </div>
  )
}
