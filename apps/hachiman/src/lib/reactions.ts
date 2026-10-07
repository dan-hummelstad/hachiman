/** One reaction chip under a message (N10). */
export interface ReactionChip {
  emoji: string
  count: number
  /** I am one of the reactors: the chip shows selected, and a click takes my reaction back. */
  mine: boolean
}

/**
 * The chips of a message from its folded reactions (emoji → user ids). Chips keep the order of
 * the map (the oldest reaction first), so a chip does not jump when someone else clicks it.
 * Emojis that nobody holds any more drop out.
 */
export function reactionChips(
  reactions: ReadonlyMap<string, ReadonlySet<string>>,
  myId: string | undefined
): ReactionChip[] {
  const out: ReactionChip[] = []
  for (const [emoji, users] of reactions) {
    if (users.size === 0) continue
    out.push({ emoji, count: users.size, mine: myId !== undefined && users.has(myId) })
  }
  return out
}

/** The emoji grid of the reaction picker. The app has no full emoji picker. */
export const QUICK_EMOJI: readonly string[] = [
  '👍',
  '👎',
  '❤️',
  '😂',
  '😮',
  '😢',
  '😡',
  '🎉',
  '🔥',
  '👀',
  '🙏',
  '👏',
  '💯',
  '✅',
  '❌',
  '🤔',
  '😎',
  '🥳',
  '😅',
  '🙌',
  '💀',
  '🫡',
  '🤝',
  '⭐',
  '🎮',
  '🍿',
  '☕',
  '🚀',
  '🐛',
  '📌',
  '💡',
  '⚠️'
]
