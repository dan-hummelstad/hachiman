/** What an unread mark shows (N7): the coral mention count, a coral mention dot, a white unread dot. */
export type UnreadMarkKind =
  | { kind: 'count'; label: string; aria: string }
  | { kind: 'mentionDot'; aria: string }
  | { kind: 'dot' }

/** "99+" above 99. */
export const countLabel = (n: number): string => (n > 99 ? '99+' : String(n))

const mentionsAria = (n: number): string => `${n} mention${n === 1 ? '' : 's'}`

/**
 * The mark of `badge`. `dot` false: no unread dot, only mentions. `count` false: the mentions show
 * as a dot without the number.
 */
export function unreadMarkOf(
  badge: { mentions: number; unread: boolean },
  { dot = true, count = true }: { dot?: boolean; count?: boolean } = {}
): UnreadMarkKind | null {
  if (badge.mentions > 0) {
    return count
      ? { kind: 'count', label: countLabel(badge.mentions), aria: mentionsAria(badge.mentions) }
      : { kind: 'mentionDot', aria: mentionsAria(badge.mentions) }
  }
  return dot && badge.unread ? { kind: 'dot' } : null
}
