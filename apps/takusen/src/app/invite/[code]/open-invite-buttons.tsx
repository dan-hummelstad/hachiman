'use client'

/**
 * The two "Open" buttons of the invite page. The link of an invite with history ends in
 * `#k=<invite seed>` (contract §12.11.4). A browser never sends the fragment to the server, so
 * only this script can hand it on: it adds the fragment to both buttons, then removes it from the
 * address bar and the history entry. A fragment of another form is not forwarded, and the page
 * tells the user (the app refuses such a link too). `lib/invite-fragment.ts` makes the decision.
 */
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
      <p className="text-sm text-destructive">
        This link is damaged. Ask whoever sent it for the full link again.
      </p>
    )
  }
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button asChild variant="outline">
        <a href={`${webHref}${fragment}`}>Open in browser</a>
      </Button>
      <Button asChild>
        <a href={`${appHref}${fragment}`}>Open in Hachiman</a>
      </Button>
    </div>
  )
}
