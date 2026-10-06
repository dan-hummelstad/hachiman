/**
 * The fragment of the invite page `/invite/<code>` (contract §11 "Invite links"). The link of an
 * invite with history ends in `#k=<invite seed>` (§12.11.4). A browser never sends the fragment to
 * the server, so only the page script (`app/invite/[code]/open-invite-buttons.tsx`) can hand it on
 * to the app. Pure, so `node --test` covers the decision.
 */

/**
 * The base64url seed of 32 bytes, no padding (`INVITE_LINK_PARAM`, 43 characters). 32 bytes use 4
 * bits of the last character, so its other 2 bits are 0 (canonical), as the crypto Worker requires.
 * The shared UI (`lib/invite-link.ts`) and Electron main (`deep-link-route.ts`) check this form.
 */
const KEY_FRAGMENT_RE = /^#k=[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/

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
  const strip = hash !== ''
  if (hash === '' || hash === '#') return { forward: '', strip }
  return { forward: KEY_FRAGMENT_RE.test(hash) ? hash : null, strip }
}
