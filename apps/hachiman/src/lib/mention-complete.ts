/**
 * Mention completion in the composer: `@` for members, roles and everyone, `#` for channels and
 * pages. The pure parts live here; components/chat/mention-menu.tsx renders the list.
 */

export type TriggerChar = '@' | '#'

/** The `@query` or `#query` that ends at the caret. `start` is the index of the trigger char. */
export interface Trigger {
  char: TriggerChar
  query: string
  start: number
  end: number
}

// The trigger must start the text or follow a space or "(", so an email or a URL fragment
// ("a@b", "page#x") does not open the menu. The query has no space and at most 32 chars.
const TRIGGER = /(^|[\s(])([@#])([^\s@#]{0,32})$/u

export function findTrigger(text: string, caret: number): Trigger | null {
  const m = TRIGGER.exec(text.slice(0, caret))
  if (!m) return null
  const start = m.index + (m[1] ?? '').length
  return { char: m[2] as TriggerChar, query: m[3] ?? '', start, end: caret }
}

/** Replace the trigger with `insert` plus one space; the caret goes after the space. */
export function applyCompletion(
  text: string,
  trigger: Trigger,
  insert: string
): { text: string; caret: number } {
  const after = text.slice(trigger.end).replace(/^ /, '')
  const next = `${text.slice(0, trigger.start)}${insert} ${after}`
  return { text: next, caret: trigger.start + insert.length + 1 }
}

/** 0 prefix, 1 prefix of a later word, 2 contains, -1 no match. Case-insensitive. */
export function matchRank(label: string, query: string): number {
  if (!query) return 0
  const l = label.toLowerCase()
  const q = query.toLowerCase()
  if (l.startsWith(q)) return 0
  if (l.split(/[\s._-]+/).some((w) => w.startsWith(q))) return 1
  return l.includes(q) ? 2 : -1
}

/**
 * The items whose labels match `query`, best match first. Equal matches keep the input order, so
 * the caller decides which group comes first (members before roles, channels before pages).
 */
export function rankItems<T>(
  items: readonly T[],
  query: string,
  labels: (item: T) => readonly (string | null | undefined)[],
  limit = 8
): T[] {
  const scored: { item: T; rank: number; i: number }[] = []
  items.forEach((item, i) => {
    const ranks = labels(item)
      .filter((l): l is string => !!l)
      .map((l) => matchRank(l, query))
      .filter((r) => r >= 0)
    if (ranks.length > 0) scored.push({ item, rank: Math.min(...ranks), i })
  })
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i)
  return scored.slice(0, limit).map((s) => s.item)
}

/** A role mention as the composer shows it (`@Captain`) and as it is sent (`<@&roleId>`). */
export interface RoleInsert {
  display: string
  wire: string
}

/**
 * The text to send: each role mention that the user picked from the menu, still in the text in its
 * display form, becomes its wire form. Longer names go first, so "@Squad Leads" is not taken for
 * "@Squad". A display form must end at a word boundary.
 */
export function toWire(text: string, roles: readonly RoleInsert[]): string {
  let out = text
  const sorted = [...roles].sort((a, b) => b.display.length - a.display.length)
  for (const r of sorted) {
    const escaped = r.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), r.wire)
  }
  return out
}
