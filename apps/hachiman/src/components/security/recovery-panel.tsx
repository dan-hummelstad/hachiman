import { useState } from 'react'
import { Check, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ErrorText } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { friendly } from '@/components/security/errors'
import { RecoveryKeyReveal } from '@/components/security/recovery-key-view'
import { StepFrame, Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
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
 * User settings → Recovery key (H3): the status card, the risk in red, and the one action. The
 * rotation runs in the 'recoveryKey' dialog, which cannot close while the new key shows (the old
 * key no longer works then).
 */
export function RecoverySection(): React.JSX.Element {
  const configured = useCryptoStore((s) => s.status?.recoveryConfigured ?? false)
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  return (
    <div className="grid gap-4">
      <div
        className={cn(
          'flex items-center gap-4 border px-4 py-4',
          configured
            ? 'border-feature-voice/40 bg-feature-voice/5'
            : 'border-feature-event/40 bg-feature-event/5'
        )}
      >
        <span
          className={cn(
            'flex size-12 shrink-0 items-center justify-center [&_svg]:size-6',
            configured
              ? 'bg-feature-voice/15 text-feature-voice-text'
              : 'bg-feature-event/15 text-feature-event-text'
          )}
        >
          <KeyRound aria-hidden />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-heading">
            {configured ? 'Your account has a recovery key' : 'Your account has no recovery key'}
          </p>
          <p className="text-text-secondary text-[13px]">
            {configured
              ? 'Keep it somewhere safe and offline.'
              : 'If you lose all of your devices, you cannot read your messages again.'}
          </p>
        </div>
        {configured && (
          <span className="rounded-check bg-feature-voice/15 text-feature-voice-text flex h-6 shrink-0 items-center gap-1 px-2 text-xs font-bold">
            <Check aria-hidden className="size-3.5" /> Set up
          </span>
        )}
      </div>
      <Callout tone="danger">
        Anyone with your recovery key can read all of your encrypted history.
      </Callout>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="lg"
          disabled={!primary}
          onClick={() => openDialog({ kind: 'recoveryKey' })}
        >
          <KeyRound /> Make a new recovery key
        </Button>
        <p className="text-meta text-text-tertiary min-w-0 flex-1">
          Make a new key if you lost the old one, or if someone else could have seen it.
          {primary ? '' : ' Only a device with your security key can do this.'}
        </p>
      </div>
    </div>
  )
}
