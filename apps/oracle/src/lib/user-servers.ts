/**
 * User-servers query helpers.
 *
 * `userServers` is a user's personal "joined servers" list (the sidebar in
 * the Hachiman client). Each row points either at a registered Oracle
 * server (`serverId` set) or at a raw `host:port` the user typed in
 * manually (`serverId` null).
 *
 * Uniqueness is enforced at (userId, host, port) — adding the same target
 * twice resolves to the existing row.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db/client'
import { userServers, type NewUserServer, type UserServer } from '@/db/schema'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UserServerNotFoundError extends Error {
  constructor(id: string) {
    super(`User server not found: ${id}`)
    this.name = 'UserServerNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const createUserServerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
  host: z
    .string()
    .trim()
    .min(1, 'Host is required')
    .max(253, 'Host is too long'),
  port: z
    .number()
    .int('Port must be an integer')
    .min(1, 'Port must be between 1 and 65535')
    .max(65535, 'Port must be between 1 and 65535'),
  serverId: z.string().uuid().optional(),
})

export const updateUserServerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name is too long')
    .optional(),
  lastUsedAt: z
    .string()
    .datetime({ offset: true, message: 'lastUsedAt must be an ISO timestamp' })
    .optional(),
})

export type CreateUserServerInput = z.infer<typeof createUserServerSchema>
export type UpdateUserServerInput = z.infer<typeof updateUserServerSchema>

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * List a user's servers, ordered by last-used desc (nulls last), then
 * added-at desc. This matches the "most recently active first" sidebar
 * ordering the client expects.
 */
export async function listUserServers(userId: string): Promise<UserServer[]> {
  return db
    .select()
    .from(userServers)
    .where(eq(userServers.userId, userId))
    .orderBy(
      // `nulls last` so freshly-added rows (no lastUsedAt) fall below ones
      // the user has actually connected to recently.
      sql`${userServers.lastUsedAt} DESC NULLS LAST`,
      desc(userServers.addedAt),
      asc(userServers.id),
    )
}

export async function getUserServerById(
  userId: string,
  id: string,
): Promise<UserServer | null> {
  const rows = await db
    .select()
    .from(userServers)
    .where(and(eq(userServers.id, id), eq(userServers.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

export async function findUserServerByHostPort(
  userId: string,
  host: string,
  port: number,
): Promise<UserServer | null> {
  const rows = await db
    .select()
    .from(userServers)
    .where(
      and(
        eq(userServers.userId, userId),
        eq(userServers.host, host),
        eq(userServers.port, port),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

export interface CreateUserServerResult {
  server: UserServer
  /** True iff a brand-new row was inserted; false if an existing match was returned. */
  created: boolean
}

/**
 * Add a server to a user's list. If (userId, host, port) already exists we
 * return the existing row with `created: false` rather than 409'ing — the
 * route handler turns that into a 409 with the existing payload so the
 * client can reconcile its local state.
 */
export async function createUserServer(
  userId: string,
  input: CreateUserServerInput,
): Promise<CreateUserServerResult> {
  const parsed = createUserServerSchema.parse(input)

  const existing = await findUserServerByHostPort(userId, parsed.host, parsed.port)
  if (existing) {
    return { server: existing, created: false }
  }

  const values: NewUserServer = {
    userId,
    serverId: parsed.serverId ?? null,
    name: parsed.name,
    host: parsed.host,
    port: parsed.port,
  }

  // ON CONFLICT guards against the race where two concurrent POSTs both
  // observed "no existing" above. The conflict is resolved by re-reading
  // the existing row.
  const inserted = await db
    .insert(userServers)
    .values(values)
    .onConflictDoNothing({
      target: [userServers.userId, userServers.host, userServers.port],
    })
    .returning()

  if (inserted[0]) {
    return { server: inserted[0], created: true }
  }

  const row = await findUserServerByHostPort(userId, parsed.host, parsed.port)
  if (!row) {
    throw new Error('Failed to insert user server')
  }
  return { server: row, created: false }
}

export async function updateUserServer(
  userId: string,
  id: string,
  patch: UpdateUserServerInput,
): Promise<UserServer> {
  const parsed = updateUserServerSchema.parse(patch)
  const updates: Partial<typeof userServers.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (parsed.name !== undefined) updates.name = parsed.name
  if (parsed.lastUsedAt !== undefined) {
    updates.lastUsedAt = new Date(parsed.lastUsedAt)
  }

  const rows = await db
    .update(userServers)
    .set(updates)
    .where(and(eq(userServers.id, id), eq(userServers.userId, userId)))
    .returning()

  const row = rows[0]
  if (!row) throw new UserServerNotFoundError(id)
  return row
}

export async function deleteUserServer(userId: string, id: string): Promise<void> {
  const rows = await db
    .delete(userServers)
    .where(and(eq(userServers.id, id), eq(userServers.userId, userId)))
    .returning({ id: userServers.id })
  if (rows.length === 0) {
    throw new UserServerNotFoundError(id)
  }
}

/**
 * Serialise a UserServer row into the wire shape the client consumes —
 * dates as ISO strings, everything camelCase.
 */
export function serializeUserServer(row: UserServer) {
  return {
    id: row.id,
    userId: row.userId,
    serverId: row.serverId,
    name: row.name,
    host: row.host,
    port: row.port,
    addedAt: row.addedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}
