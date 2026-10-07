import type { Channel } from '@hachiman/client'

/** Whether `channel` can hold threads: a guild text channel (contract §2, N12). */
export const canHoldThreads = (channel: Channel): boolean =>
  channel.type === 'text' && channel.guildId !== null

/** The longest thread name the server takes (contract §4: 1 to 100 characters). */
export const MAX_THREAD_NAME = 100

/** The name "Create thread" suggests: the first words of the message, at most 40 characters. */
export function defaultThreadName(content: string, max = 40): string {
  const words = content
    .replace(/<[@#][&!]?[\w-]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  let name = ''
  for (const w of words) {
    const next = name ? `${name} ${w}` : w
    if (next.length > max) {
      if (!name) name = w.slice(0, max)
      break
    }
    name = next
  }
  return name || 'New thread'
}

/** The trimmed name, or null when the server would refuse it. */
export function validThreadName(name: string): string | null {
  const t = name.trim()
  return t.length >= 1 && t.length <= MAX_THREAD_NAME ? t : null
}
