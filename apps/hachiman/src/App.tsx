import { useEffect } from 'react'

import { SignInScreen } from '@/components/sign-in-screen'
import { Dialogs } from '@/components/shell/dialogs'
import { Shell } from '@/components/shell/shell'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WindowStrip } from '@/components/ui/window-strip'

import { errMsg } from '@/lib/utils'
import { startHachiman } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { openDialog } from '@/stores/dialogStore'
import { useTakusenStore } from '@/stores/takusenStore'

/**
 * App root: optional Electron window strip above either the signed-in shell or the sign-in
 * window, plus every app-level dialog (driven by dialogStore).
 */
function App(): React.JSX.Element {
  const platform = usePlatform()
  const signedIn = useTakusenStore((s) => s.session !== null)

  useEffect(() => startHachiman(), [])
  useEffect(
    () =>
      platform.onOAuthCallback((url) => {
        // Read before completeSignIn clears the pending flow; reopen the invite either way.
        const inviteCode = useTakusenStore.getState().pendingFlow?.inviteCode
        void takusenService
          .completeSignIn(url)
          .catch((e) => {
            console.error('[oauth] callback failed', e)
            useTakusenStore
              .getState()
              .setAuthError(`Sign-in did not finish: ${errMsg(e)}. Sign in again.`)
          })
          .finally(() => {
            if (inviteCode) openDialog({ kind: 'joinInvite', code: inviteCode })
          })
      }),
    [platform]
  )
  useEffect(
    () => platform.onInviteCode((code) => openDialog({ kind: 'joinInvite', code })),
    [platform]
  )
  useEffect(() => {
    // A file dropped anywhere but an enabled DropZone would navigate the tab/window to it. The
    // DropZone's React handlers run first (root delegation) and preventDefault, so skip those.
    const refuse = (e: DragEvent): void => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', refuse)
    window.addEventListener('drop', refuse)
    return () => {
      window.removeEventListener('dragover', refuse)
      window.removeEventListener('drop', refuse)
    }
  }, [])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden">
        <WindowStrip />
        {signedIn ? (
          <Shell />
        ) : (
          <div className="min-h-0 flex-1">
            <SignInScreen />
          </div>
        )}
      </div>
      <Dialogs />
    </TooltipProvider>
  )
}

export default App
