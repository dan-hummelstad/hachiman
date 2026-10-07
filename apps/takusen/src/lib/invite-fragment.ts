/**
 * The fragment of the invite page `/invite/<code>` (contract §11 "Invite links"). The link of an
 * invite with history ends in `#k=<invite seed>` (§12.11.4). A browser never sends the fragment to
 * the server, so only the page script (`app/invite/[code]/open-invite-buttons.tsx`) can hand it on
 * to the app. Pure, so `node --test` covers the decision.
 */

// The key form (43 canonical base64url characters) comes from `@hachiman/client/invite-link`, the
// one invite link grammar. The app and Electron main use it too.
import { parseInviteKeyFragment } from '@hachiman/client/invite-link'

export interface InviteFragment {
  /**
   * What the page adds to both "Open" links: '' for no fragment, the fragment of a well-formed key,
   * or null for any other fragment (a damaged link: the page links to nothing and tells the user).
   */
  forward: string | null
  /** True when the page must remove the fragment from the address bar and the history entry. */
  strip: boolean
}

/** `location.hash` of the invite page → what to forward, and whether to strip it. */
export function inviteFragment(hash: string): InviteFragment {
  if (hash === '') return { forward: '', strip: false }
  const f = hash.startsWith('#') ? parseInviteKeyFragment(hash.slice(1)) : null
  return { forward: f === null ? null : f.key === null ? '' : hash, strip: true }
}
