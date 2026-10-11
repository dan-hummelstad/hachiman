import { joinNames, type ChannelAccess } from '@/lib/channel-access'

/**
 * Why I can't post in a channel: the text of the composer's notice. A read-only channel names the
 * roles that can post (B7). The mobile layout (M62) has a shorter form, because the notice shares
 * its row with the Follow button on a 375 wide phone.
 */
export function cantPostReason(
  where: string,
  readOnly: boolean,
  posters: readonly string[],
  mobile: boolean
): string {
  if (!readOnly)
    return mobile
      ? `You can't send messages in ${where}.`
      : `You don't have permission to send messages in ${where}.`
  if (posters.length === 0) return `You can't post in ${where}.`
  const who = joinNames([...posters])
  return mobile
    ? `Only ${who} can post in ${where}.`
    : `You can't post in ${where}. Only ${who} can.`
}

/** The restricted chip of the mobile channel header names this many roles (M63). */
export const CHIP_ROLES = 2

/** The roles that the restricted chip names, and how many more it counts as "+n". */
export function chipRoles<T>(roles: readonly T[]): { shown: T[]; more: number } {
  return { shown: roles.slice(0, CHIP_ROLES), more: Math.max(0, roles.length - CHIP_ROLES) }
}

/**
 * The mobile channel header shows a chip in the title row: "Read only" (M62) or the roles of a
 * restricted channel (M63). The header then leaves Threads out, and the channel sheet lists it.
 */
export const hasTitleChip = (access: ChannelAccess): boolean =>
  access.readOnly || (access.restricted && access.viewers.length > 0)
