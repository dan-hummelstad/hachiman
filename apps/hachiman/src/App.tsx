import { useEffect } from 'react'

import { FatalScreen } from '@/components/security/fatal-screen'
import { CryptoGate } from '@/components/security/onboarding'
import { SecurityNotices } from '@/components/security/security-notices'
import { SignInScreen } from '@/components/sign-in-screen'
import { Dialogs } from '@/components/shell/dialogs'
import { Shell } from '@/components/shell/shell'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WindowStrip } from '@/components/ui/window-strip'

import { errMsg } from '@/lib/utils'
import { startHachiman } from '@/services/hachiman'
import { dropSignInInviteKeys, restoreInviteKey, stashInviteKey } from '@/services/InviteService'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog } from '@/stores/dialogStore'
import { useTakusenStore } from '@/stores/takusenStore'

/**
 * App root: optional Electron window strip above one of
 * - a fatal screen (update required, device signed out: §12.13),
 * - the signed-in shell behind the encryption gate (start-up, onboarding: §12.4, §12.5),
 * - the sign-in window,
 * plus every app-level dialog (driven by dialogStore) and the security notices.
 */
function App(): React.JSX.Element {
  const platform = usePlatform()
  const signedIn = useTakusenStore((s) => s.session !== null)
  const fatal = useCryptoStore((s) => s.fatal)

  // The host gives the crypto Worker its store wrap key (§11).
  useEffect(() => startHachiman(platform), [platform])
  useEffect(() => {
    const off = platform.onOAuthCallback((url) => {
      // Read before completeSignIn clears the pending flow; reopen the invite either way.
      const inviteCode = useTakusenStore.getState().pendingFlow?.inviteCode
      if (inviteCode) restoreInviteKey(inviteCode)
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
    })
    // The browser host gives the callback of the load URL during the subscription, so the key of
    // its sign-in is in memory now. A key still in sessionStorage is of a sign-in that did not
    // finish (§12.17).
    dropSignInInviteKeys()
    return off
  }, [platform])
  useEffect(
    () =>
      platform.onInviteLink(({ code, key }) => {
        // The key of an invite with history stays out of the dialog store (§12.17).
        stashInviteKey(code, key)
        openDialog({ kind: 'joinInvite', code })
      }),
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
        {fatal ? (
          <FatalScreen fatal={fatal} />
        ) : signedIn ? (
          <CryptoGate>
            <Shell />
          </CryptoGate>
        ) : (
          <div className="min-h-0 flex-1">
            <SignInScreen />
          </div>
        )}
      </div>
      <Dialogs />
      {signedIn && !fatal && <SecurityNotices />}
    </TooltipProvider>
  )
}

export default App
