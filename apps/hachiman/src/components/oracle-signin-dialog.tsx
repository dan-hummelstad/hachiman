import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
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
import { oracleService } from '@/services/OracleService'
import { serversService } from '@/services/ServersService'
import { useOracleStore } from '@/stores/oracleStore'

interface OracleSignInDialogProps {
  isOpen: boolean
  onClose: () => void
  /**
   * How to open the authorization URL. Defaults to `window.location.assign` so
   * browser builds Just Work. Electron should pass a function that calls
   * `shell.openExternal` via IPC (or the legacy `nodeIntegration` direct require).
   */
  openAuthorizationUrl?: (url: string) => void
}

export function OracleSignInDialog(props: OracleSignInDialogProps): React.JSX.Element {
  const session = useOracleStore((s) => s.session)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleSignIn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const flow = await oracleService.beginSignIn()
      // Electron renderer exposes a global that hops to main → shell.openExternal.
      // Browser hosts just navigate the current tab. The prop wins if supplied.
      const electronOpen = (
        window as unknown as {
          hachimanOpenExternal?: (url: string) => void
        }
      ).hachimanOpenExternal
      const opener =
        props.openAuthorizationUrl ??
        electronOpen ??
        ((url: string) => {
          window.location.assign(url)
        })
      opener(flow.authorizationUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSignOut = (): void => {
    oracleService.signOut()
    props.onClose()
  }

  const handleSync = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await serversService.syncWithOracle()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.isOpen} onOpenChange={props.onClose}>
      <DialogContent className="sm:max-w-106.25">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-blue-500" />
            Takusen (Oracle) Sign-in
          </DialogTitle>
          <DialogDescription>
            Sign in with Takusen to get a verified badge on servers, sync your server list across
            devices, and share verified identity across Mumble channels.
          </DialogDescription>
        </DialogHeader>
        {session ? (
          <div className="grid gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">Signed in as </span>
              <span className="font-medium">{session.user.handle}</span>
            </div>
            <div className="text-muted-foreground text-xs">{session.user.email}</div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            We will open your system browser to complete sign-in. Tokens never touch this dialog.
          </p>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Close
            </Button>
          </DialogClose>
          {session ? (
            <>
              <Button variant="secondary" onClick={() => void handleSync()} disabled={busy}>
                Sync servers
              </Button>
              <Button variant="destructive" onClick={handleSignOut} disabled={busy}>
                Sign out
              </Button>
            </>
          ) : (
            <Button onClick={() => void handleSignIn()} disabled={busy}>
              {busy ? 'Opening…' : 'Sign in with Takusen'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
