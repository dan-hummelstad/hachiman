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
 *   a friendly splash, and hand the callback off to the deep link from JS
 *   (`bridge-handoff.tsx`).
 *
 * Registered as a redirect_uri on the `hachiman-client` public OIDC client
 * (see apps/takusen/src/db/seed.ts).
 */
import { Suspense } from 'react'

import { hachimanLinks } from '@/lib/deployment'

import { BridgeHandoff } from './bridge-handoff'

// HACHIMAN_WEB_URL is read per request, not frozen at build time.
export const dynamic = 'force-dynamic'

export default function ElectronBridgePage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <BridgeHandoff webUrl={hachimanLinks().web} />
    </Suspense>
  )
}
