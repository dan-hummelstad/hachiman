import {
  Permissions,
  computeChannelPermissions,
  has,
  type Channel,
  type Guild,
  type Invite,
  type Role
} from '@hachiman/client'
import { compareChannels } from '@/lib/model'

// Without ADMINISTRATOR, Takusen allows at most 24 hours (contract §4 "Invite limits").
const LIMITED_EXPIRY = [
  { label: '30 minutes', seconds: 1800 },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 }
]
const ADMIN_EXPIRY = [
  ...LIMITED_EXPIRY,
  { label: '7 days', seconds: 604800 },
  { label: 'Permanent', seconds: 0 }
]

/** Invite expiry choices (seconds; 0 = permanent). Only an administrator gets more than 24 hours. */
export function inviteExpiryChoices(
  isAdmin: boolean
): readonly { label: string; seconds: number }[] {
  return isAdmin ? ADMIN_EXPIRY : LIMITED_EXPIRY
}

/** False when the choices of `isAdmin` do not list `seconds`, e.g. after a loss of ADMINISTRATOR. */
export function isInviteExpiryChoice(seconds: number, isAdmin: boolean): boolean {
  return inviteExpiryChoices(isAdmin).some((c) => c.seconds === seconds)
}

/** Invite max-use choices; 0 = no limit. */
export const INVITE_MAX_USES = [0, 1, 5, 10, 25, 100]

/** A max-use choice as the select shows it: "No limit", "1 use", "25 uses". */
export function maxUsesLabel(n: number): string {
  return n === 0 ? 'No limit' : `${n} ${n === 1 ? 'use' : 'uses'}`
}

/** Permanent invites (`expiresAt === null`) first; otherwise the given order (newest first). */
export function sortInvites<T extends { expiresAt: string | null }>(invites: readonly T[]): T[] {
  return [...invites].sort((a, b) => Number(b.expiresAt === null) - Number(a.expiresAt === null))
}

/** An expiry closer than this shows in gold. */
export const INVITE_SOON_MS = 3 * 86_400_000

type InviteUse = Pick<Invite, 'uses' | 'maxUses'>

/** No use is left: `uses` reached `maxUses` (null or 0: no limit). */
export function isUsedUp(invite: InviteUse): boolean {
  return !!invite.maxUses && invite.uses >= invite.maxUses
}

/**
 * What the expiry of an invite shows at `now` (ms): `usedUp` (no use left, before all else),
 * `expired`, `permanent` (no expiry), `soon` (gold, under INVITE_SOON_MS) or `later`.
 */
export type InviteExpiryState = 'usedUp' | 'expired' | 'permanent' | 'soon' | 'later'

export function inviteExpiryState(
  invite: InviteUse & Pick<Invite, 'expiresAt'>,
  now: number
): InviteExpiryState {
  if (isUsedUp(invite)) return 'usedUp'
  if (invite.expiresAt === null) return 'permanent'
  const left = Date.parse(invite.expiresAt) - now
  // An unreadable date counts as expired: the link cannot be trusted to work.
  if (!(left > 0)) return 'expired'
  return left < INVITE_SOON_MS ? 'soon' : 'later'
}

/** The invites that still let people join (not used up, not expired): the Invites tab count. */
export function countActiveInvites(
  invites: readonly (InviteUse & Pick<Invite, 'expiresAt'>)[],
  now: number
): number {
  return invites.filter((i) => {
    const state = inviteExpiryState(i, now)
    return state !== 'usedUp' && state !== 'expired'
  }).length
}

/** The uses of an invite: "3 uses" with no limit, "11 / 25 uses" with one. */
export function inviteUsesLabel(invite: InviteUse): string {
  const unit = (n: number): string => (n === 1 ? 'use' : 'uses')
  return invite.maxUses
    ? `${invite.uses} / ${invite.maxUses} ${unit(invite.maxUses)}`
    : `${invite.uses} ${unit(invite.uses)}`
}

/** A member with no roles: what a user who joins with an invite gets. */
const EVERYONE = { user: { id: '' }, roles: [] }

/**
 * The scope of an invite with history, for display (§12.11.4): the text and pages channels of the
 * guild that @everyone can view, in sidebar order. The Worker signs the scope from the verified
 * admin state (§12.16), so the signed list can be shorter.
 */
export function inviteScope(
  guild: Pick<Guild, 'id' | 'ownerId'>,
  roles: ReadonlyMap<string, Pick<Role, 'id' | 'permissions'>>,
  channels: Iterable<Channel>
): Channel[] {
  return [...channels]
    .filter(
      (c) =>
        c.guildId === guild.id &&
        (c.type === 'text' || c.type === 'pages') &&
        has(computeChannelPermissions(guild, EVERYONE, roles, c), Permissions.VIEW_CHANNEL)
    )
    .sort(compareChannels)
}
