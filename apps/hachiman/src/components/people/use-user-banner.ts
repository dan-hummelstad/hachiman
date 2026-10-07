import { useEffect, useState } from 'react'
import { decodeIconHue } from '@/lib/guild-tint'
import { bannerGradient, userHue } from '@/lib/user-tint'
import { hachiman } from '@/services/hachiman'

/** Avatar key → decoded hue (null = no saturated pixel or no load). Avatars are plaintext files. */
const decoded = new Map<string, number | null>()
const inFlight = new Map<string, Promise<void>>()

/**
 * The profile banner (feature plan N25): a gradient on the dominant hue of the avatar (the guild
 * tint picker, N4), else on a hash of the user id.
 */
export function useUserBanner(userId: string, avatar: string | null | undefined): string {
  const [, setVersion] = useState(0)

  useEffect(() => {
    if (!avatar || decoded.has(avatar)) return
    let live = true
    let pending = inFlight.get(avatar)
    if (!pending) {
      pending = decodeIconHue(hachiman.rest.fileUrl(avatar)).then((hue) => {
        inFlight.delete(avatar)
        decoded.set(avatar, hue)
      })
      inFlight.set(avatar, pending)
    }
    void pending.then(() => {
      if (live) setVersion((v) => v + 1)
    })
    return () => {
      live = false
    }
  }, [avatar])

  return bannerGradient((avatar ? decoded.get(avatar) : null) ?? userHue(userId))
}
