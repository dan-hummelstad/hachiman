import { useEffect, useMemo, useRef } from 'react'
import type { User } from '@hachiman/client'
import { usePeople } from '@/components/people/use-people'
import { formatDayMonthYear } from '@/lib/time-format'
import { blockService } from '@/services/guild-features'
import { useChannelStore } from '@/stores/channelStore'
import { useUserStore } from '@/stores/userStore'

export interface BlockedUsers {
  /** The blocked users whose names are known, by name. */
  users: User[]
  /** How many people I blocked, with the ones whose names are not loaded yet. */
  count: number
  /** userId → when I blocked them (ISO). Can lack a user. */
  blockedAt: ReadonlyMap<string, string>
}

/**
 * Pure: the blocked users that `known` has a name for, by name. `missing`: a blocked id that
 * `known` lacks (a user blocked since the last block list).
 */
export function resolveBlockedUsers(
  blocks: ReadonlySet<string>,
  known: ReadonlyMap<string, User>
): { users: User[]; missing: boolean } {
  const users: User[] = []
  let missing = false
  for (const id of blocks) {
    const u = known.get(id)
    if (u) users.push(u)
    else missing = true
  }
  users.sort((a, b) => a.username.localeCompare(b.username))
  return { users, missing }
}

/**
 * The detail line of a blocked user (M34): "Blocked 3 Oct", with the year when it is not this
 * year's ("Blocked 18 Sep 2025"), or "Blocked" with no time.
 */
export function blockedLine(iso: string | undefined, now = Date.now(), locale?: string): string {
  const ms = iso === undefined ? NaN : Date.parse(iso)
  if (!Number.isFinite(ms)) return 'Blocked'
  return `Blocked ${formatDayMonthYear(ms, now, locale)}`
}

/**
 * The people I blocked, for the Blocked tab of the DM home and the privacy screen (M34). A blocked
 * user I no longer share a guild with is in no member list, so the name comes from the DM
 * recipients or the block list of blockService. A name that none of them has (a user blocked
 * since the last load) makes one reload of the block list per mount.
 */
export function useBlockedUsers(): BlockedUsers {
  const people = usePeople()
  const blocks = useUserStore((s) => s.blocks)
  const blockedUsers = useUserStore((s) => s.blockedUsers)
  const blockedAt = useUserStore((s) => s.blockedAt)
  const channels = useChannelStore((s) => s.channels)
  const reloaded = useRef(false)

  const known = useMemo(() => {
    const byId = new Map<string, User>(blockedUsers)
    for (const u of people) byId.set(u.id, u)
    for (const c of channels.values()) for (const u of c.recipients ?? []) byId.set(u.id, u)
    return byId
  }, [people, channels, blockedUsers])
  const { users, missing } = useMemo(() => resolveBlockedUsers(blocks, known), [blocks, known])

  useEffect(() => {
    if (!missing || reloaded.current) return
    reloaded.current = true
    void blockService.load()
  }, [missing])

  return { users, count: blocks.size, blockedAt }
}
