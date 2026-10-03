/**
 * The call participants from the MLS tree (§12.10.1), joined with what the servers report.
 *
 * - 'secure': the gateway or media reports the user, and the user has a leaf in the tree.
 * - 'joining': only a server reports the user. The user has no leaf yet, so the UI shows no media
 *   of that user as trusted.
 * - 'leaving': the user has a leaf, but no server reports the user. The leaf holds the epoch keys
 *   until the committer removes it.
 */
import type { VoicePeer, VoiceState } from '@hachiman/client'
import type { VoiceRosterEntry } from '@hachiman/crypto'

export type CallParticipantStatus = 'secure' | 'joining' | 'leaving'

export interface CallParticipant {
  userId: string
  status: CallParticipantStatus
  /** The gateway voice state, null when only media or only the tree reports the user. */
  voiceState: VoiceState | null
  /** The tree leaves of the user (normally one). Empty for 'joining'. */
  leaves: VoiceRosterEntry[]
}

/**
 * One entry per user, in the order: gateway voice states, then media peers, then tree-only users.
 * A gateway session matches a leaf by session id. A leaf without a session id (the Worker did not
 * see the session in the media roster) matches by user id.
 */
export function callParticipants(
  occupants: readonly VoiceState[],
  peers: readonly VoicePeer[],
  roster: readonly VoiceRosterEntry[]
): CallParticipant[] {
  const unclaimed = new Set(roster.filter((e) => e.leafIndex !== null))
  const leavesFor = (userId: string, sessionId: string | null): VoiceRosterEntry[] => {
    const found: VoiceRosterEntry[] = []
    for (const e of unclaimed) {
      if (e.userId !== userId) continue
      if (e.sessionId === '' || sessionId === null || e.sessionId === sessionId) found.push(e)
    }
    found.forEach((e) => unclaimed.delete(e))
    return found
  }

  const out: CallParticipant[] = []
  const seen = new Set<string>()
  const add = (userId: string, voiceState: VoiceState | null): void => {
    if (seen.has(userId)) return
    seen.add(userId)
    const leaves = leavesFor(userId, voiceState?.sessionId ?? null)
    out.push({ userId, voiceState, leaves, status: leaves.length > 0 ? 'secure' : 'joining' })
  }
  occupants.forEach((vs) => add(vs.userId, vs))
  peers.forEach((p) => add(p.userId, null))

  // Leaves that no server session claimed: a departed participant, or a stale leaf of a user
  // who is still here with another session.
  for (const e of unclaimed) {
    const here = out.find((p) => p.userId === e.userId)
    if (here) {
      here.leaves.push(e)
      continue
    }
    out.push({ userId: e.userId, voiceState: null, leaves: [e], status: 'leaving' })
  }
  return out
}

/** The user ids whose media the UI may show as trusted. */
export function secureUserIds(participants: readonly CallParticipant[]): Set<string> {
  return new Set(participants.filter((p) => p.status === 'secure').map((p) => p.userId))
}

/**
 * The 30-digit epoch code (§12.5) as 6 groups of 5 digits. Null for anything that is not exactly
 * 30 digits, so the UI never shows a partial or wrong code.
 */
export function epochCodeGroups(code: string | null): string[] | null {
  if (code === null || !/^\d{30}$/.test(code)) return null
  return Array.from({ length: 6 }, (_, i) => code.slice(i * 5, i * 5 + 5))
}
