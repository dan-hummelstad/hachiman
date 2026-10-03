import { Button } from '@/components/ui/button'
import { ScreenWindow } from '@/components/security/screen-window'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { setCryptoFatal, type CryptoFatal } from '@/stores/cryptoStore'

/**
 * The global stops of §12.13. The client does not reconnect after them.
 * - 'update_required' (close 4012): this version is too old for the server.
 * - 'device_revoked' (close 4013, or a verified revocation): the app signed out.
 */
export function FatalScreen({ fatal }: { fatal: CryptoFatal }): React.JSX.Element {
  const { platform } = usePlatform()

  if (fatal === 'update_required') {
    return (
      <ScreenWindow title="Update required" tone="danger">
        <p className="text-sm">
          This version of Hachiman is too old for the server. The server accepts only versions that
          support end-to-end encryption.
        </p>
        <p className="text-sm">
          {platform === 'browser'
            ? 'Reload the page to get the new version.'
            : 'Install the new version of the desktop app, then open it again.'}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              takusenService.signOut()
              setCryptoFatal(null)
            }}
          >
            Sign out
          </Button>
          {platform === 'browser' && <Button onClick={() => location.reload()}>Reload</Button>}
        </div>
      </ScreenWindow>
    )
  }

  return (
    <ScreenWindow title="This device was signed out" tone="danger">
      <p className="text-sm">
        This device is no longer on your account. You or another of your devices removed it, or the
        server stopped it, for example after a password reset. Its encryption keys cannot be used
        again.
      </p>
      <p className="text-sm">
        To use Hachiman here again, sign in. Then link this device from another device, or use your
        recovery key.
      </p>
      <div className="flex justify-end">
        <Button onClick={() => setCryptoFatal(null)}>Sign in again</Button>
      </div>
    </ScreenWindow>
  )
}
