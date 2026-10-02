import { useAction } from '@/hooks/use-action'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useTakusenStore } from '@/stores/takusenStore'

/**
 * Starts the Takusen PKCE sign-in; the host decides how the authorization page opens.
 * Pass `inviteCode` when signing in from an invite so it reopens afterwards. `error` is
 * a failure to start sign-in, or else the last failed OAuth callback.
 */
export function useSignIn(inviteCode: string | null = null): {
  signIn: () => Promise<void>
  busy: boolean
  error: string | null
} {
  const platform = usePlatform()
  const authError = useTakusenStore((s) => s.authError)
  const { run, busy, error } = useAction()
  const signIn = async (): Promise<void> => {
    await run('start sign-in', async () => {
      platform.beginOAuth(await takusenService.beginSignIn(platform.oauthRedirectUri, inviteCode))
    })
  }
  return { signIn, busy, error: error ?? authError }
}
