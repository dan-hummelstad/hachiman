import type { View } from '@/stores/navStore'

/** What a quick switcher result opens (N5). */
export type SwitchKind = 'text' | 'voice' | 'pages' | 'page' | 'dm' | 'person'

export interface SwitchItem {
  /** `c:<channelId>`, `p:<pageId>` or `u:<userId>`: the same key as `recentKeys` gives. */
  key: string
  kind: SwitchKind
  name: string
  guildId: string | null
  /** The guild name, or null for DMs and people. */
  guildName: string | null
  /** The channel (DM, channel, pages channel of a page); null for a person. */
  channelId: string | null
  pageId?: string
  /** The person of a 'person' result. */
  userId?: string
}

/** The switcher key of a view, or null (DM home, guild, settings). */
export function keyOfView(view: View): string | null {
  switch (view.kind) {
    case 'dm':
    case 'channel':
      return `c:${view.channelId}`
    case 'page':
      return `p:${view.pageId}`
    default:
      return null
  }
}

/** The keys of the history, the most recent first, without repeats. `past` is oldest first. */
export function recentKeys(past: readonly View[], current: View): string[] {
  const keys: string[] = []
  for (const v of [current, ...[...past].reverse()]) {
    const k = keyOfView(v)
    if (k !== null && !keys.includes(k)) keys.push(k)
  }
  return keys
}

/** 0: the name starts with the query, 1: a word starts with it, 2: it is inside, -1: no match. */
export function matchTier(name: string, query: string): number {
  const n = name.toLowerCase()
  const q = query.toLowerCase()
  const at = n.indexOf(q)
  if (at < 0) return -1
  if (at === 0) return 0
  return n.split(/[\s\-_./:]+/).some((w) => w.startsWith(q)) ? 1 : 2
}

/**
 * The results for `query`: case-insensitive substring of the name, ranked by the match tier, then
 * by recent use (`recent`: keys, the most recent first), then by name. An empty query lists the
 * recent items first, then the rest by name.
 */
export function rankItems(
  items: readonly SwitchItem[],
  query: string,
  recent: readonly string[],
  limit = 30
): SwitchItem[] {
  const q = query.trim()
  const rank = new Map(recent.map((k, i) => [k, i]))
  const recency = (it: SwitchItem): number => rank.get(it.key) ?? Number.MAX_SAFE_INTEGER
  const scored: { it: SwitchItem; tier: number }[] = []
  for (const it of items) {
    const tier = q === '' ? 0 : matchTier(it.name, q)
    if (tier >= 0) scored.push({ it, tier })
  }
  scored.sort(
    (a, b) => a.tier - b.tier || recency(a.it) - recency(b.it) || a.it.name.localeCompare(b.it.name)
  )
  return scored.slice(0, limit).map((s) => s.it)
}
