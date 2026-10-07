import { ShieldAlert } from 'lucide-react'
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
import { Warning } from '@/components/security/screen-window'
import { useUserName } from '@/components/security/use-user-name'
import { useAction } from '@/hooks/use-action'
import { cryptoService } from '@/services/CryptoService'
import { dismissKeyChange } from '@/stores/cryptoStore'
import { openDialog, useDialog } from '@/stores/dialogStore'

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

  const accept = async (): Promise<void> => {
    const r = await run('accept the new key', () =>
      friendly(cryptoService.client().acknowledgeKeyChange(userId))
    )
    if (!r.ok) return
    dismissKeyChange(userId)
    close()
  }
  const keep = (e: Event): void => {
    if (blocking) e.preventDefault()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !blocking && close()}>
      <DialogContent
        showCloseButton={!blocking}
        onEscapeKeyDown={keep}
        onPointerDownOutside={keep}
        onInteractOutside={keep}
        className="sm:max-w-[460px]"
      >
        <DialogHeader icon={<ShieldAlert />} feature={blocking ? 'danger' : 'event'}>
          <DialogTitle>
            {blocking ? `${name} has a new security key` : `New security key for ${name}`}
          </DialogTitle>
          <DialogDescription>
            {blocking
              ? `You verified ${name} before. Their security key is now different.`
              : `The security key of ${name} changed.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p>
            This happens when {name} resets their account or sets up Hachiman again. It can also
            mean that someone tries to read your messages with {name}.
          </p>
          {blocking ? (
            <Warning tone="danger">
              Do not trust the new key before you compare the safety number with {name}, in person
              or on a call.
            </Warning>
          ) : (
            <p className="text-muted-foreground text-xs leading-4">
              You did not verify {name}, so Hachiman uses the new key. To be sure, compare the
              safety number with them.
            </p>
          )}
          <ErrorText>{error}</ErrorText>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => void accept()}>
            {blocking ? 'Accept the new key' : 'OK'}
          </Button>
          <Button disabled={busy} onClick={() => openDialog({ kind: 'verification', userId })}>
            Compare the safety number
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
