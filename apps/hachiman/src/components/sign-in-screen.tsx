import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useSignIn } from '@/hooks/use-sign-in'
import { usePlatform } from '@/shared/PlatformContext'

/**
 * Signed-out screen (spec §1): a small "Sign in to Hachiman" window centred on the app
 * background — the old-messenger login window. Mounted by the shell when there's no session.
 * After sign-in, the encryption onboarding (security/onboarding.tsx) sets up this device.
 */
export function SignInScreen(): React.JSX.Element {
  const { signIn, busy, error } = useSignIn()
  const { platform } = usePlatform()

  return (
    <div className="bg-background flex min-h-full w-full flex-1 items-center justify-center p-4">
      <section
        aria-labelledby="sign-in-title"
        className="bg-popover text-foreground w-full max-w-[360px] border shadow-lg"
      >
        <header className="bg-sidebar flex h-10 items-center gap-2 border-b px-3">
          <span aria-hidden className="bg-primary size-3" />
          <h1 id="sign-in-title" className="text-sm leading-5 font-semibold">
            Sign in to Hachiman
          </h1>
        </header>
        <div className="grid gap-4 p-5">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="bg-primary text-primary-foreground flex size-12 shrink-0 items-center justify-center text-xl font-semibold"
            >
              H
            </span>
            <p className="text-sm">
              Hachiman uses your Takusen account. Sign in to see your guilds, messages and voice
              channels.
            </p>
          </div>
          <Button size="lg" className="w-full" disabled={busy} onClick={() => void signIn()}>
            {busy ? 'Opening Takusen…' : 'Sign in with Takusen'}
          </Button>
          <ErrorText>{error}</ErrorText>
          <p className="text-muted-foreground text-xs leading-4">
            {platform === 'browser'
              ? 'You’ll go to the Takusen sign-in page and come straight back here.'
              : 'Your browser opens to finish signing in. Come back here when it says you’re done.'}
          </p>
          <p className="text-muted-foreground border-t pt-3 text-xs leading-4">
            Messages and calls are end-to-end encrypted. After you sign in, you set up this device:
            link it from another device, restore it with your recovery key, or start new.
          </p>
        </div>
      </section>
    </div>
  )
}
