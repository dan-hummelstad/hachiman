/**
 * The limits of the pages delivery service (docs/gateway-protocol.md §4 Pages,
 * §12.18 "Env").
 */
import { DEFAULT_LIMITS } from '@hachiman/client/files'

export interface DocsLimits {
  /** TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES: the blob cap of a snapshot upload. */
  maxSnapshotBytes: number
  /** TAKUSEN_GUILD_PAGE_STORAGE_BYTES: the page upload bytes of one guild. 0 = no limit. */
  guildStorageBytes: number
}

export const DEFAULT_GUILD_PAGE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024
/** GET /pages/:pageId/state gives at most this many updates. */
export const STATE_UPDATES_MAX = 500
export const UPDATES_LIMIT_MAX = 500
export const UPDATES_LIMIT_DEFAULT = 200
export const SNAPSHOT_MEDIA_IDS_MAX = 1000
export const MEDIA_CLAIM_IDS_MAX = 20

function int(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`)
  return n
}

export function docsLimits(env: Readonly<Record<string, string | undefined>> = process.env): DocsLimits {
  return {
    maxSnapshotBytes: int('TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES', env.TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES, DEFAULT_LIMITS.maxPageSnapshotBytes, 1),
    guildStorageBytes: int('TAKUSEN_GUILD_PAGE_STORAGE_BYTES', env.TAKUSEN_GUILD_PAGE_STORAGE_BYTES, DEFAULT_GUILD_PAGE_STORAGE_BYTES, 0),
  }
}
