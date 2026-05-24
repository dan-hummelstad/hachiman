'use client'

/**
 * Electron OAuth bridge page.
 *
 * Why this exists:
 * - Native apps (RFC 8252) get the OAuth callback via a custom URI scheme
 *   like `app.hachiman://oauth-callback?…`. The system browser cannot render
 *   a custom-scheme URL — if Oracle redirected directly there, the user
 *   would land on a broken-looking page while the OS prompted to open the
 *   app.
 * - Browsers DO follow `window.location = 'app.hachiman://…'`, which fires
 *   the OS protocol handler. So we redirect to this HTTP page instead, show
 *   a friendly splash, and hand the callback off to the deep link from JS.
 *
 * Registered as a redirect_uri on the `hachiman-client` public OIDC client
 * (see apps/oracle/src/db/seed.ts).
 */
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'

const DEEP_LINK_SCHEME = 'app.hachiman://oauth-callback'

function buildDeepLink(params: URLSearchParams): string {
  // Preserve every param Oracle handed us (code, state, iss, error,
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
  const [triggered, setTriggered] = useState(false)
  const error = search?.get('error')

  useEffect(() => {
    if (!deepLink || error) return
    setTriggered(true)
    window.location.assign(deepLink)
  }, [deepLink, error])

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-6 text-neutral-900">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-semibold">Sign-in failed</h1>
          <p className="text-sm text-neutral-600">
            Oracle returned <code className="rounded bg-neutral-200 px-1 py-0.5 text-xs">{error}</code>
            {search?.get('error_description')
              ? ` — ${search.get('error_description')}`
              : ''}
            . You can close this tab and try again from the desktop app.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 px-6 text-neutral-900">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Returned you to the desktop app</h1>
        <p className="text-sm text-neutral-600">
          See you there! You can close this tab.
        </p>
        {triggered && deepLink ? (
          <p className="text-xs text-neutral-500">
            App didn&apos;t open?{' '}
            <a className="underline" href={deepLink}>
              Click here to retry
            </a>
            .
          </p>
        ) : null}
      </div>
    </main>
  )
}

export default function ElectronBridgePage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <BridgeInner />
    </Suspense>
  )
}
