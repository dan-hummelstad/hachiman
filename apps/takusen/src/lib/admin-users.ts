/**
 * User management for the deployment admin API (contract §4 Admin API).
 * Role changes and deletes lock the admin rows, so two admins who demote or
 * delete each other at the same time cannot leave the deployment without one.
 */
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'

import { db, type Tx } from '@/db/client'
import { guildMembers, guilds, uploads, users, type User } from '@/db/schema'
import {
  afterCursor,
  assertAdminChange,
  cursorColumn,
  likePattern,
  toPage,
  type AdminUser,
  type ListQuery,
  type Page,
  type UserRole,
} from '@/lib/admin'
import { ForbiddenError } from '@/lib/auth-helpers'
import { NotFoundError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import { deleteGuildRows, membershipChanged, membershipTransaction, MembershipTriggers, publicHistoryVisibility, publishUserUpdate } from '@/lib/guilds'
import { deleteUserOidcRows } from '@/lib/session-revocation'
import { deleteObjects } from '@/lib/storage'
import { toGuild, toUser } from '@/lib/wire'

const adminUserColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  name: users.name,
  image: users.image,
  role: users.role,
  emailVerified: users.emailVerified,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
  cursor: cursorColumn(users.createdAt),
}

type AdminUserRow = Pick<
  User,
  'id' | 'email' | 'displayName' | 'role' | 'image' | 'emailVerified' | 'emailVerifiedAt' | 'createdAt'
>

function toAdminUser(u: AdminUserRow): AdminUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    avatar: u.image,
    emailVerified: u.emailVerified !== null || u.emailVerifiedAt !== null,
    createdAt: u.createdAt.toISOString(),
  }
}

/** Newest first. `query` matches email or display name; `role` filters. */
export async function listUsers(q: ListQuery, role?: UserRole): Promise<Page<AdminUser>> {
  const where: (SQL | undefined)[] = [role ? eq(users.role, role) : undefined]
  if (q.query) {
    const pattern = likePattern(q.query)
    where.push(or(ilike(users.email, pattern), ilike(users.displayName, pattern)))
  }
  if (q.cursor) {
    where.push(afterCursor(users.createdAt, users.id, q.cursor))
  }
  const rows = await db
    .select(adminUserColumns)
    .from(users)
    .where(and(...where))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(q.limit + 1)
  return toPage(rows, q.limit, toAdminUser)
}

/** Row-locks the admin rows until `tx` ends; the actor must be one of them. */
async function lockAdmins(tx: Tx, actorId: string): Promise<void> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .for('update')
  if (!rows.some((r) => r.id === actorId)) throw new ForbiddenError()
}

async function lockTarget(tx: Tx, id: string) {
  const [row] = await tx.select(adminUserColumns).from(users).where(eq(users.id, id)).for('update')
  if (!row) throw new NotFoundError('Unknown user')
  return row
}

export interface UpdateUserInput {
  role?: UserRole
  displayName?: string
}

/** A new display name is published like a self-edit (USER_UPDATE + GUILD_MEMBER_UPDATE). */
export async function updateUser(actorId: string, id: string, input: UpdateUserInput): Promise<AdminUser> {
  const row = await db.transaction(async (tx) => {
    await lockAdmins(tx, actorId)
    const target = await lockTarget(tx, id)
    if (input.role === 'user' && target.role === 'admin') {
      assertAdminChange(actorId, target.id, 'demote')
    }
    const changes: Partial<typeof users.$inferInsert> = {}
    if (input.role !== undefined) changes.role = input.role
    if (input.displayName !== undefined) {
      changes.displayName = input.displayName
      changes.name = input.displayName
    }
    if (Object.keys(changes).length === 0) return target
    const [updated] = await tx
      .update(users)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning(adminUserColumns)
    return updated
  })
  if (input.displayName !== undefined) await publishUserUpdate(toUser(row))
  return toAdminUser(row)
}

/**
 * Deletes the account. In one transaction: the guilds it owns (as an owner
 * delete), all of its uploads, guild icons/banners that used them, and its
 * OIDC rows; the FK cascades take its memberships, messages, DM participation,
 * invites and devices. Before the user row goes, the DS queues a Remove for
 * every leaf of the user (`user_deleted`, §12.18). After commit: the DS
 * events, GUILD_DELETE per owned guild, GUILD_MEMBER_REMOVE
 * per other guild, GUILD_UPDATE per guild that lost its icon or banner, then
 * the objects (best effort). Its messages in other guilds and its DM channels
 * go without events (contract §4 Admin API, user delete).
 */
export async function deleteUser(actorId: string, id: string): Promise<void> {
  const result = await membershipTransaction(async (tx) => {
    await lockAdmins(tx, actorId)
    const target = await lockTarget(tx, id)
    assertAdminChange(actorId, target.id, 'delete')

    const owned = await tx.select({ id: guilds.id }).from(guilds).where(eq(guilds.ownerId, id))
    const keys: string[] = []
    for (const g of owned) keys.push(...(await deleteGuildRows(tx, g.id, null)))

    const memberOf = await tx
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(eq(guildMembers.userId, id))
    const own = await tx.delete(uploads).where(eq(uploads.uploaderId, id)).returning({ key: uploads.key })
    const ownKeys = own.map((u) => u.key)
    keys.push(...ownKeys)
    const touched =
      ownKeys.length === 0
        ? []
        : await tx
            .update(guilds)
            .set({
              icon: sql`CASE WHEN ${inArray(guilds.icon, ownKeys)} THEN NULL ELSE ${guilds.icon} END`,
              banner: sql`CASE WHEN ${inArray(guilds.banner, ownKeys)} THEN NULL ELSE ${guilds.banner} END`,
            })
            .where(or(inArray(guilds.icon, ownKeys), inArray(guilds.banner, ownKeys)))
            .returning()
    await membershipChanged(tx, MembershipTriggers.userDeleted(id), null)
    await tx.delete(users).where(eq(users.id, id))
    await deleteUserOidcRows(tx, id)
    return { target, keys, owned, memberOf, touched }
  })

  const user = toUser(result.target)
  await Promise.all([
    ...result.owned.map((g) => publishToGuild(g.id, 'GUILD_DELETE', { id: g.id })),
    ...result.memberOf.map((m) =>
      publishToGuild(m.guildId, 'GUILD_MEMBER_REMOVE', { guildId: m.guildId, user }),
    ),
    ...result.touched.map(async (g) => publishToGuild(g.id, 'GUILD_UPDATE', toGuild(g, await publicHistoryVisibility(g.id)))),
  ])
  await deleteObjects(result.keys)
}
