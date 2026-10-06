/**
 * Invite links (contract §11): `takusen://invite/<code>`, `https://<host>/invite/<code>`, or a bare
 * code. The link of an invite with history ends in `#k=<invite seed>` (§12.11.4). No imports, so
 * the hosts and the tests can use it.
 */

/** A parsed invite link. */
export interface InviteLink {
  code: string
  /**
   * The invite seed of an invite with history: 43 canonical base64url characters. Null without
   * `#k=`.
   */
  key: string | null
}

// Invite-code shape the clients accept. Takusen issues 8-char codes (apps/takusen/src/lib/invites.ts)
// and is the authority; this stays looser so a bad code gets Takusen's "Unknown invite" answer.
// Electron main can't import this package and keeps a copy of the same bounds in
// apps/hachiman-electron/src/main/deep-link-route.ts.
const CODE = '[A-Za-z0-9_-]{2,64}'
const BARE_CODE_RE = new RegExp(`^(${CODE})$`)
const INVITE_LINK_RE = new RegExp(
  `^(?:takusen://|https?://[^/?#]+/)invite/(${CODE})/?(?:\\?[^#]*)?(?:#(.*))?$`
)
/**
 * The only fragment a link can have: the base64url seed of 32 bytes, no padding. 32 bytes use 4
 * bits of the last character, so the other 2 bits are 0, as the crypto Worker requires
 * (`fromB64url`). A damaged last character thus fails here, before the join uses the invite.
 */
const KEY_FRAGMENT_RE = /^k=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/

/**
 * The code and key of an invite link, or null when the input is not an invite link. Fails closed:
 * a link with any other fragment (a malformed key, for example) is null, so the user cannot join
 * without the history by accident.
 */
export function parseInviteLink(input: string): InviteLink | null {
  const s = input.trim()
  const bare = BARE_CODE_RE.exec(s)
  if (bare) return { code: bare[1], key: null }
  const m = INVITE_LINK_RE.exec(s)
  if (!m) return null
  const fragment = m[2] ?? ''
  if (fragment === '') return { code: m[1], key: null }
  const key = KEY_FRAGMENT_RE.exec(fragment)
  return key ? { code: m[1], key: key[1] } : null
}

/** The invite code of a link or a bare code (see parseInviteLink). */
export function parseInviteCode(input: string): string | null {
  return parseInviteLink(input)?.code ?? null
}
