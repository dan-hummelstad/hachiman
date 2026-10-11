import { KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorText } from '@/components/ui/field'
import { friendly } from '@/components/security/errors'
import { useUserName } from '@/components/security/use-user-name'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { cryptoService } from '@/services/CryptoService'
import { dismissKeyChange } from '@/stores/cryptoStore'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { Callout } from '@/components/ui/callout'

/**
 * Dialog kind 'keyChange' (§12.5 TOFU, §12.4 rule 9): the security key of a contact changed, or
 * an older key came back. For a verified contact ('blocking') the window has no close button:
 * the user verifies again or accepts the new key. For other contacts it is a notice.
 */
export function KeyChangeDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('keyChange')
  const { userId, severity } = dialog
  const blocking = severity === 'blocking'
  const name = useUserName(userId)
  const { run, busy, error } = useAction()
  const mobile = useLayout() === 'mobile'
  // M58: on a phone the blocking form stacks Compare (primary) over the quiet Accept.
  const stacked = blocking && mobile

  const accept = async (): Promise<void> => {
    const r = await run('accept the new key', () =>
      friendly(cryptoService.client().acknowledgeKeyChange(userId))
    )
    if (!r.ok) return
    dismissKeyChange(userId)
    close()
  }
  const acceptButton = (
    <Button
      variant={blocking ? 'quiet' : 'secondary'}
      disabled={busy}
      onClick={() => void accept()}
    >
      {blocking ? 'Accept the new key' : 'OK'}
    </Button>
  )
  const keep = (e: Event): void => {
    if (blocking) e.preventDefault()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !blocking && close()}>
      <DialogContent
        presentation={blocking ? 'dialog' : 'sheet'}
        showCloseButton={!blocking}
        onEscapeKeyDown={keep}
        onPointerDownOutside={keep}
        onInteractOutside={keep}
        className="sm:max-w-[520px]"
      >
        <DialogHeader
          icon={blocking ? <ShieldAlert /> : <KeyRound />}
          feature={blocking ? 'danger' : 'event'}
        >
          <DialogTitle>
            {blocking ? `${name} has a new security key` : `New security key for ${name}`}
          </DialogTitle>
          <DialogDescription>
            {blocking ? `You verified ${name} before` : `${name} isn’t verified`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="font-semibold">
            {blocking
              ? 'Their security key is different from the one you verified.'
              : `The security key of ${name} changed.`}
          </p>
          <p className="text-text-secondary">
            This happens when {name} resets their account or sets up Hachiman again. It can also
            mean that someone is trying to read your messages with {name}.
          </p>
          {blocking ? (
            <Callout tone="danger">
              Don’t trust the new key until you compare the safety number with {name}, in person or
              on a call.
            </Callout>
          ) : (
            <Callout tone="caution">
              You haven’t verified {name}, so Hachiman now uses the new key. To be sure, compare the
              safety number with them.
            </Callout>
          )}
          <ErrorText>{error}</ErrorText>
        </div>
        <DialogFooter className={stacked ? 'flex-col' : undefined}>
          {!stacked && acceptButton}
          <Button disabled={busy} onClick={() => openDialog({ kind: 'verification', userId })}>
            <ShieldCheck />
            Compare safety numbers
          </Button>
          {stacked && acceptButton}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
