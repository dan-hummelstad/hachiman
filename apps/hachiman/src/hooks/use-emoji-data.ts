import { useEffect, useState } from 'react'
import { emojiDataNow, loadEmojiData, type EmojiData } from '@/lib/emoji-data'

/** The Unicode emoji data; null until it has loaded (the first call starts the load). */
export function useEmojiData(enabled = true): EmojiData | null {
  const [data, setData] = useState<EmojiData | null>(emojiDataNow)
  useEffect(() => {
    if (!enabled || data) return
    let live = true
    loadEmojiData().then(
      (d) => live && setData(d),
      (err: unknown) => console.warn('[emoji] could not load the emoji data', err)
    )
    return () => {
      live = false
    }
  }, [enabled, data])
  return data
}
