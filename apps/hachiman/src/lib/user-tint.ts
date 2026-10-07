/**
 * A stable hue (0–359) for a user id (FNV-1a). The DM profile banner uses it until the avatar
 * colour exists (feature plan N25). It is decoration only: no image, no user data.
 */
export function userHue(userId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 360
}

/** The banner gradient of a profile, from `userHue`. */
export function userBanner(userId: string): string {
  const hue = userHue(userId)
  return `linear-gradient(135deg, hsl(${hue} 62% 46%), hsl(${(hue + 24) % 360} 58% 34%))`
}
