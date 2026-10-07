/**
 * Invite links (contract §11): `takusen://invite/<code>`, `https://<host>/invite/<code>`, or a bare
 * code. The link of an invite with history ends in `#k=<invite seed>` (§12.11.4). The one
 * definition of the link grammar: the shared UI re-exports it (`@hachiman/hachiman/invite-link`, for
 * the hosts), and the Takusen invite page uses `parseInviteKeyFragment`. No imports, so the hosts,
 * Takusen and `node --test` can load it.
 */

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
const CODE = '[A-Za-z0-9_-]{2,64}'
const BARE_CODE_RE = new RegExp(`^(${CODE})$`)
const INVITE_LINK_RE = new RegExp(
  `^(?:takusen://|https?://[^/?#]+/)invite/(${CODE})/?(?:\\?[^#]*)?(?:#(.*))?$`,
)
/**
 * The only fragment a link can have: the base64url seed of 32 bytes (`INVITE_SEED_BYTES` of
 * @hachiman/crypto, which this package cannot import), 42 + 1 characters, no padding. 32 bytes use 4
 * bits of the last character, so the other 2 bits are 0, as the crypto Worker requires
 * (`fromB64url`). A damaged last character thus fails here, before the join uses the invite.
 */
const KEY_FRAGMENT_RE = /^k=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/

/**
 * The key of a link fragment (without `#`): `''` has no key, `k=<seed>` has the seed, and any other
 * fragment is null (fail closed).
 */
export function parseInviteKeyFragment(fragment: string): { key: string | null } | null {
  if (fragment === '') return { key: null }
  const key = KEY_FRAGMENT_RE.exec(fragment)?.[1]
  return key === undefined ? null : { key }
}

/** The link fragment that carries the seed of an invite with history: `#k=<key>`. */
export function inviteKeyFragment(key: string): string {
  return `#k=${key}`
}

/**
 * The code and key of an invite link, or null when the input is not an invite link. Fails closed:
 * a link with any other fragment (a malformed key, for example) is null, so the user cannot join
 * without the history by accident.
 */
export function parseInviteLink(input: string): InviteLink | null {
  const s = input.trim()
  const bare = BARE_CODE_RE.exec(s)?.[1]
  if (bare !== undefined) return { code: bare, key: null }
  const m = INVITE_LINK_RE.exec(s)
  const code = m?.[1]
  if (m === null || code === undefined) return null
  const f = parseInviteKeyFragment(m[2] ?? '')
  return f ? { code, key: f.key } : null
}

export function parseInviteCode(input: string): string | null {
  return parseInviteLink(input)?.code ?? null
}
