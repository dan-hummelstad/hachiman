import { useEffect } from 'react'
import { KeyRound, OctagonAlert, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { KIT_ICON_BUTTON } from '@/components/mobile/nav-bar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { FEATURE_TILE } from '@/components/ui/feature'
import { ErrorText } from '@/components/ui/field'
import { friendly } from '@/components/security/errors'
import { useUserName } from '@/components/security/use-user-name'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { usePlatform } from '@/shared/PlatformContext'
import { deferKeyChange, dismissKeyChange } from '@/stores/cryptoStore'
import { openDialog, useDialog } from '@/stores/dialogStore'
import { Callout } from '@/components/ui/callout'

/**
 * Dialog kind 'keyChange' (§12.5 TOFU, §12.4 rule 9): the security key of a contact changed, or
 * an older key came back. For a verified contact ('blocking') the scrim does not close the
 * window: the user verifies again or accepts the new key. On the mobile layout (M58) its Close
 * means "not now" (`deferKeyChange`): sending stays paused, and a tap on the paused composer opens
 * the window again. The desktop window has no close. For other contacts it is a notice.
 */
export function KeyChangeDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('keyChange')
  const { userId, severity } = dialog
  const blocking = severity === 'blocking'
  const name = useUserName(userId)
  const { run, busy, error } = useAction()
  const mobile = useLayout() === 'mobile'
  const platform = usePlatform()

  useEffect(() => {
    if (blocking) platform.haptic('warning')
  }, [blocking, platform])

  const accept = async (): Promise<void> => {
    const r = await run('accept the new key', () =>
      friendly(cryptoService.client().acknowledgeKeyChange(userId))
    )
    if (!r.ok) return
    dismissKeyChange(userId)
    close()
  }
  const compare = (): void => openDialog({ kind: 'verification', userId })
  const keep = (e: Event): void => {
    if (blocking) e.preventDefault()
  }

  if (blocking && mobile) {
    const later = (): void => {
      deferKeyChange(userId)
      close()
    }
    return (
      <Dialog open={open} onOpenChange={(o) => !o && later()}>
        <BlockingCard
          name={name}
          busy={busy}
          error={error}
          onCompare={compare}
          onAccept={() => void accept()}
          onOutside={keep}
        />
      </Dialog>
    )
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
          title={blocking ? `${name} has a new security key` : `New security key for ${name}`}
          description={blocking ? `You verified ${name} before` : `${name} isn’t verified`}
        />
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
        <DialogFooter>
          <Button
            variant={blocking ? 'quiet' : 'secondary'}
            disabled={busy}
            onClick={() => void accept()}
          >
            {blocking ? 'Accept the new key' : 'OK'}
          </Button>
          <Button disabled={busy} onClick={compare}>
            <ShieldCheck />
            Compare safety numbers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * M58 on the mobile layout: a centred card (`presentation="dialog"`) over the paused composer.
 * Header 16/12/4/16 with the red tile (40), the title (17/800) and Close (36). The body 10/16/16
 * scrolls inside the card on a short screen (iPhone SE); the footer on the panel colour stays at
 * its foot with Compare (primary, 48) over the quiet Accept. The key compare box of the mock waits
 * for per-device fingerprints (docs/ios-mobile-ui-spec.md §5), and so does the date of the earlier
 * verification: a key change clears `verifiedAt`.
 */
function BlockingCard({
  name,
  busy,
  error,
  onCompare,
  onAccept,
  onOutside
}: {
  name: string
  busy: boolean
  error: string | null
  onCompare: () => void
  onAccept: () => void
  onOutside: (e: Event) => void
}): React.JSX.Element {
  return (
    <DialogContent
      role="alertdialog"
      presentation="dialog"
      showCloseButton={false}
      onPointerDownOutside={onOutside}
      onInteractOutside={onOutside}
      className="gap-0 p-0"
    >
      <div className="flex items-start gap-3 pt-4 pr-3 pb-1 pl-4">
        <span
          aria-hidden
          className={cn(
            'flex size-10 shrink-0 items-center justify-center [&_svg]:size-5',
            FEATURE_TILE.danger
          )}
        >
          <ShieldAlert />
        </span>
        <div className="grid min-w-0 flex-1 gap-[3px] pt-px">
          <DialogTitle className="block text-[17px] leading-[1.25] text-balance break-words">
            {name} has a new security key
          </DialogTitle>
          <DialogDescription className="text-text-tertiary text-[13px] leading-[18px] font-semibold">
            You verified {name} before
          </DialogDescription>
        </div>
        <DialogClose
          aria-label="Not now"
          className={cn(
            KIT_ICON_BUTTON,
            'bg-surface-hover text-text-secondary active:bg-surface-selected'
          )}
        >
          <X className="size-[18px]" />
        </DialogClose>
      </div>
      <div className="grid gap-3 px-4 pt-2.5 pb-4">
        <p className="text-text-primary text-[15px] leading-[1.45] font-semibold text-balance">
          Their security key is different from the one you verified.
        </p>
        <p className="text-text-secondary text-[14px] leading-[1.45] font-medium">
          This happens when {name} resets their account or sets up Hachiman again. It can also mean
          someone is trying to read your messages.
        </p>
        <Callout tone="danger" size="touch" icon={<OctagonAlert />}>
          Don’t trust the new key until you compare safety numbers with {name}, in person or on a
          call.
        </Callout>
        <ErrorText>{error}</ErrorText>
      </div>
      <DialogFooter className="bg-surface-panel sticky bottom-0 z-10 mx-0 mb-0 flex-col flex-nowrap gap-1.5 px-4 py-3">
        <Button disabled={busy} onClick={onCompare}>
          <ShieldCheck />
          Compare safety numbers
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onAccept}>
          <KeyRound />
          Accept the new key
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
