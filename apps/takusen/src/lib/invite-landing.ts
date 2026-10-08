/**
 * The data of the public `/invite/[code]` page: the guild card of a usable
 * invite, or why the invite does not work. Not a REST shape: the page reads it
 * on the server. `GET /api/v1/invites/:code` stays the wire preview.
 */
import { eq, inArray } from 'drizzle-orm'

import { db } from '@/db/client'
import { guildMembers, guilds, users } from '@/db/schema'
import { fileUrl } from '@/lib/file-url'
import { readPresences } from '@/lib/guilds'
import { inviteUsability } from '@/lib/invite-history'
import { getInviteByCode } from '@/lib/invites'

export const INVITE_MEMBER_SAMPLE = 4

export interface InvitePerson {
  id: string
  displayName: string
  avatarUrl: string | null
}

export interface UsableInvite {
  status: 'ok'
  code: string
  guild: { id: string; name: string; iconUrl: string | null; bannerUrl: string | null; region: string | null }
  memberCount: number
  onlineCount: number
  /** Up to INVITE_MEMBER_SAMPLE members, online ones first. */
  members: InvitePerson[]
  /** Null only when the creator's account is deleted while the page loads (the invite cascades with it). */
  inviter: InvitePerson | null
  expiresAt: string | null
  /** An invite with history (§12.11.4): the page forwards the `#k=` fragment. */
  hasHistory: boolean
  viewerIsMember: boolean
}

export interface DeadInvite {
  status: 'expired' | 'revoked' | 'exhausted' | 'unknown'
  code: string
  /** For `expired`: when it expired. */
  expiredAt: string | null
  /** The guild name, only for a viewer who is a member: anyone else learns nothing from a dead code. */
  guildName: string | null
  viewerIsMember: boolean
}

export type InviteLanding = UsableInvite | DeadInvite

/** `onlineIds` first (in member order), then the rest, at most `n`. */
export function pickMemberSample(memberIds: readonly string[], onlineIds: ReadonlySet<string>, n: number): string[] {
  const online = memberIds.filter((id) => onlineIds.has(id))
  const offline = memberIds.filter((id) => !onlineIds.has(id))
  return [...online, ...offline].slice(0, n)
}

function person(u: { id: string; displayName: string; image: string | null }): InvitePerson {
  return { id: u.id, displayName: u.displayName, avatarUrl: fileUrl(u.image) }
}

export async function getInviteLanding(
  code: string,
  viewerId: string | null,
  now: Date = new Date(),
): Promise<InviteLanding> {
  const invite = await getInviteByCode(code)
  if (!invite) return { status: 'unknown', code, expiredAt: null, guildName: null, viewerIsMember: false }

  const [[guild], members] = await Promise.all([
    db.select().from(guilds).where(eq(guilds.id, invite.guildId)).limit(1),
    db.select({ userId: guildMembers.userId }).from(guildMembers).where(eq(guildMembers.guildId, invite.guildId)),
  ])
  if (!guild) return { status: 'unknown', code: invite.code, expiredAt: null, guildName: null, viewerIsMember: false }
  const memberIds = members.map((m) => m.userId)
  const viewerIsMember = viewerId !== null && memberIds.includes(viewerId)

  const usability = inviteUsability(invite, now)
  if (usability !== 'ok') {
    return {
      status: usability,
      code: invite.code,
      expiredAt: usability === 'expired' && invite.expiresAt ? invite.expiresAt.toISOString() : null,
      guildName: viewerIsMember ? guild.name : null,
      viewerIsMember,
    }
  }

  const online = new Set((await readPresences(memberIds)).map((p) => p.userId))
  const sample = pickMemberSample(memberIds, online, INVITE_MEMBER_SAMPLE)
  const people = await db
    .select({ id: users.id, displayName: users.displayName, image: users.image })
    .from(users)
    .where(inArray(users.id, [...new Set([...sample, invite.createdBy])]))
  const byId = new Map(people.map((u) => [u.id, u]))
  const inviter = byId.get(invite.createdBy)

  return {
    status: 'ok',
    code: invite.code,
    guild: {
      id: guild.id,
      name: guild.name,
      iconUrl: fileUrl(guild.icon),
      bannerUrl: fileUrl(guild.banner),
      region: guild.region,
    },
    memberCount: memberIds.length,
    onlineCount: online.size,
    members: sample.flatMap((id) => {
      const u = byId.get(id)
      return u ? [person(u)] : []
    }),
    inviter: inviter ? person(inviter) : null,
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    hasHistory: invite.record !== null,
    viewerIsMember,
  }
}
