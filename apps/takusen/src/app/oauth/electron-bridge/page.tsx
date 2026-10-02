'use client'

/**
 * Electron OAuth bridge page.
 *
 * Why this exists:
 * - Native apps (RFC 8252) get the OAuth callback via a custom URI scheme
 *   like `app.hachiman://oauth-callback?…`. The system browser cannot render
 *   a custom-scheme URL — if Takusen redirected directly there, the user
 *   would land on a broken-looking page while the OS prompted to open the
 *   app.
 * - Browsers DO follow `window.location = 'app.hachiman://…'`, which fires
 *   the OS protocol handler. So we redirect to this HTTP page instead, show
 *   a friendly splash, and hand the callback off to the deep link from JS.
 *
 * Registered as a redirect_uri on the `hachiman-client` public OIDC client
 * (see apps/takusen/src/db/seed.ts).
 */
import { Suspense, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'

import { Window, WindowScreen } from '@/components/window'

const DEEP_LINK_SCHEME = 'app.hachiman://oauth-callback'

function buildDeepLink(params: URLSearchParams): string {
  // Preserve every param Takusen handed us (code, state, iss, error,
  // error_description, …). The Electron main process parses them out of
  // the URL we hand it via the OS protocol handler.
  const qs = new URLSearchParams()
  for (const [key, value] of params.entries()) {
    qs.set(key, value)
  }
  return `${DEEP_LINK_SCHEME}?${qs.toString()}`
}

function BridgeInner(): React.JSX.Element {
  const search = useSearchParams()
  const deepLink = useMemo(
    () => (search ? buildDeepLink(new URLSearchParams(search.toString())) : null),
    [search],
  )
  const error = search?.get('error')
  const errorDescription = search?.get('error_description')

  // Hand off to the app once. The retry link below is derived from the same
  // values, so there is no state to set here.
  useEffect(() => {
    if (!deepLink || error) return
    window.location.assign(deepLink)
  }, [deepLink, error])

  if (error) {
    return (
      <WindowScreen>
        <Window title="Sign-in failed">
          <p className="text-sm">
            Takusen returned{' '}
            <code className="border bg-sidebar px-1 py-0.5 font-mono text-[13px]">{error}</code>
            {errorDescription ? `: ${errorDescription}` : ''}.
          </p>
          <p className="text-sm text-muted-foreground">
            You can close this tab and try again from the desktop app.
          </p>
        </Window>
      </WindowScreen>
    )
  }

  return (
    <WindowScreen>
      <Window
        title="Back to Hachiman"
        footer={
          deepLink ? (
            <p className="text-muted-foreground">
              App didn&apos;t open?{' '}
              <a
                className="font-medium text-foreground underline decoration-primary decoration-2 underline-offset-4 hover:decoration-foreground"
                href={deepLink}
              >
                Open Hachiman again
              </a>
            </p>
          ) : null
        }
      >
        <p className="text-[15px] leading-5 font-semibold">You&apos;re signed in.</p>
        <p className="text-sm text-muted-foreground">
          We sent you back to the desktop app. You can close this tab.
        </p>
      </Window>
    </WindowScreen>
  )
}

export default function ElectronBridgePage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <BridgeInner />
    </Suspense>
  )
}
