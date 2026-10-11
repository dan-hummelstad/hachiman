import { parseInviteLink, type InviteLink } from '@/lib/invite-link'

/**
 * The invite in a link of a message, when the link is an invite page of this Takusen (`origin`,
 * the issuer origin): the mobile layout then opens the join sheet in the app (M45). A link to
 * another server, or an invite link with a damaged key, is null and opens as a normal link.
 */
export function chatInviteLink(href: string, origin: string): InviteLink | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  return parseInviteLink(href)
}

/**
 * The subtitle of the join sheet for an invite link tapped in a message: "From marlowe, in your
 * DMs" (a DM or group DM), "From marlowe, in #general" (a guild channel), or "From marlowe" when
 * the channel is not known.
 */
export function inviteFromLine(
  sender: string,
  channel: { guildId: string | null; name: string | null } | undefined
): string {
  if (!channel) return `From ${sender}`
  if (channel.guildId === null) return `From ${sender}, in your DMs`
  return channel.name ? `From ${sender}, in #${channel.name}` : `From ${sender}`
}

/**
 * The E2EE line of the join sheet (M45): the guild and the own active devices that get its keys
 * at the join. `devices` null: the count is not known (encryption is not ready yet).
 */
export function inviteKeysLine(guildName: string, devices: number | null): string {
  const who =
    devices === null || devices < 1
      ? 'Your devices get'
      : devices === 1
        ? 'Your device gets'
        : `Your ${devices} devices get`
  return `${guildName} is end-to-end encrypted. ${who} its keys when you join.`
}
