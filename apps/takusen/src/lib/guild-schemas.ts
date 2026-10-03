/**
 * Shared zod pieces for the /api/v1 guild routes.
 */
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels, regions } from '@/db/schema'
import { ValidationError } from '@/lib/errors'
import { regionCodeSchema } from '@/lib/regions'

export const nameSchema = z.string().trim().min(1).max(100)
export const colorSchema = z.number().int().min(0).max(0xffffff)
/** Permission bitfields: JS-safe, all bits < 2^31 (contract conventions). */
export const permissionsSchema = z.number().int().min(0).max(0x7fffffff)
/** `joined` or `shared` (§12.6). */
export const historyVisibilitySchema = z.enum(['joined', 'shared'])
export { regionCodeSchema }

/** FK-safe region check: unknown codes are a 400, not a 500 from Postgres. */
export async function assertRegion(code: string | null | undefined): Promise<void> {
  if (!code) return
  const [row] = await db.select({ code: regions.code }).from(regions).where(eq(regions.code, code)).limit(1)
  if (!row) throw new ValidationError(`Unknown region "${code}"`)
}

/** A parent must be a category of the same guild (categories don't nest). */
export async function assertParent(
  guildId: string,
  parentId: string | null | undefined,
  childType: string,
): Promise<void> {
  if (!parentId) return
  if (childType === 'category') throw new ValidationError('Categories cannot be nested')
  const [parent] = await db
    .select({ type: channels.type })
    .from(channels)
    .where(and(eq(channels.id, parentId), eq(channels.guildId, guildId)))
    .limit(1)
  if (parent?.type !== 'category') throw new ValidationError('parentId must be a category in this guild')
}
