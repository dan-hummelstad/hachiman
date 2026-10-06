import {
  parseInviteLink,
  type InviteLink,
} from "@hachiman/hachiman/invite-link";

/**
 * The deep-link route of the load URL (./PlatformService.ts `consumeLaunchUrl`).
 * The caller resets the URL to `/` for every route. Pure, so `node --test` can
 * load it.
 */
export type LaunchRoute =
  | { kind: "oauth"; url: string }
  /** `link` is null when the link does not parse: a malformed key, for example. */
  | { kind: "invite"; link: InviteLink | null };

/**
 *  - `/oauth/callback?code=…&state=…` (or `error=`) → "oauth" with the full URL
 *  - `/invite/<code>[#k=<key>]` → "invite" with `parseInviteLink(href)`. Every
 *    `/invite` path is a route, also one that does not parse, so the reset
 *    removes the key of an invite with history from the address bar and the
 *    history entry (contract §11 "Invite links").
 *  - anything else → null: the URL stays.
 */
export function launchRoute(
  loc: Pick<Location, "pathname" | "search" | "href">,
): LaunchRoute | null {
  const path = loc.pathname.replace(/\/+$/, "");
  if (path === "/oauth/callback" && /[?&](code|error)=/.test(loc.search))
    return { kind: "oauth", url: loc.href };
  if (`${path}/`.startsWith("/invite/"))
    return { kind: "invite", link: parseInviteLink(loc.href) };
  return null;
}
