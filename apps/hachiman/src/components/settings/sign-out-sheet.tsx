import { LogOut } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { takusenService } from '@/services/TakusenService'
import { useDialog } from '@/stores/dialogStore'

/**
 * Sign out of this device, from the red row of the mobile settings list (dialog kind `signOut`).
 * For now a confirm that ends the session, as the desktop settings row does at once. This device
 * keeps its keys.
 */
export function SignOutSheet(): React.JSX.Element {
  const { open, close } = useDialog('signOut')
  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      title="Sign out?"
      tone="danger"
      icon={<LogOut />}
      confirmLabel="Sign out"
      body="To use Hachiman on this device again, you must sign in again."
      onConfirm={async () => takusenService.signOut()}
    />
  )
}
