import { hashString } from '@/lib/hash'

/**
 * A stable hue (0–359) for a user id (FNV-1a). The profile banner uses it when the user has no
 * avatar, or the avatar has no saturated pixel (feature plan N25). Decoration only.
 */
export function userHue(userId: string): number {
  return hashString(userId) % 360
}
