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
  /** The person of a 'person' result, or the other person of a 1:1 DM. */
  userId?: string
  /** A person or DM: the guilds where the person (a recipient) is a member, for the guild filter. */
  guildIds?: readonly string[]
  /** A person or 1:1 DM: the avatar file key. */
  avatar?: string | null
}

/** The chips of the mobile search screen (M66): All, People (DMs and people), Channels. */
export type SwitchFilterKind = 'all' | 'people' | 'channels'

/** What the switcher lists: the chip and the "In:" guild (null: any guild). */
export interface SwitchFilter {
  kind: SwitchFilterKind
  guildId: string | null
}

/** Everything, in any guild: the desktop switcher's only filter. */
export const ANY_RESULT: SwitchFilter = { kind: 'all', guildId: null }

/** A DM or a person: the People chip and the PEOPLE group. */
export const isPersonKind = (kind: SwitchKind): boolean => kind === 'dm' || kind === 'person'

/** Whether `it` passes `filter`. A DM or person is in a guild when the person is a member of it. */
export function inFilter(it: SwitchItem, filter: SwitchFilter): boolean {
  const person = isPersonKind(it.kind)
  if (filter.kind === 'people' && !person) return false
  if (filter.kind === 'channels' && person) return false
  if (filter.guildId === null) return true
  return person ? (it.guildIds?.includes(filter.guildId) ?? false) : it.guildId === filter.guildId
}

/**
 * The chip that the mobile search screen starts on: People when it opens over the DM home (the
 * "Find or start a conversation" field, M56), else All.
 */
export function initialFilterKind(view: View): SwitchFilterKind {
  return view.kind === 'dmHome' ? 'people' : 'all'
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

/** The characters between words, where `matchTier` splits a name. */
const WORD_BREAK = /[\s\-_./:]/

/**
 * Where `query` matches `name`, for the highlight: `[start, end)` in `name`, or null for no match
 * (or an empty query). The same place that `matchTier` ranks: the start of the name, else the
 * first match at the start of a word, else the first match. Case-insensitive.
 */
export function matchRange(name: string, query: string): [number, number] | null {
  const q = query.trim().toLowerCase()
  const n = name.toLowerCase()
  // A lower-case form of another length (a few Unicode letters) has no index into `name`.
  if (q === '' || n.length !== name.length) return null
  const first = n.indexOf(q)
  if (first < 0) return null
  let at = first
  while (at > 0 && !WORD_BREAK.test(n.charAt(at - 1))) {
    at = n.indexOf(q, at + 1)
    if (at < 0) {
      at = first
      break
    }
  }
  return [at, at + q.length]
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

/** The groups of the mobile search screen (M66), in their order. */
export type SwitchGroup = 'recent' | 'channels' | 'people'

export interface SwitchSection {
  group: SwitchGroup
  items: SwitchItem[]
}

/** The most results in the RECENT group. */
export const RECENT_MAX = 5

/**
 * Splits ranked `results` into the groups of the mobile search screen: RECENT (the results that
 * are in `recent`, the most recent first, at most `max`), then CHANNELS (channels and pages) and
 * PEOPLE (DMs and people) in rank order. Empty groups are left out.
 */
export function groupResults(
  results: readonly SwitchItem[],
  recent: readonly string[],
  max = RECENT_MAX
): SwitchSection[] {
  const rank = new Map(recent.map((k, i) => [k, i]))
  const latest = results
    .filter((it) => rank.has(it.key))
    .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0))
    .slice(0, max)
  const shown = new Set(latest.map((it) => it.key))
  const rest = results.filter((it) => !shown.has(it.key))
  const sections: SwitchSection[] = [
    { group: 'recent', items: latest },
    { group: 'channels', items: rest.filter((it) => !isPersonKind(it.kind)) },
    { group: 'people', items: rest.filter((it) => isPersonKind(it.kind)) }
  ]
  return sections.filter((s) => s.items.length > 0)
}
