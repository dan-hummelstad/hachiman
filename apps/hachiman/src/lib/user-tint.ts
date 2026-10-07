/**
 * A stable hue (0–359) for a user id (FNV-1a). The profile banner uses it when the user has no
 * avatar, or the avatar has no saturated pixel (feature plan N25). Decoration only.
 */
export function userHue(userId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 360
}

/** The banner gradient of a profile for a hue (the avatar's dominant hue, else `userHue`). */
export function bannerGradient(hue: number): string {
  return `linear-gradient(135deg, hsl(${hue} 62% 46%), hsl(${(hue + 24) % 360} 58% 34%))`
}
