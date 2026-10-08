'use client'

/**
 * The two "Open" buttons of the invite page. The link of an invite with history ends in
 * `#k=<invite seed>` (contract §12.11.4). A browser never sends the fragment to the server, so
 * only this script can hand it on: it adds the fragment to both buttons, then removes it from the
 * address bar and the history entry. A fragment of another form is not forwarded, and the page
 * tells the user (the app refuses such a link too). `lib/invite-fragment.ts` makes the decision.
 */
import { ArrowUpRightIcon, GlobeIcon } from 'lucide-react'
import { signOut } from 'next-auth/react'
import { useEffect, useSyncExternalStore } from 'react'

import { Button } from '@/components/ui/button'
import { inviteFragment } from '@/lib/invite-fragment'

/** The fragment of the page as it loaded: kept after the page removed it from the address bar. */
let loaded: { pathname: string; hash: string } | null = null
function loadedHash(): string {
  const { pathname, hash } = window.location
  if (loaded?.pathname !== pathname) loaded = { pathname, hash }
  return loaded.hash
}
const noChanges = (): (() => void) => () => undefined

export function OpenInviteButtons({
  webHref,
  appHref,
}: {
  webHref: string
  appHref: string
}): React.JSX.Element {
  const hash = useSyncExternalStore(noChanges, loadedHash, () => '')
  const { forward: fragment, strip } = inviteFragment(hash)

  useEffect(() => {
    if (!strip) return
    const { pathname, search } = window.location
    window.history.replaceState(null, '', pathname + search)
  }, [strip])

  if (fragment === null) {
    return (
      <p className="text-sm font-semibold text-feature-danger-text">
        This link is damaged. Ask whoever sent it for the full link again.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2.5">
      <Button asChild size="lg" className="w-full">
        <a href={`${appHref}${fragment}`}>
          <ArrowUpRightIcon aria-hidden />
          Open in Hachiman
        </a>
      </Button>
      <Button asChild variant="secondary" size="lg" className="w-full">
        <a href={`${webHref}${fragment}`}>
          <GlobeIcon aria-hidden />
          Open in browser
        </a>
      </Button>
    </div>
  )
}

/**
 * "Not you?": signs out of Takusen and reloads this invite page. The reload puts back the
 * fragment as the page loaded it, so the `#k=` key survives the switch; a sign-out callback URL
 * would send it to the server.
 */
export function NotYouButton(): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="link"
      className="ml-auto text-[13.5px] font-extrabold"
      onClick={() => {
        const { pathname, search } = window.location
        const hash = loadedHash()
        void signOut({ redirect: false }).then(() => {
          window.history.replaceState(null, '', pathname + search + hash)
          window.location.reload()
        })
      }}
    >
      Not you?
    </Button>
  )
}
